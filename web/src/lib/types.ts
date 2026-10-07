/* Tipos compartilhados do front — espelham o contrato da API do servidor. */

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
  provider: string;
  model: string | null;
  warning: string | null;
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
    agent: "openrouter" | "local";
    board: "trello" | "demo";
    models: { stt: string; agent: string };
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
  cardId: string | null;
}

export type Phase =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "confirming"
  | "executing"
  | "speaking"
  | "error";

export interface FeedItem {
  id: number;
  kind: "you" | "plan" | "done" | "error" | "info";
  text: string;
  at: string;
}

export interface ToastData {
  id: number;
  text: string;
  tone: "success" | "error" | "info";
}