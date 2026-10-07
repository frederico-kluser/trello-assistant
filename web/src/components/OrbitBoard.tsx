import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Board, TCard } from "@/lib/types";
import { TaskCard } from "./TaskCard";

/** Tamanho de desenho do sistema — escalado por `scale` para caber em qualquer tela. */
const DESIGN = { w: 860, h: 520 };
const TILT = 66; // inclinação do plano orbital (anéis quase de canto, como os de Júpiter)
const MAX_RINGS = 5;
const MAX_CARDS_PER_RING = 6;

interface OrbitBoardProps {
  board: Board;
  focusIds: Set<string>;
  selectedCardId: string | null;
  onSelectCard: (card: TCard) => void;
  children?: ReactNode;
}

interface Ring {
  listId: string;
  listName: string;
  rx: number;
  duration: number;
  direction: number;
  cards: TCard[];
}

/** Sistema orbital: cards giram em anéis ao redor do botão de record. */
export function OrbitBoard({ board, focusIds, selectedCardId, onSelectCard, children }: OrbitBoardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      setViewportWidth(entries[0].contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Escala mínima 0.55 mantém os cards tocáveis (≥ ~88 px) em telas estreitas.
  const scale = viewportWidth > 0 ? Math.max(0.55, Math.min(1, viewportWidth / DESIGN.w)) : 1;
  const ringCount = viewportWidth > 0 && viewportWidth < 640 ? 3 : MAX_RINGS;

  const rings = useMemo<Ring[]>(() => {
    const lists = board.lists.filter((list) => !list.closed).slice(0, ringCount);
    return lists.map((list, index) => ({
      listId: list.id,
      listName: list.name,
      rx: 122 + index * 52,
      duration: 118 + index * 27,
      direction: index % 2 === 0 ? 1 : -1,
      cards: board.cards.filter((card) => card.idList === list.id && !card.closed).slice(0, MAX_CARDS_PER_RING),
    }));
  }, [board, ringCount]);

  return (
    <div
      ref={containerRef}
      className="stage-vignette relative mx-auto w-full overflow-hidden rounded-3xl"
      style={{ height: DESIGN.h * scale, maxHeight: "72vh" }}
    >
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          width: DESIGN.w,
          height: DESIGN.h,
          transform: `translate(-50%, -50%) scale(${scale})`,
          perspective: 1200,
        }}
      >
        {rings.map((ring) => {
          const step = ring.cards.length > 0 ? 360 / ring.cards.length : 360;
          return (
            <div
              key={ring.listId}
              className="absolute left-1/2 top-1/2"
              style={{ transform: `rotateX(${TILT}deg)`, transformStyle: "preserve-3d" }}
            >
              {/* fragmentos dos anéis */}
              <div
                aria-hidden="true"
                className="ring-arc absolute rounded-full"
                style={{ width: ring.rx * 2, height: ring.rx * 2, left: -ring.rx, top: -ring.rx }}
              />
              <div
                aria-hidden="true"
                className="ring-arc-cool absolute rounded-full"
                style={{ width: ring.rx * 2, height: ring.rx * 2, left: -ring.rx, top: -ring.rx }}
              />

              {/* rótulo da lista, ancorado no anel */}
              <div
                className="absolute"
                style={{
                  transform: `rotate(${212 + ring.direction * 6}deg) translateX(${ring.rx}px)`,
                  transformStyle: "preserve-3d",
                }}
              >
                <div style={{ transform: `rotate(${-(212 + ring.direction * 6)}deg) rotateX(-${TILT}deg)` }}>
                  <span className="glass inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {ring.listName}
                  </span>
                </div>
              </div>

              {/* braço que gira carregando os cards */}
              <motion.div
                className="absolute"
                style={{ transformStyle: "preserve-3d" }}
                animate={reduce ? undefined : { rotate: [0, 360 * ring.direction] }}
                transition={{ duration: ring.duration, repeat: Infinity, ease: "linear" }}
              >
                {ring.cards.map((card, index) => {
                  const angle = step * index + (ring.listId.length % 7) * 5;
                  const focused = focusIds.has(card.id) || selectedCardId === card.id;
                  return (
                    <div
                      key={card.id}
                      className="absolute"
                      style={{
                        transform: `rotate(${angle}deg) translateX(${ring.rx}px)`,
                        transformStyle: "preserve-3d",
                      }}
                    >
                      {/* contra-rotação: mantém o card sempre de pé */}
                      <motion.div
                        style={{ transformStyle: "preserve-3d" }}
                        animate={reduce ? { rotate: -angle } : { rotate: [-angle, -angle - 360 * ring.direction] }}
                        transition={{ duration: ring.duration, repeat: Infinity, ease: "linear" }}
                      >
                        <motion.div
                          style={{ transform: `rotateX(-${TILT}deg)`, transformStyle: "preserve-3d" }}
                          animate={{ z: focused ? 96 : 0 }}
                          transition={{ type: "spring", stiffness: 210, damping: 26 }}
                        >
                          <AnimatePresence mode="popLayout">
                            <TaskCard
                              key={card.id}
                              card={card}
                              focused={focused}
                              dimmed={focusIds.size > 0 && !focused}
                              floatDelay={index * 0.7}
                              onSelect={onSelectCard}
                            />
                          </AnimatePresence>
                        </motion.div>
                      </motion.div>
                    </div>
                  );
                })}

                {/* moonlets decorativos */}
                {[0.5, 1.5].map((slot) => (
                  <div
                    key={slot}
                    aria-hidden="true"
                    className="absolute"
                    style={{ transform: `rotate(${step * slot}deg) translateX(${ring.rx}px)` }}
                  >
                    <span className="block h-1.5 w-1.5 rounded-full bg-primary/50" />
                  </div>
                ))}
              </motion.div>
            </div>
          );
        })}

        {/* núcleo central (planeta + botão de record) */}
        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">{children}</div>
      </div>
    </div>
  );
}