import { AnimatePresence, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Board, TCard } from "@/lib/types";
import { MoreChip, OrbitChip, tidyName, useElementRegistry } from "./OrbitChip";

/* ── geometria ─────────────────────────────────────────────────────────── */

export interface Ring {
  listId: string;
  name: string;
  count: number;
  shown: TCard[];
  hidden: number;
  rx: number;
  ry: number;
  dir: 1 | -1;
  duration: number;
  base: number;
  labelAngle: number;
}

export interface Geometry {
  w: number;
  h: number;
  cx: number;
  cy: number;
  cardW: number;
  cardH: number;
  planetR: number;
  compact: boolean;
  rings: Ring[];
  hiddenLists: number;
  focusScale: number;
}

const hash = (text: string) => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
};

/** Elipses que ocupam toda a área livre; cards por anel limitados pela circunferência. */
export function computeGeometry(w: number, h: number, bottomInset: number, board: Board): Geometry {
  const compact = w < 720;
  const cardW = compact ? 98 : w < 1100 ? 136 : 152;
  const cardH = compact ? 34 : 44;
  const planetR = compact ? 42 : w < 1100 ? 60 : 74;
  const topPad = 10;
  const usableH = Math.max(160, h - bottomInset - topPad);
  const cx = w / 2;
  const cy = topPad + usableH / 2;

  const rxMax = Math.max(planetR + cardW / 2 + 40, w / 2 - cardW / 2 - (compact ? 2 : 10));
  const ryMax = Math.max(planetR + cardH / 2 + 30, usableH / 2 - cardH / 2 - 8);
  // O anel interno precisa liberar o planeta em TODOS os ângulos (nas diagonais o card
  // retangular invade o círculo): amostra a elipse e cresce até o retângulo não tocar.
  let rxMin = planetR + cardW / 2 + 18;
  let ryMin = planetR + cardH / 2 + 10;
  const hw = (cardW / 2) * 1.06;
  const hh = (cardH / 2) * 1.06;
  const clears = (rx: number, ry: number) => {
    for (let deg = 0; deg < 360; deg += 6) {
      const a = (deg * Math.PI) / 180;
      const dx = Math.max(0, Math.abs(rx * Math.cos(a)) - hw);
      const dy = Math.max(0, Math.abs(ry * Math.sin(a)) - hh);
      if (Math.hypot(dx, dy) < planetR + 8) return false;
    }
    return true;
  };
  for (let guard = 0; guard < 40 && !clears(rxMin, ryMin); guard += 1) {
    rxMin *= 1.04;
    ryMin *= 1.04;
  }

  const maxRings = compact ? 3 : w < 900 ? 5 : w < 1200 ? 6 : 8;
  const lists = board.lists.filter((list) => !list.closed).sort((a, b) => a.pos - b.pos);
  const open = new Set(lists.map((list) => list.id));
  const byList = new Map<string, TCard[]>();
  for (const card of board.cards) {
    if (card.closed || !open.has(card.idList)) continue;
    const bucket = byList.get(card.idList) ?? [];
    bucket.push(card);
    byList.set(card.idList, bucket);
  }
  for (const bucket of byList.values()) bucket.sort((a, b) => a.pos - b.pos);

  // Listas com cards primeiro (anéis vazios só poluem); o resto fica no trilho.
  const withCards = lists.filter((list) => (byList.get(list.id)?.length ?? 0) > 0);
  const chosen = (withCards.length ? withCards : lists).slice(0, maxRings);

  const rings: Ring[] = chosen.map((list, index) => {
    const t = chosen.length === 1 ? 0.6 : index / (chosen.length - 1);
    const rx = rxMin + t * Math.max(0, rxMax - rxMin);
    const ry = ryMin + t * Math.max(0, ryMax - ryMin);
    const perimeter = 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2);
    const capacity = Math.max(3, Math.min(compact ? 4 : 14, Math.floor(perimeter / (cardW * (compact ? 1.7 : 1.45)))));
    const all = byList.get(list.id) ?? [];
    const overflow = all.length > capacity;
    const shown = overflow ? all.slice(0, capacity - 1) : all;
    return {
      listId: list.id,
      name: list.name,
      count: all.length,
      shown,
      hidden: all.length - shown.length,
      rx,
      ry,
      dir: index % 2 === 0 ? 1 : -1,
      duration: 90 + index * 26,
      base: hash(list.id) % 360,
      labelAngle: index % 2 === 0 ? 212 : 328,
    };
  });

  return { w, h, cx, cy, cardW, cardH, planetR, compact, rings, hiddenLists: Math.max(0, lists.length - chosen.length), focusScale: compact ? 1.2 : 1.45 };
}

