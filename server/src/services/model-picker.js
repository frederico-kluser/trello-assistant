/**
 * Escolha do "melhor modelo" (a voz do assistente) no OpenRouter.
 *
 * `OPENROUTER_MODEL` aceita três estados:
 *   - um id fixo (ex.: `google/gemini-3.8-flash`) → usado como está (source `pinned`);
 *   - `auto` (padrão de fábrica) → descoberta dinâmica em `GET /models` (source `auto`);
 *   - qualquer falha na descoberta → `OPENROUTER_MODEL_FALLBACK` (source `fallback`).
 *
 * Este módulo NUNCA lança: o pior caso é devolver o modelo de reserva com um
 * motivo curto. A escolha fica em cache por `OPENROUTER_MODEL_TTL_MINUTES`.
 *
 * Guardrails: os MESMOS tetos de preço que o resto do app já usa
 * (`OPENROUTER_MAX_PROMPT_PRICE` / `OPENROUTER_MAX_COMPLETION_PRICE`), na mesma
 * unidade documentada — USD por 1M de tokens (a API devolve USD por token em
 * `pricing.prompt`/`pricing.completion`, strings; multiplicamos por 1e6).
 */
import { config } from "../config.js";

const MODELS_PATH = "/models";
/** Downloads do catálogo: 10 s por tentativa, 1 retry. */
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_ATTEMPTS = 2;
const DEFAULT_MIN_CONTEXT_LENGTH = 32_000;
const DEFAULT_TTL_MINUTES = 60;
/** Sufixos de variante de catálogo que NÃO servem `/chat/completions`. */
const NON_CHAT_SUFFIXES = [":batch"];

/** Cache do último resultado `auto` (TTL) e último resultado resolvido. */
let cache = null; // { modelId, at, expiresAt }
let lastResolved = null; // { modelId, source, reason? }

const clean = (value) => (typeof value === "string" ? value.trim() : "");

function modelsUrl() {
  const base = clean(config.openrouter.baseUrl) || "https://openrouter.ai/api/v1";
  return `${base.replace(/\/+$/, "")}${MODELS_PATH}`;
}

/** Número tolerante ("10", 10 → 10; null, "", "abc" → null). */
const finite = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

/** USD por token (string) → USD por 1M de tokens; null quando ausente/inválido. */
function pricePerMillion(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n * 1e6 : null;
}

/** O modelo aceita texto na entrada? (`architecture.input_modalities` / `modality`) */
function hasTextInput(entry) {
  const arch = entry?.architecture;
  if (!arch) return false;
  if (Array.isArray(arch.input_modalities)) {
    return arch.input_modalities.some((m) => clean(String(m)).toLowerCase() === "text");
  }
  const modality = clean(arch.modality);
  if (!modality) return false;
  const [input] = modality.split("->");
  return input.split("+").some((part) => part.trim().toLowerCase() === "text");
}

const intelligenceIndex = (entry) => {
  const n = Number(entry?.benchmarks?.artificial_analysis?.intelligence_index);
  return Number.isFinite(n) ? n : null;
};
const agenticIndex = (entry) => {
  const n = Number(entry?.benchmarks?.artificial_analysis?.agentic_index);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
};

/** Variantes de catálogo do Batch API (`:batch`) não são atendidas no chat. */
function isChatRoutable(entry) {
  const id = clean(entry?.id);
  return Boolean(id) && !NON_CHAT_SUFFIXES.some((suffix) => id.endsWith(suffix));
}

/**
 * Escolhe o melhor modelo da lista (puro, sem I/O).
 * Mantém entradas com entrada de texto, contexto >= minContextLength, dentro dos
 * tetos de preço (quando definidos) e COM benchmark de inteligência; ordena por
 * inteligência DESC, empate por agentic_index DESC e depois pricing.prompt ASC.
 * @returns {object|null} a entrada vencedora (objeto original) ou null.
 */
