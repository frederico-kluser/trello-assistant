/**
 * Orquestração de uma SESSÃO: histórico real nos messages, busca por
 * característica (`search_cards`), "última pesquisa" acionável (@lastSearch),
 * planos heterogéneos e resolução dinâmica do modelo.
 *
 * Sem rede e sem chaves: o fetch global é substituído (só /chat/completions e
 * GET /models), o JEV entra por `setJevTransport` e o board vem do DemoBoard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { normalizeSessionId } from "../src/routes/api.js";
import { HISTORY_MAX_CHARS, HISTORY_MAX_TURNS, normalizeHistory } from "../src/services/agent.js";
import { getResolvedModel, resetModelCache } from "../src/services/model-picker.js";
import {
  expandLastSearch,
  isCharacteristicSearch,
  isLastSearchRef,
  isLastSearchReference,
  MISSING_SEARCH_NOTE,
  MISSING_SEARCH_SPEECH,
  planCommand,
} from "../src/services/planner.js";
import { sessionStore } from "../src/services/session-store.js";
import { setJevTransport } from "../src/services/jev.js";
import { splitClauses } from "../src/services/jev-planner.js";
import { DemoBoard, setBackend } from "../src/services/trello.js";

/* ── cenário: board/comentários demo, JEV e chat sob controlo ─────────── */

const demo = new DemoBoard();
const board = await demo.getBoard();
const card = (name) => board.cards.find((c) => c.name === name);
setBackend(demo); // nenhum teste toca a API real do Trello
// A busca por característica lê o board pelo cache do app (`getBoardCached()`),
// que por sua vez lê o backend fixado acima — determinístico de ponta a ponta.

config.openrouter.apiKey = "test-key";
config.jev.enabled = true;
// Modelo FIXO por omissão: sem descoberta em GET /models, o chat é só 1 chamada.
// O caminho "auto" tem um teste próprio mais abaixo.
config.openrouter.model = "test/pinned-model";

const llmPlan = (actions, speech = "Pronto, fiz o que pediu.") => JSON.stringify({ speech, needsConfirmation: false, actions });

/** Stub do fetch: só aceita o POST do chat (prova de que nada toca a rede). */
function stubChat(content, { status = 200 } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, body: init?.body ? JSON.parse(init.body) : null });
    if (!/\/chat\/completions$/.test(target)) throw new Error(`chamada de rede inesperada: ${target}`);
    const json =
      status === 200
        ? { model: "served/by-provider", choices: [{ message: { content } }] }
        : { error: { message: "o modelo não aceitou o pedido" } };
    return { ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify(json) };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** JEV proibido: qualquer decisão lança (o plano tem de vir do chat). */
function forbiddenJev() {
  const calls = [];
  setJevTransport(async (url, opts) => {
    calls.push(opts?.body?.state?.comando ?? "");
    throw new Error("o JEV não devia ser consultado neste teste");
  });
  return calls;
}

/* ── JEV sintético (mesmo formato do jev.js) ──────────────────────────── */

const choice = (value, confidence = 0.97) => ({ type: "choice", choice: value, probabilities: { [value]: confidence }, confidence });
const noul = (p) => ({ type: "noul", noul: p });
const answers = (over = {}) => ({
  clear: noul(0.98),
  compound: noul(0.02),
  intent: choice("other"),
  card: choice("NENHUM", 0.99),
  list: choice("NENHUMA", 0.99),
  ...over,
});
const jevReply = (a, ms = 2) => async () => ({
  status: 200,
  headers: {},
  text: JSON.stringify({ answers: a, model: "typesafe/jev-1.13-test", usage: { input_tokens: 100, cost: 0.000004 } }),
  reusedSocket: true,
  ms,
});

/* ── 1. histórico da sessão nos messages ─────────────────────────────── */

