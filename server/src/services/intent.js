/**
 * Interpretador local de comandos (pt-BR) — fallback offline do agente.
 * Cobre o vocabulário essencial do Trello: criar, apagar, mover, editar,
 * prazo, comentário, arquivar, lista e checklist. É o que mantém o app
 * utilizável enquanto não há chave do OpenRouter.
 */
import { normalizeActions, requiresConfirmation, toIsoDate } from "../domain/actions.js";

const norm = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const WEEKDAYS = {
  domingo: 0, seg: 1, segunda: 1, terca: 2, ter: 2, quarta: 3, qua: 3,
  quinta: 4, qui: 4, sexta: 5, sex: 5, sabado: 6, sab: 6,
};

const MONTHS = {
  janeiro: 0, fevereiro: 1, marco: 2, abril: 3, maio: 4, junho: 5,
  julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
};

/** Frase de data inteira (para removê-la de um comando sem mutilar o nome). */
export const DATE_PHRASE_RE =
  /\b(?:amanh[ãa]|hoje|depois de amanh[ãa]|semana que vem|m[êe]s que vem|fim de semana|pr[óo]xim[ao]s?\s+(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|semana|m[êe]s)|dia \d{1,2}|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?|\d{1,2} de [a-z]+|(?:pr[óo]xima |na |no )?(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?(?: que vem)?)(?:\s*(?:[àa]s)?\s*\d{1,2}h\d{0,2})?/gi;

const KEYWORD_DATE_RE = /\b(?:prazo|vencimento|data|entrega|due|due date|coloca (?:uma )?data|marca (?:uma )?data|vence)\b/i;

/**
 * Converte expressões de data pt-BR em ISO-8601. Retorna null se não achar.
 * Prazos futuros ficam às 12h (hora local) do dia pedido; "hoje" às 23h, para
 * não nascer atrasado. O `now` injetável existe para os testes.
 */
export function parsePtDate(fragment, now = new Date()) {
  const text = norm(fragment);
  if (!text) return null;

  const at = (year, month, day, hour = 12) => {
    const date = new Date(year, month, day, hour, 0, 0, 0);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  };
  const inDays = (days) => at(now.getFullYear(), now.getMonth(), now.getDate() + days);

  if (/\bhoje\b/.test(text)) return at(now.getFullYear(), now.getMonth(), now.getDate(), 23);
  if (/depois de amanha/.test(text)) return inDays(2);
  if (/\bamanha\b/.test(text)) return inDays(1);

  const relative = /\b(?:daqui a|em)\s+(\d{1,3})\s+(dias?|semanas?)\b/.exec(text);
  if (relative) return inDays(Number(relative[1]) * (relative[2].startsWith("semana") ? 7 : 1));
  if (/(?:semana que vem|proxima semana)/.test(text)) return inDays(7);
  if (/(?:mes que vem|proximo mes)/.test(text)) return at(now.getFullYear(), now.getMonth() + 1, now.getDate());

  if (/fim de semana/.test(text)) {
    const delta = (6 - now.getDay() + 7) % 7 || 7;
    return inDays(delta);
  }

  const weekdayMatch =
    /(?:proxim[ao]s?\s+|na\s+|no\s+)?\b(domingo|segunda-feira|segunda|terca-feira|terca|quarta-feira|quarta|quinta-feira|quinta|sexta-feira|sexta|sabado|sab)\b(?:\s+que vem)?/.exec(
      text,
    );
  if (weekdayMatch) {
    const target = WEEKDAYS[weekdayMatch[1].replace(/-feira$/, "")];
    const nextWeek = /que vem|proxim/.test(weekdayMatch[0]) ? 7 : 0;
    let delta = (target - now.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    return inDays(delta + nextWeek);
  }

  const monthMatch = /(?:dia\s+)?(\d{1,2})\s*(?:de|\/)\s*([a-z]+|\d{1,2})(?:\s*(?:de|\/)\s*(\d{4}))?/.exec(text);
  if (monthMatch) {
    const day = Number(monthMatch[1]);
    const monthToken = norm(monthMatch[2]);
    const month = MONTHS[monthToken] ?? (Number.isFinite(Number(monthToken)) ? Number(monthToken) - 1 : null);
    const year = monthMatch[3] ? Number(monthMatch[3]) : now.getFullYear();
    if (month !== null && day >= 1 && day <= 31) return at(year, month, day);
  }

  // "dia 20" sozinho: este mês se ainda não passou, senão o próximo.
  const dayOnly = /\bdia\s+(\d{1,2})\b/.exec(text);
  if (dayOnly) {
    const day = Number(dayOnly[1]);
    if (day >= 1 && day <= 31) {
      const nextMonth = day < now.getDate();
      return at(now.getFullYear(), now.getMonth() + (nextMonth ? 1 : 0), day);
    }
  }

  return toIsoDate(fragment);
}

/** Remove artigo + sinônimos de "card" + conectores de referência. */
export const cleanRef = (value) => {
  const original = String(value ?? "").trim();
  const stripped = original
    .replace(/^(no |na |do |da |em |para |pra |ate |até |de |o |um |uma |os |as )+/i, "")
    .replace(/^(card|cartao|tarefa|item)(\s+(chamado|de nome|com o nome|intitulado))?\s*/i, "")
    .replace(/\s+(por favor|pfv|pf|fav|no trello|no board|do board|do trello|ai|aí)\s*$/i, "")
    .replace(/^["'“”«»]+|["'“”«»]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || original;
};

/** "X para Y" / "X em Y" → { from, to } (ou null). */
function splitPair(fragment, connectors = ["para", "pra", "em", "no", "na", "ate", "até"]) {
  const text = String(fragment ?? "").trim();
  const pattern = new RegExp(`^(.+?)\\s+(?:${connectors.join("|")})\\s+(.+)$`, "i");
  const match = pattern.exec(text);
  if (!match) return null;
  return { from: cleanRef(match[1]), to: cleanRef(match[2]) };
}

export function describeShort(action) {
  switch (action.type) {
    case "create_card":
      return `criar o card «${action.name}»${action.list ? ` na lista «${action.list}»` : ""}`;
    case "delete_card":
      return `apagar definitivamente o card «${action.card}»`;
    case "move_card":
      return `mover «${action.card}» para «${action.list}»`;
    case "update_card":
      return `editar o card «${action.card}»`;
    case "set_due":
      if (action.due) return `colocar prazo em «${action.card}»`;
      if (action.due_complete !== undefined) {
        return action.due_complete === true || action.due_complete === "true"
          ? `marcar «${action.card}» como concluído`
          : `reabrir «${action.card}»`;
      }
      return `remover o prazo de «${action.card}»`;
    case "comment_card":
      return `comentar em «${action.card}»`;
    case "archive_card":
      return `arquivar o card «${action.card}»`;
    case "create_list":
      return `criar a lista «${action.name}»`;
    case "add_checklist_item":
      return `adicionar «${action.text}» ao checklist de «${action.card}»`;
    default:
      return `executar ${action.type}`;
  }
}

export function describeBoard(board) {
  const parts = (board.lists ?? []).map((list) => {
    const cards = (board.cards ?? []).filter((card) => card.idList === list.id && !card.closed);
    return `${list.name} com ${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
  });
  return `No board ${board.name} você tem ${parts.join(", ")}.`;
}

/** Parser principal — devolve o mesmo formato do agente OpenRouter. */
export function parseTranscriptLocally(transcript, board = { lists: [], cards: [], name: "" }) {
  const raw = String(transcript ?? "").trim();
  const t = norm(raw);

  if (!raw) {
    return { speech: "Não ouvi nada. Pode repetir?", actions: [], needsConfirmation: false };
  }

  const actions = [];

  /* Consultas de informação — sem ações. */
  if (/(o que (eu )?(tenho|fazer)|quais (sao|são) (os|meus)|meus cards|mostra|lista (os|meus)|resumo|como (esta|está) o board)/.test(t)) {
    return { speech: describeBoard(board), actions: [], needsConfirmation: false };
  }

  /* ── criar card ───────────────────────────────────────────── */
  const createMatch = /\b(cria[r]?|crie|adiciona[r]?|inclui[r]?|faz um card|novo card|nova tarefa|coloca um card)\b/i.exec(raw);
  const isListRequest = /\b(cria[r]?|crie|adiciona[r]?|inclui[r]?)\w*\s+(uma\s+)?lista\b/i.test(raw);
  if (createMatch && !isListRequest && !/\b(nao|não)\b/i.test(raw)) {
    let rest = raw.slice(createMatch.index + createMatch[1].length);
    rest = rest.replace(/^(um|uma|o|a)?\s*(card|cartao|tarefa|item)?\s*(chamado|de nome|com o nome|intitulado)?\s*/i, "");

    const due = parsePtDate(rest) ?? parsePtDate(raw);
    rest = rest
      .replace(/\b(com|com o|com a)?\s*(prazo|data|vencimento|entrega)\s*(de|para|pra|em|no|na|ate|até|:)?/gi, " ")
      .replace(DATE_PHRASE_RE, " ")
      .replace(/\s+/g, " ")
      .trim();

    let list = null;
    const listMatch = /\s+(?:na|em|pra|para|no|dentro d[ao])\s+(?:lista\s+)?(.+)$/i.exec(rest);
    if (listMatch) {
      list = cleanRef(listMatch[1]);
      rest = rest.slice(0, listMatch.index).trim();
    }

    const name = cleanRef(rest) || cleanRef(raw);
    if (name) {
      const action = { type: "create_card", name };
      if (list) action.list = list;
      if (due) action.due = due;
      actions.push(action);
    }
  }

  /* ── apagar card ──────────────────────────────────────────── */
  if (!actions.length) {
    const deleteMatch = /\b(apaga[r]?|apague|deleta[r]?|delete|remove[r]?|remova|exclui[r]?|exclua|risca[r]?|corta[r]?)(?!\s+(a\s+)?(data|prazo))/i.exec(raw);
    if (deleteMatch) {
      const name = cleanRef(raw.slice(deleteMatch.index + deleteMatch[1].length));
      if (name) actions.push({ type: "delete_card", card: name, reason: "pedido por voz" });
    }
  }

  /* ── mover card ───────────────────────────────────────────── */
  if (!actions.length) {
    const moveMatch = /\b(move[r]?|mova|muda[r]?|mude|joga[r]?|jogue|passa[r]?|passe|transferir?|transfira)\b/i.exec(raw);
    if (moveMatch) {
      const rest = raw.slice(moveMatch.index + moveMatch[1].length).replace(/^\s*d[oeoa]+\s*card\s*/i, "");
      const pair = splitPair(rest);
      if (pair?.from && pair?.to) {
        actions.push({ type: "move_card", card: pair.from, list: pair.to });
      }
    }
  }

  /* ── prazo / data ─────────────────────────────────────────── */
  if (!actions.length) {
    const dueMatch = KEYWORD_DATE_RE.exec(raw);
    if (dueMatch) {
      const rest = raw.slice(dueMatch.index);
      const due = parsePtDate(rest);
      if (due) {
        const cleaned = rest
          .replace(/^(coloca|marca|defina|define|bota|adiciona|adicione|add)?\s*(uma\s+)?(data|prazo|vencimento|entrega|due|due date)\s*(de|para|pra|em|no|na|ate|até|:)?/i, " ")
          .replace(DATE_PHRASE_RE, " ")
          .replace(/\s+/g, " ")
          .trim();
        const cardRef = cleanRef(cleaned) || cleanRef(raw.replace(KEYWORD_DATE_RE, " ").replace(DATE_PHRASE_RE, " "));
        if (cardRef) actions.push({ type: "set_due", card: cardRef, due });
      }
    }
  }

  /* ── marcar prazo como concluído ──────────────────────────── */
  if (!actions.length) {
    const doneMatch = /(marca|marcar|conclui|concluir|finaliza|finalizar|pronta|pronto|feita|feito|done).*(como (feita|pronta|concluida|concluída|done)|done)/i.exec(raw);
    if (doneMatch) {
      const cardRef = cleanRef(raw.replace(doneMatch[0], " "));
      if (cardRef) actions.push({ type: "set_due", card: cardRef, due_complete: true });
    }
  }

  /* ── comentar ─────────────────────────────────────────────── */
  if (!actions.length) {
    const commentMatch = /\b(comenta[r]?|comente|anota[r]?|anote|nota[r]?|observa[r]?|observ)/i.exec(raw);
    if (commentMatch) {
      const rest = raw.slice(commentMatch.index + commentMatch[1].length);
      const quoted = /["'“”«»]([^"'“”«»]+)["'“”«»]/.exec(rest);
      const text = quoted ? quoted[1] : "";
      const inCard = /(no card|no cartao|na tarefa|do card|de)\s+(.+)$/i.exec(rest);
      if (inCard && text) {
        actions.push({ type: "comment_card", card: cleanRef(inCard[2]), text });
      }
    }
  }

  /* ── arquivar ─────────────────────────────────────────────── */
  if (!actions.length) {
    const archiveMatch = /\b(arquiva[r]?|arquive|encerra[r]?|encerre|joga no lixo|manda para o arquivo)/i.exec(raw);
    if (archiveMatch) {
      const name = cleanRef(raw.slice(archiveMatch.index + archiveMatch[1].length));
      if (name) actions.push({ type: "archive_card", card: name });
    }
  }

  /* ── criar lista ──────────────────────────────────────────── */
  if (!actions.length) {
    const listMatch = /\b(cria[r]?|crie|adiciona[r]?|adicionar)\s+(uma\s+)?lista\s+(chamada\s+|de nome\s+|com o nome\s+)?(.+)/i.exec(raw);
    if (listMatch) {
      const name = cleanRef(listMatch[4]);
      if (name) actions.push({ type: "create_list", name });
    }
  }

  /* ── checklist ────────────────────────────────────────────── */
  if (!actions.length) {
    const checkMatch = /\b(adiciona[r]?|adicionar|coloca[r]?|inclui[r]?|anota[r]?)\s+(.+?)\s+(no|ao|na|à)\s+checklist\s*(de|do|da)?\s*(.*)/i.exec(raw);
    if (checkMatch) {
      const text = cleanRef(checkMatch[2]);
      const cardRef = cleanRef(checkMatch[6]);
      if (text && cardRef) actions.push({ type: "add_checklist_item", card: cardRef, checklist: null, text });
    }
  }

  const normalized = normalizeActions(actions);

  if (!normalized.length) {
    return {
      speech:
        "Não tenho certeza do que fazer com isso. Tente algo como: «cria um card revisar proposta na lista a fazer», «move revisar proposta para fazendo» ou «coloca prazo amanhã no card revisar proposta».",
      actions: [],
      needsConfirmation: false,
    };
  }

  const speech = `Vou ${normalized.map((action) => describeShort(action)).join(" e ")}.`;
  const warning = normalized.some((action) => action.type === "delete_card")
    ? "Essa ação é definitiva e não dá para desfazer."
    : "";

  return {
    speech: warning ? `${speech} ${warning}` : speech,
    actions: normalized,
    needsConfirmation: normalized.some(requiresConfirmation),
  };
}