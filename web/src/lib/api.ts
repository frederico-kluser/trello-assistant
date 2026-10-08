import type { ActionResult, Board, Plan, PlannedAction, PlanTrace, StatusPayload, JevTrace } from "./types";
import type { SessionTurn } from "./session";

export class ApiError extends Error {
  code: string;
  hint: string | null;

  constructor(code: string, message: string, hint: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * O gate de acesso é TOTP no cloudflared: não há chave nenhuma na URL do app.
 * Um 401 quer dizer sessão do gate expirada, e a saída é reautenticar — não
 * reabrir um link com parâmetro.
 */
const REAUTH_MESSAGE = "Sessão expirada: autentique-se de novo no gate (TOTP) e recarregue a página.";

/** Fim de cadeia: nenhuma tentativa (SSE ou JSON) devolveu um plano. */
const EMPTY_STREAM_MESSAGE = "O servidor encerrou sem devolver um plano.";

/** Teto da subida da STT. Cobre o pior caso do servidor (transcrição de 60 s + 1 retry interno da OpenAI). */
export const STT_TIMEOUT_MS = 150_000;

/** Silêncio máximo tolerado no SSE: nenhum byte neste intervalo = túnel morto (o servidor manda heartbeats). */
export const SSE_IDLE_TIMEOUT_MS = 45_000;

/** Repetições do SSE com o mesmo corpo antes do fallback JSON (≤ 3 tentativas no total). */
export const SSE_MAX_RETRIES = 2;

/** Fôlego antes de repetir a subida do áudio: em 3G um segundo inteiro evita repetir no mesmo buraco. */
export const STT_RETRY_DELAY_MS = 1_000;

/** Fôlego antes de repetir o SSE. GUESS: o brief não fixa valor; curto de propósito para não somar ao idle-timeout. */
export const SSE_RETRY_DELAY_MS = 500;

/** Teto da última tentativa (JSON simples): o servidor aceita e pode demorar; sem isto o pedido ficaria pendurado para sempre. */
export const FALLBACK_TIMEOUT_MS = 150_000;

export interface SttOptions {
  /** Substitui `STT_TIMEOUT_MS` (testes usam valores pequenos). */
  timeoutMs?: number;
  /** Substitui `STT_RETRY_DELAY_MS`. */
  retryDelayMs?: number;
}

/** Aviso de repetição. `fallback: true` marca a tentativa final, que vai em JSON simples (sem `?stream=1`). */
export interface AgentNetRetry {
  /** Número da tentativa que acabou de falhar (1 = a primeira). */
  attempt: number;
  /** `empty`: o fluxo fechou sem plano (túnel cortou a resposta) — também conta como tentativa falhada. */
  reason: "idle" | "network" | "empty";
  fallback: boolean;
}

export interface AgentStreamOptions {
  /** Substitui `SSE_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
  /** Substitui `SSE_MAX_RETRIES`. */
  maxRetries?: number;
  /** Substitui `SSE_RETRY_DELAY_MS`. */
  retryDelayMs?: number;
  /** Substitui `FALLBACK_TIMEOUT_MS`. */
  fallbackTimeoutMs?: number;
  /** Sem callback (o caso do App), nada muda na tela. Um callback que estoure é ignorado. */
  onNetRetry?: (info: AgentNetRetry) => void;
}

/**
 * Falha de TRANSPORTE: `fetch` rejeitou ou o corpo foi cortado no meio — o
 * servidor não chegou a concluir a resposta. É o único caso que se repete:
 * `ApiError` é decisão do servidor (HTTP ou evento `error`) e não se repete.
 */
class TransportError extends Error {
  readonly reason: "idle" | "network";
  /** `before_headers`: ainda não havia resposta nenhuma (rede ou watchdog do upload). */
  readonly phase: "before_headers" | "body";
  readonly detail: unknown;

  constructor(reason: "idle" | "network", phase: "before_headers" | "body", detail: unknown) {
    super(reason === "idle" ? "O servidor parou de responder no meio do pedido." : "Falha de rede ao falar com o servidor.");
    this.name = "TransportError";
    this.reason = reason;
    this.phase = phase;
    this.detail = detail;
  }
}

/** O fluxo SSE fechou sem plano: não é erro do servidor, é tentativa perdida (túnel cortou a resposta). */
class EmptyStreamError extends Error {
  constructor() {
    super(EMPTY_STREAM_MESSAGE);
    this.name = "EmptyStreamError";
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Traduz a falha de transporte para a forma de erro que o resto do front já conhece (`ApiError`). */
function asApiError(err: unknown, hint: string | null = null): ApiError {
  if (err instanceof ApiError) return err;
  const message =
    err instanceof TransportError && err.reason === "idle"
      ? "O servidor parou de responder no meio do pedido. Tente de novo."
      : "Falha de rede: não consegui falar com o servidor. Tente de novo.";
  return new ApiError("network_error", message, hint);
}

/** Dica mostrada no rodapé quando a última falha foi silêncio (e não queda declarada) da conexão. */
function idleHint(reason: AgentNetRetry["reason"] | null | undefined, idleTimeoutMs: number): string | null {
  if (reason !== "idle") return null;
  return `A conexão ficou ${Math.round(idleTimeoutMs / 1000)} s sem responder. Verifique o sinal e tente de novo.`;
}

/**
 * `fetch` + corpo JSON, com timeout opcional. Sem `options.timeoutMs` o
 * comportamento é o de sempre (os outros endpoints não ganham prazo novo).
 */
async function request<T>(path: string, init?: RequestInit, options?: { timeoutMs?: number }): Promise<T> {
  const controller = options?.timeoutMs ? new AbortController() : null;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options?.timeoutMs)
    : null;
  const signal = controller?.signal ?? init?.signal;

  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body instanceof FormData ? init?.headers : { "content-type": "application/json", ...init?.headers },
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    throw new TransportError(timedOut ? "idle" : "network", "before_headers", err);
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new TransportError(timedOut ? "idle" : "network", "body", err);
  } finally {
    if (timer) clearTimeout(timer);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // O gate TOTP pode devolver HTML (ex.: 401): trate como erro legível, não como crash.
    throw new ApiError(`http_${res.status}`, res.status === 401 ? REAUTH_MESSAGE : `Resposta inesperada do servidor (${res.status}).`);
  }

  if (!res.ok) {
    const error = payload.error as { code?: string; message?: string; hint?: string } | undefined;
    throw new ApiError(error?.code ?? `http_${res.status}`, error?.message ?? `Falha na requisição (${res.status})`, error?.hint ?? null);
  }
  return payload as T;
}

/** Evento do SSE antes do plano. Num comando composto o JEV nem é consultado (`jev: null`). */
export type AgentEvent = { type: "jev"; jev: JevTrace | null };

export interface ConfirmResult {
  decision: "yes" | "no" | "unclear";
  engine: "jev" | "local";
  confidence: number;
  ms: number;
}

type SttResult = { text: string; provider: string; model: string; ms: number };

/**
 * Uma moldura SSE → evento. Linhas que não sejam `data:` são ignoradas: os
 * comentários de heartbeat (`: ping`) e campos como `event:`/`id:`/`retry:` não
 * são erro nem fim de fluxo. Moldura sem dados devolve `null`.
 *
 * `data:` ilegível é defeito LOCAL (o servidor nunca manda JSON quebrado):
 * vira `ApiError` e é DEFINITIVO — aborta sem repetir, porque repetir faria o
 * servidor planejar de novo por causa de um frame corrompido.
 */
function parseFrame(raw: string): ({ type?: string } & Record<string, unknown>) | null {
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) return null;
    try {
      return JSON.parse(data) as { type?: string } & Record<string, unknown>;
    } catch {
      throw new ApiError("sse_parse_error", "Recebi um evento ilegível do servidor (frame SSE inválido).");
    }
  }
  return null;
}

