import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, SSE_IDLE_TIMEOUT_MS, SSE_MAX_RETRIES, STT_TIMEOUT_MS, api } from "../src/lib/api.ts";
import type { AgentEvent, AgentNetRetry, AgentStreamOptions } from "../src/lib/api.ts";

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Payload do servidor (mesmo formato no SSE e no JSON simples de `/api/agent`). */
const PLAN = {
  speech: "Criei o card.",
  needsConfirmation: false,
  actions: [],
  provider: "llm",
  model: null,
  band: null,
  warning: null,
  listing: [],
  search: null,
  trace: {},
};
const PLAN_EVENT = { type: "plan", ...PLAN };
const SESSION = { sessionId: "s-1", history: [] };
const noop = () => undefined;

const frame = (event: unknown) => `data: ${JSON.stringify(event)}`;
const PING = ": ping"; // heartbeat de comentário: não é evento nem fim de fluxo

type FetchCall = { url: string; init: RequestInit; body: unknown };

/** Troca o `fetch` global; cada chamada fica registada para contar tentativas e comparar corpos. */
function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {}, body: init?.body ?? null };
    calls.push(call);
    // Como o fetch real: falha vira rejeição, nunca exceção síncrona.
    return Promise.resolve().then(() => handler(call));
  }) as typeof globalThis.fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const sseResponse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

/** Fluxo que entrega as molduras e fecha (o caso feliz). */
function streamOf(frames: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of frames) controller.enqueue(encoder.encode(item));
      controller.close();
    },
  });
}

/** Fluxo que abre e fica MUDO: só morre quando o AbortSignal da requisição dispara (como o fetch real). */
function silentBody(signal?: AbortSignal | null) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const kill = () => controller.error(new DOMException("The operation was aborted.", "AbortError"));
      if (signal?.aborted) kill();
      else signal?.addEventListener("abort", kill, { once: true });
    },
  });
}

/** Fluxo que pinga as molduras de `everyMs` em `everyMs` e fecha no fim. */
function dripBody(signal: AbortSignal | null | undefined, frames: string[], everyMs: number) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const kill = () => {
        try {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        } catch {
          /* já fechado */
        }
      };
      signal?.addEventListener("abort", kill, { once: true });
      try {
        for (const item of frames) {
          await sleep(everyMs);
          if (signal?.aborted) return;
          controller.enqueue(encoder.encode(item));
        }
        controller.close();
      } catch {
        /* fluxo já fechado pelo abort */
      }
      signal?.removeEventListener("abort", kill);
    },
  });
}

/** Fluxo que entrega a 1ª moldura e depois CAI no meio da leitura (2º read rejeita). */
function breakingBody() {
  let step = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      step += 1;
      if (step === 1) controller.enqueue(encoder.encode(`${frame({ type: "jev", jev: null })}\n\n`));
      else controller.error(new TypeError("network error"));
    },
  });
}

const blobOf = (type: string) => new Blob([new Uint8Array([1, 2, 3])], { type });

test("contrato: prazos e teto de repetições do SSE", () => {
  assert.equal(SSE_IDLE_TIMEOUT_MS, 45_000);
  assert.equal(SSE_MAX_RETRIES, 2); // ≤ 3 tentativas de SSE
  assert.equal(STT_TIMEOUT_MS, 150_000); // acima do pior caso do servidor (60 s + retry interno)
});

test("SSE: fluxo mudo estoura o idle-timeout, repete 2× e o fallback JSON devolve o plano", async () => {
  const events: AgentEvent[] = [];
  const retries: AgentNetRetry[] = [];
  const { calls, restore } = stubFetch((call) =>
    call.url.includes("stream=1") ? sseResponse(silentBody(call.init.signal)) : jsonResponse(PLAN),
  );

  try {
    const plan = await api.agent("cria um card", {}, (event) => events.push(event), SESSION, {
      idleTimeoutMs: 20,
      retryDelayMs: 0,
      onNetRetry: (info) => retries.push(info),
    });
    assert.deepEqual(plan, PLAN_EVENT); // entrou pelo mesmo caminho de eventos (applyEvent)
  } finally {
    restore();
  }

  // 3 tentativas de SSE (1 + SSE_MAX_RETRIES) e a última sem `?stream=1`.
  assert.deepEqual(
    calls.map((call) => call.url),
    ["/api/agent?stream=1", "/api/agent?stream=1", "/api/agent?stream=1", "/api/agent"],
  );
  assert.equal(calls[3].init.method, "POST");
  assert.deepEqual(calls[3].body, calls[0].body); // o MESMO corpo, só sem `?stream=1`
  assert.deepEqual(retries, [
    { attempt: 1, reason: "idle", fallback: false },
    { attempt: 2, reason: "idle", fallback: false },
    { attempt: 3, reason: "idle", fallback: true },
  ]);
  assert.deepEqual(events, []); // o payload simples não traz eventos intermediários
});