test("histórico da sessão entra nos messages como turnos reais entre system e user", async () => {
  forbiddenJev();
  const chat = stubChat(llmPlan([{ type: "comment_card", card: "Escrever o README", text: "ok" }]));
  const history = [
    { role: "user", content: "cria um card revisar contrato na lista a fazer" },
    { role: "assistant", content: "Criei o card «Revisar contrato» em A Fazer." },
  ];
  try {
    const said = "comenta ok no readme e arquiva o cabo hdmi";
    const r = await planCommand({ transcript: said, board, context: { history } });

    const messages = chat.calls[0].body.messages;
    assert.equal(messages.length, 4); // system + 2 turnos + user atual
    assert.equal(messages[0].role, "system");
    assert.deepEqual(messages.slice(1, 3), history); // verbatim, na ordem
    assert.equal(messages[3].role, "user");
    assert.match(messages[3].content, /O QUE A PESSOA FALOU:\ncomenta ok no readme/);
    assert.match(messages[3].content, /CARDS:/); // o turno atual leva o board
    // As regras novas do prompt: histórico é sessão real e @lastSearch é o marcador.
    assert.match(messages[0].content, /turnos REAIS desta mesma sessão/);
    assert.match(messages[0].content, /"card": "@lastSearch"/);
    assert.equal(r.provider, "llm");
  } finally {
    chat.restore();
    setJevTransport(null);
  }
});

test("normalizeHistory: só user/assistant, teto de 20 turnos (os mais recentes) e 500 chars", () => {
  const long = "x".repeat(HISTORY_MAX_CHARS + 120);
  const raw = [
    { role: "user", content: "  comando antigo  " },
    { role: "system", content: "isto não é turno de conversa" },
    { role: "assistant" }, // sem content
    { role: "tool", content: "nem isto" },
    { role: "USER", content: "papel em maiúsculas não conta" },
    { role: "user", content: long },
    "nem um objeto",
  ];
  const turns = normalizeHistory(raw);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], { role: "user", content: "comando antigo" }); // trim
  assert.equal(turns[1].content.length, HISTORY_MAX_CHARS); // cortado

  const many = Array.from({ length: HISTORY_MAX_TURNS + 5 }, (_, index) => ({ role: "user", content: `turno ${index}` }));
  const kept = normalizeHistory(many);
  assert.equal(kept.length, HISTORY_MAX_TURNS);
  assert.equal(kept.at(-1).content, `turno ${HISTORY_MAX_TURNS + 4}`); // ficam os mais recentes
  assert.deepEqual(normalizeHistory("nope"), []);
  assert.deepEqual(normalizeHistory(undefined), []);
});

test("sessionId: ausente, vazio, não-string ou acima de 128 chars → sem sessão (nunca lança)", () => {
  assert.equal(normalizeSessionId(undefined), null);
  assert.equal(normalizeSessionId(null), null);
  assert.equal(normalizeSessionId(42), null);
  assert.equal(normalizeSessionId("   "), null);
  assert.equal(normalizeSessionId("x".repeat(129)), null); // oversized: ignorado
  assert.equal(normalizeSessionId("x".repeat(128)), "x".repeat(128)); // teto aceite
  assert.equal(normalizeSessionId("  sessão-1  "), "sessão-1");
});

/* ── 2b. pré-roteador: referências à ÚLTIMA PESQUISA ──────────────────── */

test("pré-roteador: referências à última pesquisa (1 cláusula) vão ao System Two, não ao JEV", async () => {
  for (const said of [
    "quantas atividades apareceram nessa última pesquisa?",
    "comenta ok em todas elas",
    "os da última pesquisa",
    "todos eles",
    "essas atividades",
    "@lastSearch",
    "me mostra os resultados anteriores",
    "qual foi o resultado da última busca?",
    "dessas atividades, quais estão atrasadas?",
    "esses cards",
  ]) {
    assert.equal(isLastSearchReference(said), true, `deveria rotear: ${said}`);
  }
  for (const said of [
    "criar card Pagar contas na lista Fazendo",
    "marca o prazo do readme pra sexta",
    "cria uma lista chamada ideias",
    "move o readme para feito",
    "lista os cards da coluna Ideias",
  ]) {
    assert.equal(isLastSearchReference(said), false, `NÃO deveria rotear: ${said}`);
  }
});

