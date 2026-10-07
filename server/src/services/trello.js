/**
 * Backend do board: Trello REST v1 (real) ou modo demonstração (in-memory).
 * Ambos expõem as mesmas primitivas — o domínio não sabe qual está ativo.
 *
 * API do Trello: https://developer.atlassian.com/cloud/trello/rest/
 * Autenticação: key + token em query string (?key=...&token=...).
 */
import { config } from "../config.js";
import { request } from "../lib/http.js";
import { AppError, SETUP_GUIDE } from "../lib/errors.js";

const CARD_FIELDS = "name,desc,due,dueComplete,idList,pos,closed,url,idLabels,idChecklists,dateLastActivity";
const norm = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

export function normalizeCard(raw, labelIndex = {}) {
  return {
    id: raw.id,
    idList: raw.idList,
    name: raw.name,
    desc: raw.desc ?? "",
    due: raw.due ?? null,
    dueComplete: Boolean(raw.dueComplete),
    pos: raw.pos ?? 0,
    closed: Boolean(raw.closed),
    url: raw.url ?? `https://trello.com/c/${raw.shortLink ?? raw.id}`,
    labels: (raw.idLabels ?? []).map((id) => labelIndex[id] ?? { id, name: "", color: null }),
    checklists: (raw.checklists ?? []).map((list) => ({
      id: list.id,
      name: list.name,
      items: (list.checkItems ?? []).map((item) => ({ id: item.id, name: item.name, state: item.state })),
    })),
    dateLastActivity: raw.dateLastActivity ?? null,
  };
}

function normalizeBoard(raw, { demo, boardId }) {
  const labelIndex = {};
  const labels = (raw.labels ?? [])
    .filter((label) => label?.id)
    .map((label) => {
      const entry = { id: label.id, name: label.name ?? "", color: label.color ?? null };
      labelIndex[label.id] = entry;
      return entry;
    });

  return {
    id: raw.id ?? boardId,
    name: raw.name ?? "Board",
    url: raw.url ?? "https://trello.com",
    demo,
    lists: (raw.lists ?? [])
      .filter((list) => !list.closed)
      .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
      .map((list) => ({ id: list.id, name: list.name, pos: list.pos ?? 0, closed: Boolean(list.closed) })),
    cards: (raw.cards ?? [])
      .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
      .map((card) => normalizeCard(card, labelIndex)),
    labels,
    members: (raw.members ?? []).map((member) => ({
      id: member.id,
      fullName: member.fullName ?? member.username ?? "",
      username: member.username ?? "",
    })),
  };
}

/* ────────────────────────────── Trello real ────────────────────────────── */

export class TrelloApi {
  constructor(cfg = config.trello) {
    this.cfg = cfg;
    // A API aceita o shortLink (código do URL trello.com/b/<código>) no PATH
    // (GET /boards/{id}), mas NÃO há garantia de resolução em parâmetros de
    // CORPO (ex.: idBoard em POST /lists). Por isso resolvemos o id canónico
    // no primeiro getBoard() e reutilizamos o id completo nos restantes pedidos.
    this.resolvedBoardId = null;
  }

  get kind() {
    return "trello";
  }