test("SSE: eventos pingados dentro da janela (com heartbeat) rearmam o watchdog e NÃO abortam", async () => {
  const events: AgentEvent[] = [];
  const frames = [
    `${PING}\n\n`,
    `${frame({ type: "jev", jev: { intent: "create" } })}\n\n`,
    `${PING}\n\n`,
    `${frame({ type: "jev", jev: null })}\n\n`,
    `${frame(PLAN_EVENT)}\n\n`,
  ];
  const { calls, restore } = stubFetch((call) => sseResponse(dripBody(call.init.signal, frames, 20)));

  try {
    const plan = await api.agent("cria", {}, (event) => events.push(event), SESSION, { idleTimeoutMs: 150, retryDelayMs: 0 });
    assert.equal(plan.speech, PLAN.speech);
  } finally {
    restore();
  }

  assert.equal(calls.length, 1); // nenhuma repetição: o silêncio nunca chegou perto de 150 ms
  assert.equal(events.length, 2); // os dois vereditos do JEV chegaram no meio
});

test("SSE: queda no meio da leitura repete a MESMA chamada e vence na 2ª tentativa", async () => {
  const events: AgentEvent[] = [];
  let attempt = 0;
  const { calls, restore } = stubFetch(() => {
    attempt += 1;
    return attempt === 1
      ? sseResponse(breakingBody())
      : sseResponse(streamOf([`${frame({ type: "jev", jev: null })}\n\n`, `${frame(PLAN_EVENT)}\n\n`]));
  });

  try {
    const plan = await api.agent("cria", {}, (event) => events.push(event), SESSION, { idleTimeoutMs: 500, retryDelayMs: 0 });
    assert.equal(plan.speech, PLAN.speech);
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url), ["/api/agent?stream=1", "/api/agent?stream=1"]);
  assert.equal(events.length, 2); // o evento da tentativa cortada repete-se: o App só reescreve o estado
});

test("SSE: molduras de comentário (`: ping`) são ignoradas — não são erro nem fim de fluxo", async () => {
  const events: AgentEvent[] = [];
  const { calls, restore } = stubFetch(() =>
    sseResponse(streamOf([`${PING}\n\n`, `${PING}\n\n`, `${frame({ type: "jev", jev: null })}\n\n`, `${PING}\n\n`, `${frame(PLAN_EVENT)}\n\n`])),
  );

  try {
    const plan = await api.agent("cria", {}, (event) => events.push(event), SESSION, { idleTimeoutMs: 500, retryDelayMs: 0 });
    assert.equal(plan.speech, PLAN.speech);
  } finally {
    restore();
  }

  assert.equal(calls.length, 1); // comentário não é tratado como fim de fluxo (nem como plano)
  assert.equal(events.length, 1);
});

test("SSE: fluxo que fecha SEM plano conta como tentativa falhada e o fallback salva o comando", async () => {
  const retries: AgentNetRetry[] = [];
  const { calls, restore } = stubFetch((call) =>
    call.url.includes("stream=1") ? sseResponse(streamOf([`${PING}\n\n`])) : jsonResponse(PLAN),
  );

  try {
    const plan = await api.agent("cria", {}, noop, SESSION, { idleTimeoutMs: 500, retryDelayMs: 0, onNetRetry: (info) => retries.push(info) });
    assert.equal(plan.speech, PLAN.speech);
  } finally {
    restore();
  }

  assert.equal(calls.length, 4);
  assert.deepEqual(retries.map((info) => info.reason), ["empty", "empty", "empty"]);
});

test("SSE: falha de rede nas 3 tentativas e no fallback mantém a forma de erro já conhecida", async () => {
  const { calls, restore } = stubFetch(() => {
    throw new TypeError("Failed to fetch");
  });

  let caught: unknown;
  try {
    await api.agent("cria", {}, noop, SESSION, { idleTimeoutMs: 500, retryDelayMs: 0 });
  } catch (err) {
    caught = err;
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "network_error");
  assert.equal((caught as ApiError).hint, null); // queda declarada, não silêncio
  assert.equal(calls.length, 4); // 3 SSE + 1 JSON, todas na rede
});

