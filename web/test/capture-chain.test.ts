/**
 * Testes da LIGAÇÃO da captura (node:test, sem React, sem navegador): um shim de
 * AudioContext/MediaRecorder prova o que o verifier reprovou no caminho real —
 * que qualquer falha DEPOIS do stream aberto derruba microfone e contexto antes
 * de rejeitar, e que um `onstop` que nunca chega não pendura o encerramento.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCaptureChain } from "../src/lib/capture-chain.ts";
import { RECORDER_STOP_TIMEOUT_MS, createCompressedRecorder, stopRecorder } from "../src/lib/recorder.ts";

const realMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
const realWorkletNode = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");

afterEach(() => {
  if (realMediaRecorder) Object.defineProperty(globalThis, "MediaRecorder", realMediaRecorder);
  else delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  if (realWorkletNode) Object.defineProperty(globalThis, "AudioWorkletNode", realWorkletNode);
  else delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
});

/* ── Shim de navegador ────────────────────────────────────────────────── */

interface Log {
  stoppedTracks: number;
  closedContexts: number;
  recorderStopCalls: number;
  disconnected: number;
}

/** AudioWorkletNode falso: o Node não tem esse global, então o teste o instala. */
class FakeWorkletNode {
  static created: FakeWorkletNode[] = [];
  port = { onmessage: null as ((event: { data: unknown }) => void) | null };
  connected = false;
  ctx: unknown;
  name: string;
  options: unknown;
  constructor(ctx: unknown, name: string, options: unknown) {
    this.ctx = ctx;
    this.name = name;
    this.options = options;
    FakeWorkletNode.created.push(this);
  }
  connect() {
    this.connected = true;
  }
  disconnect() {
    /* no-op */
  }
}

function installWorkletNode() {
  FakeWorkletNode.created = [];
  Object.defineProperty(globalThis, "AudioWorkletNode", { value: FakeWorkletNode, configurable: true, writable: true });
  return FakeWorkletNode.created;
}

