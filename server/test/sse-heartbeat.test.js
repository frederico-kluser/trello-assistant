import { test } from "node:test";
import assert from "node:assert/strict";
import { HEARTBEAT_FRAME, HEARTBEAT_INTERVAL_MS, startSseHeartbeat } from "../src/lib/sse-heartbeat.js";

/* ── Dublês ───────────────────────────────────────────────────────────── */

/** Timers falsos: nada de espera real, o teste avança o relógio na mão. */
function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  const cleared = [];
  return {
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      cleared.push(id);
      timers.delete(id);
    },
    /** Dispara todos os timers ativos `times` vezes. */
    tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        for (const timer of [...timers.values()]) timer.fn();
      }
    },
    pending: () => [...timers.values()],
    cleared,
  };
}

/** Resposta falsa: só as flags que a guarda de escrita consulta. */
function fakeRes(flags = {}) {
  return {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writable: true,
    chunks: [],
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
    ...flags,
  };
}

/** Coletor puro: conta e guarda o que o heartbeat escreveu. */
function recorder() {
  const chunks = [];
  return { chunks, write: (chunk) => chunks.push(chunk) };
}

/* ── Constantes ───────────────────────────────────────────────────────── */

test("HEARTBEAT_INTERVAL_MS é 15 s e o frame é o comentário `: ping`", () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 15_000);
  assert.equal(HEARTBEAT_FRAME, ": ping\n\n");
});

/* ── Ciclo de vida ────────────────────────────────────────────────────── */

test("escreve ': ping\\n\\n' a cada tick do intervalo, nada antes do primeiro", () => {
  const timers = fakeTimers();
  const out = recorder();
  const stop = startSseHeartbeat(fakeRes(), { write: out.write, setInterval: timers.setInterval, clearInterval: timers.clearInterval });

  assert.deepEqual(out.chunks, [], "nada é escrito antes do primeiro tick");
  timers.tick();
  assert.deepEqual(out.chunks, [": ping\n\n"]);
  timers.tick(2);
  assert.deepEqual(out.chunks, [": ping\n\n", ": ping\n\n", ": ping\n\n"], "um ping por tick");
  stop();
});

test("agenda no intervalo padrão (15 s) e respeita intervalMs injetado", () => {
  const padrao = fakeTimers();
  const stopPadrao = startSseHeartbeat(fakeRes(), { setInterval: padrao.setInterval, clearInterval: padrao.clearInterval });
  assert.deepEqual(padrao.pending().map((t) => t.ms), [15_000]);
  stopPadrao();

  const custom = fakeTimers();
  const stopCustom = startSseHeartbeat(fakeRes(), { intervalMs: 2_000, setInterval: custom.setInterval, clearInterval: custom.clearInterval });
  assert.deepEqual(custom.pending().map((t) => t.ms), [2_000]);
  stopCustom();
});

