/**
 * Orquestrador do plano: System Two (compostos e buscas por característica) →
 * JEV → interpretador local.
 *
 *  1. Comandos SIMULTÂNEOS (a fala tem 2+ cláusulas com verbo de comando),
 *     BUSCAS POR CARACTERÍSTICA (comentário/descrição/prazo/etiqueta) e
 *     REFERÊNCIAS À ÚLTIMA PESQUISA ("essas atividades", "os da última
 *     pesquisa") vão ao System Two (planWithMimo) — mesmo de uma cláusula só
 *     (ver `isCharacteristicSearch` e `isLastSearchReference`), porque o JEV não
 *     tem contexto de sessão. O System Two planeja o comando INTEIRO: várias
 *     ações numa só fala saem num plano único, na ordem pedida.
 *  2. Comandos ÚNICOS são do JEV (System One): ele classifica e resolve a
 *     cláusula numa cascata (intenção CRUD → colunas → cards), e o plano sai
 *     pronto. Se ele se abstém com `compound` (um trecho que afinal juntava 2+
 *     ações), o System Two recebe o comando inteiro.
 *  3. As restantes abstenções (clareza, card, lista, indisponibilidade) NÃO têm
 *     fallback genérico: respondemos com `actions: []`, banda `abstain`,
 *     `warning` com o motivo e uma fala de esclarecimento. Se o próprio System
 *     Two falhou num composto, o `warning` diz isso e ainda tentamos o JEV por
 *     cláusulas (compostos limpos podem sair por lá).
 *  4. Sem chave OpenRouter (JEV desligado), o interpretador local pt-BR mantém o
 *     app vivo.
 *
 * ESTADO DA SESSÃO (nos dois motores):
 *   • toda resposta com listagem (a cascata do JEV incluída) guarda a "última
 *     pesquisa" — ids + consulta — no session-store;
 *   • a ação de LEITURA `search_cards` (vocabulário do LLM) é executada aqui
 *     contra nome + descrição + comentários e vira `listing` + `search` + fala
 *     determinística — nunca chega ao executor do domínio;
 *   • `card: "@lastSearch"` expande-se numa ação por card guardado, com o nome
 *     real do board (ou cai com warning, se não há pesquisa anterior).
 *
 * O `trace` devolvido alimenta o painel "Decisões" da UI: o que o JEV decidiu,
 * com que confiança, por que (não) operou e quanto tempo cada degrau levou.
 * `trace.llm` é o degrau do System Two; as chaves `mimo` e `fallback` ficam
 * sempre `null` (compatibilidade da UI).
 */
import { performance } from "node:perf_hooks";
import { config } from "../config.js";
import { LISTING_CAP, splitClauses, planWithJev } from "./jev-planner.js";
import { SEARCH_ACTION, planWithMimo } from "./agent.js";
import { parseTranscriptLocally } from "./intent.js";
import { describeAction, normalizeActions, requiresConfirmation } from "../domain/actions.js";
import { getBoardCached, getCommentsCached } from "./board-cache.js";
import { searchCards } from "./search-engine.js";
import { sessionStore } from "./session-store.js";
import { getResolvedModel } from "./model-picker.js";

const ms = (since) => Math.round(performance.now() - since);

/* ── pré-roteador determinístico: busca por CARACTERÍSTICA ────────────── */

/**
 * Pedido que só o System Two resolve bem: procurar cards por uma
 * CARACTERÍSTICA do conteúdo (comentário, descrição, menção), por prazo ou por
 * etiqueta. O JEV só vê nome/coluna/etiquetas/prazo do card — nunca os
 * comentários — e abster-se-ia; o LLM transforma a característica num
 * `search_cards` que o planner executa contra nome + descrição + comentários.
 *
 * Recall-first: o regex de TERMO é largo e o de VERBO cobre listar/mostrar/
 * buscar/perguntar. Um falso positivo só custa uma ida ao LLM (que também sabe
 * fazer CRUD); um falso negativo devolve abstenção ao utilizador.
 */
export const SEARCH_TERM_RE =
  /\b(?:coment|descri|descrit|descrev|mencion|men[çc][ãa]o|atras|venc|prazo|etiqueta|label|marcador|due\b|fal(?:a|am|ando|ou)\s+(?:sobre|de|do|da))/i;
