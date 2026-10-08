/**
 * Geometria do palco: o que o recon só suspeitava, aqui vira conta.
 *
 * Palco real de um 380×844: `max-lg:h-[68dvh]` → 574 px de altura, 380 px de largura
 * e `bottomInset` 150 (viewport < 640, o valor que o App passa em App.tsx).
 *
 * O que o teste cobra é o PIOR estado do loop do OrbitStage, não o card em repouso:
 * repouso ×1,06, selecionado ×1,1, selecionado+lista ativa ×1,2595 no anel e a fila
 * de foco (card puxado, que troca a profundidade pela escala de foco) ×1,4256.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_SCALE,
  COMPACT_CHIP_H,
  LIST_GAIN,
  RING_WORST_SCALE,
  SELECTED_GAIN,
  computeGeometry,
  worstState,
} from "../src/lib/orbit-geometry.ts";
import type { Board, TCard } from "../src/lib/types.ts";

/** Board sintético: `lists` listas abertas com `per` cards cada. */
function board(lists: number, per: number): Board {
  const list = (i: number) => ({ id: `l${i}`, name: `Lista ${i}`, pos: i * 100, closed: false });
  const card = (listId: string, i: number): TCard => ({
    id: `${listId}-c${i}`,
    idList: listId,
    name: `card ${listId}.${i}`,
    desc: "",
    due: null,
    dueComplete: false,
    pos: i * 100,
    closed: false,
    url: "",
    labels: [],
    checklists: [],
  });
  const ls = Array.from({ length: lists }, (_, i) => list(i));
  return { id: "b", name: "Board", url: "", demo: false, lists: ls, cards: ls.flatMap((l) => Array.from({ length: per }, (_, i) => card(l.id, i))), labels: [], members: [] };
}

/** Palco de um 380×844 com o dock do celular. */
const PHONE = { w: 380, h: 574, inset: 150 };
const geo = (w: number, h = PHONE.h, inset = PHONE.inset) => computeGeometry(w, h, inset, board(6, 5), null);

test("as escalas do orçamento batem com o loop (profundidade × lista ativa × selecionado)", () => {
  assert.equal(CARD_SCALE, 1.06);
  assert.equal(LIST_GAIN, 1.08);
  assert.equal(SELECTED_GAIN, 1.1);
  assert.ok(Math.abs(RING_WORST_SCALE - 1.25928) < 1e-9, `pior escala do anel = ${RING_WORST_SCALE}`);
  // A puxada para a fila troca a profundidade pela escala de foco: é o teto global.
  assert.ok(geo(380).focusScale * LIST_GAIN * SELECTED_GAIN > RING_WORST_SCALE);
});

test("chip compacto: a geometria modela a caixa real (34,25 px), não 32", () => {
  assert.equal(COMPACT_CHIP_H, 34.25); // py-1 (8) + 2 × 10,5 px × 1,25
  for (const w of [380, 480, 719]) {
    const g = geo(w);
    assert.equal(g.compact, true);
    assert.equal(g.cardH, COMPACT_CHIP_H, `${w}px: cardH tem de ser a caixa real`);
    assert.notEqual(g.cardH, 32);
  }
  assert.equal(geo(720).cardH, 44); // ≥720: caixa de desktop, intacta
});

test("380 px: folga ≥ 0 em TODOS os estados (repouso, selecionado, selecionado+lista, fila)", () => {
  const s = worstState(geo(PHONE.w));
  assert.ok(s.ringMargin >= 0, `anel cortado em ${s.ringMargin.toFixed(2)}px no pior estado`);
  assert.ok(s.focusRowMargin >= 0, `fila de foco cortada em ${s.focusRowMargin.toFixed(2)}px`);
  assert.ok(s.focusRowTop >= 0, `fila de foco sai por cima em ${s.focusRowTop.toFixed(2)}px`);
  assert.ok(s.pullPathMargin >= 0, `caminho da puxada cortado em ${s.pullPathMargin.toFixed(2)}px`);
});

test("380 px: o card nunca invade o planeta (folga ≥ 8 px no pior estado do anel)", () => {
  const s = worstState(geo(PHONE.w));
  assert.ok(s.ringPlanetGap >= 8, `folga planetar de ${s.ringPlanetGap.toFixed(2)}px`);
});

test("380 px: o card cabe com a escala de repouso do loop e com a do pior estado", () => {
  const g = geo(PHONE.w);
  const atRest = (g.cardW / 2) * CARD_SCALE;
  const worst = (g.cardW / 2) * RING_WORST_SCALE;
  for (const ring of g.rings) {
    assert.ok(ring.rx + atRest <= g.w / 2, `${ring.name}: repouso passa ${(ring.rx + atRest - g.w / 2).toFixed(2)}px`);
    assert.ok(ring.rx + worst <= g.w / 2, `${ring.name}: pior estado passa ${(ring.rx + worst - g.w / 2).toFixed(2)}px`);
    assert.ok(ring.rx >= g.planetR + g.cardW / 2, `${ring.name}: rx ${ring.rx.toFixed(1)} < planetR + cardW/2`);
  }
});

