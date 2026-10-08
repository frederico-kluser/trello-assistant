import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Configuração central do servidor.
 * As credenciais vivem SÓ aqui (process.env / .env na raiz do repositório)
 * e nunca são enviadas ao navegador — o front consome apenas /api/*.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");

dotenv.config({ path: path.join(repoRoot, ".env") });

const clean = (value) => (typeof value === "string" ? value.trim() : "");
const num = (value) => {
  const n = Number.parseFloat(clean(value));
  return Number.isFinite(n) ? n : null;
};
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Enum oficial do OpenRouter para reasoning.effort. */
const REASONING_EFFORTS = new Set(["max", "xhigh", "high", "medium", "low", "minimal", "none"]);
const reasoningEffort = (value) => {
  const v = clean(value).toLowerCase();
  return REASONING_EFFORTS.has(v) ? v : "max";
};

export const config = {
  repoRoot,
  port: Number.parseInt(clean(process.env.PORT) || "8787", 10),
  app: {
    name: clean(process.env.APP_NAME) || "Trello Orbit",
    url: clean(process.env.APP_URL) || "http://localhost:8787",
  },
  openai: {
    apiKey: clean(process.env.OPENAI_API_KEY),
    baseUrl: clean(process.env.OPENAI_BASE_URL) || "https://api.openai.com/v1",
    sttModel: clean(process.env.OPENAI_STT_MODEL) || "gpt-4o-mini-transcribe",
    language: clean(process.env.OPENAI_STT_LANGUAGE) || "pt",
    maxUploadBytes: 25 * 1024 * 1024,
  },
  openrouter: {
    apiKey: clean(process.env.OPENROUTER_API_KEY),
    baseUrl: clean(process.env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1",
    // System Two (a voz do assistente). "auto" = melhor modelo descoberto em
    // GET /models pelo services/model-picker.js (ver OPENROUTER_MODEL_FALLBACK).
    model: clean(process.env.OPENROUTER_MODEL) || "auto",
    // Reserva usada quando a descoberta automática falha (ou não acha candidato).
    modelFallback: clean(process.env.OPENROUTER_MODEL_FALLBACK) || "google/gemini-3.8-flash",
    // Validade da escolha automática, em minutos (padrão 60).
    modelTtlMinutes: (() => {
      const minutes = num(process.env.OPENROUTER_MODEL_TTL_MINUTES);
      return minutes !== null && minutes > 0 ? minutes : 60;
    })(),
    // Esforço de raciocínio do modelo: max | xhigh | high | medium | low | minimal | none.
    // Padrão "max" — o System Two pensa o máximo antes de devolver o plano (se o
    // modelo recusar o campo, agent.js repete uma vez sem ele).
    reasoningEffort: reasoningEffort(process.env.OPENROUTER_REASONING_EFFORT),
    // Teto de saída. Com effort alto os reasoning tokens consomem este orçamento
    // (e são cobrados como output), então deixamos folga para o JSON final.
    maxTokens: Number.parseInt(clean(process.env.OPENROUTER_MAX_TOKENS) || "16000", 10),
    maxPromptPrice: num(process.env.OPENROUTER_MAX_PROMPT_PRICE),
    maxCompletionPrice: num(process.env.OPENROUTER_MAX_COMPLETION_PRICE),
  },
  /**
   * JEV (TypeSafe "System One") via OpenRouter — faz TODAS as classificações:
   * intenção CRUD, card, lista, guardas e o portão de colunas, em UMA chamada
   * (as perguntas correm em paralelo dentro do modelo). Quando a intenção é
   * listagem, a cascata colunas → cards avalia os cards abertos em lotes.
   * Comandos ÚNICOS são dele; comandos SIMULTÂNEOS (várias ações numa fala) vão
   * ao System Two (config.openrouter.model). Abstenções por clareza/card NÃO
   * têm fallback genérico: o app pede esclarecimento.
   */
  jev: {
    enabled: clean(process.env.JEV_ENABLED).toLowerCase() !== "false" && Boolean(clean(process.env.OPENROUTER_API_KEY)),
    model: clean(process.env.JEV_MODEL) || "typesafe/jev-1.13",
    url: clean(process.env.JEV_URL) || "https://openrouter.ai/api/alpha/decisions",
    // Decisão leva ~300 ms: se passar disto, é melhor responder "indisponível".
    timeoutMs: Number.parseInt(clean(process.env.JEV_TIMEOUT_MS) || "4000", 10),
    // Bandas de ação: auto ≥ 0.80 · hitl 0.50–0.79 · abstain < 0.50. A doc do modelo sugere 0.90,
    // mas decisões REVERSÍVEIS toleram menos (medido no eval: 0.80 executa direto ~40% mais
    // comandos corretos, com 0 ações erradas). Criar/apagar sempre confirmam, qualquer que seja a banda.
    autoThreshold: num(process.env.JEV_AUTO_THRESHOLD) ?? 0.8,
    hitlThreshold: num(process.env.JEV_HITL_THRESHOLD) ?? 0.5,
    // Cascata de listagem: cards por chamada na avaliação em lotes (clamp 4–24;
    // acima de ~16–32 itens a qualidade do lote degrada).
    cardBatch: clamp(Number.parseInt(clean(process.env.JEV_CARD_BATCH) || "16", 10) || 16, 4, 24),
    // Limiares ASSIMÉTRICOS da listagem (read-only): listar inclui a partir de
    // 0,50; entre 0,35 e 0,50 sai com a ressalva "talvez" — nunca escondido.
    listInclude: num(process.env.JEV_LIST_INCLUDE) ?? 0.5,
    listMaybe: num(process.env.JEV_LIST_MAYBE) ?? 0.35,
    // Portão de colunas: critério LARGO (recall-first). Se nenhuma coluna passar,
    // passam todas — o filtro fino por card é que decide.
    colInclude: num(process.env.JEV_COL_INCLUDE) ?? 0.35,
  },
  trello: {
    apiKey: clean(process.env.TRELLO_API_KEY),
    token: clean(process.env.TRELLO_API_TOKEN),
    boardId: clean(process.env.TRELLO_BOARD_ID),
    baseUrl: clean(process.env.TRELLO_BASE_URL) || "https://api.trello.com/1",
  },
};

/**
 * Capacidades reais desta execução — usadas pelo front para saber
 * se deve usar STT da OpenAI, agente OpenRouter e board real/demo.
 */
export function capabilities() {
  const hasTrello = Boolean(config.trello.apiKey && config.trello.token);
  return {
    stt: config.openai.apiKey ? "openai" : "browser",
    // Motor principal das classificações. Sem JEV não há reserva: o interpretador local.
    engine: config.jev.enabled ? "jev" : "local",
    fallback: config.jev.enabled ? "none" : "local",
    board: hasTrello ? "trello" : "demo",
    models: {
      stt: config.openai.sttModel,
      jev: config.jev.enabled ? config.jev.model : null,
      // System Two: planeja os comandos simultâneos (e, no futuro, gera texto em criar/editar).
      llm: config.openrouter.apiKey ? config.openrouter.model : null,
    },
  };
}

/** Checklist honesta do que falta configurar (sem expor segredos). */
export function missingSetup() {
  const missing = [];
  if (!config.openai.apiKey) {
    missing.push({
      key: "OPENAI_API_KEY",
      what: "Transcrição de voz com a API STT da OpenAI",
      where: "https://platform.openai.com/api-keys",
      impact: "Enquanto isso o app usa o reconhecimento do navegador (funciona, menos preciso).",
    });
  }
  if (!config.openrouter.apiKey) {
    missing.push({
      key: "OPENROUTER_API_KEY",
      what: `Classificação e listagem com o JEV (${config.jev.model}) e comandos compostos com o System Two (${config.openrouter.model})`,
      where: "https://openrouter.ai/keys",
      impact: "Enquanto isso o app usa o interpretador local de comandos (pt-BR).",
    });
  }
  if (!config.trello.apiKey || !config.trello.token) {
    missing.push({
      key: "TRELLO_API_KEY / TRELLO_API_TOKEN",
      what: "Acesso ao seu board real do Trello",
      where: "https://trello.com/power-ups/admin",
      impact: "Enquanto isso o app roda em modo demonstração com um board fictício.",
    });
  } else if (!config.trello.boardId) {
    missing.push({
      key: "TRELLO_BOARD_ID",
      what: "Qual board usar",
      where: "GET /api/trello/boards (lista os seus boards)",
      impact: "Sem o id, o app entra em modo demonstração.",
    });
  }
  return missing;
}