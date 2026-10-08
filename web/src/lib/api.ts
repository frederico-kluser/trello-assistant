import type { ActionResult, Board, Plan, PlannedAction, PlanTrace, StatusPayload, JevTrace } from "./types";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body instanceof FormData ? init?.headers : { "content-type": "application/json", ...init?.headers },
  });

  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // O túnel/gate pode devolver HTML (ex.: 401): trate como erro legível, não como crash.
    throw new ApiError(`http_${res.status}`, res.status === 401 ? "Sessão expirada: abra de novo o link com ?key=." : `Resposta inesperada do servidor (${res.status}).`);
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

export const api = {
  status: () => request<StatusPayload>("/api/status"),

  board: async (fresh = false) => (await request<{ board: Board }>(`/api/board${fresh ? "?fresh=1" : ""}`)).board,

  /** Aquece o servidor (socket do JEV + board) assim que a gravação começa. */
  warm: () => {
    void fetch("/api/warm", { method: "POST", keepalive: true }).catch(() => undefined);
  },

  /** Envia o áudio (WAV 16 kHz) para a STT da OpenAI. */
  stt: async (blob: Blob) => {
    const form = new FormData();
    form.append("audio", blob, "gravacao.wav");
    return request<{ text: string; provider: string; model: string; ms: number }>("/api/stt", { method: "POST", body: form });
  },

  /**
   * Texto → plano. Usa SSE: `onEvent` recebe o veredito do JEV (intenção,
   * colunas e guardas) enquanto a cascata de cards e o plano final ainda não
   * chegaram. Não há reserva genérica: se o JEV se abstém, o plano vem com
   * `actions: []`, `band: "abstain"` e `warning`. Comando com várias ações
   * segue por outro caminho — o plano chega com `provider: "llm"` e
   * `trace.llm` (System Two), e o JEV pode nem ter sido consultado.
   */
  agent: async (
    transcript: string,
    context: { lastCardId?: string | null },
    onEvent: (event: AgentEvent) => void,
  ): Promise<Plan> => {
    const res = await fetch("/api/agent?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ transcript, context }),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let error: { code?: string; message?: string; hint?: string } | undefined;
      try {
        error = (JSON.parse(text) as { error?: typeof error }).error;
      } catch {
        /* HTML do gate */
      }
      throw new ApiError(error?.code ?? `http_${res.status}`, error?.message ?? (res.status === 401 ? "Sessão expirada: abra de novo o link com ?key=." : `Falha na requisição (${res.status})`), error?.hint ?? null);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: Plan | null = null;

    const handle = (raw: string) => {
      const line = raw.split("\n").find((entry) => entry.startsWith("data: "));
      if (!line) return;
      const event = JSON.parse(line.slice(6)) as { type: string } & Record<string, unknown>;
      if (event.type === "plan") final = event as unknown as Plan;
      else if (event.type === "error") {
        const error = event.error as { code?: string; message?: string };
        throw new ApiError(error.code ?? "internal_error", error.message ?? "Erro interno do servidor.");
      } else onEvent(event as unknown as AgentEvent);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        handle(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    if (buffer.trim()) handle(buffer);
    if (!final) throw new ApiError("empty_stream", "O servidor encerrou sem devolver um plano.");
    return final;
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