test("'quantas atividades apareceram nessa última pesquisa?' (1 cláusula) responde pela pesquisa guardada", async () => {
  const sessionId = "orc-lastref-count";
  const ids = [card("Montar o board de voz").id, card("Escrever o README").id];
  sessionStore.setLastSearch(sessionId, { ids, query: { text: "board" } });
  const jevCalls = forbiddenJev();
  const chat = stubChat(llmPlan([], "Apareceram 2 atividades na última pesquisa."));
  try {
    const said = "quantas atividades apareceram nessa última pesquisa?";
    assert.equal(splitClauses(said).length, 1);
    assert.equal(isCharacteristicSearch(said), false); // só a referência o traz para cá
    const r = await planCommand({ transcript: said, board, context: { sessionId } });

    assert.equal(jevCalls.length, 0); // o JEV não enxerga a sessão
    assert.equal(chat.calls.length, 1);
    assert.equal(r.provider, "llm");
    // O modelo RECEBE a última pesquisa (nomes + ids) na mensagem atual.
    const userMessage = chat.calls[0].body.messages.at(-1).content;
    assert.match(userMessage, /ÚLTIMA PESQUISA/);
    assert.match(userMessage, /"Montar o board de voz"/);
    assert.match(userMessage, /"Escrever o README"/);
    assert.equal(r.warning, null); // havia pesquisa: nada a avisar
    assert.deepEqual(sessionStore.getLastSearch(sessionId).ids, ids); // intacta
  } finally {
    chat.restore();
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

test("'comenta ok em todas elas' (1 cláusula) expande @lastSearch em ações concretas", async () => {
  const sessionId = "orc-lastref-act";
  const ids = [card("Montar o board de voz").id, card("Escrever o README").id];
  sessionStore.setLastSearch(sessionId, { ids, query: { text: "board" } });
  const jevCalls = forbiddenJev();
  const chat = stubChat(llmPlan([{ type: "comment_card", card: "@lastSearch", text: "ok" }]));
  try {
    const r = await planCommand({ transcript: "comenta ok em todas elas", board, context: { sessionId } });
    assert.equal(jevCalls.length, 0);
    assert.equal(r.provider, "llm");
    assert.deepEqual(r.actions, [
      { type: "comment_card", card: "Montar o board de voz", text: "ok" },
      { type: "comment_card", card: "Escrever o README", text: "ok" },
    ]);
    assert.equal(r.warning, null);
  } finally {
    chat.restore();
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

test("'essas atividades' SEM pesquisa anterior: aviso determinístico e nada é guardado", async () => {
  const sessionId = "orc-lastref-none";
  sessionStore.clear(sessionId);
  const jevCalls = forbiddenJev();
  const chat = stubChat(llmPlan([], "Claro, vou verificar."));
  try {
    const r = await planCommand({ transcript: "faz um resumo dessas atividades", board, context: { sessionId } });
    assert.equal(jevCalls.length, 0); // não cai no JEV (que faria uma listagem nova)
    assert.equal(chat.calls.length, 1);
    assert.equal(r.provider, "llm");
    assert.deepEqual(r.actions, []);
    assert.equal(r.warning, MISSING_SEARCH_NOTE);
    assert.equal(r.speech, MISSING_SEARCH_SPEECH);
    assert.equal(r.listing, undefined); // nenhuma listagem inventada
    assert.equal(sessionStore.getLastSearch(sessionId), null); // não criou/sobrescreveu
  } finally {
    chat.restore();
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

test("comandos de CRUD comuns continuam no JEV (o novo predicado não os rouba)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`não devia chamar a rede: ${url}`);
  };
  setJevTransport(jevReply(answers({ intent: choice("create_card", 0.99), list: choice("Fazendo", 0.99) })));
  try {
    const said = "criar card Pagar contas na lista Fazendo";
    assert.equal(isLastSearchReference(said), false);
    assert.equal(isCharacteristicSearch(said), false);
    const r = await planCommand({ transcript: said, board });
    assert.equal(r.provider, "jev");
    assert.equal(r.actions[0].type, "create_card");
  } finally {
    setJevTransport(null);
    globalThis.fetch = real;
  }
});

test("listagem do JEV continua no JEV e continua a guardar a última pesquisa", async () => {
  const sessionId = "orc-jev-listing-2";
  sessionStore.clear(sessionId);
  const said = "listar cards da coluna Ideias";
  assert.equal(isLastSearchReference(said), false);
  assert.equal(isCharacteristicSearch(said), false);
  setJevTransport(async (url, opts) => {
    if (opts.body.questions?.intent) return jevReply(answers({ intent: choice("listar_cards", 0.99) }))();
    return jevReply({ c_0: noul(0.9) })();
  });
  try {
    const r = await planCommand({ transcript: said, board, context: { sessionId } });
    assert.equal(r.provider, "jev");
    assert.ok(r.listing.length >= 1);
    const stored = sessionStore.getLastSearch(sessionId);
    assert.deepEqual(stored.ids, r.listing.map((item) => item.id));
    assert.equal(stored.query.source, "jev-listing"); // trace, nunca o texto cru
  } finally {
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});


/* ── 2. pré-roteador determinístico da busca por característica ───────── */

test("pré-roteador: busca por característica de UMA cláusula vai ao System Two; CRUD continua no JEV", async () => {
  for (const said of [
    "quais atividades têm comentários sobre pagamento?",
    "me mostra os cards atrasados",
    "busca os cards com a etiqueta urgente",
    "o que tem prazo essa semana",
    "lista os cards que mencionam o cliente",
    "tem algum card com descrição sobre contrato?",
    "quais cards falam sobre o cliente",
    "o que foi comentado sobre o orçamento?",
    "procure as atividades com etiqueta urgente",
    "onde estão os cards atrasados?",
  ]) {
    assert.equal(isCharacteristicSearch(said), true, `deveria rotear: ${said}`);
  }
  for (const said of [
    "criar card X na lista Y",
    "cria um card chamado revisar contrato na lista a fazer",
    "marca o prazo do readme pra sexta",
    "comenta ok no readme",
    "adiciona um comentário no card readme",
    "move o readme para feito",
    "cria uma lista chamada ideias",
  ]) {
    assert.equal(isCharacteristicSearch(said), false, `NÃO deveria rotear: ${said}`);
  }

  // Roteamento de facto: o comando é de UMA cláusula e mesmo assim vai ao chat.
  const jevCalls = forbiddenJev();
  const chat = stubChat(llmPlan([{ type: "search_cards", text: "pagamento" }], "Encontrei as atividades."));
  const said = "quais atividades têm comentários sobre pagamento?";
  try {
    assert.equal(splitClauses(said).length, 1);
    const r = await planCommand({ transcript: said, board, context: {} });
    assert.equal(jevCalls.length, 0); // o JEV nunca vê uma busca por característica
    assert.equal(chat.calls.length, 1);
    assert.equal(r.provider, "llm");
    assert.equal(r.trace.engine, "llm");
  } finally {
    chat.restore();
    setJevTransport(null);
  }
});

test("CRUD de cláusula única continua a sair pelo JEV, sem chamar o chat", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`não devia chamar a rede: ${url}`);
  };
  setJevTransport(jevReply(answers({ intent: choice("create_card", 0.99), list: choice("A Fazer", 0.99) })));
  try {
    const said = "criar card X na lista Y";
    assert.equal(isCharacteristicSearch(said), false);
    const r = await planCommand({ transcript: said, board });
    assert.equal(r.provider, "jev");
    assert.equal(r.actions[0].type, "create_card");
  } finally {
    setJevTransport(null);
    globalThis.fetch = real;
  }
});

/* ── 3. search_cards: execução, fala determinística e última pesquisa ─── */

test("search_cards: listing + search + fala determinística + última pesquisa guardada", async () => {
  const sessionId = "orc-search-1";
  sessionStore.clear(sessionId);
  forbiddenJev();
  const chat = stubChat(
    JSON.stringify({ speech: "Aqui estão as atividades.", needsConfirmation: true, actions: [{ type: "search_cards", text: "pagamento" }] }),
  );
  try {
    const r = await planCommand({
      transcript: "quais atividades têm comentários sobre pagamento?",
      board,
      context: { sessionId },
    });

    assert.equal(r.provider, "llm");
    assert.deepEqual(r.actions, []); // leitura: nada para executar/confirmar
    assert.equal(r.needsConfirmation, false); // nem com needsConfirmation:true do modelo
    assert.equal(r.warning, null);

    assert.equal(r.listing.length, 1);
    assert.equal(r.listing[0].name, "Revisar proposta do cliente"); // só o COMENTÁRIO tem "pagamento"
    assert.equal(r.listing[0].list, "A Fazer");
    assert.equal(r.listing[0].maybe, false);
    assert.ok(r.listing[0].matchedFields.includes("comment"));
    assert.equal(r.listing[0].id, card("Revisar proposta do cliente").id);

    assert.deepEqual(r.search, { query: { text: "pagamento" }, count: 1 });
    assert.equal(r.speech, "Encontrei 1 atividade: Revisar proposta do cliente.");

    const stored = sessionStore.getLastSearch(sessionId);
    assert.deepEqual(stored.ids, [r.listing[0].id]);
    assert.deepEqual(stored.query, { text: "pagamento" });
  } finally {
    chat.restore();
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

test("search_cards sem resultados: fala própria, listing vazio e pesquisa guardada vazia", async () => {
  const sessionId = "orc-search-2";
  sessionStore.clear(sessionId);
  forbiddenJev();
  const chat = stubChat(llmPlan([{ type: "search_cards", text: "gnuplot" }]));
  try {
    const r = await planCommand({ transcript: "quais cards mencionam gnuplot?", board, context: { sessionId } });
    assert.equal(r.speech, "Não encontrei nenhuma atividade com essas características.");
    assert.deepEqual(r.listing, []);
    assert.equal(r.search.count, 0);
    assert.deepEqual(sessionStore.getLastSearch(sessionId).ids, []);
    assert.equal(r.actions.length, 0);
  } finally {
    chat.restore();
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

/* ── 4. @lastSearch: expansão server-side ─────────────────────────────── */

test("comando de CRUD intercalado NÃO apaga a última pesquisa da sessão", async () => {
  const sessionId = "orc-keep-1";
  const searched = card("Revisar proposta do cliente").id;
  sessionStore.setLastSearch(sessionId, { ids: [searched], query: { text: "pagamento" } });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`o CRUD é do JEV: nada de rede (${url})`);
  };
  setJevTransport(jevReply(answers({ intent: choice("create_card", 0.99), list: choice("Fazendo", 0.99) })));
  try {
    const r = await planCommand({ transcript: "criar card Nota fiscal na lista Fazendo", board, context: { sessionId } });
    assert.equal(r.provider, "jev");
    assert.equal(r.actions[0].type, "create_card");
    assert.equal(r.listing, undefined); // comando sem listagem

    // A última pesquisa anterior continua lá, intacta (ids + consulta).
    const stored = sessionStore.getLastSearch(sessionId);
    assert.deepEqual(stored.ids, [searched]);
    assert.deepEqual(stored.query, { text: "pagamento" });

    // E o follow-up continua a funcionar depois do comando intercalado.
    setJevTransport(null);
    const chat = stubChat(llmPlan([{ type: "comment_card", card: "@lastSearch", text: "ok" }]));
    try {
      const follow = await planCommand({ transcript: "comenta ok em todas elas e arquiva o cabo hdmi", board, context: { sessionId } });
      assert.deepEqual(follow.actions, [{ type: "comment_card", card: "Revisar proposta do cliente", text: "ok" }]);
      assert.equal(follow.warning, null);
    } finally {
      chat.restore();
    }
  } finally {
    setJevTransport(null);
    globalThis.fetch = real;
    sessionStore.clear(sessionId);
  }
});

test("mesmo comando: search_cards + @lastSearch usa os ids FRESCOS da busca", async () => {
  const sessionId = "orc-same-plan-1";
  sessionStore.clear(sessionId); // sem pesquisa anterior nenhuma
  forbiddenJev();
  const chat = stubChat(
    llmPlan([
      { type: "search_cards", text: "pagamento" },
      { type: "comment_card", card: "@lastSearch", text: "ok" },
    ]),
  );
  try {
    const r = await planCommand({
      transcript: "busca os cards com comentários sobre pagamento e comenta ok em todos eles",
      board,
      context: { sessionId },
    });
    assert.equal(r.search.count, 1);
    assert.equal(r.warning, null); // não cai no "não há pesquisa anterior"
    assert.deepEqual(r.actions, [{ type: "comment_card", card: "Revisar proposta do cliente", text: "ok" }]);
    assert.match(r.speech, /^Encontrei 1 atividade: Revisar proposta do cliente\./);
    assert.deepEqual(sessionStore.getLastSearch(sessionId).ids, [card("Revisar proposta do cliente").id]);
  } finally {
    chat.restore();
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

test("pesquisa vazia: aviso próprio, distinto do 'não há pesquisa anterior'", async () => {
  const sessionId = "orc-empty-warn-1";
  sessionStore.clear(sessionId);
  forbiddenJev();
  let chat = stubChat(llmPlan([{ type: "search_cards", text: "gnuplot" }]));
  try {
    const first = await planCommand({ transcript: "quais cards mencionam gnuplot?", board, context: { sessionId } });
    assert.equal(first.search.count, 0);
    assert.deepEqual(sessionStore.getLastSearch(sessionId).ids, []);
    chat.restore();

    chat = stubChat(llmPlan([{ type: "comment_card", card: "@lastSearch", text: "ok" }]));
    const follow = await planCommand({ transcript: "comenta ok nelas e arquiva o cabo hdmi", board, context: { sessionId } });
    assert.deepEqual(follow.actions, []);
    assert.match(follow.warning, /a última pesquisa não encontrou nenhum card nesta sessão/);
    assert.doesNotMatch(follow.warning, /não há pesquisa anterior/);
  } finally {
    chat.restore();
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

test("@lastSearch: uma ação marcada expande-se em N ações com os nomes reais do board", async () => {
  const sessionId = "orc-last-1";
  forbiddenJev();
  const ids = [card("Montar o board de voz").id, card("Escrever o README").id];
  sessionStore.setLastSearch(sessionId, { ids, query: { text: "board" } });
  const chat = stubChat(llmPlan([{ type: "comment_card", card: "@lastSearch", text: "ok" }]));
  try {
    const r = await planCommand({ transcript: "comenta ok em todas essas atividades e arquiva o cabo hdmi", board, context: { sessionId } });
    assert.equal(r.actions.length, 2);
    assert.deepEqual(r.actions, [
      { type: "comment_card", card: "Montar o board de voz", text: "ok" },
      { type: "comment_card", card: "Escrever o README", text: "ok" },
    ]);
    assert.equal(r.warning, null);
  } finally {
    chat.restore();
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

test("@lastSearch sem pesquisa anterior: a ação cai e o plano explica por quê", async () => {
  const sessionId = "orc-last-2";
  sessionStore.clear(sessionId); // sessão sem pesquisa
  forbiddenJev();
  const chat = stubChat(llmPlan([{ type: "comment_card", card: "@lastSearch", text: "ok" }]));
  try {
    const r = await planCommand({ transcript: "comenta ok em todas essas atividades e arquiva o cabo hdmi", board, context: { sessionId } });
    assert.deepEqual(r.actions, []);
    assert.match(r.warning, /não há pesquisa anterior nesta sessão/);
  } finally {
    chat.restore();
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

test("expandLastSearch (unitário): variantes do marcador, ids mortos e sem pesquisa", () => {
  const fakeBoard = { lists: [], cards: [{ id: "c-1", name: "Alfa" }, { id: "c-2", name: "Beta" }] };
  for (const ref of ["@lastSearch", "@lastsearch", "última pesquisa", "ultima pesquisa", "@pesquisa", "ÚLTIMA PESQUISA", "pesquisa anterior"]) {
    assert.equal(isLastSearchRef(ref), true, ref);
  }
  for (const ref of ["Alfa", "", null, undefined, "@ultimaPesquisaX"]) {
    assert.equal(isLastSearchRef(ref), false, String(ref));
  }

  const action = { type: "set_due", card: "@lastSearch", due: "2026-08-21" };
  assert.deepEqual(expandLastSearch([action], { board: fakeBoard, lastSearch: { ids: ["c-1", "c-2"] } }), [
    { type: "set_due", card: "Alfa", due: "2026-08-21" },
    { type: "set_due", card: "Beta", due: "2026-08-21" },
  ]);
  // nome citado normalmente passa intacto
  const plain = { type: "archive_card", card: "Alfa" };
  assert.deepEqual(expandLastSearch([plain], { board: fakeBoard, lastSearch: { ids: [] } }), [plain]);

  const notes = [];
  assert.deepEqual(expandLastSearch([action], { board: fakeBoard, lastSearch: null, onDrop: (r) => notes.push(r) }), []);
  assert.match(notes[0], /não há pesquisa anterior nesta sessão/);

  const dead = [];
  assert.deepEqual(expandLastSearch([action], { board: fakeBoard, lastSearch: { ids: ["c-9"] }, onDrop: (r) => dead.push(r) }), []);
  assert.match(dead[0], /já não estão no quadro/);
});

/* ── 5. planos heterogéneos e vocabulário do prompt ───────────────────── */

test("comando heterogéneo: update_card(desc) + set_due + comment_card saem os três, na ordem falada", async () => {
  forbiddenJev();
  const chat = stubChat(
    llmPlan([
      { type: "update_card", card: "Montar o board de voz", desc: "STT + orquestração + Trello." },
      { type: "set_due", card: "Revisar proposta do cliente", due: "2026-08-21" },
      { type: "comment_card", card: "Escrever o README", text: "ok" },
    ]),
  );
  try {
    const r = await planCommand({
      transcript: "edita a descrição do card montar o board de voz pra 'STT + orquestração + Trello', marca o due do revisar proposta pra sexta, e comenta 'ok' no readme",
      board,
    });
    assert.deepEqual(r.actions.map((a) => a.type), ["update_card", "set_due", "comment_card"]);
    assert.deepEqual(r.actions.map((a) => a.card), ["Montar o board de voz", "Revisar proposta do cliente", "Escrever o README"]);
    assert.equal(r.actions[0].desc, "STT + orquestração + Trello.");
    assert.equal(r.actions[2].text, "ok");
    assert.equal(r.needsConfirmation, false);
    assert.equal(r.provider, "llm");

    // O prompt documenta o vocabulário INTEIRO (9 tipos + a leitura) e o marcador.
    const system = chat.calls[0].body.messages[0].content;
    for (const type of [
      "create_card",
      "delete_card",
      "move_card",
      "update_card",
      "set_due",
      "comment_card",
      "archive_card",
      "create_list",
      "add_checklist_item",
      "search_cards",
    ]) {
      assert.match(system, new RegExp(`"type":"${type}"`), type);
    }
    assert.match(system, /@lastSearch/);
    assert.match(system, /ISO-8601 em UTC/);
  } finally {
    chat.restore();
    setJevTransport(null);
  }
});

/* ── 6. resolução do modelo (wiring do model-picker) ──────────────────── */

test("model-picker fixo: o corpo do chat e o plan.model levam o id resolvido", async () => {
  forbiddenJev();
  const chat = stubChat(llmPlan([{ type: "archive_card", card: "Comprar cabo HDMI" }]));
  try {
    const r = await planCommand({ transcript: "arquiva o cabo hdmi e move o readme para feito", board });
    assert.equal(config.openrouter.model, "test/pinned-model");
    assert.equal(chat.calls[0].body.model, "test/pinned-model"); // resolvido, não "auto"
    assert.equal(r.model, "test/pinned-model");
    assert.equal(r.trace.llm.model, "test/pinned-model");
    assert.equal(getResolvedModel().modelId, "test/pinned-model");
  } finally {
    chat.restore();
    setJevTransport(null);
  }
});

test("model-picker 'auto': o melhor modelo descoberto em GET /models é quem responde", async () => {
  const real = globalThis.fetch;
  const saved = config.openrouter.model;
  const seen = [];
  const catalog = {
    data: [
      { id: "vendor/fraco", context_length: 64_000, pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"] }, benchmarks: { artificial_analysis: { intelligence_index: 20, agentic_index: 10 } } },
      { id: "vendor/melhor", context_length: 200_000, pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"] }, benchmarks: { artificial_analysis: { intelligence_index: 88, agentic_index: 70 } } },
    ],
  };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    seen.push(target);
    const body = /\/models$/.test(target) ? catalog : { model: "vendor/melhor", choices: [{ message: { content: llmPlan([{ type: "archive_card", card: "Comprar cabo HDMI" }]) } }] };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  config.openrouter.model = "auto";
  resetModelCache();
  forbiddenJev();
  try {
    const r = await planCommand({ transcript: "arquiva o cabo hdmi e move o readme para feito", board });
    assert.ok(seen.some((url) => /\/models$/.test(url)), "descobriu o catálogo");
    assert.equal(getResolvedModel().modelId, "vendor/melhor");
    assert.equal(r.model, "vendor/melhor"); // plan.model = id resolvido dinamicamente
    assert.equal(r.trace.llm.model, "vendor/melhor");
  } finally {
    config.openrouter.model = saved;
    resetModelCache();
    globalThis.fetch = real;
    setJevTransport(null);
  }
});

test("modelo escolhido devolve 404: descarta o cache, resolve de novo e repete UMA vez", async () => {
  const real = globalThis.fetch;
  const saved = config.openrouter.model;
  const modelFor = (id, intelligence) => ({
    id,
    context_length: 200_000,
    pricing: { prompt: "0", completion: "0" },
    architecture: { input_modalities: ["text"] },
    benchmarks: { artificial_analysis: { intelligence_index: intelligence, agentic_index: 10 } },
  });
  const catalogs = [
    { data: [modelFor("vendor/campeao", 90), modelFor("vendor/reserva", 60)] },
    { data: [modelFor("vendor/reserva", 60)] }, // o campeão saiu do catálogo
  ];
  const chat = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (/\/models$/.test(target)) {
      const body = catalogs.shift() ?? { data: [modelFor("vendor/reserva", 60)] };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    }
    chat.push(JSON.parse(init.body).model);
    const ok = chat.length > 1;
    const body = ok
      ? { model: chat.at(-1), choices: [{ message: { content: llmPlan([{ type: "archive_card", card: "Comprar cabo HDMI" }]) } }] }
      : { error: { message: "modelo descontinuado" } };
    return { ok, status: ok ? 200 : 404, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  config.openrouter.model = "auto";
  resetModelCache();
  forbiddenJev();
  try {
    const r = await planCommand({ transcript: "arquiva o cabo hdmi e move o readme para feito", board });
    assert.deepEqual(chat, ["vendor/campeao", "vendor/reserva"]); // repetiu com o modelo re-resolvido
    assert.equal(r.model, "vendor/reserva");
    assert.equal(r.actions.length, 1);
  } finally {
    config.openrouter.model = saved;
    resetModelCache();
    globalThis.fetch = real;
    setJevTransport(null);
  }
});