test("a escrita injetada recebe a string exata do frame", () => {
  const timers = fakeTimers();
  const out = recorder();
  const stop = startSseHeartbeat(fakeRes(), { write: out.write, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  timers.tick();
  assert.equal(out.chunks[0], ": ping\n\n");
  assert.equal(typeof out.chunks[0], "string");
  stop();
});

test("sem escrita injetada usa res.write", () => {
  const timers = fakeTimers();
  const res = fakeRes();
  const stop = startSseHeartbeat(res, { setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  timers.tick(2);
  assert.deepEqual(res.chunks, [": ping\n\n", ": ping\n\n"]);
  stop();
});

test("stop() para os pings e limpa o intervalo (não agenda mais nada)", () => {
  const timers = fakeTimers();
  const out = recorder();
  const stop = startSseHeartbeat(fakeRes(), { write: out.write, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  timers.tick();
  assert.equal(out.chunks.length, 1);

  stop();
  assert.equal(timers.pending().length, 0, "o timer foi cancelado");
  timers.tick(5);
  assert.equal(out.chunks.length, 1, "nenhum ping depois do stop");
});

test("stop() é idempotente: chamadas repetidas não relançam nem recancelam", () => {
  const timers = fakeTimers();
  const stop = startSseHeartbeat(fakeRes(), { setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  stop();
  assert.doesNotThrow(() => stop());
  stop();
  assert.equal(timers.cleared.length, 1, "um único clearInterval");
});

/* ── Guarda de escrita ────────────────────────────────────────────────── */

for (const flag of ["writableEnded", "writableFinished", "destroyed"]) {
  test(`guarda: com ${flag} não escreve mais (e não lança)`, () => {
    const timers = fakeTimers();
    const out = recorder();
    const res = fakeRes();
    const stop = startSseHeartbeat(res, { write: out.write, setInterval: timers.setInterval, clearInterval: timers.clearInterval });

    timers.tick();
    assert.equal(out.chunks.length, 1);
    res[flag] = true;
    assert.doesNotThrow(() => timers.tick(3));
    assert.equal(out.chunks.length, 1, `nada escrito com ${flag}`);
    stop();
  });
}

test("guarda: res.writable === false também bloqueia a escrita", () => {
  const timers = fakeTimers();
  const out = recorder();
  const res = fakeRes({ writable: false });
  const stop = startSseHeartbeat(res, { write: out.write, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  timers.tick(2);
  assert.deepEqual(out.chunks, []);
  stop();
});

/* ── Robustez ─────────────────────────────────────────────────────────── */

test("res inválido devolve um stop vazio, sem lançar e sem agendar timer", () => {
  for (const bad of [null, undefined, 42, "res", true, [], () => {}]) {
    const timers = fakeTimers();
    let stop;
    assert.doesNotThrow(() => {
      stop = startSseHeartbeat(bad, { setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    }, `res=${String(bad)}`);
    assert.equal(typeof stop, "function");
    assert.equal(timers.pending().length, 0);
    assert.doesNotThrow(() => stop());
  }
});

test("res sem write e sem escrita injetada é no-op silencioso", () => {
  const timers = fakeTimers();
  let stop;
  assert.doesNotThrow(() => {
    stop = startSseHeartbeat({ writableEnded: false }, { setInterval: timers.setInterval, clearInterval: timers.clearInterval });
  });
  assert.equal(timers.pending().length, 0);
  assert.doesNotThrow(() => stop());
});

test("escrita que lança (socket morto) não vaza erro no tick e o ping segue tentando", () => {
  const timers = fakeTimers();
  let calls = 0;
  const stop = startSseHeartbeat(fakeRes(), {
    write: () => {
      calls += 1;
      throw new Error("ERR_STREAM_DESTROYED");
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  assert.doesNotThrow(() => timers.tick(3));
  assert.equal(calls, 3, "tentou nos três ticks");
  stop();
});

test("intervalMs inválido cai no padrão de 15 s (nunca lança)", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "x", null]) {
    const timers = fakeTimers();
    const stop = startSseHeartbeat(fakeRes(), { intervalMs: bad, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    assert.deepEqual(timers.pending().map((t) => t.ms), [15_000], `intervalMs=${String(bad)}`);
    stop();
  }
});

/* ── Atomicidade do frame ─────────────────────────────────────────────── */

test("o ping não se mistura com um frame `data:`: cada write é uma unidade inteira", () => {
  const timers = fakeTimers();
  const res = fakeRes();
  const stop = startSseHeartbeat(res, { setInterval: timers.setInterval, clearInterval: timers.clearInterval });

  res.write(`data: ${JSON.stringify({ type: "jev", jev: { band: "auto" } })}\n\n`);
  timers.tick();
  res.write(`data: ${JSON.stringify({ type: "plan", speech: "ok" })}\n\n`);

  // Dois frames `data:` + um ping, cada um no seu próprio write.
  assert.deepEqual(res.chunks.length, 3);
  assert.ok(res.chunks[0].startsWith("data: {"));
  assert.equal(res.chunks[1], ": ping\n\n");
  assert.ok(res.chunks[2].startsWith("data: {"));
  assert.ok(res.chunks.every((chunk) => chunk.endsWith("\n\n")), "todo chunk fecha com linha em branco");
  assert.ok(!res.chunks.some((chunk) => chunk.includes("data:") && chunk.includes(": ping")), "nunca no mesmo chunk");
  stop();
});