export const SEARCH_VERB_RE =
  /\b(?:list|mostr|exib|busc|pesquis|procur|encontr|filtr|selecion|quant|existe|tem\b|t[êe]m\b|h[áa]\b|ver\b|v[êe]\b|qual\b|quai[st]\b|o que\b|quem\b|onde\b)/i;
/** "na lista X" / "para a lista Y" é o SUBSTANTIVO lista, não o verbo "listar". */
const LIST_NOUN_RE = /\b(?:n[ao]s?|d[ao]s?|para|pra|à|a|ness[ae]|nest[ae]|dess[ae]|dest[ae]|em)\s+(?:uma\s+|a\s+)?lista\b/gi;

/** O comando (qualquer trecho) é uma busca por característica? */
export function isCharacteristicSearch(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  if (!SEARCH_TERM_RE.test(raw)) return false;
  return SEARCH_VERB_RE.test(raw.replace(LIST_NOUN_RE, " "));
}

/* ── pré-roteador determinístico: referência à ÚLTIMA PESQUISA ────────── */

/**
 * Frases que apontam para as atividades da ÚLTIMA PESQUISA da sessão ("essas
 * atividades", "os da última pesquisa", "todos eles"…). O JEV não tem contexto
 * de sessão: mandado para lá, ele faz uma listagem NOVA do board inteiro e
 * substitui a pesquisa guardada — exatamente o que o follow-up não quer. Estas
 * falas vão ao System Two, que recebe a ÚLTIMA PESQUISA na mensagem e sabe
 * responder (ou emitir `card: "@lastSearch"`).
 *
 * Testado sobre o texto SEM acentos e em minúsculas (ver `flatten`).
 */
export const LAST_REF_RE =
  /(?:@\s*(?:lastsearch|pesquisa)|ultim[ao]s?\s+(?:pesquisa|busca)|resultados?\s+anterior(?:es)?|resultados?\s+d[ae]\s+ultim[ao]|ess[ae]s?\s+atividades?|(?:ess[ae]s?|est[ae]s?|aquel[ae]s?|dest[ae]s?|nest[ae]s?)\s+cards?|tod[ao]s?\s+(?:el[ae]s?|ess[ae]s?)|os\s+resultados?)/;

/** Minúsculas e sem acentos: "ÚLTIMA PESQUISA" → "ultima pesquisa". */
const flatten = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** O comando (qualquer trecho) fala das atividades da última pesquisa? */
export function isLastSearchReference(text) {
  const flat = flatten(text);
  return Boolean(flat.trim()) && LAST_REF_RE.test(flat);
}

/* ── busca por característica: ação de LEITURA executada aqui ─────────── */

/** Item no formato do ListingItem da UI, com os campos novos (opcionais) a mais. */
export function toListingItem(item = {}) {
  const list = item.listName ?? item.list ?? "?";
  const listing = {
    id: String(item.id ?? ""),
    name: String(item.name ?? ""),
    list,
    due: item.due ? String(item.due).slice(0, 10) : null,
    maybe: false,
  };
  if (item.listName) listing.listName = item.listName;
  if (Array.isArray(item.labels) && item.labels.length) listing.labels = item.labels;
  if (Array.isArray(item.matchedFields) && item.matchedFields.length) listing.matchedFields = item.matchedFields;
  if (item.descSnippet) listing.descSnippet = item.descSnippet;
  if (Number.isFinite(item.score)) listing.score = item.score;
  return listing;
}

/** Fala determinística da busca: "Encontrei N atividades: A, B e C." */
export function searchSpeech(listing = [], { cap = LISTING_CAP } = {}) {
  const total = listing.length;
  if (!total) return "Não encontrei nenhuma atividade com essas características.";
  const names = listing.slice(0, cap).map((item) => item.name);
  const spoken = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
  const head = `Encontrei ${total} ${total === 1 ? "atividade" : "atividades"}: ${spoken}.`;
  const rest = total - names.length;
  return rest > 0 ? `${head} E mais ${rest}.` : head;
}

