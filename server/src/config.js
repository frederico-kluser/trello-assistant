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
    model: clean(process.env.OPENROUTER_MODEL) || "xiaomi/mimo-v2.6-pro",
    maxPromptPrice: num(process.env.OPENROUTER_MAX_PROMPT_PRICE),
    maxCompletionPrice: num(process.env.OPENROUTER_MAX_COMPLETION_PRICE),
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
    agent: config.openrouter.apiKey ? "openrouter" : "local",
    board: hasTrello ? "trello" : "demo",
    models: {
      stt: config.openai.sttModel,
      agent: config.openrouter.model,
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
      what: `Análise da fala com ${config.openrouter.model}`,
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