  async call(path, { method = "GET", query, body } = {}) {
    try {
      const { data } = await request(`${this.cfg.baseUrl}${path}`, {
        method,
        query: { ...query, key: this.cfg.apiKey, token: this.cfg.token },
        json: body,
        timeoutMs: 20_000,
      });
      return data;
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        throw new AppError("trello_unauthorized", "O Trello recusou as credenciais (key/token).", {
          status: 502,
          hint: `Gere novas credenciais — guia: ${SETUP_GUIDE}`,
          detail: err.detail ?? null,
        });
      }
      if (err?.status === 404) {
        throw new AppError("trello_not_found", "Board/card/lista não encontrado no Trello.", {
          status: 404,
          hint: "Confira TRELLO_BOARD_ID no .env",
          detail: err.detail ?? null,
        });
      }
      throw new AppError("trello_failed", `Falha na API do Trello: ${err.message}`, {
        status: 502,
        detail: err.detail ?? null,
      });
    }
  }

  async listBoards() {
    const data = await this.call("/members/me/boards", {
      query: { fields: "name,url,closed", filter: "open" },
    });
    return (data ?? []).map((board) => ({ id: board.id, name: board.name, url: board.url }));
  }

  async getBoard() {
    const raw = await this.call(`/boards/${encodeURIComponent(this.cfg.boardId)}`, {
      query: {
        fields: "id,name,url",
        lists: "all",
        list_fields: "name,pos,closed",
        cards: "all",
        card_fields: CARD_FIELDS,
        labels: "all",
        members: "all",
        member_fields: "fullName,username",
        checklists: "all",
        checkItem_fields: "name,state",
      },
    });
    // Normaliza o shortLink para o id canónico (vem sempre em `id`).
    this.resolvedBoardId = raw.id ?? this.cfg.boardId;
    const checklistsByCard = {};
    for (const list of raw.checklists ?? []) {
      const idCard = list.idCard ?? list.idBoard;
      (checklistsByCard[idCard] ??= []).push(list);
    }
    raw.cards = (raw.cards ?? []).map((card) => ({ ...card, checklists: checklistsByCard[card.id] ?? [] }));
    return normalizeBoard(raw, { demo: false, boardId: this.cfg.boardId });
  }

  async createCard({ name, desc = "", idList, due = null, pos = "bottom", labels = [] }) {
    const idLabels = await this.resolveLabelIds(labels);
    return normalizeCard(
      await this.call("/cards", {
        method: "POST",
        body: { name, desc, idList, due: due ?? undefined, pos, idLabels: idLabels.join(",") || undefined },
      }),
    );
  }

  async updateCard(id, patch, board = null) {
    const body = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.desc !== undefined) body.desc = patch.desc;
    if (patch.due !== undefined) body.due = patch.due; // null remove o prazo
    if (patch.dueComplete !== undefined) body.dueComplete = patch.dueComplete;
    if (patch.idList !== undefined) body.idList = patch.idList;
    if (patch.pos !== undefined) body.pos = patch.pos;
    if (patch.closed !== undefined) body.closed = patch.closed;

    let updated = null;
    if (Object.keys(body).length > 0) {
      updated = await this.call(`/cards/${encodeURIComponent(id)}`, { method: "PUT", body });
    }

    if (patch.addLabels?.length) {
      const ids = await this.resolveLabelIds(patch.addLabels, board);
      for (const labelId of ids) {
        await this.call(`/cards/${encodeURIComponent(id)}/idLabels`, {
          method: "POST",
          query: { value: labelId },
        });
      }
    }
    if (patch.removeLabels?.length) {
      const boardNow = board ?? (await this.getBoard());
      const card = boardNow.cards.find((c) => c.id === id);
      const wanted = patch.removeLabels.map(norm);
      for (const label of card?.labels ?? []) {
        if (wanted.includes(norm(label.name)) || wanted.includes(norm(label.color))) {
          await this.call(`/cards/${encodeURIComponent(id)}/idLabels/${encodeURIComponent(label.id)}`, {
            method: "DELETE",
          });
        }
      }
    }

    if (patch.addLabels?.length || patch.removeLabels?.length || !updated) {
      updated = await this.call(`/cards/${encodeURIComponent(id)}`, { query: { fields: CARD_FIELDS } });
    }
    return normalizeCard(updated);
  }

  async deleteCard(id) {
    await this.call(`/cards/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async addComment(id, text) {
    await this.call(`/cards/${encodeURIComponent(id)}/actions/comments`, {
      method: "POST",
      body: { text },
    });
  }

  async createList({ name }) {
    return this.call("/lists", {
      method: "POST",
      body: { name, idBoard: this.resolvedBoardId ?? this.cfg.boardId },
    });
  }

  async addChecklistItem(idCard, { checklist = null, text }) {
    const lists = await this.call(`/cards/${encodeURIComponent(idCard)}/checklists`);
    let target = checklist
      ? (lists ?? []).find((list) => norm(list.name) === norm(checklist)) ?? null
      : (lists ?? [])[0] ?? null;
    if (!target) {
      target = await this.call(`/cards/${encodeURIComponent(idCard)}/checklists`, {
        method: "POST",
        body: { name: checklist || "Checklist" },
      });
    }
    await this.call(`/checklists/${encodeURIComponent(target.id)}/checkItems`, {
      method: "POST",
      body: { name: text },
    });
    return this.call(`/cards/${encodeURIComponent(idCard)}`, { query: { fields: CARD_FIELDS } }).then((card) =>
      normalizeCard(card),
    );
  }

  /** Converte nomes/cores de etiqueta em ids reais do board. */
  async resolveLabelIds(labels, board = null) {
    if (!labels?.length) return [];
    const snapshot = board ?? (await this.getBoard());
    const ids = [];
    for (const ref of labels) {
      const needle = norm(ref);
      const match =
        snapshot.labels.find((label) => norm(label.name) === needle) ??
        snapshot.labels.find((label) => norm(label.color) === needle) ??
        snapshot.labels.find((label) => norm(label.name).includes(needle));
      if (match) ids.push(match.id);
    }
    return ids;
  }
}

/* ─────────────────────────── Modo demonstração ─────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

export class DemoBoard {
  constructor() {
    this.state = this.seed();
  }

  get kind() {
    return "demo";
  }

  seed() {
    const lists = [
      { id: "l-ideias", name: "Ideias", pos: 1, closed: false },
      { id: "l-todo", name: "A Fazer", pos: 2, closed: false },
      { id: "l-doing", name: "Fazendo", pos: 3, closed: false },
      { id: "l-done", name: "Feito", pos: 4, closed: false },
    ];
    const labels = [
      { id: "lb-urgente", name: "urgente", color: "red" },
      { id: "lb-bug", name: "bug", color: "orange" },
      { id: "lb-casa", name: "casa", color: "green" },
      { id: "lb-trabalho", name: "trabalho", color: "blue" },
      { id: "lb-ideia", name: "ideia", color: "purple" },
    ];
    const cards = [
      { id: "c-1", idList: "l-ideias", name: "Explorar anéis de Júpiter no visual", desc: "Traço fino + partículas.", due: null, labels: ["lb-ideia"] },
      { id: "c-2", idList: "l-ideias", name: "Playlist para o modo foco", desc: "", due: null, labels: [] },
      { id: "c-3", idList: "l-todo", name: "Revisar proposta do cliente", desc: "Conferir valores e prazos.", due: iso(3), labels: ["lb-trabalho"] },
      { id: "c-4", idList: "l-todo", name: "Comprar cabo HDMI", desc: "", due: iso(1), labels: ["lb-casa"] },
      { id: "c-5", idList: "l-todo", name: "Ligar para o contador", desc: "", due: iso(2), labels: ["lb-trabalho"] },
      { id: "c-6", idList: "l-doing", name: "Montar o board de voz", desc: "STT + MiMo + Trello.", due: iso(0), labels: ["lb-urgente", "lb-trabalho"] },
      { id: "c-7", idList: "l-doing", name: "Escrever o README", desc: "", due: null, labels: [] },
      { id: "c-8", idList: "l-done", name: "Criar o repositório", desc: "", due: iso(-1), dueComplete: true, labels: [] },
    ].map((card, index) => ({
      ...card,
      pos: (index + 1) * 1024,
      closed: false,
      dueComplete: card.dueComplete ?? false,
      url: "https://trello.com/b/demo/demo",
      checklists:
        card.id === "c-6"
          ? [{ id: "ck-1", name: "Entrega", items: [{ id: "ci-1", name: "Gravar voz", state: "complete" }, { id: "ci-2", name: "Confirmar ações", state: "incomplete" }] }]
          : [],
    }));

    return {
      id: "demo-board",
      name: "Board de demonstração",
      url: "https://trello.com",
      lists,
      cards,
      labels,
      members: [{ id: "m-1", fullName: "Você", username: "voce" }],
    };
  }

  async listBoards() {
    return [{ id: "demo-board", name: "Board de demonstração", url: "https://trello.com" }];
  }

  async getBoard() {
    return normalizeBoard(structuredClone(this.state), { demo: true, boardId: "demo-board" });
  }

  nextId(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  }

  async createCard({ name, desc = "", idList, due = null, pos = "bottom", labels = [] }) {
    const listCards = this.state.cards.filter((card) => card.idList === idList);
    const maxPos = Math.max(0, ...listCards.map((card) => card.pos));
    const card = {
      id: this.nextId("c"),
      idList,
      name,
      desc,
      due,
      dueComplete: false,
      pos: pos === "top" ? 1 : maxPos + 1024,
      closed: false,
      url: "https://trello.com/b/demo/demo",
      labels: (labels ?? [])
        .map((ref) => this.state.labels.find((l) => norm(l.name) === norm(ref) || norm(l.color) === norm(ref)))
        .filter(Boolean)
        .map((l) => l.id),
      checklists: [],
      dateLastActivity: new Date().toISOString(),
    };
    this.state.cards.push(card);
    return normalizeCard(structuredClone(card), this.labelIndex());
  }

  labelIndex() {
    return Object.fromEntries(this.state.labels.map((label) => [label.id, label]));
  }

  async updateCard(id, patch) {
    const card = this.state.cards.find((c) => c.id === id);
    if (!card) throw new AppError("unknown_reference", `Card «${id}» não existe no board demo.`, { status: 422 });
    if (patch.name !== undefined) card.name = patch.name;
    if (patch.desc !== undefined) card.desc = patch.desc;
    if (patch.due !== undefined) card.due = patch.due;
    if (patch.dueComplete !== undefined) card.dueComplete = patch.dueComplete;
    if (patch.closed !== undefined) card.closed = patch.closed;
    if (patch.idList !== undefined) {
      card.idList = patch.idList;
      card.pos = patch.pos === "bottom" ? 999999 : 1;
    } else if (patch.pos !== undefined) {
      card.pos = patch.pos === "bottom" ? 999999 : 1;
    }
    if (patch.addLabels?.length) {
      for (const ref of patch.addLabels) {
        const label = this.state.labels.find((l) => norm(l.name) === norm(ref) || norm(l.color) === norm(ref));
        if (label && !card.labels.includes(label.id)) card.labels.push(label.id);
      }
    }
    if (patch.removeLabels?.length) {
      const wanted = patch.removeLabels.map(norm);
      card.labels = card.labels.filter((id) => {
        const label = this.state.labels.find((l) => l.id === id);
        return !label || (!wanted.includes(norm(label.name)) && !wanted.includes(norm(label.color)));
      });
    }
    card.dateLastActivity = new Date().toISOString();
    return normalizeCard(structuredClone(card), this.labelIndex());
  }

  async deleteCard(id) {
    this.state.cards = this.state.cards.filter((card) => card.id !== id);
  }

  async addComment(id, text) {
    const card = this.state.cards.find((c) => c.id === id);
    if (!card) throw new AppError("unknown_reference", `Card «${id}» não existe no board demo.`, { status: 422 });
    (card.comments ??= []).push({ text, at: new Date().toISOString() });
  }

  async createList({ name }) {
    const list = { id: this.nextId("l"), name, pos: this.state.lists.length + 1, closed: false };
    this.state.lists.push(list);
    return { ...list };
  }

  async addChecklistItem(idCard, { checklist = null, text }) {
    const card = this.state.cards.find((c) => c.id === idCard);
    if (!card) throw new AppError("unknown_reference", `Card «${idCard}» não existe no board demo.`, { status: 422 });
    let target = checklist
      ? (card.checklists ?? []).find((list) => norm(list.name) === norm(checklist)) ?? null
      : (card.checklists ?? [])[0] ?? null;
    if (!target) {
      target = { id: this.nextId("ck"), name: checklist || "Checklist", items: [] };
      (card.checklists ??= []).push(target);
    }
    target.items.push({ id: this.nextId("ci"), name: text, state: "incomplete" });
    return normalizeCard(structuredClone(card), this.labelIndex());
  }
}

let backend = null;

/** Backend ativo: Trello real quando há credenciais; senão, demo. */
export function getBackend() {
  if (backend) return backend;
  const hasTrello = Boolean(config.trello.apiKey && config.trello.token && config.trello.boardId);
  backend = hasTrello ? new TrelloApi() : new DemoBoard();
  return backend;
}

export function backendKind() {
  return getBackend().kind;
}