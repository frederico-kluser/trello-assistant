/**
 * Testes do model-picker (ZERO rede): fetch sempre injetado.
 * Cobre pickBest (puro) e resolveChatModel (cache, TTL, fallback, robustez).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_MODEL = "auto";
process.env.OPENROUTER_MODEL_FALLBACK = "test/fallback-model";
process.env.OPENROUTER_MODEL_TTL_MINUTES = "30";
process.env.OPENROUTER_MAX_PROMPT_PRICE = "10";
process.env.OPENROUTER_MAX_COMPLETION_PRICE = "50";

const { config } = await import("../src/config.js");
const { pickBest, resolveChatModel, getResolvedModel, resetModelCache } = await import(
  "../src/services/model-picker.js"
);

const FALLBACK = "test/fallback-model";
const TTL_MS = 30 * 60_000;

/** Monta uma entrada no formato de GET /models. */
const model = ({ id, int, agentic, prompt, completion = "0.00001", context = 200000, inputs = ["text"] }) => ({
  id,
  context_length: context,
  architecture: { input_modalities: inputs, modality: `${inputs.join("+")}->text` },
  pricing: { prompt, completion },
  ...(int === undefined
    ? {}
    : {
        benchmarks: {
          artificial_analysis: {
            intelligence_index: int,
            ...(agentic === undefined ? {} : { agentic_index: agentic }),
          },
        },
      }),
});

/** Catálogo principal: vencedor esperado = vendor/smart-cheap (int 55). */
const CATALOG = [
  model({ id: "vendor/genius-pricy", int: 62, agentic: 50, prompt: "0.00005" }), // 50 USD/M > teto 10
  model({ id: "vendor/genius-pricy-output", int: 61, agentic: 50, prompt: "0.000001", completion: "0.0005" }),
  model({ id: "vendor/smart-cheap", int: 55, agentic: 40, prompt: "0.000003" }),
  model({ id: "vendor/free-smart", int: 50, prompt: "0", completion: "0" }),
  model({ id: "vendor/unbenchmarked", prompt: "0.0000001" }),
  model({ id: "vendor/vision-only", int: 99, prompt: "0.000001", inputs: ["image"] }),
  model({ id: "vendor/tiny-context", int: 98, prompt: "0.000001", context: 8000 }),
];

/** Variante de catálogo do Batch API: barata e "inteligente", mas não serve /chat/completions. */
const BATCH_VARIANT = model({ id: "vendor/genius-pricy:batch", int: 70, prompt: "0.000001" });

const okResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });
const idsOf = (models) => models.map((m) => m.id);

let clockOffset = 0;
const realNow = Date.now;
const withShiftedClock = (fn) => {
  Date.now = () => realNow() + clockOffset;
  try {
    return fn();
  } finally {
    Date.now = realNow;
    clockOffset = 0;
  }
};

test("config: OPENROUTER_MODEL aceita auto, reserva e TTL vêm do ambiente", () => {
  assert.equal(config.openrouter.model, "auto");
  assert.equal(config.openrouter.modelFallback, FALLBACK);
  assert.equal(config.openrouter.modelTtlMinutes, 30);
  assert.equal(config.openrouter.maxPromptPrice, 10);
  assert.equal(config.openrouter.maxCompletionPrice, 50);
});

test("config: TTL ausente ou inválido volta a 60 minutos", async () => {
  process.env.OPENROUTER_MODEL_TTL_MINUTES = "";
  const blank = await import("../src/config.js?ttl=blank");
  assert.equal(blank.config.openrouter.modelTtlMinutes, 60);
  process.env.OPENROUTER_MODEL_TTL_MINUTES = "abc";
  const invalid = await import("../src/config.js?ttl=invalid");
  assert.equal(invalid.config.openrouter.modelTtlMinutes, 60);
  delete process.env.OPENROUTER_MODEL_FALLBACK;
  const noFallback = await import("../src/config.js?fallback=default");
  assert.equal(noFallback.config.openrouter.modelFallback, "google/gemini-3.8-flash");
  assert.equal(noFallback.config.openrouter.model, "auto");
  process.env.OPENROUTER_MODEL_TTL_MINUTES = "30";
  process.env.OPENROUTER_MODEL_FALLBACK = FALLBACK;
});

test("pickBest: escolhe a maior inteligência dentro dos tetos", () => {
  const best = pickBest(CATALOG, { maxPromptPriceUsdPerMillion: 10, maxCompletionPriceUsdPerMillion: 50 });
  assert.equal(best?.id, "vendor/smart-cheap");
});

test("pickBest: exclui quem passa do teto de prompt", () => {
  // Só o teto de prompt vale: genius-pricy (50 USD/M) cai, genius-pricy-output (1 USD/M) fica.
  const best = pickBest(CATALOG, { maxPromptPriceUsdPerMillion: 10 });
  assert.equal(best?.id, "vendor/genius-pricy-output");
  const onlyPricey = pickBest([CATALOG[0]], { maxPromptPriceUsdPerMillion: 10 });
  assert.equal(onlyPricey, null);
});

