/**
 * Teclado virtual: a conta do que ficou coberto (`innerHeight − visualViewport`),
 * com o limiar que separa "teclado aberto" de "barra de endereço se mexeu".
 *
 * Números de referência de um 380×844 (iPhone 12/13 mini, Safari): teclado ≈330 px,
 * visual viewport 514 px; com a página rolada, `offsetTop` cresce e o inset encolhe.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { KEYBOARD_MIN_RATIO, keyboardInset, keyboardInsetPx, useKeyboardInset } from "../src/hooks/useKeyboardInset.ts";

const WINDOW_H = 844;
const KEYBOARD = 330;
const VV = WINDOW_H - KEYBOARD; // 514

test("insetPx: diferença crua janela − visual viewport − offsetTop, nunca negativa", () => {
  assert.equal(keyboardInsetPx(844, 514, 0), 330);
  assert.equal(keyboardInsetPx(844, 514, 112), 218); // página rolada revela parte do dock
  assert.equal(keyboardInsetPx(844, 844, 0), 0); // teclado fechado
  assert.equal(keyboardInsetPx(844, 900, 0), 0); // zoom de pinça para fora: vv maior que a janela
  assert.equal(keyboardInsetPx(844, 400, 500), 0); // offsetTop além da diferença
  assert.equal(keyboardInsetPx(844, 514, -40), 370); // offsetTop negativo (zoom) não vira negativo
});

test("insetPx: entradas degeneradas viram 0 em vez de NaN", () => {
  for (const [h, vh, off] of [
    [Number.NaN, 514, 0],
    [844, Number.NaN, 0],
    [844, 514, Number.NaN],
    [844, Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 514, 0],
  ] as [number, number, number][]) {
    assert.equal(keyboardInsetPx(h, vh, off), 0, `degenerado: ${h}/${vh}/${off}`);
  }
});

test("inset: o limiar de 15% decide nos dois sentidos", () => {
  assert.equal(KEYBOARD_MIN_RATIO, 0.15);
  const threshold = WINDOW_H * KEYBOARD_MIN_RATIO; // 126,6 px
  const below = Math.floor(threshold); // 126: barra de endereço se mexendo
  const above = Math.ceil(threshold) + 1; // 128: teclado
  assert.equal(keyboardInset(WINDOW_H, WINDOW_H - below, 0), 0, "abaixo do limiar não desloca nada");
  assert.equal(keyboardInset(WINDOW_H, WINDOW_H - above, 0), above, "acima do limiar desloca o inset inteiro");
  // ida e volta: abre → 330; fecha → 0; abre de novo → 330 (sem histerese/estado)
  assert.equal(keyboardInset(WINDOW_H, VV, 0), KEYBOARD);
  assert.equal(keyboardInset(WINDOW_H, WINDOW_H, 0), 0);
  assert.equal(keyboardInset(WINDOW_H, VV, 0), KEYBOARD);
});

test("inset: arredonda e nunca devolve fração", () => {
  assert.equal(keyboardInset(844, 514.4, 0), 330); // 329,6 → 330
  assert.equal(keyboardInset(844, 513.6, 0), 330); // 330,4 → 330
});

test("inset: janela degenerada (ainda não medida) devolve 0", () => {
  assert.equal(keyboardInset(0, -300, 0), 0);
  assert.equal(keyboardInset(-100, -400, 0), 0);
});

test("inset: o dock do 380×844 sobe menos que o inset (o palco termina antes do fundo)", () => {
  const inset = keyboardInset(WINDOW_H, VV, 0);
  const visibleBottom = WINDOW_H - inset; // 514
  const dockBottom = 52 + 574; // TopBar + palco (68dvh) = 626
  assert.equal(inset, KEYBOARD);
  assert.equal(visibleBottom, VV);
  assert.ok(dockBottom - visibleBottom + 8 > 0, "há o que subir");
  assert.ok(dockBottom - visibleBottom + 8 < inset, "subir o inset cru passaria do ponto");
});

test("inset: com a página já rolada não sobra nada a subir", () => {
  const scrolled = 120; // o Safari traz o input para a vista
  const inset = keyboardInset(WINDOW_H, VV, scrolled);
  assert.equal(inset, KEYBOARD - scrolled);
  assert.ok(WINDOW_H - inset - scrolled === VV);
});

test("hook: módulo importa sem DOM e sem tocar window na avaliação (SSR-safe)", () => {
  assert.equal(typeof useKeyboardInset, "function");
});
