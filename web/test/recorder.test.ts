/**
 * Testes do recorder comprimido — PUROS (node:test, sem jsdom, sem MediaRecorder).
 * Provam a cadeia de decisão webm/opus → mp4 → WAV, a extensão derivada do mime,
 * o bitrate e a matemática do tamanho. O que só um navegador prova (o
 * MediaRecorder de verdade capturando o stream) fica no hook, de propósito.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RECORDER_BITRATE,
  RECORDER_MIME_CANDIDATES,
  estimateCompressedBytes,
  pickRecorderMime,
  recorderExtFor,
  recorderFileName,
  shouldUseRecorder,
  type IsTypeSupported,
} from "../src/lib/recorder.ts";

/** isTypeSupported falso, exceto para os mimes listados (ordem observada no calls). */
function supports(...allowed: string[]) {
  const calls: string[] = [];
  const isTypeSupported: IsTypeSupported = (mime) => {
    calls.push(mime);
    return allowed.includes(mime);
  };
  return { calls, isTypeSupported };
}

test("recorder: nada de MediaRecorder é tocado no carregamento do módulo", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  assert.equal(descriptor, undefined, "o Node não tem MediaRecorder — o módulo puro não pode depender dele");
  // Se o pick olhasse o navegador no import (e não na chamada), isto viria undefined/erro.
  assert.equal(pickRecorderMime(), null);
  assert.equal(shouldUseRecorder(pickRecorderMime(), false), false);
});

test("recorder: escolhe webm/opus quando o navegador grava webm (Android/Chrome, Safari 18.4+)", () => {
  const { calls, isTypeSupported } = supports("audio/webm;codecs=opus", "audio/mp4");
  assert.equal(pickRecorderMime(isTypeSupported), "audio/webm;codecs=opus");
  assert.deepEqual(calls, ["audio/webm;codecs=opus"], "webm é o primeiro da fila e já resolve");
});

test("recorder: cai para mp4/AAC quando não há webm (iOS Safari < 18.4)", () => {
  const { calls, isTypeSupported } = supports("audio/mp4");
  assert.equal(pickRecorderMime(isTypeSupported), "audio/mp4");
  assert.deepEqual(calls, ["audio/webm;codecs=opus", "audio/mp4"], "tenta webm antes de aceitar mp4");
});

test("recorder: nenhum comprimido suportado → null (caminho WAV legado)", () => {
  const { calls, isTypeSupported } = supports();
  assert.equal(pickRecorderMime(isTypeSupported), null);
  assert.deepEqual(calls, [...RECORDER_MIME_CANDIDATES], "consulta os candidatos na ordem declarada");
});

test("recorder: extensão vem do MIME, não de constante fixa", () => {
  assert.equal(recorderExtFor("audio/webm;codecs=opus"), "webm");
  assert.equal(recorderExtFor("audio/webm"), "webm");
  assert.equal(recorderExtFor("audio/mp4"), "m4a");
  assert.equal(recorderExtFor("audio/mp4;codecs=mp4a.40.2"), "m4a");
  assert.equal(recorderExtFor("audio/x-m4a"), "m4a");
  assert.equal(recorderExtFor("audio/wav"), "wav");
  assert.equal(recorderExtFor(""), "wav");
  assert.equal(recorderExtFor(null), "wav");
  assert.equal(recorderExtFor(undefined), "wav");
  assert.equal(recorderFileName("audio/mp4"), "gravacao.m4a");
  assert.equal(recorderFileName(null), "gravacao.wav");
});

test("recorder: modo cru força o WAV mesmo com comprimido disponível", () => {
  assert.equal(shouldUseRecorder("audio/webm;codecs=opus", false), true);
  assert.equal(shouldUseRecorder("audio/mp4", false), true);
  assert.equal(shouldUseRecorder("audio/webm;codecs=opus", true), false, "modo cru = pipeline WAV intacto");
  assert.equal(shouldUseRecorder(null, false), false, "sem MediaRecorder o WAV continua sendo o caminho");
  assert.equal(shouldUseRecorder(null, true), false);
});

test("recorder: 32 kbps é o teto de fala e 10 s ≈ 40 KB (contra ~320 KB do WAV)", () => {
  assert.equal(RECORDER_BITRATE, 32_000);
  assert.equal(estimateCompressedBytes(10), 40_000);
  assert.equal(estimateCompressedBytes(10) / 1024, 39.0625, "≈ 39 KB, dentro da meta 30–120 KB");
  assert.equal(estimateCompressedBytes(30), 120_000, "30 s ≈ 120 KB (o pior caso da meta)");
  assert.equal(estimateCompressedBytes(2), 8_000);
  assert.equal(estimateCompressedBytes(0.22), 880, "fala mínima de 220 ms ≈ 0,9 KB — acima do piso de 400 B do servidor");
  assert.equal(estimateCompressedBytes(10, 24_000), 30_000, "24 kbps também é faixa de fala válida");
});

test("recorder: estimativa aguenta entrada degenerada sem virar NaN/0", () => {
  assert.equal(estimateCompressedBytes(0), 1);
  assert.equal(estimateCompressedBytes(-5), 1);
  assert.equal(estimateCompressedBytes(Number.NaN), 1);
  assert.equal(estimateCompressedBytes(10, 0), 1);
  assert.equal(estimateCompressedBytes(Number.POSITIVE_INFINITY), 1);
});

test("recorder: o ganho sobre o WAV 16 kHz fica entre 8× e 32×", () => {
  const wavBytes = (seconds: number) => seconds * 16_000 * 2; // 16-bit mono
  const ratio = wavBytes(10) / estimateCompressedBytes(10);
  assert.ok(ratio >= 8 && ratio <= 32, `razão ${ratio.toFixed(1)}× fora do esperado`);
});