/** Executa um `search_cards`: board + comentários → motor de busca. Read-only. */
async function runSearchAction(action) {
  const query = {};
  if (action.text) query.text = action.text;
  if (action.listName) query.listName = action.listName;
  if (Array.isArray(action.labels) && action.labels.length) query.labels = action.labels;
  if (action.due) query.due = action.due;
  // O board da busca é o MESMO que a UI vê (cache do app), não um snapshot do chamador.
  const board = await getBoardCached();
  const comments = await getCommentsCached();
  const found = await searchCards({ board, comments, query, now: Date.now() });
  const listing = (found?.items ?? []).map(toListingItem);
  return { listing, query, total: Number.isFinite(found?.total) ? found.total : listing.length };
}

/** Separa as ações de escrita das buscas (executadas já) preservando a ordem falada. */
async function runSearchActions(actions) {
  const writes = [];
  const listing = [];
  let search = null;
  let query = null;
  for (const action of actions ?? []) {
    if (action?.type !== SEARCH_ACTION) {
      writes.push(action);
      continue;
    }
    const result = await runSearchAction(action);
    listing.push(...result.listing);
    query = result.query;
    search = { query: result.query, count: result.total };
  }
  return { actions: writes, listing, search, query };
}

/**
 * Consulta guardada de uma listagem do JEV: a TRACE da cascata (colunas que
 * passaram, contagens) — nunca o texto cru do comando.
 */
export function listingTraceQuery(trace) {
  return {
    source: "jev-listing",
    kept: trace?.kept ?? [],
    pruned: trace?.pruned ?? [],
    gateNote: trace?.gateNote ?? null,
    listed: trace?.listed ?? 0,
    maybe: trace?.maybe ?? 0,
  };
}

/* ── última pesquisa como estado acionável ───────────────────────────── */

/** Aviso (e fala) quando o comando aponta para uma pesquisa que NÃO existe. */
export const MISSING_SEARCH_NOTE = "não há pesquisa anterior nesta sessão.";
export const MISSING_SEARCH_SPEECH =
  "Não há pesquisa anterior nesta sessão. Faça uma busca primeiro — por exemplo, «quais cards têm comentários sobre pagamento?» — e depois peça para agir sobre elas.";

/** Marcadores que o modelo usa para dizer "os cards da última pesquisa". */
const LAST_SEARCH_REFS = new Set([
  "@lastsearch",
  "@last search",
  "@pesquisa",
  "@ultima pesquisa",
  "@ultima-pesquisa",
  "ultima pesquisa",
  "ultima busca",
  "pesquisa anterior",
  "busca anterior",
  "lastsearch",
]);

/** `card` aponta para a última pesquisa? (aceita @lastSearch, "última pesquisa"…) */
export function isLastSearchRef(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return false;
  const flat = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
  return LAST_SEARCH_REFS.has(flat);
}

/**
 * Expande `card: "@lastSearch"` em UMA ação por card guardado, com o NOME real
 * resolvido no board (é por nome que o executor resolve o card). Sem pesquisa
 * anterior (ou sem cards vivos), a ação cai e explica-se no `onDrop`.
 */
export function expandLastSearch(actions = [], { board, lastSearch = null, onDrop = () => {} } = {}) {
  const ids = Array.isArray(lastSearch?.ids) ? lastSearch.ids : [];
  const nameOf = new Map((board?.cards ?? []).map((card) => [card.id, card.name]));
  const out = [];
  for (const action of actions) {
    if (!isLastSearchRef(action?.card)) {
      out.push(action);
      continue;
    }
    if (!ids.length) {
      onDrop(lastSearch ? "a última pesquisa não encontrou nenhum card nesta sessão." : MISSING_SEARCH_NOTE);
      continue;
    }
    const resolved = ids.filter((id) => nameOf.has(id));
    if (!resolved.length) {
      onDrop("os cards da última pesquisa já não estão no quadro.");
      continue;
    }
    for (const id of resolved) out.push({ ...action, card: nameOf.get(id) });
  }
  return out;
}