/**
 * Caminho único de emissão: o mesmo para as molduras do SSE e para o payload
 * JSON validado do fallback. Devolve o plano quando chegou; eventos
 * intermediários vão para `onEvent`; um evento `error` vira `ApiError` (decisão
 * do servidor). Um `onEvent` que estoura é defeito LOCAL do app, não da rede:
 * vira `ApiError` definitivo em vez de gastar 4 ciclos de planejamento no servidor.
 */
function applyEvent(event: { type?: string } & Record<string, unknown>, onEvent: (event: AgentEvent) => void): Plan | null {
  if (event.type === "plan") return event as unknown as Plan;
  if (event.type === "error") {
    const error = event.error as { code?: string; message?: string } | undefined;
    throw new ApiError(error?.code ?? "internal_error", error?.message ?? "Erro interno do servidor.");
  }
  try {
    onEvent(event as unknown as AgentEvent);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiError("sse_listener_error", `Falha ao tratar um evento do servidor: ${detail}`);
  }
  return null;
}

/**
 * Plano a partir do payload JSON simples (sem `?stream=1`). Valida ANTES de
 * emitir — o payload tem de PARECER um plano: um `{}` devolvido pelo túnel/gate
 * não pode virar plano vazio, e `type: "error"` é erro do servidor, não plano.
 * O `type: "plan"` só é acrescentado quando o campo está AUSENTE (o payload
 * simples não o traz); um `type` explícito nunca é sobrescrito.
 */
