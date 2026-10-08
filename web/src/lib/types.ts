/* Tipos compartilhados do front. Espelham o contrato da API do servidor. */

export interface TList {
  id: string;
  name: string;
  pos: number;
  closed: boolean;
}

export interface TLabel {
  id: string;
  name: string;
  color: string | null;
}

export interface ChecklistItem {
  id: string;
  name: string;
  state: string;
}

export interface Checklist {
  id: string;
  name: string;
  items: ChecklistItem[];
}

export interface TCard {
  id: string;
  idList: string;
  name: string;
  desc: string;
  due: string | null;
  dueComplete: boolean;
  pos: number;
  closed: boolean;
  url: string;
  labels: TLabel[];
  checklists: Checklist[];
  dateLastActivity?: string | null;
}

export interface Board {
  id: string;
  name: string;
  url: string;
  demo: boolean;
  lists: TList[];
  cards: TCard[];
  labels: TLabel[];
  members: { id: string; fullName: string; username: string }[];
}

/* ── decisões do JEV ───────────────────────────────────────────────────── */

export type Band = "auto" | "hitl" | "abstain";

/** Quem planeou o comando: JEV (System One), interpretador local pt-BR ou o LLM (System Two). */
export type PlanProvider = "jev" | "local" | "llm";

export interface Decision {
  id: string;
  label: string;
  type: "choice" | "noul";
  value: string | boolean;
  display: string;
  confidence: number;
  band: Band;
  used?: boolean;
  p?: number;
  top?: { key: string; probability: number }[];
  /** Só nas decisões de card da cascata de listagem: listado com ressalva («talvez»). */
  maybe?: boolean;
}

export interface TraceClause {
  text: string;
  status: "ok" | "abstain";
  code: string | null;
  reason: string | null;
  decisions: Decision[];
}

/** Onde um item bateu numa busca por característica. */
export type MatchedField = "name" | "desc" | "comment" | "label" | "list";

/** Card que a cascata de listagem decidiu mostrar (plan.listing). */
export interface ListingItem {
  id: string;
  name: string;
  list: string;
  due?: string | null;
  /** true = «talvez»: p ≥ JEV_LIST_MAYBE mas abaixo de JEV_LIST_INCLUDE. */
  maybe: boolean;
  /* Campos da busca por característica: todos opcionais — um servidor antigo não os manda. */
  /** Onde a busca casou neste item (vira chip pt-BR no painel). */
  matchedFields?: MatchedField[];
  /** Trecho do campo que casou (descrição/comentário), quando houver. */
  descSnippet?: string;
  /** Nome da lista do card, quando o plano souber (o `list` continua a ser o rótulo curto). */
  listName?: string;
  /** Relevância da busca (maior = melhor), quando o servidor mandar. */
  score?: number;
}

/** Trace da cascata de listagem (trace.jev.listing): colunas → cards em lotes. */
export interface ListingTrace {
  /** Portão de colunas: 1 noul por coluna aberta (id `col_<i>`). */
  columns: Decision[];
  /** Filtro fino: 1 noul por card (id `c_<j>`), em lotes de JEV_CARD_BATCH. */
  cards: Decision[];
  /** Nomes das colunas aprovadas. */
  kept: string[];
  /** Nomes das colunas cortadas no portão. */
  pruned: string[];
  /** true = nenhuma coluna passou o limiar, então passaram todas (recall-first). */
  fallbackColumns: boolean;
  batches: number;
  evaluated: number;
  listed: number;
  maybe: number;
}

export interface JevTrace {
  status: "ok" | "abstain" | "unavailable";
  code: string | null;
  reason: string | null;
  model?: string;
  latencyMs?: number;
  totalMs?: number;
  reusedSocket?: boolean;
  usage?: { input_tokens: number; cost: number };
  clauses: TraceClause[];
  /** Presente apenas quando a intenção é listagem (cascata colunas → cards). */
  listing?: ListingTrace | null;
}

/**
 * Trace do System Two (a melhor voz disponível no servidor): só existe quando a
 * fala tem várias ações e o comando inteiro foi planeado pelo LLM.
 */
export interface LlmTrace {
  status: "ok" | "failed";
  model?: string;
  latencyMs?: number;
  /** Porque falhou (pt-BR), quando `status: "failed"`. */
  reason?: string;
}

export interface PlanTrace {
  /** "llm" = comando composto planeado pelo System Two. */
  engine: PlanProvider;
  totalMs: number;
  /** null quando o comando é claramente composto: o JEV nem chega a ser consultado. */
  jev: JevTrace | null;
  /** Presente apenas em planos "llm" (2..N ações numa só fala). */
  llm?: LlmTrace | null;
}

/* ── plano e ações ─────────────────────────────────────────────────────── */

export interface PlannedAction {
  type: string;
  description: string;
  requiresConfirmation: boolean;
  [key: string]: unknown;
}

/**
 * Busca por característica: `query` é o texto solto ou o critério estruturado
 * que o servidor usou e `count` é quantas atividades ele achou. Os itens vêm em
 * `plan.listing`.
 */
export interface PlanSearch {
  query: string | Record<string, unknown>;
  count: number;
}

export interface Plan {
  speech: string;
  actions: PlannedAction[];
  needsConfirmation: boolean;
  /** "local" = interpretador pt-BR (sem chave OpenRouter); "llm" = System Two (comando composto). */
  provider: PlanProvider;
  model: string | null;
  /** O LLM não devolve confiança: em planos "llm" a banda pode vir null. */
  band: Band | null;
  /** Motivo (pt-BR) quando o JEV se abstém ou está indisponível — é o banner da UI. */
  warning: string | null;
  /** Só em planos de listagem: os cards que a cascata decidiu listar. */
  listing?: ListingItem[];
  /** Opcional: só existe quando o comando foi uma busca por característica. */
  search?: PlanSearch | null;
  trace: PlanTrace;
}

export interface MissingSetup {
  key: string;
  what: string;
  where: string;
  impact: string;
}

export interface StatusPayload {
  capabilities: {
    stt: "openai" | "browser";
    engine: "jev" | "local";
    /** "none" = JEV ativo (não há reserva genérica); "local" = sem chave OpenRouter. */
    fallback: "none" | "local";
    board: "trello" | "demo";
    /** `llm` = System Two: planeia comandos compostos e, no futuro, gera texto em criar/editar. */
    models: { stt: string; jev: string | null; llm?: string | null };
  };
  backend: string;
  boardName: string;
  missing: MissingSetup[];
  guide: string;
}

export interface ActionResult {
  ok: boolean;
  type: string;
  message: string;
  spoken: string;
  cardId: string | null;
}

export type Phase = "idle" | "listening" | "transcribing" | "thinking" | "confirming" | "executing" | "speaking";

export interface FeedItem {
  id: number;
  kind: "you" | "jev" | "plan" | "done" | "error" | "info";
  text: string;
  at: string;
}

/** Linha do pipeline de um comando (voz → System One/Two → Trello). */
export interface PipelineStep {
  key: "stt" | "jev" | "trello";
  state: "idle" | "active" | "done" | "skipped" | "warn" | "failed";
  ms?: number;
  note?: string;
}

export interface ToastData {
  id: number;
  text: string;
  tone: "success" | "error" | "info";
}
