/**
 * Busca de cards por CARACTERÍSTICAS — texto livre (nome + descrição +
 * comentários + etiquetas + lista) combinado com filtros estruturais (lista,
 * etiquetas, estado do prazo, arquivados).
 *
 * Este módulo é PURO de propósito: não importa config/trello nem toca a rede.
 * Recebe o board já lido (readBoard/getBoardCached), os comentários já
 * normalizados (getBoardComments) e o `now` — logo é testável sem fixtures de
 * rede e reaproveitável por qualquer caminho (planner, rotas, busca "última
 * pesquisa").
 *
 * Texto: NFD → sem acentos → minúsculas → pontuação/emoji viram espaço →
 * espaços colapsados. A query é dividida em TERMOS e TODOS precisam casar
 * (AND), cada um em pelo menos um campo do card.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Peso de cada campo quando é o campo de MAIOR peso atingido por um termo. */
const FIELD_WEIGHTS = { name: 3, desc: 2, comment: 1.5, label: 2, list: 2 };
/** Bônus por campo ADICIONAL atingido pelo mesmo termo. */
const EXTRA_FIELD_BONUS = 1;
/** Ordem canónica de `matchedFields` (determinística, independente da query). */
const FIELD_ORDER = ["name", "desc", "comment", "label", "list"];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normaliza texto para comparação tolerante (acentos, caixa, pontuação, emoji).
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const termsOf = (text) => normalizeText(text).split(" ").filter(Boolean);

function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const startOfDay = (ms) => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Modos de prazo honrados. Qualquer outra coisa vira 'any' (sem filtro). */
const DUE_MODES = new Set(["any", "set", "none", "overdue", "today", "week"]);

/** `due` malformado nunca é ignorado em silêncio: normaliza ou vira 'any'. */
function normalizeDue(value) {
  if (typeof value !== "string") return "any";
  const mode = value.trim().toLowerCase();
  return DUE_MODES.has(mode) ? mode : "any";
}

/** `labels` string vira [string]; array tolera itens com { name }. */
function normalizeLabels(value) {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item?.name ?? item ?? "")).filter(Boolean);
}

/** Filtro de prazo. 'today'/'week' usam dias de CALENDÁRIO a partir de `nowMs`. */
function passesDue(due, mode, nowMs) {
  if (mode === "any") return true;
  const dueMs = toMs(due);
  switch (mode) {
    case "set":
      return dueMs !== null;
    case "none":
      return dueMs === null;
    case "overdue":
      return dueMs !== null && dueMs < nowMs;
    case "today":
      return dueMs !== null && startOfDay(dueMs) === startOfDay(nowMs);
    case "week": {
      if (dueMs === null) return false;
      const from = startOfDay(nowMs);
      return dueMs >= from && dueMs < from + 7 * DAY_MS;
    }
    default:
      // inalcançável: normalizeDue já reduziu tudo a DUE_MODES
      return true;
  }
}

function passesLabels(card, wanted) {
  if (!wanted.length) return true;
  const owned = card.labels ?? [];
  const names = owned.map((label) => normalizeText(label?.name)).filter(Boolean);
  const colors = owned.map((label) => normalizeText(label?.color)).filter(Boolean);
  return wanted.every((ref) => {
    const needle = normalizeText(ref);
    if (!needle) return true;
    return (
      names.includes(needle) ||
      colors.includes(needle) ||
      names.some((name) => name.includes(needle))
    );
  });
}

function passesStructure(card, { listName, filters, nowMs }) {
  // arquivados: SÓ o booleano true significa "só eles"; resto = só abertos
  if (Boolean(card.closed) !== filters.archived) return false;

  if (filters.listName) {
    const have = normalizeText(listName);
    if (have !== filters.listName && !have.includes(filters.listName)) return false;
  }

  if (!passesLabels(card, filters.labels)) return false;

  return passesDue(card.due, filters.due, nowMs);
}

/**
 * Pontua um card para os termos da busca.
 * @returns {{score:number, matchedFields:string[]}|null} null = algum termo não casou
 */