function emitFallback(payload: Record<string, unknown>, onEvent: (event: AgentEvent) => void): Plan {
  if (payload.type === "error") {
    const error = payload.error as { code?: string; message?: string; hint?: string } | undefined;
    throw new ApiError(error?.code ?? "internal_error", error?.message ?? "Erro interno do servidor.", error?.hint ?? null);
  }
  const looksLikePlan = Array.isArray(payload.actions) || typeof payload.speech === "string";
  if (!looksLikePlan || (payload.type !== undefined && payload.type !== "plan")) throw new ApiError("empty_stream", EMPTY_STREAM_MESSAGE);

  const plan = applyEvent(payload.type === "plan" ? payload : { ...payload, type: "plan" }, onEvent);
  if (!plan) throw new ApiError("empty_stream", EMPTY_STREAM_MESSAGE);
  return plan;
}

/**
 * Uma tentativa de SSE: watchdog de silêncio + leitura do fluxo. Qualquer byte
 * (evento ou heartbeat) rearma o watchdog; silêncio ou queda no meio da leitura
 * viram `TransportError` — o chamador decide se repete.
 */
async function consumeSse(body: string, onEvent: (event: AgentEvent) => void, idleTimeoutMs: number): Promise<Plan> {
  const controller = new AbortController();
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** (Re)arma o watchdog. Chamado antes do fetch: o silêncio também cobre conexão + cabeçalhos. */
  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      controller.abort();
    }, idleTimeoutMs);
  };
  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  kick();
  let res: Response;
  try {
    res = await fetch("/api/agent?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    throw new TransportError(idle ? "idle" : "network", "before_headers", err);
  } finally {
    stop();
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let error: { code?: string; message?: string; hint?: string } | undefined;
    try {
      error = (JSON.parse(text) as { error?: typeof error }).error;
    } catch {
      /* HTML do gate TOTP */
    }
    throw new ApiError(error?.code ?? `http_${res.status}`, error?.message ?? (res.status === 401 ? REAUTH_MESSAGE : `Falha na requisição (${res.status})`), error?.hint ?? null);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: Plan | null = null;

  try {
    kick();
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        kick(); // chegou byte: a conexão está viva (heartbeat de comentário também conta)
        buffer += decoder.decode(value, { stream: !done });
      }
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const event = parseFrame(buffer.slice(0, split));
        if (event) {
          const plan = applyEvent(event, onEvent);
          if (plan) final = plan;
        }
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = parseFrame(buffer);
      if (event) {
        const plan = applyEvent(event, onEvent);
        if (plan) final = plan;
      }
    }
  } catch (err) {
    if (err instanceof ApiError) throw err; // o servidor respondeu: não é falha de transporte
    if (final) return final; // o plano já chegou inteiro: a queda logo depois dele não pode perder o comando
    throw new TransportError(idle ? "idle" : "network", "body", err);
  } finally {
    stop();
    try {
      controller.abort(); // solta o socket que ficou pendurado
      void reader.cancel().catch(() => undefined);
    } catch {
      /* fluxo já fechado */
    }
  }

  if (!final) throw new EmptyStreamError();
  return final;
}

/** Nome do ficheiro no multipart: acompanha o `type` do blob (webm/opus no caso normal, m4a no iOS antigo). */
function sttFilename(blob: Blob): string {
  const type = (blob.type ?? "").toLowerCase();
  if (type.includes("webm")) return "gravacao.webm";
  if (type.includes("mp4")) return "gravacao.m4a";
  return "gravacao.wav";
}