export async function planCommand({ transcript, board, context = {}, onEvent = () => {} }) {
  const started = performance.now();
  const text = String(transcript ?? "").trim();
  const trace = { engine: "local", totalMs: 0, jev: null, mimo: null, fallback: null, llm: null };
  const sessionId = typeof context.sessionId === "string" && context.sessionId.trim() ? context.sessionId.trim() : null;
  // A última pesquisa desta sessão: o que os follow-ups ("essas atividades") usam.
  // `let` porque uma busca DESTE comando passa a ser "a última" já na expansão.
  let lastSearch = context.lastSearch ?? (sessionId ? sessionStore.getLastSearch(sessionId) : null);
  const notes = [];
  // O comando fala das atividades da última pesquisa? (ver `isLastSearchReference`)
  const lastRef = isLastSearchReference(text);

  if (!text) {
    return {
      speech: "Não ouvi nada. Pode repetir?",
      actions: [],
      needsConfirmation: false,
      provider: "local",
      model: null,
      warning: null,
      band: null,
      trace,
    };
  }

  const finish = (result) => {
    // "@lastSearch" vira uma ação por card guardado (com o nome REAL do board).
    const actions = expandLastSearch(result.actions ?? [], {
      board,
      lastSearch,
      onDrop: (reason) => notes.push(reason),
    });
    // Referência à última pesquisa e NENHUMA pesquisa (nem a deste plano): a
    // resposta é determinística — nada de o JEV inventar uma listagem nova do
    // board inteiro. (Avaliado AQUI: uma busca do próprio plano já preencheu
    // `lastSearch` em `rememberSearch`.)
    const semPesquisa = lastRef && !lastSearch;
    if (semPesquisa && !notes.includes(MISSING_SEARCH_NOTE)) notes.push(MISSING_SEARCH_NOTE);
    const speech = semPesquisa && result.provider === "llm" && !actions.length ? MISSING_SEARCH_SPEECH : result.speech;
    trace.totalMs = ms(started);
    const warning = [result.warning, ...notes].filter(Boolean).join(" ") || null;
    return { warning: null, band: null, model: null, ...result, speech, actions, warning, trace };
  };

  /**
   * Guarda a "última pesquisa" da sessão (ids + consulta estruturada — nunca o
   * texto cru do comando) e faz dela a pesquisa corrente DESTE plano, para que um
   * `@lastSearch` no mesmo comando já enxergue o que a busca acabou de encontrar.
   * Só é chamada quando o plano produziu uma pesquisa/listagem de verdade: um
   * comando sem listagem deixa a última pesquisa anterior INTACTA.
   */
  const rememberSearch = (listing, query) => {
    const ids = (listing ?? []).map((item) => item?.id).filter(Boolean);
    const stored = sessionId ? sessionStore.setLastSearch(sessionId, { ids, query }) : { ids, query, at: Date.now() };
    if (stored) lastSearch = stored;
    return stored;
  };

  /* System Two — planeja o comando INTEIRO (uma fala, todas as ações). */
  const planWithLlm = async () => {
    // A sessão resolvida AQUI (última pesquisa inclusive) vai no contexto: é dela
    // que saem a secção "ÚLTIMA PESQUISA" da mensagem e a regra do @lastSearch.
    const llm = await planWithMimo({ transcript: text, board, context: { ...context, sessionId, lastSearch } });
    trace.engine = "llm";
    trace.jev = null; // o plano não vem do JEV: não há veredito dele para mostrar
    trace.llm = { status: "ok", model: llm.model, latencyMs: llm.latencyMs };
    onEvent({ type: "llm", llm: trace.llm });
    // As buscas por característica são executadas AQUI (read-only): o plano que
    // segue para a execução só leva ações de escrita.
    const found = await runSearchActions(llm.plan.actions);
    // Sem busca não se toca na última pesquisa (continuidade sobrevive a comandos
    // de CRUD intercalados); com busca, os ids frescos valem já para o @lastSearch.
    if (found.search) rememberSearch(found.listing, found.query);
    const speechParts = [...(found.search ? [searchSpeech(found.listing)] : []), ...(found.actions.length ? [llm.plan.speech] : [])];
    return finish({
      speech: speechParts.join(" ") || llm.plan.speech,
      actions: found.actions,
      // A busca é LEITURA: sozinha, não há nada para confirmar.
      needsConfirmation: found.search && !found.actions.length ? false : llm.plan.needsConfirmation,
      provider: "llm",
      model: llm.model,
      band: null,
      // Uma busca corre sempre com `listing` (mesmo vazia) + `search` (a consulta).
      ...(found.search ? { listing: found.listing, search: found.search } : {}),
    });
  };

  /** Registra a falha do System Two no trace (honestidade do painel) e devolve a nota do warning. */
  const noteLlmFailure = (err) => {
    const reason = err?.message ?? "erro desconhecido";
    // `status: "failed"` é o vocabulário da UI (web/src/lib/types.ts → LlmTrace).
    trace.llm = { status: "failed", model: getResolvedModel()?.modelId ?? config.openrouter.model, latencyMs: ms(started), reason };
    onEvent({ type: "llm", llm: trace.llm });
    return ` O planejador do comando inteiro falhou (${reason}).`;
  };

  /* 1) Comandos SIMULTÂNEOS (2+ cláusulas), BUSCAS POR CARACTERÍSTICA e
   *    REFERÊNCIAS À ÚLTIMA PESQUISA (mesmo de uma cláusula só) → o System Two
   *    planeja tudo de uma vez: o JEV não tem contexto de sessão. */
  const simultaneous = splitClauses(text).length > 1;
  const needsLlm = simultaneous || isCharacteristicSearch(text) || lastRef;
  let llmError = null;
  let llmNote = "";
  if (needsLlm && config.openrouter.apiKey) {
    try {
      return await planWithLlm();
    } catch (err) {
      // Sem o System Two ainda dá para resolver compostos limpos cláusula a cláusula.
      llmError = err;
      llmNote = noteLlmFailure(err);
    }
  }

  /* 2) JEV — System One (comando único; ou composto limpo, após falha do LLM) */
  if (config.jev.enabled) {
    const jev = await planWithJev({ transcript: text, board, context: { ...context, sessionId, lastSearch } });
    trace.jev = { status: jev.status, code: jev.code ?? null, reason: jev.reason ?? null, ...jev.trace };
    // O motor desta resposta é o JEV mesmo quando ele se abstém: é dele o motivo.
    trace.engine = "jev";
    // O navegador vê o veredito do JEV na hora (~0,5 s).
    onEvent({ type: "jev", jev: trace.jev });
    if (jev.status === "ok") {
      // Listagem do JEV (≥1 card) também é "última pesquisa" — guarda a trace da
      // cascata; sem listagem, a última pesquisa anterior fica intocada.
      const jevListing = jev.plan.listing ?? [];
      if (jevListing.length) rememberSearch(jevListing, listingTraceQuery(jev.trace?.listing));
      return finish({
        speech: jev.plan.speech,
        actions: jev.plan.actions,
        needsConfirmation: jev.plan.needsConfirmation,
        provider: "jev",
        model: jev.trace.model,
        band: jev.plan.band,
        ...(jev.plan.listing ? { listing: jev.plan.listing } : {}),
      });
    }

    /* 3) Abstenção por composto num trecho só → o comando inteiro vai ao System Two. */
    if (jev.code === "compound" && config.openrouter.apiKey && !llmError) {
      try {
        return await planWithLlm();
      } catch (err) {
        llmError = err;
        llmNote = noteLlmFailure(err);
      }
    }

    // 4) Sem fallback genérico: abstenção/indisponibilidade viram pedido de esclarecimento.
    const reason = String(jev.reason ?? "motivo desconhecido");
    const speech =
      jev.status === "unavailable"
        ? `O JEV está indisponível: ${reason.replace(/^o JEV está indisponível:\s*/i, "")} Tente novamente em instantes.`
        : `${reason} Pode reformular ou dar mais detalhes?`;
    return finish({
      speech,
      actions: [],
      needsConfirmation: false,
      provider: "jev",
      model: jev.trace.model,
      band: "abstain",
      warning: llmError ? `${reason}.${llmNote}` : reason,
    });
  }

  /* 5) Interpretador local — o app nunca fica inutilizável sem chaves */
  const local = parseTranscriptLocally(text, board);
  const actions = normalizeActions(local.actions).map((action) => ({
    ...action,
    description: describeAction(action, board),
    requiresConfirmation: requiresConfirmation(action),
  }));
  trace.engine = "local";
  return finish({
    speech: local.speech,
    actions,
    needsConfirmation: local.needsConfirmation,
    provider: "local",
  });
}