test("SSE: tudo em silêncio e fallback também caindo → ApiError com dica de silêncio", async () => {
  const { restore } = stubFetch((call) => {
    if (call.url.includes("stream=1")) return sseResponse(silentBody(call.init.signal));
    throw new TypeError("Failed to fetch");
  });

  let caught: unknown;
  try {
    await api.agent("cria", {}, noop, SESSION, { idleTimeoutMs: 20, retryDelayMs: 0 });
  } catch (err) {
    caught = err;
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "network_error");
  assert.match((caught as ApiError).hint ?? "", /sem responder/);
});

test("SSE: sem plano nas 3 tentativas e fallback fora do ar ainda reporta `empty_stream`", async () => {
  const { restore } = stubFetch((call) =>
    call.url.includes("stream=1") ? sseResponse(streamOf([`${PING}\n\n`])) : Promise.reject(new TypeError("Failed to fetch")),
  );

  let caught: unknown;
  try {
    await api.agent("cria", {}, noop, SESSION, { idleTimeoutMs: 500, retryDelayMs: 0 });
  } catch (err) {
    caught = err;
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "empty_stream");
});

test("SSE: HTTP de erro do servidor não se repete (nem cai no fallback)", async () => {
  const { calls, restore } = stubFetch(() => jsonResponse({ error: { code: "bad_request", message: "Envie o comando." } }, 400));

  let caught: unknown;
  try {
    await api.agent("", {}, noop, SESSION, { idleTimeoutMs: 500, retryDelayMs: 0 });
  } catch (err) {
    caught = err;
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "bad_request");
  assert.equal(calls.length, 1);
});

test("STT: falha de rede repete UMA vez (2 fetch) e a 2ª vence", async () => {
  let attempt = 0;
  const { calls, restore } = stubFetch(() => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("Failed to fetch");
    return jsonResponse({ text: "cria um card", provider: "openai", model: "whisper-1", ms: 900 });
  });

  try {
    const out = await api.stt(blobOf("audio/webm;codecs=opus"), { retryDelayMs: 0 });
    assert.deepEqual(out, { text: "cria um card", provider: "openai", model: "whisper-1", ms: 900 });
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url), ["/api/stt", "/api/stt"]);
});

test("STT: HTTP 500 NÃO se repete (o servidor já repetiu a OpenAI) e o erro sobe", async () => {
  const { calls, restore } = stubFetch(() => jsonResponse({ error: { code: "stt_failed", message: "Não consegui transcrever." } }, 500));

  let caught: unknown;
  try {
    await api.stt(blobOf("audio/wav"), { retryDelayMs: 0 });
  } catch (err) {
    caught = err;
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "stt_failed");
  assert.equal((caught as ApiError).message, "Não consegui transcrever.");
  assert.equal(calls.length, 1);
});

test("STT: o nome do ficheiro no multipart segue o tipo do blob", async () => {
  const names: string[] = [];
  const { restore } = stubFetch((call) => {
    names.push(((call.body as FormData).get("audio") as File).name);
    return jsonResponse({ text: "ok", provider: "openai", model: "whisper-1", ms: 1 });
  });

  try {
    await api.stt(blobOf("audio/webm;codecs=opus"), { retryDelayMs: 0 });
    await api.stt(blobOf("audio/mp4"), { retryDelayMs: 0 });
    await api.stt(blobOf(""), { retryDelayMs: 0 });
    await api.stt(blobOf("audio/wav"), { retryDelayMs: 0 });
  } finally {
    restore();
  }

  assert.deepEqual(names, ["gravacao.webm", "gravacao.m4a", "gravacao.wav", "gravacao.wav"]);
});

/* ── Reparação 1: validação do fallback, defeitos locais, callback e prazo do fallback ── */

/** Servidor que aceita a ligação e NUNCA responde: só morre no abort (como o fetch real). */
function hanging(signal?: AbortSignal | null) {
  return new Promise<Response>((_, reject) => {
    const kill = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });
  });
}

const agentOptions = (extra: AgentStreamOptions = {}): AgentStreamOptions => ({
  idleTimeoutMs: 20,
  retryDelayMs: 0,
  fallbackTimeoutMs: 300,
  ...extra,
});

/** Corre o agente com as opções rápidas e devolve o erro (ou `undefined` se voltou plano). */
async function catchAgent(onEvent: (event: AgentEvent) => void = noop, extra: AgentStreamOptions = {}) {
  let caught: unknown;
  try {
    await api.agent("cria um card", {}, onEvent, SESSION, agentOptions(extra));
  } catch (err) {
    caught = err;
  }
  return caught;
}