interface Slot {
  id: string;
  ring: number;
  angle0: number;
  kind: "card" | "more";
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/* ── componente ────────────────────────────────────────────────────────── */

export interface PulseSignal {
  key: number;
  tone: "create" | "delete" | "ok";
}

interface OrbitStageProps {
  board: Board;
  focusIds: Set<string>;
  selectedId: string | null;
  activeListId: string | null;
  bottomInset: number;
  pulse: PulseSignal | null;
  onSelectCard: (card: TCard) => void;
  onSelectList: (listId: string) => void;
  /** O palco decide o tamanho do planeta (a geometria dos anéis depende dele). */
  children: (planetSize: number) => ReactNode;
}

/**
 * Palco orbital em tela cheia. Um único loop rAF posiciona todos os cards
 * (transform/opacity direto no DOM): zero re-render do React por frame.
 */
export function OrbitStage({ board, focusIds, selectedId, activeListId, bottomInset, pulse, onSelectCard, onSelectList, children }: OrbitStageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const reduce = useReducedMotion();
  const { map: els, register } = useElementRegistry();

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geo = useMemo(() => (size.w > 0 ? computeGeometry(size.w, size.h, bottomInset, board) : null), [size, bottomInset, board]);

  const listNames = useMemo(() => new Map(board.lists.map((list) => [list.id, list.name])), [board.lists]);

  const slots = useMemo<Slot[]>(() => {
    if (!geo) return [];
    const out: Slot[] = [];
    geo.rings.forEach((ring, ringIndex) => {
      const total = ring.shown.length + (ring.hidden > 0 ? 1 : 0);
      ring.shown.forEach((card, i) => out.push({ id: card.id, ring: ringIndex, angle0: ring.base + (i * 360) / total, kind: "card" }));
      if (ring.hidden > 0) out.push({ id: `more-${ring.listId}`, ring: ringIndex, angle0: ring.base + ((total - 1) * 360) / total, kind: "more" });
    });
    return out;
  }, [geo]);

  /* refs lidas pelo loop (o efeito do rAF monta uma vez só) */
  const geoRef = useRef(geo);
  const slotsRef = useRef(slots);
  const focusRef = useRef(focusIds);
  const selectedRef = useRef(selectedId);
  const activeListRef = useRef(activeListId);
  const reduceRef = useRef(Boolean(reduce));
  const hoverRing = useRef(-1);
  const phase = useRef<number[]>([]);
  const slow = useRef<number[]>([]);
  const dim = useRef(0);
  const focusBlend = useRef(new Map<string, number>());
  const born = useRef(new Map<string, number>());
  const introDone = useRef(false);

  geoRef.current = geo;
  slotsRef.current = slots;
  focusRef.current = focusIds;
  selectedRef.current = selectedId;
  activeListRef.current = activeListId;
  reduceRef.current = Boolean(reduce);

  // Nascimento: no primeiro render os cards saem do planeta em cascata; depois, só os novos.
  useLayoutEffect(() => {
    const now = performance.now();
    let order = 0;
    for (const slot of slots) {
      if (born.current.has(slot.id)) continue;
      born.current.set(slot.id, introDone.current ? now : now + order * 28);
      order += 1;
    }
    if (slots.length) introDone.current = true;
  }, [slots]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      const g = geoRef.current;
      if (g && g.rings.length) {
        const rings = g.rings;
        rings.forEach((ring, i) => {
          const calm = hoverRing.current === i || activeListRef.current === ring.listId;
          slow.current[i] = (slow.current[i] ?? 1) + ((calm ? 0.04 : 1) - (slow.current[i] ?? 1)) * (1 - Math.exp(-dt * 6));
          phase.current[i] = (phase.current[i] ?? 0) + (reduceRef.current ? 0 : ring.dir * (360 / ring.duration) * dt * slow.current[i]);
        });

        const focus = focusRef.current;
        const hasFocus = focus.size > 0;
        dim.current += ((hasFocus || activeListRef.current ? 1 : 0) - dim.current) * (1 - Math.exp(-dt * 5));

        // posição dos cards em foco (fila na frente do planeta, acima do dock)
        const focusIds = slotsRef.current.filter((slot) => focus.has(slot.id)).map((slot) => slot.id).slice(0, 3);
        // O card citado "vem para perto": flutua logo acima do planeta (nunca sob o dock/confirmação).
        const fy = g.cy - g.planetR - g.cardH * g.focusScale * 0.5 - 30;
        const gap = g.cardW * g.focusScale + 14;

        for (const slot of slotsRef.current) {
          const el = els.current.get(slot.id);
          if (!el) continue;
          const ring = rings[slot.ring];
          if (!ring) continue;

          const a = ((phase.current[slot.ring] ?? 0) + slot.angle0) * (Math.PI / 180);
          let x = g.cx + ring.rx * Math.cos(a);
          let y = g.cy + ring.ry * Math.sin(a);
          const depth = (Math.sin(a) + 1) / 2; // 0 = fundo, 1 = frente
          let scale = 0.8 + 0.26 * depth;
          let opacity = 0.62 + 0.38 * depth;
          let z = Math.round(depth * 100);

          const focused = focus.has(slot.id);
          const k0 = focusBlend.current.get(slot.id) ?? 0;
          const k = k0 + ((focused ? 1 : 0) - k0) * (1 - Math.exp(-dt * 7));
          focusBlend.current.set(slot.id, k);

          if (k > 0.002) {
            const rank = Math.max(0, focusIds.indexOf(slot.id));
            const fx = g.cx + (rank - (Math.min(focusIds.length, 3) - 1) / 2) * gap;
            const e = easeOut(Math.min(1, k));
            x = lerp(x, fx, e);
            y = lerp(y, fy, e);
            scale = lerp(scale, g.focusScale, e);
            opacity = lerp(opacity, 1, e);
            z = Math.round(lerp(z, 220, e));
          } else if (dim.current > 0.01) {
            const inActive = activeListRef.current === ring.listId;
            if (!inActive) opacity *= 1 - 0.62 * dim.current;
            else {
              opacity = lerp(opacity, 1, dim.current);
              scale *= 1 + 0.08 * dim.current;
            }
          }

          if (selectedRef.current === slot.id) {
            scale *= 1.1;
            opacity = 1;
            z = Math.max(z, 150);
          }

          const born0 = born.current.get(slot.id);
          if (born0 !== undefined) {
            const b = Math.max(0, Math.min(1, (now - born0) / 1000));
            if (b < 1) {
              const e = easeOut(b);
              x = lerp(g.cx, x, e);
              y = lerp(g.cy, y, e);
              scale *= e;
              opacity *= Math.min(1, b * 3);
            }
          }

          el.style.transform = `translate3d(${(x - (slot.kind === "card" ? g.cardW / 2 : 16)).toFixed(1)}px, ${(y - (slot.kind === "card" ? g.cardH / 2 : 13)).toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
          el.style.opacity = opacity.toFixed(3);
          el.style.zIndex = String(z);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [els]);

  const labelPos = (ring: Ring) => {
    if (!geo) return { x: 0, y: 0 };
    const a = (ring.labelAngle * Math.PI) / 180;
    return { x: geo.cx + ring.rx * Math.cos(a), y: geo.cy + ring.ry * Math.sin(a) };
  };

  return (
    <div ref={rootRef} className="stage-bg relative h-full w-full overflow-hidden" role="region" aria-label="Órbita do board">
      {geo && (
        <>
          {/* anéis: o fundo (parte de cima) é mais fraco → sensação de profundidade */}
          <svg className="pointer-events-none absolute inset-0" width={geo.w} height={geo.h} aria-hidden="true">
            <defs>
              <linearGradient id="ring-depth" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="white" stopOpacity="0.28" />
                <stop offset="1" stopColor="white" stopOpacity="1" />
              </linearGradient>
              <mask id="ring-mask">
                <rect width={geo.w} height={geo.h} fill="url(#ring-depth)" />
              </mask>
            </defs>
            <g mask="url(#ring-mask)">
              {geo.rings.map((ring) => {
                const active = activeListId === ring.listId;
                return (
                  <ellipse
                    key={ring.listId}
                    cx={geo.cx}
                    cy={geo.cy}
                    rx={ring.rx}
                    ry={ring.ry}
                    fill="none"
                    stroke="var(--color-primary)"
                    strokeOpacity={active ? 0.75 : 0.17}
                    strokeWidth={active ? 1.6 : 1}
                    style={{ transition: "stroke-opacity 240ms, stroke-width 240ms" }}
                  />
                );
              })}
            </g>
          </svg>

          {/* rótulos dos anéis, escalonados para nunca colidirem */}
          {geo.rings.map((ring) => {
            const { x, y } = labelPos(ring);
            const active = activeListId === ring.listId;
            return (
              <button
                key={ring.listId}
                type="button"
                onClick={() => onSelectList(ring.listId)}
                className={`absolute z-[8] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wider transition-colors ${
                  active ? "bg-primary text-primary-foreground" : "bg-background/55 text-muted-foreground/80 hover:text-foreground"
                }`}
                style={{ left: x, top: y }}
                aria-label={`Lista ${tidyName(ring.name)}, ${ring.count} cards`}
              >
                {tidyName(ring.name)} <span className="tnum opacity-70">{ring.count}</span>
              </button>
            );
          })}

          {/* o "Saturno" decorativo ao redor do planeta */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-[49] rounded-[50%] border border-primary/25"
            style={{
              left: geo.cx,
              top: geo.cy,
              width: geo.planetR * 3.1,
              height: geo.planetR * 0.95,
              transform: "translate(-50%, -50%) rotate(-14deg)",
            }}
          />

          {/* eco quando algo é criado/apagado */}
          {pulse && (
            <span
              key={pulse.key}
              aria-hidden="true"
              className={`animate-ripple pointer-events-none absolute z-[45] rounded-full border-2 ${
                pulse.tone === "delete" ? "border-destructive" : "border-primary"
              }`}
              style={{ left: geo.cx, top: geo.cy, width: geo.planetR * 2, height: geo.planetR * 2 }}
            />
          )}

          {/* cards */}
          <AnimatePresence>
            {geo.rings.flatMap((ring, ringIndex) =>
              ring.shown.map((card) => (
                <OrbitChip
                  key={card.id}
                  card={card}
                  ringIndex={ringIndex}
                  listName={listNames.get(card.idList) ?? ""}
                  width={geo.cardW}
                  compact={geo.compact}
                  focused={focusIds.has(card.id)}
                  selected={selectedId === card.id}
                  register={register}
                  onSelect={onSelectCard}
                  onHover={(index) => {
                    hoverRing.current = index;
                  }}
                />
              )),
            )}
          </AnimatePresence>
          {geo.rings.map((ring) =>
            ring.hidden > 0 ? (
              <MoreChip key={`more-${ring.listId}`} id={`more-${ring.listId}`} count={ring.hidden} listName={ring.name} register={register} onOpen={() => onSelectList(ring.listId)} />
            ) : null,
          )}

          {/* núcleo: o planeta fica entre os cards do fundo (z<50) e os da frente (z>50) */}
          <div className="absolute z-[50]" style={{ left: geo.cx, top: geo.cy, transform: "translate(-50%, -50%)" }}>
            {children(geo.planetR * 2)}
          </div>
        </>
      )}
    </div>
  );
}