export const api = {
  status: () => request<StatusPayload>("/api/status"),

  board: async (fresh = false) => (await request<{ board: Board }>(`/api/board${fresh ? "?fresh=1" : ""}`)).board,

  /** Aquece o servidor (socket do JEV + board) assim que a gravação começa. */
  warm: () => {
    void fetch("/api/warm", { method: "POST", keepalive: true }).catch(() => undefined);
  },

  /**
   * Envia o áudio para a STT da OpenAI. Tem prazo próprio (`STT_TIMEOUT_MS`,
   * acima do pior caso do servidor) e repete UMA vez a falha de rede: HTTP
   * 4xx/5xx não se repete, porque o servidor já repete a OpenAI por dentro.
   */
  stt: async (blob: Blob, options: SttOptions = {}): Promise<SttResult> => {
    const timeoutMs = options.timeoutMs ?? STT_TIMEOUT_MS;
    const retryDelayMs = options.retryDelayMs ?? STT_RETRY_DELAY_MS;
    const upload = () => {
      const form = new FormData();
      form.append("audio", blob, sttFilename(blob));
      return request<SttResult>("/api/stt", { method: "POST", body: form }, { timeoutMs });
    };

    try {
      return await upload();
    } catch (err) {
      if (!(err instanceof TransportError) || err.phase !== "before_headers") throw asApiError(err);
      await sleep(retryDelayMs);
      try {
        return await upload();
      } catch (again) {
        throw asApiError(again);
      }
    }
  },

  /**
   * Texto → plano. Usa SSE: `onEvent` recebe o veredito do JEV (intenção,
   * colunas e guardas) enquanto a cascata de cards e o plano final ainda não
   * chegaram. Não há reserva genérica: se o JEV se abstém, o plano vem com
   * `actions: []`, `band: "abstain"` e `warning`. Comando com várias ações
   * segue por outro caminho — o plano chega com `provider: "llm"` e
   * `trace.llm` (System Two), e o JEV pode nem ter sido consultado.
   *
   * Num túnel/3G o fluxo pode emudecer, cair no meio ou fechar sem plano: o
   * watchdog de silêncio (`SSE_IDLE_TIMEOUT_MS`, rearmado a cada byte —
   * heartbeat de comentário conta) aborta a tentativa, o MESMO corpo é repetido
   * até `SSE_MAX_RETRIES` (uma tentativa sem plano conta como falhada) e, se
   * ainda falhar, vai UMA última tentativa sem `?stream=1` — o servidor
   * responde o mesmo payload em JSON simples, que entra pelo mesmo caminho de
   * eventos (`applyEvent`). Só depois disso o erro sobe. Decisão explícita do
   * servidor (HTTP de erro ou evento `error`) não se repete.
   *
   * `session` vai sempre: o `sessionId` é a chave do estado da conversa no
   * servidor e `history` é o contexto das trocas anteriores (mais recente por
   * último, já capado em web/src/lib/session.ts). O comando atual NÃO entra no
   * histórico — ele viaja no `transcript`. Nada disto é persistido no
   * navegador: um F5 começa uma sessão nova, de propósito.
   */
  agent: async (
    transcript: string,
    context: { lastCardId?: string | null },
    onEvent: (event: AgentEvent) => void,
    session: { sessionId: string; history: SessionTurn[] },
    options: AgentStreamOptions = {},
  ): Promise<Plan> => {
    const body = JSON.stringify({ transcript, context, sessionId: session.sessionId, history: session.history });
    const idleTimeoutMs = options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;
    const maxRetries = Math.max(0, options.maxRetries ?? SSE_MAX_RETRIES);
    const retryDelayMs = options.retryDelayMs ?? SSE_RETRY_DELAY_MS;
    const fallbackTimeoutMs = options.fallbackTimeoutMs ?? FALLBACK_TIMEOUT_MS;
    // Um `onNetRetry` com defeito é problema do app: não pode matar a cadeia e perder o comando.
    const notify = (info: AgentNetRetry) => {
      try {
        options.onNetRetry?.(info);
      } catch {
        /* callback do chamador estourou: seguimos com a repetição */
      }
    };

    let failure: AgentNetRetry["reason"] | null = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        return await consumeSse(body, onEvent, idleTimeoutMs);
      } catch (err) {
        // Só se repete o que NÃO é decisão do servidor (ApiError) nem defeito local do app:
        // silêncio, rede caída ou fluxo que fechou sem plano.
        const reason = err instanceof TransportError ? err.reason : err instanceof EmptyStreamError ? "empty" : null;
        if (!reason) throw err;
        failure = reason;
        notify({ attempt, reason, fallback: attempt > maxRetries });
        if (attempt > maxRetries) break;
        await sleep(retryDelayMs);
      }
    }

    // Última cartada: mesmo corpo sem `?stream=1` (payload em JSON simples), com prazo próprio e SEM repetição.
    try {
      const payload = await request<Record<string, unknown>>(
        "/api/agent",
        { method: "POST", headers: { accept: "application/json" }, body },
        { timeoutMs: fallbackTimeoutMs },
      );
      return emitFallback(payload, onEvent);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Cadeia esgotada: nem o SSE nem o JSON trouxeram plano (inclui o prazo do fallback estourado).
      if (failure === "empty" || (err instanceof TransportError && err.reason === "idle")) throw new ApiError("empty_stream", EMPTY_STREAM_MESSAGE);
      throw asApiError(err, idleHint(failure, idleTimeoutMs));
    }
  },

  /** "sim"/"cancela" falados: o JEV classifica. */
  confirm: (text: string, pending: string) =>
    request<ConfirmResult>("/api/confirm", { method: "POST", body: JSON.stringify({ text, pending }) }),

  /** Executa o plano. `confirmed` é obrigatório para criar/apagar. */
  execute: (actions: PlannedAction[], confirmed: boolean) =>
    request<{ ok: boolean; results: ActionResult[]; board: Board }>("/api/actions", {
      method: "POST",
      body: JSON.stringify({ actions, confirmed }),
    }),

  trelloBoards: () => request<{ boards: { id: string; name: string; url: string }[] }>("/api/trello/boards"),
};

export type { PlanTrace };