test("pickBest: exclui quem passa do teto de completion", () => {
  // Só o teto de completion vale: genius-pricy-output (500 USD/M) cai, genius-pricy (10 USD/M) fica.
  const best = pickBest(CATALOG, { maxCompletionPriceUsdPerMillion: 50 });
  assert.equal(best?.id, "vendor/genius-pricy");
  assert.equal(pickBest([CATALOG[1]], { maxCompletionPriceUsdPerMillion: 50 }), null);
});

test("pickBest: teto inclui o valor exato do limite (<= teto)", () => {
  const exactly = model({ id: "vendor/exactly-ten", int: 55, prompt: "0.00001", completion: "0.00005" });
  const best = pickBest([exactly], { maxPromptPriceUsdPerMillion: 10, maxCompletionPriceUsdPerMillion: 50 });
  assert.equal(best?.id, "vendor/exactly-ten");
});

test("pickBest: mantém variante gratuita (pricing 0) dentro dos tetos", () => {
  const best = pickBest([CATALOG[3]], { maxPromptPriceUsdPerMillion: 10, maxCompletionPriceUsdPerMillion: 50 });
  assert.equal(best?.id, "vendor/free-smart");
});

test("pickBest: aceita tetos como string (valores vindos de env) e null", () => {
  assert.equal(pickBest([CATALOG[0]], { maxPromptPriceUsdPerMillion: "10" }), null);
  assert.equal(pickBest([CATALOG[2]], { maxPromptPriceUsdPerMillion: "10" })?.id, "vendor/smart-cheap");
  assert.equal(pickBest([CATALOG[2]], { maxPromptPriceUsdPerMillion: null })?.id, "vendor/smart-cheap");
  assert.equal(pickBest([CATALOG[2]], null)?.id, "vendor/smart-cheap");
});

test("pickBest: exclui modelos sem benchmark de inteligência", () => {
  assert.equal(pickBest([CATALOG[4]]), null);
});

test("pickBest: exclui modalidade sem texto na entrada", () => {
  assert.equal(pickBest([CATALOG[5]]), null);
  const audio = model({ id: "vendor/audio", int: 90, prompt: "0.000001", inputs: ["audio"] });
  assert.equal(pickBest([audio]), null);
});

test("pickBest: exclui contexto menor que o mínimo (32k por padrão)", () => {
  assert.equal(pickBest([CATALOG[6]]), null);
  const ok32k = model({ id: "vendor/ctx-32k", int: 10, prompt: "0.000001", context: 32000 });
  assert.equal(pickBest([ok32k])?.id, "vendor/ctx-32k");
  assert.equal(pickBest([ok32k], { minContextLength: 64000 }), null);
});

test("pickBest: filtros são um E lógico — reprovar em qualquer um elimina", () => {
  const failsTwo = model({ id: "vendor/bad", int: 99, prompt: "0.001", context: 4000, inputs: ["image"] });
  const failsPriceAndBenchmark = model({ id: "vendor/bad2", prompt: "0.001" });
  assert.equal(pickBest([failsTwo, failsPriceAndBenchmark], { maxPromptPriceUsdPerMillion: 10 }), null);
  const survives = model({ id: "vendor/good", int: 1, prompt: "0.000001" });
  assert.equal(pickBest([failsTwo, failsPriceAndBenchmark, survives], { maxPromptPriceUsdPerMillion: 10 })?.id, "vendor/good");
});

test("pickBest: empate de inteligência vai para o maior agentic_index", () => {
  const lowAgentic = model({ id: "vendor/a", int: 55, agentic: 10, prompt: "0.000001" });
  const highAgentic = model({ id: "vendor/b", int: 55, agentic: 45, prompt: "0.000009" });
  assert.equal(pickBest([lowAgentic, highAgentic])?.id, "vendor/b");
});

test("pickBest: empate de inteligência e agentic vai para o menor pricing.prompt", () => {
  const pricey = model({ id: "vendor/pricey", int: 55, agentic: 40, prompt: "0.000009" });
  const cheap = model({ id: "vendor/cheap", int: 55, agentic: 40, prompt: "0.000001" });
  assert.equal(pickBest([pricey, cheap])?.id, "vendor/cheap");
});

test("pickBest: aguenta entradas malformadas sem lançar", () => {
  assert.equal(pickBest(undefined), null);
  assert.equal(pickBest("nao é lista"), null);
  assert.equal(pickBest([null, {}, { id: 42 }, { architecture: {}, pricing: {} }]), null);
  assert.equal(pickBest([]), null);
});

test("resolveChatModel: id fixo vence a descoberta (source pinned, sem fetch)", async () => {
  resetModelCache();
  config.openrouter.model = "vendor/pinned-model";
  let calls = 0;
  const resolved = await resolveChatModel({
    fetchImpl: async () => {
      calls += 1;
      return okResponse({ data: CATALOG });
    },
  });
  assert.deepEqual(resolved, { modelId: "vendor/pinned-model", source: "pinned" });
  assert.equal(calls, 0);
  assert.equal(getResolvedModel()?.source, "pinned");
  config.openrouter.model = "auto";
});

