/**
 * Testes do STT (ZERO rede): o transporte OpenAI é sempre injetado por um stub
 * de globalThis.fetch — nenhuma chamada real e nenhuma leitura de .env (a config
 * é sobrescrita aqui e restaurada no fim).
 *
 * Foco: o piso de bytes POR FORMATO. O `< 1500 B` antigo recusava clipes
 * comprimidos legítimos (220 ms a 32 kbps ≈ 0,9 KB); o WAV mantém o piso alto.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";

const { config } = await import("../src/config.js");
const { COMPRESSED_MIN_BYTES, WAV_MIN_BYTES, minAudioBytes, extensionFor, transcribeAudio } = await import(
  "../src/services/stt.js"
);

const FAKE_KEY = "test-key-sem-rede";
const ORIGINAL = { ...config.openai };
const realFetch = globalThis.fetch;

after(() => {
  Object.assign(config.openai, ORIGINAL);
  globalThis.fetch = realFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(config.openai, ORIGINAL);
});

/** Cada teste começa com chave de mentira (nunca a do .env) e limite pequeno. */
function configure({ apiKey = FAKE_KEY, maxUploadBytes = 25 * 1024 * 1024 } = {}) {
  config.openai.apiKey = apiKey;
  config.openai.maxUploadBytes = maxUploadBytes;
}

/** Stub do transporte: registra o FormData e responde como a OpenAI. */
function stubFetch({ text = "criar card de teste", status = 200, body } = {}) {
  const calls = [];
  globalThis.fetch = (async (url, init = {}) => {
    calls.push({ url: String(url), init, form: init.body instanceof FormData ? init.body : null });
    const payload = body ?? { text };
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const bytes = (n) => new Uint8Array(n);

test("stt: piso de bytes é condicional ao formato (comprimido 400 B, WAV 1500 B)", () => {
  assert.equal(COMPRESSED_MIN_BYTES, 400);
  assert.equal(WAV_MIN_BYTES, 1500);
  assert.deepEqual(minAudioBytes("audio/webm", "gravacao.webm"), { min: 400, kind: "compressed" });
  assert.deepEqual(minAudioBytes("audio/webm;codecs=opus", "gravacao.webm"), { min: 400, kind: "compressed" });
  assert.deepEqual(minAudioBytes("audio/mp4", "gravacao.m4a"), { min: 400, kind: "compressed" });
  assert.deepEqual(minAudioBytes("audio/wav", "gravacao.wav"), { min: 1500, kind: "wav" });
  assert.deepEqual(minAudioBytes("audio/wav", ""), { min: 1500, kind: "wav" });
  assert.deepEqual(minAudioBytes("", "gravacao.webm"), { min: 400, kind: "compressed" }, "sem mime, a extensão decide");
  assert.deepEqual(minAudioBytes("", ""), { min: 1500, kind: "unknown" }, "sem informação, mantém o conservador");
});

test("stt: clipe webm de 1 KB passa o guard e chega à OpenAI como gravacao.webm", async () => {
  configure();
  const calls = stubFetch();
  const result = await transcribeAudio({
    buffer: bytes(1024),
    filename: "gravacao.webm",
    mimetype: "audio/webm;codecs=opus",
  });
  assert.equal(calls.length, 1, "o guard não pode barrar um clipe comprimido válido");
  assert.match(calls[0].url, /\/audio\/transcriptions$/);
  const file = calls[0].form.get("file");
  assert.equal(file.name, "gravacao.webm");
  assert.equal(file.type, "audio/webm;codecs=opus");
  assert.equal(file.size, 1024);
  assert.equal(calls[0].form.get("response_format"), "json");
  assert.equal(calls[0].form.get("language"), config.openai.language);
  assert.equal(result.text, "criar card de teste");
  assert.equal(result.provider, "openai");
  assert.equal(result.bytes, 1024);
});

test("stt: clipe mp4/AAC de 1 KB (iOS antigo) passa e vira gravacao.m4a", async () => {
  configure();
  const calls = stubFetch({ text: "ok" });
  await transcribeAudio({ buffer: bytes(1024), filename: "gravacao.m4a", mimetype: "audio/mp4" });
  assert.equal(calls[0].form.get("file").name, "gravacao.m4a");
  assert.equal(extensionFor("audio/mp4", "gravacao.m4a"), "m4a");
});

test("stt: clipe WAV de 1 KB continua rejeitado com 422 (piso herdado de 1500 B)", async () => {
  configure();
  const calls = stubFetch();
  await assert.rejects(
    transcribeAudio({ buffer: bytes(1024), filename: "gravacao.wav", mimetype: "audio/wav" }),
    (err) => err.status === 422 && err.code === "audio_too_short",
  );
  assert.equal(calls.length, 0, "nada pode sair para a rede");
});

test("stt: áudio vazio → 400 e nada na rede; sem chave → 503 (guardas intactos)", async () => {
  configure();
  const calls = stubFetch();
  await assert.rejects(transcribeAudio({ buffer: bytes(0), filename: "g.webm", mimetype: "audio/webm" }), (err) => err.status === 400 && err.code === "bad_request");
  await assert.rejects(transcribeAudio({ buffer: undefined, filename: "g.webm", mimetype: "audio/webm" }), (err) => err.status === 400);
  assert.equal(calls.length, 0);

  configure({ apiKey: "" });
  await assert.rejects(
    transcribeAudio({ buffer: bytes(2048), filename: "g.webm", mimetype: "audio/webm" }),
    (err) => err.status === 503 && err.code === "missing_openai_key",
  );
  assert.equal(calls.length, 0);
});

test("stt: acima do limite de upload → 413 antes de qualquer guarda de tamanho mínimo", async () => {
  configure({ maxUploadBytes: 1500 });
  const calls = stubFetch();
  await assert.rejects(
    transcribeAudio({ buffer: bytes(1501), filename: "g.webm", mimetype: "audio/webm" }),
    (err) => err.status === 413 && err.code === "upload_too_large",
  );
  assert.equal(calls.length, 0);
});

test("stt: transcrição vazia vira 422 stt_empty (não passa batido)", async () => {
  configure();
  stubFetch({ text: "   " });
  await assert.rejects(
    transcribeAudio({ buffer: bytes(2048), filename: "g.webm", mimetype: "audio/webm" }),
    (err) => err.status === 422 && err.code === "stt_empty",
  );
});

test("stt: mime fora de audio/video cai no padrão seguro (arquivo continua nomeado)", async () => {
  configure();
  const calls = stubFetch({ text: "ok" });
  await transcribeAudio({ buffer: bytes(2048), filename: "gravacao.m4a", mimetype: "application/octet-stream" });
  assert.equal(calls[0].form.get("file").type, "audio/webm", "mime não confiável vira o padrão do servidor");
  assert.equal(calls[0].form.get("file").name, "gravacao.webm");
});

test("stt: falha do provedor vira 502 stt_failed (sem vazar detalhe bruto)", async () => {
  configure();
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 401 });
  await assert.rejects(
    transcribeAudio({ buffer: bytes(2048), filename: "g.webm", mimetype: "audio/webm" }),
    (err) => err.status === 502 && err.code === "stt_failed",
  );
});
