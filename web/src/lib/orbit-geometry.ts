/**
 * Geometria da órbita — módulo puro, sem React e sem DOM.
 *
 * Vive fora do OrbitStage.tsx por um motivo prático: `node --test` não consegue
 * importar `.tsx` (JSX não é "type stripping"), então a matemática dos anéis só
 * é testável de verdade — em telas estreitas de celular, por exemplo — se
 * morar num `.ts`. O componente importa daqui; nada mais mudou.
 */

import type { Board, TCard } from "./types.ts";

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
  /** Distância entre as vagas da fila de foco (3 cards puxados). */
  focusRowGap: number;
  /** Y absoluto da fila de foco no palco. */
  focusRowY: number;
  /** Escala de um card puxado + selecionado + lista ativa (pior estado da fila). */
  focusRowScale: number;
}

const hash = (text: string) => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
};

/**
 * Escalas que o loop do OrbitStage compõe, na ordem em que ele as aplica
 * (`scale = 0,8 + 0,26·depth` → puxada da fila → lista ativa → selecionado).
 * Ficam aqui para a geometria e o loop não divergirem: a folga de borda tem de
 * orçar o pior estado REAL, não o card em repouso.
 */
export const CARD_SCALE = 1.06; // 0,8 + 0,26·depth, depth ∈ [0,1]
export const LIST_DIM_GAIN = 0.08; // scale *= 1 + 0,08·dim (lista ativa ou card em foco)
export const LIST_GAIN = 1 + LIST_DIM_GAIN;
export const SELECTED_GAIN = 1.1; // scale *= 1,1 (card selecionado)
/** Pior escala de um card PARADO no anel: profundidade × lista ativa × selecionado. */
export const RING_WORST_SCALE = CARD_SCALE * LIST_GAIN * SELECTED_GAIN; // 1,2595
/** Altura real da caixa do chip compacto: py-1 (8) + 2 linhas de 10,5 px × 1,25 (26,25). */
export const COMPACT_CHIP_H = 34.25;
/** Folga horizontal extra do anel externo, em px (compacto). */
const EDGE_PAD = 4;
/** Espaçamento extra entre os cards da fila de foco e altura dela acima do planeta. */
const FOCUS_ROW_PAD = 14;
const FOCUS_ROW_LIFT = 30;

/** Elipses que ocupam toda a área livre; cards por anel limitados pela circunferência. */
export function computeGeometry(w: number, h: number, bottomInset: number, board: Board, spotlightIds: Set<string> | null = null): Geometry {
  const compact = w < 720;
  // Celular estreito (≈380 px úteis): cards e planeta um degrau menores. Com 98 px de
  // card, a folga de borda do pior estado (×1,2595) fica negativa e os 3 anéis colapsam.
  const phone = w < 480;
  const cardW = phone ? 80 : compact ? 98 : w < 1100 ? 136 : 152;
  const cardH = compact ? COMPACT_CHIP_H : 44;
  const planetR = phone ? 34 : compact ? 42 : w < 1100 ? 60 : 74;
  const focusScale = compact ? 1.2 : 1.45;
  const topPad = 10;
  const usableH = Math.max(160, h - bottomInset - topPad);
  const cx = w / 2;
  const cy = topPad + usableH / 2;

  // No compacto a folga desconta o pior estado do anel; ≥720 px mantém a fórmula
  // histórica (×1,06) de propósito — mudar isso mexeria no visual de desktop.
  const slackScale = compact ? RING_WORST_SCALE : CARD_SCALE;
  const rxMax = Math.max(planetR + cardW / 2 + 40, compact ? w / 2 - (cardW / 2) * slackScale - EDGE_PAD : w / 2 - cardW / 2 - 10);
  const ryMax = Math.max(planetR + cardH / 2 + 30, usableH / 2 - cardH / 2 - 8);
  // O anel interno precisa liberar o planeta em TODOS os ângulos (nas diagonais o card
  // retangular invade o círculo): amostra a elipse e cresce até o retângulo não tocar.
  let rxMin = planetR + cardW / 2 + 18;
  let ryMin = planetR + cardH / 2 + 10;
  const hw = (cardW / 2) * slackScale;
  const hh = (cardH / 2) * slackScale;
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
  // Spotlight (listagem): só as listas com cards listados viram anel e, nelas, só os
  // listados aparecem — sem corte por capacidade e sem chip «+N». Se nenhum id da
  // listagem existir no board, cai no desenho normal (nunca um palco vazio).
  const spot = spotlightIds && spotlightIds.size > 0 ? spotlightIds : null;
  const spotLists = spot ? lists.filter((list) => (byList.get(list.id) ?? []).some((card) => spot.has(card.id))) : [];
  const spotActive = spotLists.length > 0;
  const ringLimit = spotActive ? Math.max(maxRings, compact ? 5 : 8) : maxRings;
  const chosen = spotActive ? spotLists.slice(0, ringLimit) : (withCards.length ? withCards : lists).slice(0, maxRings);

  const rings: Ring[] = chosen.map((list, index) => {
    const t = chosen.length === 1 ? 0.6 : index / (chosen.length - 1);
    const rx = rxMin + t * Math.max(0, rxMax - rxMin);
    const ry = ryMin + t * Math.max(0, ryMax - ryMin);
    const perimeter = 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2);
    const capacity = Math.max(3, Math.min(compact ? 4 : 14, Math.floor(perimeter / (cardW * (compact ? 1.7 : 1.45)))));
    const all = byList.get(list.id) ?? [];
    const highlight = spotActive && spot ? all.filter((card) => spot.has(card.id)) : null;
    const overflow = highlight ? false : all.length > capacity;
    const shown = highlight ?? (overflow ? all.slice(0, capacity - 1) : all);
    return {
      listId: list.id,
      name: list.name,
      count: highlight ? highlight.length : all.length,
      shown,
      hidden: highlight ? 0 : all.length - shown.length,
      rx,
      ry,
      dir: index % 2 === 0 ? 1 : -1,
      duration: 90 + index * 26,
      base: hash(list.id) % 360,
      labelAngle: index % 2 === 0 ? 212 : 328,
    };
  });

  // Fila de foco (≤3 cards puxados para perto do planeta): posição e escala que o loop
  // usa. Fica na geometria para o teste conseguir orçar o pior estado da fila (×1,4256).
  const focusRowGap = cardW * focusScale + FOCUS_ROW_PAD;
  const focusRowY = cy - planetR - (cardH / 2) * focusScale - FOCUS_ROW_LIFT;
  const focusRowScale = focusScale * LIST_GAIN * SELECTED_GAIN;

  return {
    w,
    h,
    cx,
    cy,
    cardW,
    cardH,
    planetR,
    compact,
    rings,
    hiddenLists: Math.max(0, lists.length - chosen.length),
    focusScale,
    focusRowGap,
    focusRowY,
    focusRowScale,
  };
}