export function pickBest(models, guardrails = {}) {
  const list = Array.isArray(models) ? models : [];
  const {
    maxPromptPriceUsdPerMillion = null,
    maxCompletionPriceUsdPerMillion = null,
    minContextLength = DEFAULT_MIN_CONTEXT_LENGTH,
  } = guardrails ?? {};
  const minContext = finite(minContextLength) ?? DEFAULT_MIN_CONTEXT_LENGTH;
  const promptCeiling = finite(maxPromptPriceUsdPerMillion);
  const completionCeiling = finite(maxCompletionPriceUsdPerMillion);

  const eligible = [];
  for (const entry of list) {
    if (!hasTextInput(entry)) continue;
    const context = Number(entry?.context_length);
    if (!Number.isFinite(context) || context < minContext) continue;
    const promptPrice = pricePerMillion(entry?.pricing?.prompt);
    const completionPrice = pricePerMillion(entry?.pricing?.completion);
    if (promptCeiling !== null && (promptPrice === null || promptPrice > promptCeiling)) continue;
    if (completionCeiling !== null && (completionPrice === null || completionPrice > completionCeiling)) continue;
    const intelligence = intelligenceIndex(entry);
    if (intelligence === null) continue;
    eligible.push({ entry, intelligence, promptPrice });
  }
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (b.intelligence !== a.intelligence) return b.intelligence - a.intelligence;
    const agentic = agenticIndex(b.entry) - agenticIndex(a.entry);
    if (Number.isFinite(agentic) && agentic !== 0) return agentic;
    return (a.promptPrice ?? Number.POSITIVE_INFINITY) - (b.promptPrice ?? Number.POSITIVE_INFINITY);
  });
  return eligible[0].entry;
}

/** Teto de preço configurado (mesma leitura do resto do app: USD por 1M de tokens). */
function configGuardrails() {
  return {
    maxPromptPriceUsdPerMillion: config.openrouter.maxPromptPrice ?? null,
    maxCompletionPriceUsdPerMillion: config.openrouter.maxCompletionPrice ?? null,
    minContextLength: DEFAULT_MIN_CONTEXT_LENGTH,
  };
}

function ttlMs() {
  const minutes = Number(config.openrouter.modelTtlMinutes);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TTL_MINUTES;
  return safe * 60_000;
}

function fallbackModelId() {
  const id = clean(config.openrouter.modelFallback);
  return id || "google/gemini-3.8-flash";
}

function shortReason(error) {
  const message = error?.name === "AbortError" ? "timeout" : clean(error?.message) || "falha na descoberta";
  return message.slice(0, 120);
}

/** Baixa o catálogo com timeout e devolve o array de modelos (lança em falha). */
async function fetchModels(fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const response = await fetchImpl(modelsUrl(), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response || response.ok !== true) throw new Error(`HTTP ${response?.status ?? "sem resposta"}`);
    const payload = await response.json();
    const models = Array.isArray(payload) ? payload : payload?.data;
    if (!Array.isArray(models)) throw new Error("payload sem lista de modelos");
    return models;
  } finally {
    clearTimeout(timer);
  }
}

function remember(resolved) {
  lastResolved = resolved;
  return { ...resolved };
}

function useFallback(reason) {
  return remember({ modelId: fallbackModelId(), source: "fallback", reason: reason || "descoberta falhou" });
}

/**
 * Resolve o modelo de chat. Nunca lança.
 * @param {{ fetchImpl?: Function, force?: boolean }} [options]
 * @returns {Promise<{ modelId: string, source: 'pinned'|'auto'|'fallback', reason?: string }>}
 */
export async function resolveChatModel({ fetchImpl, force } = {}) {
  try {
    const pinned = clean(config.openrouter.model);
    if (pinned && pinned.toLowerCase() !== "auto") {
      return remember({ modelId: pinned, source: "pinned" });
    }

    if (!force && cache && cache.expiresAt > Date.now()) {
      return remember({ modelId: cache.modelId, source: "auto" });
    }

    const fetchFn = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
    if (typeof fetchFn !== "function") return useFallback("fetch indisponível");

    let reason = "descoberta falhou";
    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
      try {
        const models = await fetchModels(fetchFn);
        const best = pickBest(models.filter(isChatRoutable), configGuardrails());
        const modelId = clean(best?.id);
        if (!modelId) {
          reason = "nenhum modelo elegível";
          break;
        }
        const now = Date.now();
        cache = { modelId, at: now, expiresAt: now + ttlMs() };
        return remember({ modelId, source: "auto" });
      } catch (error) {
        reason = shortReason(error);
      }
    }
    return useFallback(reason);
  } catch (error) {
    return useFallback(shortReason(error));
  }
}

/** Último resultado resolvido (sem I/O), ou null. */
export function getResolvedModel() {
  return lastResolved ? { ...lastResolved } : null;
}

/** Limpa cache + último resultado (testes/reconfiguração). */
export function resetModelCache() {
  cache = null;
  lastResolved = null;
}
