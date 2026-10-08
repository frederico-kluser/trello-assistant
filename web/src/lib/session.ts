/**
 * Sessão de conversa do front — 100% em memória.
 *
 * Nada aqui toca localStorage/sessionStorage/cookie, de propósito: um F5 começa
 * uma sessão nova, com histórico vazio, e o estado que o servidor guardou para o
 * id antigo simplesmente expira por TTL. O `sessionId` é gerado uma vez por
 * carregamento de página (`newSessionId()`) e nunca é persistido.
 *
 * O módulo é puro — sem React, sem `window` obrigatório — para rodar no
 * `node --test`, como web/test/audio.test.ts.
 */

import type { MatchedField } from "./types";

/* ── histórico ─────────────────────────────────────────────────────────── */

/** Papel de quem falou numa entrada do histórico. */
export type SessionRole = "user" | "assistant";

export interface SessionTurn {
  role: SessionRole;
  content: string;
}

/** O servidor recebe no máximo as 20 entradas mais recentes. */
export const HISTORY_MAX_ENTRIES = 20;

/** Cada `content` é cortado em 500 caracteres antes de sair daqui. */
export const HISTORY_MAX_CONTENT = 500;

/**
 * Corta em `HISTORY_MAX_CONTENT` sem reticências: o servidor só quer o texto.
 * O corte nunca parte um par surrogado — um emoji cortado ao meio viraria um
 * substituto solto (texto malformado) no corpo do POST.
 */
export function clampContent(text: string, max: number = HISTORY_MAX_CONTENT): string {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  // Último código é um substituto alto: o par ficou de fora, então ele sai também.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface SessionHistory {
  /** Acrescenta uma entrada já truncada; acima do teto, a mais antiga sai. */
  push(role: SessionRole, content: string): void;
  /** Cópia pronta para o corpo da requisição, mais recente por último. */
  toArray(): SessionTurn[];
  size(): number;
}

/**
 * Histórico da sessão. `toArray()` sempre devolve cópias (nunca a referência
 * interna) e o teto é aplicado a cada `push`, descartando as entradas mais
 * antigas — se o corte cair no meio de um par, o servidor recebe um `assistant`
 * órfão no começo e decide o que fazer com ele.
 */
export function createSessionHistory(max: number = HISTORY_MAX_ENTRIES): SessionHistory {
  const cap = Number.isFinite(max) && max > 0 ? Math.trunc(max) : HISTORY_MAX_ENTRIES;
  const entries: SessionTurn[] = [];

  return {
    push(role, content) {
      entries.push({ role, content: clampContent(content) });
      if (entries.length > cap) entries.splice(0, entries.length - cap);
    },
    toArray() {
      return entries.map((entry) => ({ ...entry }));
    },
    size() {
      return entries.length;
    },
  };
}

/**
 * Turnos do BUFFER de histórico (pares pergunta/resposta). Satura junto com ele
 * (20 entradas = 10 turnos); para o número real da sessão, use `Session.turns()`.
 */
export function turnCount(entries: readonly SessionTurn[]): number {
  return Math.floor(entries.length / 2);
}

/** Chip de sessão: “12 turnos nesta sessão”. */
export function turnLabel(turns: number): string {
  const value = Number.isFinite(turns) && turns > 0 ? Math.trunc(turns) : 0;
  return `${value} ${value === 1 ? "turno" : "turnos"} nesta sessão`;
}

/** O mesmo rótulo, a partir das entradas do histórico. */
export function sessionSummary(entries: readonly SessionTurn[]): string {
  return turnLabel(turnCount(entries));
}

/**
 * Resumo do assistente para o histórico: a fala do plano quando ela veio, ou
 * uma nota curta quando o comando falhou — o histórico nunca deixa a pergunta
 * sem resposta.
 */
export function assistantSummary(speech: string | null | undefined, failure?: string | null): string {
  const spoken = String(speech ?? "").trim();
  if (spoken) return clampContent(spoken);
  const note = String(failure ?? "").trim();
  return note ? clampContent(`Não consegui concluir o comando: ${note}`) : "Não consegui concluir o comando.";
}

/* ── sessão ────────────────────────────────────────────────────────────── */

export interface Session {
  /** Id que o servidor usa como chave do estado da conversa. */
  id: string;
  history: SessionHistory;
  /**
   * Turnos concluídos NESTA sessão, contados desde o começo. Não vem do tamanho
   * do buffer do histórico — quem satura em 20 entradas é o buffer, não o contador.
   */
  turns(): number;
  /**
   * Fecha uma troca: a pergunta e a resposta entram no histórico (capado) e o
   * turno é contado. É o único caminho que mexe no contador — devolve o total.
   */
  completeExchange(question: string, answer: string): number;
}

