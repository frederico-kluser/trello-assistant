/**
 * Cliente do JEV (TypeSafe "System One") via OpenRouter — endpoint Decisions.
 *
 * O JEV não gera texto: recebe um `state` + perguntas tipadas e devolve
 * decisões (noul → P(sim); choice → opção + distribuição + confiança;
 * score → posição numa régua). As perguntas de UM pedido são avaliadas EM
 * PARALELO dentro do modelo (~300 ms no total), por isso o planner agrupa
 * todas as classificações numa única chamada.
 *
 * Latência: usamos node:https com agente keep-alive (HTTP/1.1) — medido pela
 * skill jev-agent-skill como mais rápido que h2 em rajadas. O socket fica
 * quente entre comandos (e é aquecido quando a gravação começa).
 */
import https from "node:https";
import { performance } from "node:perf_hooks";
import { config } from "../config.js";

/** Códigos estáveis — o planner e a UI explicam em pt-BR por que o JEV não operou. */
export class JevError extends Error {
  constructor(code, message, { status = null, retriable = false, detail = null } = {}) {
    super(message);
    this.name = "JevError";
    this.code = code;
    this.status = status;
    this.retriable = retriable;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 16 });

/** Transporte padrão (substituível em testes via `setJevTransport`). */
function httpsPost(urlString, { headers, body, timeoutMs }) {
  const url = new URL(urlString);
  const payload = JSON.stringify(body);
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        agent,
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
            reusedSocket: Boolean(req.reusedSocket),
            ms: performance.now() - started,
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

let transport = httpsPost;
/** Só para testes: injeta um transporte falso (sem rede). */
export function setJevTransport(fn) {
  transport = fn ?? httpsPost;
}

function classify(status, text) {
  let message = "";
  try {
    message = JSON.parse(text)?.error?.message ?? "";
  } catch {
    message = String(text ?? "").slice(0, 160);
  }
  if (status === 401) return new JevError("auth", "a chave do OpenRouter foi recusada (401)", { status });
  if (status === 402) return new JevError("credits", "sem créditos no OpenRouter (402)", { status });
  if (status === 429) return new JevError("rate_limit", "limite de requisições do JEV atingido (429)", { status, retriable: true });
  if (status === 400 || status === 422) {
    return new JevError("invalid", `o JEV rejeitou o pedido (HTTP ${status}${message ? `: ${message}` : ""})`, { status, detail: message });
  }
  if (status === 403 || status === 404 || status === 413) {
    return new JevError("unavailable", `o JEV não está acessível (HTTP ${status})`, { status });
  }
  return new JevError("server", `o JEV está indisponível (HTTP ${status})`, { status, retriable: true });
}

/**
 * Uma chamada de decisão. Retenta UMA vez erros transitórios (429/5xx/rede)
 * dentro do orçamento `timeoutMs` — passou disso, é mais rápido cair no MiMo.
 *
 * @returns {{answers:Record<string,any>, model:string, usage:any, latencyMs:number, reusedSocket:boolean}}
 */
export async function decide({ state, questions, sessionId, timeoutMs = config.jev.timeoutMs }) {
  if (!config.openrouter.apiKey) {
    throw new JevError("auth", "falta OPENROUTER_API_KEY para usar o JEV", { status: 401 });
  }

  const deadline = performance.now() + timeoutMs;
  const body = { model: config.jev.model, state, questions };
  if (sessionId) body.session_id = String(sessionId).slice(0, 256);
  const headers = {
    authorization: `Bearer ${config.openrouter.apiKey}`,
    "http-referer": config.app.url,
    "x-openrouter-title": config.app.name,
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = Math.max(250, deadline - performance.now());
    try {
      const res = await transport(config.jev.url, { headers, body, timeoutMs: remaining });
      if (res.status >= 200 && res.status < 300) {
        let data;
        try {
          data = JSON.parse(res.text);
        } catch {
          throw new JevError("server", "o JEV devolveu uma resposta ilegível", { status: res.status, retriable: true });
        }
        if (!data?.answers || typeof data.answers !== "object") {
          throw new JevError("server", "o JEV não devolveu respostas", { status: res.status, retriable: true });
        }
        return {
          answers: data.answers,
          model: data.model ?? config.jev.model,
          usage: data.usage ?? null,
          latencyMs: Math.round(res.ms),
          reusedSocket: Boolean(res.reusedSocket),
        };
      }
      lastError = classify(res.status, res.text);
      if (lastError.retriable) {
        const retryAfter = Number.parseFloat(res.headers?.["retry-after"] ?? "");
        lastError.retryAfterMs = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 1000) : null;
      }
    } catch (err) {
      lastError =
        err instanceof JevError
          ? err
          : err?.message === "timeout"
            ? new JevError("timeout", `o JEV demorou mais de ${(timeoutMs / 1000).toFixed(1)} s`, { retriable: true })
            : new JevError("network", `sem rede para o JEV (${err?.code ?? err?.message ?? "erro"})`, { retriable: true });
    }

    if (!lastError.retriable || attempt === 1) break;
    const wait = lastError.retryAfterMs ?? 200 + Math.random() * 150;
    if (performance.now() + wait >= deadline) break;
    await sleep(wait);
  }
  throw lastError;
}

/** Aquece DNS+TCP+TLS (chamado quando a gravação começa; custa ~$0.00001). */
export async function warmJev() {
  if (!config.jev.enabled) return false;
  try {
    await decide({
      state: "aquecimento",
      questions: { ok: { type: "noul", instructions: "O texto é uma palavra?" } },
      timeoutMs: 2500,
    });
    return true;
  } catch {
    return false;
  }
}