function scoreCard(card, { listName, comments, wantedTerms }) {
  const fields = {
    name: normalizeText(card.name),
    desc: normalizeText(card.desc),
    comment: normalizeText(comments.map((comment) => comment.text).join(" \n ")),
    label: normalizeText((card.labels ?? []).map((label) => label?.name).join(" \n ")),
    list: normalizeText(listName),
  };

  const matched = new Set();
  let score = 0;
  for (const term of wantedTerms) {
    const hits = FIELD_ORDER.filter((field) => fields[field] && fields[field].includes(term));
    if (hits.length === 0) return null; // um termo sem match exclui o card (AND)
    for (const field of hits) matched.add(field);
    const base = Math.max(...hits.map((field) => FIELD_WEIGHTS[field]));
    score += base + (hits.length - 1) * EXTRA_FIELD_BONUS;
  }
  return { score, matchedFields: FIELD_ORDER.filter((field) => matched.has(field)) };
}

function compareByScoreThenName(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const nameA = normalizeText(a.name);
  const nameB = normalizeText(b.name);
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0;
}

/**
 * Busca cards do board por características.
 *
 * Tolerante a entrada malformada: `comments`/`query` não-array/não-objeto viram
 * [] / {} e os filtros são COERIDOS (nunca ignorados em silêncio): `labels`
 * string vira [string], `due` é comparado em minúsculas contra os 6 modos
 * válidos (resto → 'any'), `archived` só é true quando é o booleano true.
 * Texto NÃO vazio que normaliza para ZERO termos (CJK, só símbolos/emoji)
 * devolve resultado VAZIO — jamais um "match-all" silencioso.
 *
 * @param {object} params
 * @param {object} params.board   board como readBoard/getBoard devolve (lists[] + cards[])
 * @param {Array}  [params.comments] comentários normalizados de getBoardComments
 * @param {object} [params.query]
 * @param {string} [params.query.text]      termos livres (todos precisam casar)
 * @param {string} [params.query.listName]  nome da lista (comparação normalizada)
 * @param {string[]|string} [params.query.labels]  etiquetas exigidas (TODAS)
 * @param {'any'|'set'|'none'|'overdue'|'today'|'week'} [params.query.due]
 * @param {boolean} [params.query.archived] false (padrão) = só abertos; true = só arquivados
 * @param {number} [params.query.limit]     padrão 50, teto 200
 * @param {Date|string|number} [params.now] relógio injetável (testes)
 * @returns {{items:Array<object>, total:number}}
 */
export function searchCards({ board, comments = [], query = {}, now = new Date() } = {}) {
  const lists = Array.isArray(board?.lists) ? board.lists : [];
  const cards = Array.isArray(board?.cards) ? board.cards : [];
  const commentList = Array.isArray(comments) ? comments : [];
  const q = query && typeof query === "object" && !Array.isArray(query) ? query : {};

  const rawText =
    typeof q.text === "string" ? q.text : q.text === undefined || q.text === null ? "" : String(q.text);
  const wantedTerms = termsOf(rawText);
  // texto com conteúdo REAL que não gera termo nenhum → vazio, nunca tudo
  if (rawText.trim() && wantedTerms.length === 0) return { items: [], total: 0 };

  const filters = {
    archived: q.archived === true,
    listName: q.listName === undefined || q.listName === null ? "" : normalizeText(q.listName),
    labels: normalizeLabels(q.labels),
    due: normalizeDue(q.due),
  };

  const listById = new Map(lists.map((list) => [list.id, list]));
  const commentsByCard = new Map();
  for (const comment of commentList) {
    if (!comment?.cardId) continue;
    const bucket = commentsByCard.get(comment.cardId);
    if (bucket) bucket.push(comment);
    else commentsByCard.set(comment.cardId, [comment]);
  }

  const nowMs = toMs(now) ?? Date.now();
  const limit = clampLimit(q.limit);
  const matches = [];

  for (const card of cards) {
    if (!card) continue;
    const listName = listById.get(card.idList)?.name ?? "";
    if (!passesStructure(card, { listName, filters, nowMs })) continue;

    const scored = scoreCard(card, {
      listName,
      comments: commentsByCard.get(card.id) ?? [],
      wantedTerms,
    });
    if (!scored) continue;

    const item = {
      id: card.id,
      name: card.name ?? "",
      listName,
      labels: (card.labels ?? []).map((label) => label?.name ?? "").filter(Boolean),
      due: card.due ?? null,
      matchedFields: scored.matchedFields,
      score: scored.score,
    };
    if (scored.matchedFields.includes("desc")) {
      item.descSnippet = String(card.desc ?? "").trim().slice(0, 80);
    }
    matches.push(item);
  }

  matches.sort(compareByScoreThenName);
  return { items: matches.slice(0, limit), total: matches.length };
}