/** Pior estado alcançável pelo loop — o que a folga de borda tem de aguentar. */
export interface WorstState {
  /** Menor margem horizontal de um card no anel (≥ 0 = nada cortado pela borda). */
  ringMargin: number;
  /** Menor folga entre o card no anel e a borda do planeta (≥ 0 = não invade). */
  ringPlanetGap: number;
  /** Menor margem horizontal da fila de foco com as 3 vagas ocupadas. */
  focusRowMargin: number;
  /** Topo do card da fila de foco (≥ 0 = não sai por cima do palco). */
  focusRowTop: number;
  /** Menor margem horizontal em qualquer ponto do caminho anel → fila. */
  pullPathMargin: number;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Amostra os estados que o loop aplica (repouso ×1,06, selecionado, selecionado+lista
 * ativa ×1,2595 no anel e a puxada para a fila, que troca a profundidade pela escala de
 * foco: ×1,2 compacto / ×1,45 desktop, sempre ×1,08 ×1,1).
 *
 * O caminho da puxada PODE cruzar o planeta de propósito (o card vai na frente, z=220):
 * isso é animação, não repouso — a folga planetar medida aqui é a do anel.
 */
export function worstState(g: Geometry): WorstState {
  const halfW = (s: number) => (g.cardW / 2) * s;
  const halfH = (s: number) => (g.cardH / 2) * s;
  let ringMargin = Infinity;
  let ringPlanetGap = Infinity;
  let pullPathMargin = Infinity;
  for (const ring of g.rings) {
    for (let deg = 0; deg < 360; deg += 2) {
      const a = (deg * Math.PI) / 180;
      const dx0 = ring.rx * Math.cos(a);
      const dy0 = ring.ry * Math.sin(a);
      for (const s of [CARD_SCALE, CARD_SCALE * SELECTED_GAIN, RING_WORST_SCALE]) {
        const hw = halfW(s);
        ringMargin = Math.min(ringMargin, g.cx - Math.abs(dx0) - hw);
        const dx = Math.max(0, Math.abs(dx0) - hw);
        const dy = Math.max(0, Math.abs(dy0) - halfH(s));
        ringPlanetGap = Math.min(ringPlanetGap, Math.hypot(dx, dy) - g.planetR);
      }
      for (let step = 0; step <= 40; step += 1) {
        const e = easeOut(step / 40);
        const x = dx0 + (g.cx - g.focusRowGap - dx0) * e;
        const s = (CARD_SCALE + (g.focusScale - CARD_SCALE) * e) * LIST_GAIN * SELECTED_GAIN;
        pullPathMargin = Math.min(pullPathMargin, g.cx - Math.abs(x) - halfW(s));
      }
    }
  }
  const rowHw = halfW(g.focusRowScale);
  return {
    ringMargin,
    ringPlanetGap,
    focusRowMargin: g.cx - g.focusRowGap - rowHw,
    focusRowTop: g.focusRowY - halfH(g.focusRowScale),
    pullPathMargin,
  };
}