/** MediaRecorder falso: controla quando o onstop chega (e se chega). */
function installFakeMediaRecorder({ fireOnStop = true }: { fireOnStop?: boolean } = {}) {
  const instances: FakeRecorder[] = [];
  class FakeRecorder {
    static isTypeSupported = (mime: string) => mime.startsWith("audio/webm");
    state = "inactive";
    mimeType = "";
    audioBitsPerSecond = 0;
    stream: unknown;
    chunks: Blob[] = [];
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    stopCalls = 0;
    constructor(stream: unknown, options: { mimeType: string; audioBitsPerSecond: number }) {
      this.stream = stream;
      this.mimeType = options.mimeType;
      this.audioBitsPerSecond = options.audioBitsPerSecond;
      instances.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.stopCalls += 1;
      if (fireOnStop) {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(64)], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    /** Usado pelo teste de timeout: entrega pedaços SEM fechar a gravação. */
    emit(data: Blob) {
      this.chunks.push(data);
      this.ondataavailable?.({ data });
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { value: FakeRecorder, configurable: true, writable: true });
  return instances;
}

function fakeStream(log: Log) {
  const track = {
    label: "fake-mic",
    stop() {
      log.stoppedTracks += 1;
    },
  };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

/** AudioContext falso: `workletThrows` e `connectThrows` reproduzem as falhas reais. */
function fakeContext(log: Log, { workletThrows = false, connectThrows = false, withWorklet = true } = {}) {
  const node = () => ({
    connect() {
      if (connectThrows) throw new Error("connect falhou");
    },
    disconnect() {
      log.disconnected += 1;
    },
  });
  const context = {
    sampleRate: 16_000,
    destination: node(),
    resume: async () => undefined,
    close: async () => {
      log.closedContexts += 1;
    },
    createMediaStreamSource: () => node(),
    createGain: () => ({ ...node(), gain: { value: 0 } }),
    createScriptProcessor: () => ({
      ...node(),
      onaudioprocess: null as unknown,
    }),
    ...(withWorklet
      ? {
          audioWorklet: {
            addModule: async () => {
              if (workletThrows) throw new Error("worklet falhou");
            },
          },
        }
      : {}),
  };
  return context as unknown as AudioContext;
}

function newLog(): Log {
  return { stoppedTracks: 0, closedContexts: 0, recorderStopCalls: 0, disconnected: 0 };
}

/** Simula o que o hook faz no catch: derruba recorder, stream e contexto. */
async function forcedTeardown(recorder: { stop: () => Promise<Blob> } | null, stream: MediaStream, ctx: AudioContext) {
  try {
    await recorder?.stop();
  } catch {
    /* já parado */
  }
  stream.getTracks().forEach((track) => track.stop());
  await ctx.close();
}

/* ── Cadeia de captura (o guard do start) ─────────────────────────────── */

test("captura: worklet saudável liga a cadeia e o recorder grava a MESMA stream", async () => {
  const log = newLog();
  const instances = installFakeMediaRecorder();
  const worklets = installWorkletNode();
  const stream = fakeStream(log);
  const ctx = fakeContext(log);

  const recorder = createCompressedRecorder(stream, { mime: "audio/webm;codecs=opus" });
  recorder.start();
  const chain = await createCaptureChain({ ctx, source: ctx.createMediaStreamSource(stream), workletUrl: "blob:x", onBlock: () => {} });

  assert.equal(chain.tap, "worklet", "com AudioWorkletNode disponível o caminho moderno é usado de verdade");
  assert.equal(worklets.length, 1);
  assert.equal(worklets[0].name, "pcm-capture");
  assert.equal(worklets[0].connected, true, "o tap foi ligado ao sink");
  assert.equal(chain.nodes.length, 2, "worklet + sink");
  assert.equal(instances[0].stream, stream, "MediaRecorder e VAD consomem a MESMA MediaStream");
  assert.equal(instances[0].audioBitsPerSecond, 32_000);
  assert.equal(recorder.recording, true);

  const blob = await recorder.stop();
  assert.equal(blob.type, "audio/webm;codecs=opus");
  assert.equal(log.stoppedTracks, 0, "nada derrubado no caminho feliz");
});

test("F2 (webm): worklet lança depois do recorder ligado → derruba tudo e rejeita", async () => {
  const log = newLog();
  const instances = installFakeMediaRecorder();
  const worklets = installWorkletNode();
  const stream = fakeStream(log);
  const ctx = fakeContext(log, { workletThrows: true, connectThrows: true });

  const recorder = createCompressedRecorder(stream, { mime: "audio/webm;codecs=opus" });
  recorder.start();

  await assert.rejects(
    async () => {
      try {
        await createCaptureChain({ ctx, source: ctx.createMediaStreamSource(stream), workletUrl: "blob:x", onBlock: () => {} });
      } catch (err) {
        await forcedTeardown(recorder, stream, ctx); // guard do start()
        throw err;
      }
    },
    /connect falhou/,
  );

  assert.equal(worklets.length, 0, "o addModule lançou antes de criar o nó");
  assert.equal(instances[0].stopCalls, 1, "recorder parado antes de rejeitar (flush do último pedaço)");
  assert.equal(recorder.recording, false);
  assert.equal(log.stoppedTracks, 1, "a track do microfone foi parada — sem mic vivo");
  assert.equal(log.closedContexts, 1, "o AudioContext foi fechado");
});

test("F2 (WAV): sem worklet o ScriptProcessor que lança no connect também derruba tudo", async () => {
  const log = newLog();
  const stream = fakeStream(log);
  const ctx = fakeContext(log, { withWorklet: false, connectThrows: true });

  await assert.rejects(
    async () => {
      try {
        await createCaptureChain({ ctx, source: ctx.createMediaStreamSource(stream), workletUrl: "blob:x", onBlock: () => {} });
      } catch (err) {
        await forcedTeardown(null, stream, ctx);
        throw err;
      }
    },
    /connect falhou/,
  );

  assert.equal(log.stoppedTracks, 1);
  assert.equal(log.closedContexts, 1);
});

test("F2: worklet que recusa vira fallback ScriptProcessor (não é erro fatal)", async () => {
  const log = newLog();
  const stream = fakeStream(log);
  const ctx = fakeContext(log, { workletThrows: true });

  const chain = await createCaptureChain({ ctx, source: ctx.createMediaStreamSource(stream), workletUrl: "blob:x", onBlock: () => {} });
  assert.equal(chain.tap, "script-processor");
  assert.equal(log.stoppedTracks, 0);
});

/* ── Encerramento que nunca pendura (o guard do stop) ─────────────────── */

test("F1: onstop que nunca chega → stopRecorder resolve no teto, força a parada e diz timedOut", async () => {
  const instances = installFakeMediaRecorder({ fireOnStop: false });
  const stream = fakeStream(newLog());
  const recorder = createCompressedRecorder(stream, { mime: "audio/webm;codecs=opus" });
  recorder.start();

  const started = Date.now();
  const { blob, timedOut, empty } = await stopRecorder(recorder, 25);
  const elapsed = Date.now() - started;

  assert.equal(timedOut, true, "o teto venceu — nada de espera infinita");
  assert.ok(elapsed < 1_000, `resolveu em ${elapsed} ms`);
  assert.equal(empty, true, "sem pedaço nenhum: o hook trata como falha, não como upload vazio");
  assert.equal(blob.size, 0);
  // Uma tentativa só: o stop() já levou o recorder para 'inactive', então a
  // força não repete o stop (repetir lançaria InvalidStateError no navegador).
  assert.equal(instances[0].stopCalls, 1);
  assert.equal(instances[0].state, "inactive");
  assert.equal(recorder.recording, false);
});

test("F1: pedaços que já chegaram são preservados quando o onstop trava", async () => {
  const instances = installFakeMediaRecorder({ fireOnStop: false });
  const stream = fakeStream(newLog());
  const recorder = createCompressedRecorder(stream, { mime: "audio/webm;codecs=opus" });
  recorder.start();
  instances[0].emit(new Blob([new Uint8Array(100)], { type: "audio/webm;codecs=opus" }));
  instances[0].emit(new Blob([new Uint8Array(50)], { type: "audio/webm;codecs=opus" }));
  assert.equal(recorder.hasChunks, true);

  const { blob, timedOut, empty } = await stopRecorder(recorder, 25);
  assert.equal(timedOut, true);
  assert.equal(empty, false);
  assert.equal(blob.size, 150, "o clipe já gravado não se perde");
  assert.equal(blob.type, "audio/webm;codecs=opus", "tipo pedido → upload nomeia gravacao.webm");
});

test("F1: depois do timeout o teardown derruba microfone e contexto (nada fica vivo)", async () => {
  const log = newLog();
  installFakeMediaRecorder({ fireOnStop: false });
  const stream = fakeStream(log);
  const ctx = fakeContext(log);
  const recorder = createCompressedRecorder(stream, { mime: "audio/webm;codecs=opus" });
  recorder.start();

  const { timedOut, empty } = await stopRecorder(recorder, 25);
  await forcedTeardown(recorder, stream, ctx); // o hook faz isto logo em seguida

  assert.equal(timedOut, true);
  assert.equal(empty, true);
  assert.equal(log.stoppedTracks, 1, "a track do microfone foi parada mesmo no timeout");
  assert.equal(log.closedContexts, 1, "o AudioContext foi fechado mesmo no timeout");
  assert.equal(recorder.recording, false);
});

test("F1: stop que rejeita também resolve (com os pedaços) em vez de estourar", async () => {
  const recorder = {
    stop: () => Promise.reject(new Error("stop explodiu")),
    forceStop: () => Promise.resolve(new Blob([new Uint8Array(10)], { type: "audio/mp4" })),
  };
  const { blob, timedOut, empty } = await stopRecorder(recorder, 25);
  assert.equal(timedOut, true);
  assert.equal(empty, false);
  assert.equal(blob.size, 10);
});

test("F1: o teto exportado é 2 s (o valor que o hook usa de verdade)", () => {
  assert.equal(RECORDER_STOP_TIMEOUT_MS, 2_000);
});

test("caminho feliz: onstop chega → stopRecorder marca timedOut=false e não força nada", async () => {
  const instances = installFakeMediaRecorder();
  const recorder = createCompressedRecorder(fakeStream(newLog()), { mime: "audio/webm;codecs=opus" });
  recorder.start();

  const { blob, timedOut, empty } = await stopRecorder(recorder, 1_000);
  assert.equal(timedOut, false);
  assert.equal(empty, false);
  assert.equal(blob.size, 64);
  assert.equal(instances[0].stopCalls, 1, "uma única parada: a força não foi usada");
  assert.equal(recorder.recording, false);
});
