import type { ActionResult, Board, PlannedAction, StatusPayload } from "./types";

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
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!res.ok) {
    const error = payload.error as { code?: string; message?: string; hint?: string } | undefined;
    throw new ApiError(
      error?.code ?? `http_${res.status}`,
      error?.message ?? `Falha na requisição (${res.status})`,
      error?.hint ?? null,
    );
  }
  return payload as T;
}

export interface AgentResponse {
  speech: string;
  actions: PlannedAction[];
  needsConfirmation: boolean;
  provider: string;
  model: string | null;
  warning: string | null;
  board: Board;
}

export const api = {
  status: () => request<StatusPayload>("/api/status"),

  board: async () => (await request<{ board: Board }>("/api/board")).board,

  /** Envia o áudio gravado para a STT da OpenAI. */
  stt: async (blob: Blob) => {
    const form = new FormData();
    const extension = blob.type.includes("mp4") ? "m4a" : "webm";
    form.append("audio", blob, `gravacao.${extension}`);
    return request<{ text: string; provider: string; model: string }>("/api/stt", {
      method: "POST",
      body: form,
    });
  },

  /** Manda o texto transcrito para o agente planejar ações. */
  agent: (transcript: string) =>
    request<AgentResponse>("/api/agent", {
      method: "POST",
      body: JSON.stringify({ transcript }),
    }),

  /** Executa o plano. `confirmed` é obrigatório para criar/apagar. */
  execute: (actions: PlannedAction[], confirmed: boolean) =>
    request<{ ok: boolean; results: ActionResult[]; board: Board }>("/api/actions", {
      method: "POST",
      body: JSON.stringify({ actions, confirmed }),
    }),

  trelloBoards: () => request<{ boards: { id: string; name: string; url: string }[] }>("/api/trello/boards"),
};