test("380 px: os anéis cabem na altura útil do palco (não entram no dock nem no topo)", () => {
  const g = geo(PHONE.w);
  const hh = (g.cardH / 2) * RING_WORST_SCALE;
  const top = 10;
  const bottom = g.cy + (PHONE.h - PHONE.inset - top) / 2;
  for (const ring of g.rings) {
    assert.ok(g.cy - ring.ry - hh >= top, `${ring.name}: card entra na faixa do topo`);
    assert.ok(g.cy + ring.ry + hh <= bottom, `${ring.name}: card entra na faixa do dock (${(g.cy + ring.ry + hh).toFixed(1)} > ${bottom.toFixed(1)})`);
  }
});

test("folga ≥ 0 de 340 px a 719 px (limite compacto)", () => {
  for (const w of [340, 344, 360, 375, 390, 414, 440, 479, 480, 520, 600, 719]) {
    const g = geo(w);
    const s = worstState(g);
    const where = `${w}px (cardW=${g.cardW} cardH=${g.cardH} planetR=${g.planetR})`;
    assert.ok(s.ringMargin >= 0, `${where}: anel ${s.ringMargin.toFixed(2)}`);
    assert.ok(s.ringPlanetGap >= 0, `${where}: planeta ${s.ringPlanetGap.toFixed(2)}`);
    assert.ok(s.focusRowMargin >= 0, `${where}: fila ${s.focusRowMargin.toFixed(2)}`);
    assert.ok(s.focusRowTop >= 0, `${where}: topo da fila ${s.focusRowTop.toFixed(2)}`);
  }
});

test("o degrau 'phone' para em 480 px: 480–719 px mantém 98/42 (cardW e planeta)", () => {
  assert.equal(geo(480).cardW, 98);
  assert.equal(geo(480).planetR, 42);
  assert.equal(geo(380).cardW, 80);
  assert.equal(geo(380).planetR, 34);
});

test("320 px: o resíduo é conhecido e pequeno (não é regressão silenciosa)", () => {
  const s = worstState(geo(320));
  // Abaixo de ~336 px não sobra largura para 3 anéis de 80 px no pior estado.
  assert.ok(s.ringMargin < 0 && s.ringMargin > -12, `anel em 320px = ${s.ringMargin.toFixed(2)}px`);
  assert.ok(s.focusRowMargin < 0 && s.focusRowMargin > -12, `fila em 320px = ${s.focusRowMargin.toFixed(2)}px`);
  assert.ok(s.ringPlanetGap >= 0, "o planeta continua livre mesmo em 320px");
});

test("≥720 px: comportamento de desktop congelado (valores do HEAD fb6aa16)", () => {
  // Congelados a partir da função do HEAD: qualquer mudança aqui é regressão de desktop.
  const frozen: [number, number, number, number, number, number, number, number, number, number][] = [
    // w, h, inset, cardW, cardH, planetR, cy, anéis, primeiro rx, último rx
    [720, 700, 184, 136, 44, 60, 263, 5, 170.79935, 282],
    [1024, 800, 184, 136, 44, 60, 313, 6, 170.79935, 434],
    [1440, 900, 156, 152, 44, 74, 377, 6, 196.536238, 634],
  ];
  for (const [w, h, inset, cardW, cardH, planetR, cy, count, firstRx, lastRx] of frozen) {
    const g = computeGeometry(w, h, inset, board(6, 5), null);
    assert.equal(g.compact, false, `${w}px não pode ser compacto`);
    assert.equal(g.cardW, cardW);
    assert.equal(g.cardH, cardH);
    assert.equal(g.planetR, planetR);
    assert.equal(g.cy, cy);
    assert.equal(g.focusScale, 1.45);
    assert.equal(g.rings.length, count);
    assert.equal(Math.round(g.rings[0].rx * 1e6) / 1e6, firstRx);
    assert.equal(g.rings[g.rings.length - 1].rx, lastRx);
  }
});

test("320–479 px: o pior estado não piora com o spotlight (até 5 anéis)", () => {
  const b = board(6, 5);
  const ids = new Set(b.cards.slice(0, 6).map((card) => card.id));
  for (const w of [344, 380, 479]) {
    const g = computeGeometry(w, PHONE.h, PHONE.inset, b, ids);
    const s = worstState(g);
    assert.ok(g.rings.length > 0);
    assert.ok(s.ringMargin >= 0, `${w}px com spotlight: anel ${s.ringMargin.toFixed(2)}`);
    assert.ok(s.ringPlanetGap >= 0, `${w}px com spotlight: planeta ${s.ringPlanetGap.toFixed(2)}`);
  }
});
