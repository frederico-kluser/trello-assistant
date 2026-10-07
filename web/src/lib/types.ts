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
}

export interface TraceClause {
  text: string;
  status: "ok" | "abstain";
  code: string | null;
  reason: string | null;
  decisions: Decision[];
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
}

export interface PlanTrace {
  engine: "jev" | "mimo" | "local";
  totalMs: number;
  jev: JevTrace | null;
  mimo: { status: "ok" | "failed" | "started"; model?: string; latencyMs?: number; reason?: string } | null;
  fallback: { from: string; to: string; code?: string; reason?: string; mimoReason?: string } | null;
}

/* ── plano e ações ─────────────────────────────────────────────────────── */

export interface PlannedAction {
  type: string;
  description: string;
  requiresConfirmation: boolean;
  [key: string]: unknown;
}

export interface Plan {
  speech: string;
  actions: PlannedAction[];
  needsConfirmation: boolean;
  provider: "jev" | "mimo" | "local" | "local-fallback";
  model: string | null;
  band: Band | null;
  warning: string | null;
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
    engine: "jev" | "mimo" | "local";
    fallback: "mimo" | "local";
    board: "trello" | "demo";
    models: { stt: string; jev: string | null; mimo: string | null };
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
  kind: "you" | "jev" | "mimo" | "plan" | "done" | "error" | "info";
  text: string;
  at: string;
}

/** Linha do pipeline de um comando (voz → JEV → [MiMo] → Trello). */
export interface PipelineStep {
  key: "stt" | "jev" | "mimo" | "trello";
  state: "idle" | "active" | "done" | "skipped" | "warn" | "failed";
  ms?: number;
  note?: string;
}

export interface ToastData {
  id: number;
  text: string;
  tone: "success" | "error" | "info";
}