test("F1: fallback 200 com `{}` NÃO vira plano — empty_stream", async () => {
  const seen: AgentEvent[] = [];
  const { calls, restore } = stubFetch((call) => (call.url.includes("stream=1") ? sseResponse(silentBody(call.init.signal)) : jsonResponse({})));

  let caught: unknown;
  try {
    caught = await catchAgent((event) => seen.push(event));
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "empty_stream");
  assert.deepEqual(seen, []); // o `{}` não foi emitido como se fosse evento
  assert.equal(calls.length, 4);
});

test('F1: fallback com `type: "error"` devolve o erro do servidor, nunca um plano', async () => {
  const seen: AgentEvent[] = [];
  const { restore } = stubFetch((call) =>
    call.url.includes("stream=1")
      ? sseResponse(streamOf([`${PING}\n\n`]))
      : jsonResponse({ type: "error", error: { code: "llm_down", message: "O planejador caiu." } }),
  );

  let caught: unknown;
  try {
    caught = await catchAgent((event) => seen.push(event));
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "llm_down");
  assert.equal((caught as ApiError).message, "O planejador caiu.");
  assert.deepEqual(seen, []);
});

test("F2: `onEvent` que estoura é defeito LOCAL — definitivo, 1 fetch, sem repetir", async () => {
  const { calls, restore } = stubFetch(() =>
    sseResponse(streamOf([`${frame({ type: "jev", jev: null })}\n\n`, `${frame(PLAN_EVENT)}\n\n`])),
  );

  let caught: unknown;
  try {
    caught = await catchAgent(() => {
      throw new Error("listener bugado");
    });
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "sse_listener_error");
  assert.match((caught as ApiError).message, /listener bugado/);
  assert.equal(calls.length, 1); // não gastou 4 ciclos de planejamento no servidor
});

test("F2: frame `data:` ilegível é defeito local — definitivo, 1 fetch, sem fallback", async () => {
  const malformed = `${frame({ type: "jev", jev: null }).slice(0, -1)}\n\n`; // JSON partido (sem a chave final)
  const { calls, restore } = stubFetch(() => sseResponse(streamOf([malformed])));

  let caught: unknown;
  try {
    caught = await catchAgent();
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "sse_parse_error");
  assert.equal(calls.length, 1);
});

test("F3: `onNetRetry` que estoura não mata a cadeia — o plano volta", async () => {
  const { calls, restore } = stubFetch((call) => (call.url.includes("stream=1") ? sseResponse(silentBody(call.init.signal)) : jsonResponse(PLAN)));

  let plan: Awaited<ReturnType<typeof api.agent>> | null = null;
  let caught: unknown;
  try {
    plan = await api.agent("cria", {}, noop, SESSION, {
      ...agentOptions(),
      onNetRetry: () => {
        throw new Error("callback bugado");
      },
    });
  } catch (err) {
    caught = err;
  } finally {
    restore();
  }

  assert.equal(caught, undefined);
  assert.equal(plan?.speech, PLAN.speech);
  assert.equal(calls.length, 4); // 3 SSE + fallback: a cadeia correu até ao fim
});

test("F4: fallback que aceita e nunca responde bate no prazo → empty_stream, sem repetir o fallback", async () => {
  const { calls, restore } = stubFetch((call) => (call.url.includes("stream=1") ? sseResponse(silentBody(call.init.signal)) : hanging(call.init.signal)));

  let caught: unknown;
  try {
    caught = await catchAgent(noop, { fallbackTimeoutMs: 30 });
  } finally {
    restore();
  }

  assert.ok(caught instanceof ApiError);
  assert.equal((caught as ApiError).code, "empty_stream"); // cadeia esgotada
  assert.equal(calls.length, 4); // 3 SSE + 1 JSON
  assert.equal(calls.filter((call) => !call.url.includes("stream=1")).length, 1); // o fallback não se repete
});

test("SSE: plano que já chegou sobrevive a uma queda logo depois (1 fetch, sem repetir)", async () => {
  let step = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      step += 1;
      if (step === 1) controller.enqueue(encoder.encode(`${frame(PLAN_EVENT)}\n\n`));
      else controller.error(new TypeError("network error"));
    },
  });
  const { calls, restore } = stubFetch(() => sseResponse(body));

  let plan: Awaited<ReturnType<typeof api.agent>> | null = null;
  try {
    // 4 argumentos, sem options: a assinatura pública antiga continua a valer.
    plan = await api.agent("cria", {}, noop, SESSION);
  } finally {
    restore();
  }

  assert.equal(plan?.speech, PLAN.speech);
  assert.equal(calls.length, 1);
});