/**
 * Sessão do carregamento atual da página: id novo + histórico vazio. Vive num
 * ref do App; o próximo F5 chama isto outra vez e começa do zero.
 */
export function createSession(): Session {
  const history = createSessionHistory();
  let turns = 0;

  return {
    id: newSessionId(),
    history,
    turns: () => turns,
    completeExchange(question, answer) {
      history.push("user", question);
      history.push("assistant", answer);
      turns += 1;
      return turns;
    },
  };
}

/** Id de sessão: UUID v4 por carregamento de página, nunca guardado em lugar nenhum. */
export function newSessionId(): string {
  const webCrypto = typeof crypto === "undefined" ? undefined : crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();

  // Reserva para navegador antigo (ou ambiente de teste sem crypto): mesma forma, ainda sem persistir.
  const bytes = new Uint8Array(16);
  if (webCrypto && typeof webCrypto.getRandomValues === "function") webCrypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // versão 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ── voz que respondeu ─────────────────────────────────────────────────── */

/** Rótulo neutro quando o evento não diz qual modelo respondeu. */
export const VOICE_FALLBACK_LABEL = "melhor voz (auto)";

/** true quando o modelo não veio ou veio como "auto": não há id concreto para mostrar. */
export function isAutoModel(model?: string | null): boolean {
  const value = String(model ?? "").trim().toLowerCase();
  return value === "" || value === "auto";
}

/* ── busca por característica ──────────────────────────────────────────── */

/** Consulta da busca: texto solto ou critério estruturado (campo → valor). */
export type SearchQuery = string | Record<string, unknown> | null | undefined;

/**
 * O que os helpers de busca leem. Estrutural de propósito: aceita o `PlanSearch`
 * do contrato e também um evento antigo que só traga `{ query, count }`.
 */
export interface SearchPayload {
  query?: SearchQuery;
  count?: number | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Texto legível da consulta (ex.: { campo: "comment", texto: "nota" } → “campo: comment · texto: nota”). */
export function searchQueryText(query: SearchQuery): string {
  if (typeof query === "string") return query.trim();
  if (!isPlainObject(query)) return "";
  return Object.entries(query)
    .filter(([, value]) => value !== null && value !== undefined && value !== "" && typeof value !== "object")
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}

/**
 * Quantos resultados a busca achou. Os itens recebidos mandam (são o que está na
 * tela); sem eles, vale o `count` do servidor.
 */
export function searchCount(search: SearchPayload | null | undefined, items?: readonly unknown[] | null): number {
  const received = items?.length ?? 0;
  if (received > 0) return received;
  const declared = Number(search?.count);
  return Number.isFinite(declared) && declared > 0 ? Math.trunc(declared) : 0;
}

/** “3 atividades” / “1 atividade”. */
export function activityLabel(total: number): string {
  const value = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  return `${value} ${value === 1 ? "atividade" : "atividades"}`;
}

/** Título do bloco de resultados: “3 atividades com “proposta””. */
export function searchTitle(search: SearchPayload | null | undefined, items?: readonly unknown[] | null): string {
  const total = activityLabel(searchCount(search, items));
  const query = searchQueryText(search?.query);
  return query ? `${total} com “${query}”` : total;
}

/** Chip: “última pesquisa: 3 atividades”. */
export function searchSummary(search: SearchPayload | null | undefined, items?: readonly unknown[] | null): string {
  return `última pesquisa: ${activityLabel(searchCount(search, items))}`;
}

const MATCHED_LABEL: Record<string, string> = {
  name: "nome",
  desc: "descrição",
  comment: "comentário",
  label: "label",
  list: "lista",
};

/** Rótulo pt-BR de um campo; campo que o front ainda não conhece aparece como veio. */
export function matchedFieldLabel(field: MatchedField | string): string {
  return MATCHED_LABEL[String(field)] ?? String(field);
}

/** Chips de um item da listagem: sem repetição e ignorando o que não for texto. */
export function matchedFieldLabels(fields: readonly (MatchedField | string)[] | null | undefined): string[] {
  if (!fields?.length) return [];
  return [...new Set(fields.filter((field): field is string => typeof field === "string").map(matchedFieldLabel))];
}
