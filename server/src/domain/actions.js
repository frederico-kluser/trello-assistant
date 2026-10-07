/**
 * Domínio de ações do Trello — contrato único entre o agente (OpenRouter),
 * o interpretador local e o executor. Toda ação tem forma estável e descrição
 * humana em pt-BR (usada pela fala, pelos toasts e pelo leitor de tela).
 */
import { AppError } from "../lib/errors.js";

export const ACTION_TYPES = Object.freeze({
  create_card: { confirm: true, label: "criar card" },
  delete_card: { confirm: true, label: "apagar card" },
  move_card: { confirm: false, label: "mover card" },
  update_card: { confirm: false, label: "editar card" },
  set_due: { confirm: false, label: "definir prazo" },
  comment_card: { confirm: false, label: "comentar" },
  archive_card: { confirm: false, label: "arquivar card" },
  create_list: { confirm: false, label: "criar lista" },
  add_checklist_item: { confirm: false, label: "adicionar item de checklist" },
});

export function requiresConfirmation(action) {
  return Boolean(ACTION_TYPES[action?.type]?.confirm);
}

const truthy = (value) => value === true || value === "true";

/** Normaliza uma data solta para ISO-8601 (ou null). */
export function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString();
  const raw = String(value).trim();
  if (!raw) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/.exec(raw);
  if (iso) {
    const date = new Date(raw.length === 10 ? `${raw}T12:00:00` : raw);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }

  const br = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(raw);
  if (br) {
    const year = br[3] ? (br[3].length === 2 ? 2000 + Number(br[3]) : Number(br[3])) : new Date().getFullYear();
    const date = new Date(year, Number(br[2]) - 1, Number(br[1]), 12, 0, 0);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function norm(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // pontuação e emojis viram espaço: "Para fazer ( hoje)" ≈ "para fazer hoje",
    // "Fazendo 🎉" ≈ "fazendo" — nomes reais de board não são "limpos".
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve uma referência de card por id, nome exato ou trecho do nome. */
export function findCard(board, ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) throw new AppError("unknown_reference", "Não recebi qual card usar.", { status: 422 });

  const needle = norm(raw);
  const cards = board.cards ?? [];

  const byId = cards.find((card) => card.id === raw);
  if (byId) return byId;

  const pool = cards.filter((card) => !card.closed);
  const exact = pool.filter((card) => norm(card.name) === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw ambiguous("card", raw, exact);

  const partial = pool.filter((card) => norm(card.name).includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw ambiguous("card", raw, partial);

  const inclClosed = cards.filter((card) => norm(card.name).includes(needle));
  if (inclClosed.length === 1) return inclClosed[0];
  if (inclClosed.length > 1) throw ambiguous("card", raw, inclClosed);

  throw new AppError("unknown_reference", `Não encontrei nenhum card chamado «${raw}».`, {
    status: 422,
    detail: { suggestions: cards.slice(0, 6).map((card) => card.name) },
  });
}

/** Resolve uma referência de lista por id, nome exato ou trecho do nome. */
export function findList(board, ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) throw new AppError("unknown_reference", "Não recebi em qual lista.", { status: 422 });

  const needle = norm(raw);
  const lists = (board.lists ?? []).filter((list) => !list.closed);

  const byId = lists.find((list) => list.id === raw);
  if (byId) return byId;

  const exact = lists.filter((list) => norm(list.name) === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw ambiguous("lista", raw, exact);

  const partial = lists.filter((list) => norm(list.name).includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw ambiguous("lista", raw, partial);

  throw new AppError("unknown_reference", `Não encontrei nenhuma lista chamada «${raw}».`, {
    status: 422,
    detail: { suggestions: lists.map((list) => list.name) },
  });
}

function ambiguous(kind, ref, matches) {
  return new AppError(
    "ambiguous_reference",
    `«${ref}» bate com mais de um ${kind}: ${matches.slice(0, 4).map((m) => `«${m.name}»`).join(", ")}.`,
    { status: 422, detail: { candidates: matches.slice(0, 6).map((m) => ({ id: m.id, name: m.name })) } },
  );
}

/** Valida/limpa a lista de ações vinda do agente. */
export function normalizeActions(raw) {
  if (!Array.isArray(raw)) return [];
  const actions = [];
  for (const item of raw) {
    const type = String(item?.type ?? "").trim();
    if (!ACTION_TYPES[type]) continue;
    const action = { type };
    for (const [key, value] of Object.entries(item)) {
      if (key === "type" || value === undefined || value === null || value === "") continue;
      action[key] = value;
    }
    actions.push(action);
  }
  return actions;
}

const formatDate = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return String(iso);
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
};

/** Descrição humana da ação (fala, toast, aria-label). */
export function describeAction(action, board = null) {
  const cardName = (ref) => {
    if (!board) return String(ref ?? "");
    try {
      return findCard(board, ref).name;
    } catch {
      return String(ref ?? "");
    }
  };
  const listName = (ref) => {
    if (!board) return String(ref ?? "");
    try {
      return findList(board, ref).name;
    } catch {
      return String(ref ?? "");
    }
  };

  switch (action.type) {
    case "create_card":
      return `criar o card «${action.name}»${action.list ? ` na lista «${listName(action.list)}»` : ""}${action.due ? ` com prazo ${formatDate(toIsoDate(action.due))}` : ""}`;
    case "delete_card":
      return `apagar definitivamente o card «${cardName(action.card)}»`;
    case "move_card":
      return `mover «${cardName(action.card)}» para «${listName(action.list)}»`;
    case "update_card":
      return `editar o card «${cardName(action.card)}»`;
    case "set_due":
      return action.due
        ? `colocar prazo ${formatDate(toIsoDate(action.due))} em «${cardName(action.card)}»`
        : `remover o prazo de «${cardName(action.card)}»`;
    case "comment_card":
      return `comentar em «${cardName(action.card)}»`;
    case "archive_card":
      return `arquivar o card «${cardName(action.card)}»`;
    case "create_list":
      return `criar a lista «${action.name}»`;
    case "add_checklist_item":
      return `adicionar «${action.text}» ao checklist de «${cardName(action.card)}»`;
    default:
      return `executar «${action.type}»`;
  }
}

/**
 * Executa uma única ação contra o backend (Trello real ou modo demo).
 * Lança AppError com mensagem em pt-BR quando algo não bate.
 */
export async function applyAction(action, { board, backend }) {
  switch (action.type) {
    case "create_card": {
      const name = String(action.name ?? "").trim();
      if (!name) throw new AppError("bad_request", "O card precisa de um nome.", { status: 422 });
      const list = action.list ? findList(board, action.list) : board.lists.find((l) => !l.closed);
      if (!list) throw new AppError("unknown_reference", "O board não tem nenhuma lista aberta.", { status: 422 });
      const card = await backend.createCard({
        name,
        desc: action.desc ? String(action.desc) : "",
        idList: list.id,
        due: toIsoDate(action.due),
        pos: action.position === "top" || action.position === "bottom" ? action.position : "bottom",
        labels: Array.isArray(action.labels) ? action.labels : [],
      });
      return { type: action.type, message: describeAction(action, board), card, list };
    }

    case "delete_card": {
      const card = findCard(board, action.card);
      await backend.deleteCard(card.id);
      return { type: action.type, message: describeAction(action, board), card };
    }

    case "move_card": {
      const card = findCard(board, action.card);
      const list = findList(board, action.list);
      const updated = await backend.updateCard(card.id, {
        idList: list.id,
        pos: action.position === "top" || action.position === "bottom" ? action.position : "top",
      });
      return { type: action.type, message: describeAction(action, board), card: updated ?? card, list };
    }

    case "update_card": {
      const card = findCard(board, action.card);
      const patch = {};
      if (action.name) patch.name = String(action.name);
      if (action.desc !== undefined) patch.desc = String(action.desc ?? "");
      if (action.add_labels) patch.addLabels = Array.isArray(action.add_labels) ? action.add_labels : [action.add_labels];
      if (action.remove_labels) patch.removeLabels = Array.isArray(action.remove_labels) ? action.remove_labels : [action.remove_labels];
      const updated = await backend.updateCard(card.id, patch);
      return { type: action.type, message: describeAction(action, board), card: updated ?? card };
    }

    case "set_due": {
      const card = findCard(board, action.card);
      const due = toIsoDate(action.due);
      const patch = { due };
      if (action.due_complete !== undefined) patch.dueComplete = truthy(action.due_complete);
      const updated = await backend.updateCard(card.id, patch);
      return { type: action.type, message: describeAction(action, board), card: updated ?? card };
    }

    case "comment_card": {
      const card = findCard(board, action.card);
      const text = String(action.text ?? "").trim();
      if (!text) throw new AppError("bad_request", "O comentário está vazio.", { status: 422 });
      await backend.addComment(card.id, text);
      return { type: action.type, message: describeAction(action, board), card };
    }

    case "archive_card": {
      const card = findCard(board, action.card);
      const updated = await backend.updateCard(card.id, { closed: true });
      return { type: action.type, message: describeAction(action, board), card: updated ?? card };
    }

    case "create_list": {
      const name = String(action.name ?? "").trim();
      if (!name) throw new AppError("bad_request", "A lista precisa de um nome.", { status: 422 });
      const list = await backend.createList({ name });
      return { type: action.type, message: describeAction(action, board), list };
    }

    case "add_checklist_item": {
      const card = findCard(board, action.card);
      const text = String(action.text ?? "").trim();
      if (!text) throw new AppError("bad_request", "O item do checklist está vazio.", { status: 422 });
      const updated = await backend.addChecklistItem(card.id, {
        checklist: action.checklist ? String(action.checklist) : null,
        text,
      });
      return { type: action.type, message: describeAction(action, board), card: updated ?? card };
    }

    default:
      throw new AppError("bad_request", `Ação desconhecida: ${action.type}`, { status: 422 });
  }
}