test("resolveChatModel: auto escolhe o melhor elegível do catálogo", async () => {
  resetModelCache();
  const resolved = await resolveChatModel({ fetchImpl: async () => okResponse({ data: CATALOG }) });
  assert.deepEqual(resolved, { modelId: "vendor/smart-cheap", source: "auto" });
  assert.equal(getResolvedModel()?.modelId, "vendor/smart-cheap");
});

test("resolveChatModel: descarta variantes de Batch API (:batch) na descoberta", async () => {
  resetModelCache();
  const withBatch = [...CATALOG, BATCH_VARIANT];
  assert.equal(pickBest(withBatch)?.id, "vendor/genius-pricy:batch"); // pickBest puro não filtra sufixo
  const resolved = await resolveChatModel({ fetchImpl: async () => okResponse({ data: withBatch }) });
  assert.equal(resolved.modelId, "vendor/smart-cheap");
});

test("resolveChatModel: cache — a segunda chamada não faz fetch", async () => {
  resetModelCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse({ data: CATALOG });
  };
  await resolveChatModel({ fetchImpl });
  const second = await resolveChatModel({ fetchImpl });
  assert.equal(calls, 1);
  assert.equal(second.modelId, "vendor/smart-cheap");
  const forced = await resolveChatModel({ fetchImpl, force: true });
  assert.equal(calls, 2);
  assert.equal(forced.modelId, "vendor/smart-cheap");
});

test("resolveChatModel: TTL expira e a próxima chamada refaz o fetch", async () => {
  resetModelCache();
  let calls = 0;
  let catalog = CATALOG;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse({ data: catalog });
  };
  await resolveChatModel({ fetchImpl });
  assert.equal(calls, 1);

  catalog = [...CATALOG, model({ id: "vendor/new-genius", int: 80, agentic: 60, prompt: "0.000002" })];
  clockOffset = TTL_MS - 1_000; // ainda dentro do TTL
  const cached = await withShiftedClock(() => resolveChatModel({ fetchImpl }));
  assert.equal(calls, 1);
  assert.equal(cached.modelId, "vendor/smart-cheap");

  clockOffset = TTL_MS + 1_000; // expirou
  const fresh = await withShiftedClock(() => resolveChatModel({ fetchImpl }));
  assert.equal(calls, 2);
  assert.equal(fresh.modelId, "vendor/new-genius");
});

test("resolveChatModel: falha de rede (HTTP 500) → reserva, com motivo", async () => {
  resetModelCache();
  const resolved = await resolveChatModel({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(resolved.modelId, FALLBACK);
  assert.equal(resolved.source, "fallback");
  assert.match(resolved.reason, /500/);
  assert.equal(getResolvedModel()?.source, "fallback");
});

test("resolveChatModel: fetch que lança → reserva e exatamente 1 retry", async () => {
  resetModelCache();
  let calls = 0;
  const resolved = await resolveChatModel({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("ENOTFOUND openrouter.ai");
    },
  });
  assert.equal(calls, 2);
  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.modelId, FALLBACK);
  assert.match(resolved.reason, /ENOTFOUND/);
});

test("resolveChatModel: catálogo vazio/nada elegível → reserva", async () => {
  resetModelCache();
  const empty = await resolveChatModel({ fetchImpl: async () => okResponse({ data: [] }) });
  assert.equal(empty.source, "fallback");
  assert.match(empty.reason, /nenhum modelo elegível/);

  resetModelCache();
  const nothingEligible = await resolveChatModel({
    fetchImpl: async () => okResponse({ data: [CATALOG[5], CATALOG[6], CATALOG[4]] }),
  });
  assert.equal(nothingEligible.source, "fallback");
});

test("resolveChatModel: payload malformado nunca lança", async () => {
  resetModelCache();
  const payloads = [
    async () => okResponse({ data: "nope" }),
    async () => okResponse({ models: [] }),
    async () => okResponse(null),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } }),
    async () => null,
  ];
  for (const fetchImpl of payloads) {
    resetModelCache();
    const resolved = await resolveChatModel({ fetchImpl });
    assert.equal(resolved.source, "fallback");
    assert.equal(resolved.modelId, FALLBACK);
    assert.ok(resolved.reason.length > 0);
  }
});

test("resolveChatModel: aceita lista crua (array) e passa AbortSignal de timeout", async () => {
  resetModelCache();
  let seenSignal = null;
  const resolved = await resolveChatModel({
    fetchImpl: async (url, options) => {
      seenSignal = options?.signal;
      assert.match(url, /\/models$/);
      return okResponse(CATALOG);
    },
  });
  assert.equal(resolved.modelId, "vendor/smart-cheap");
  assert.ok(seenSignal instanceof AbortSignal);
});

test("resetModelCache: limpa cache e último resultado", async () => {
  resetModelCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse({ data: CATALOG });
  };
  await resolveChatModel({ fetchImpl });
  assert.ok(getResolvedModel());
  resetModelCache();
  assert.equal(getResolvedModel(), null);
  await resolveChatModel({ fetchImpl });
  assert.equal(calls, 2);
});
