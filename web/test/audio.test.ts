import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VAD, VoiceActivity, encodeWav, normalize, resample, trimToSpeech } from "../src/lib/audio.ts";

const tone = (seconds: number, rate: number, amplitude: number, hz = 440) =>
  Float32Array.from({ length: Math.floor(seconds * rate) }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate));

const blockMs = 64; // 1024 amostras a 16 kHz

/** Alimenta o VAD com blocos de RMS constante durante `ms` e devolve o último veredito. */
function feed(vad: VoiceActivity, rms: number, ms: number) {
  let verdict = "continue";
  for (let t = 0; t < ms; t += blockMs) verdict = vad.push(rms, rms * 1.4, blockMs);
  return verdict;
}

test("WAV: cabeçalho RIFF/PCM mono 16 kHz e tamanho exato", async () => {
  const wav = encodeWav(tone(0.5, 16_000, 0.5));
  const view = new DataView(await wav.arrayBuffer());
  const text = (offset: number, length: number) => String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8000 * 2);
  assert.equal(wav.size, 44 + 8000 * 2);
  assert.equal(wav.type, "audio/wav");
});

test("resample: 48 kHz → 16 kHz mantém a duração e o conteúdo", () => {
  const input = tone(1, 48_000, 0.6, 200);
  const out = resample(input, 48_000, 16_000);
  assert.equal(out.length, 16_000);
  const peak = out.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
  assert.ok(peak > 0.55 && peak <= 0.61, `pico ${peak}`);
  assert.equal(resample(input, 16_000, 16_000), input); // mesma taxa: sem cópia
});

test("normalize: sobe microfone baixo (até 10×) e não mexe em áudio já forte nem em silêncio", () => {
  const quiet = tone(0.2, 16_000, 0.05);
  const boosted = normalize(quiet);
  const peak = boosted.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
  assert.ok(peak > 0.45 && peak < 0.75, `pico normalizado ${peak}`);

  const loud = tone(0.2, 16_000, 0.6);
  assert.equal(normalize(loud), loud);

  const dead = new Float32Array(1600);
  assert.equal(normalize(dead), dead);
});

test("VAD: fala seguida de silêncio encerra sozinho (≈1,1 s depois)", () => {
  const vad = new VoiceActivity(DEFAULT_VAD);
  assert.equal(feed(vad, 0.004, 400), "continue"); // ruído de fundo
  assert.equal(feed(vad, 0.15, 1200), "continue"); // falando
  assert.ok(vad.heardSpeech);
  assert.equal(feed(vad, 0.004, 1000), "continue"); // pausa curta: ainda espera
  assert.equal(feed(vad, 0.004, 300), "stop"); // passou de 1,1 s de silêncio
});

test("VAD: sem fala, desiste depois do prazo e diz 'no_speech'", () => {
  const vad = new VoiceActivity(DEFAULT_VAD);
  assert.equal(feed(vad, 0.003, 8000), "continue");
  assert.equal(feed(vad, 0.003, 1200), "no_speech");
  assert.equal(vad.heardSpeech, false);
});

test("VAD: zumbido constante vira piso de ruído (não 'fala') e a fala real ainda é detectada", () => {
  const vad = new VoiceActivity(DEFAULT_VAD);
  assert.equal(feed(vad, 0.02, 3000), "continue"); // ventilador a 2% desde o clique
  assert.equal(vad.heardSpeech, false, "o zumbido não pode contar como fala");
  assert.ok(vad.threshold > 0.02, `limiar ${vad.threshold} deveria subir acima do zumbido`);
  feed(vad, 0.2, 500);
  assert.equal(vad.heardSpeech, true);
  assert.equal(feed(vad, 0.02, 1200), "stop"); // e o zumbido depois da fala conta como silêncio
});

test("VAD: quem fala logo ao clicar (sem pausa) ainda é detectado", () => {
  const vad = new VoiceActivity(DEFAULT_VAD);
  feed(vad, 0.12, 2000); // fala desde o 1º bloco: o piso estimado é limitado a 3%
  assert.equal(vad.heardSpeech, true);
  assert.ok(vad.floor <= 0.03);
});

test("VAD: gravação longa demais é cortada em 30 s", () => {
  const vad = new VoiceActivity({ ...DEFAULT_VAD, maxMs: 2000 });
  assert.equal(feed(vad, 0.2, 2200), "max");
});

test("trimToSpeech: guarda 300 ms antes e 450 ms depois da fala", () => {
  const rate = 16_000;
  const samples = new Float32Array(rate * 6); // 6 s
  const out = trimToSpeech(samples, rate, [{ startMs: 2000, endMs: 3000 }]);
  assert.equal(out.length, Math.round(((3000 + 450) - (2000 - 300)) / 1000 * rate)); // 1,75 s
  assert.equal(trimToSpeech(samples, rate, []).length, samples.length); // sem fala: devolve tudo
});
