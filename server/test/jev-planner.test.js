import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { capabilities, config } from "../src/config.js";
import { setJevTransport } from "../src/services/jev.js";
import {
  bandFor,
  buildCardQuestions,
  buildQuestions,
  cardLine,
  extractCreate,
  INTENTS,
  intentClass,
  interpretClause,
  lexicalCard,
  LISTING_INTENTS,
  listingSpeech,
  planWithJev,
  runListingCascade,
  splitBatches,
  splitClauses,
} from "../src/services/jev-planner.js";
import { planCommand } from "../src/services/planner.js";
import { sessionStore } from "../src/services/session-store.js";
import { DemoBoard } from "../src/services/trello.js";

const board = await new DemoBoard().getBoard();
const card = (name) => board.cards.find((c) => c.name === name);
const list = (name) => board.lists.find((l) => l.name === name);
const openCardsOf = (b) => b.cards.filter((c) => !c.closed);

// Determinismo nos testes: o lote e os limiares não dependem do .env da máquina.
config.jev.cardBatch = 16;
config.jev.listInclude = 0.5;
config.jev.listMaybe = 0.35;
config.jev.colInclude = 0.35;
// Modelo FIXO (caminho "pinned" do model-picker): sem descoberta em GET /models,
// o corpo enviado ao /chat/completions é previsível e o stub de fetch só vê a
// chamada do chat. A resolução dinâmica ("auto") é testada em orchestration.test.js.
config.openrouter.model = "google/gemini-3.8-flash";

/* ── helpers: respostas sintéticas no formato do JEV ─────────────────── */

const choice = (value, confidence = 0.97) => ({ type: "choice", choice: value, probabilities: { [value]: confidence }, confidence });
const noul = (p) => ({ type: "noul", noul: p });

/** respostas "limpas": fala clara, uma ação, sem lista/card, salvo o que o teste sobrescreve */
const answers = (over = {}) => ({
  clear: noul(0.98),
  compound: noul(0.02),
  intent: choice("other"),
  card: choice("NENHUM", 0.99),
  list: choice("NENHUMA", 0.99),
  ...over,
});

const clause = (text, a, extra = {}) => {
  const built = buildQuestions({ board, transcript: text, context: extra.context ?? {} });
  return interpretClause({ text, answers: answers(a), built, board });
};

const reply = (a, ms = 5) => async () => ({
  status: 200,
  headers: {},
  text: JSON.stringify({ answers: a, model: "typesafe/jev-1.13-test", usage: { input_tokens: 100, cost: 0.000004 } }),
  reusedSocket: true,
  ms,
});

/** Responde a fase 1 (intenção) e os lotes da cascata de forma distinguível. */
const phase1 = (over) => answers(over);
const isPhase1 = (body) => Boolean(body.questions?.intent);

/* ── bandas ──────────────────────────────────────────────────────────── */

test("bandFor: choice usa confidence; noul usa certeza e rejeita o indeciso", () => {
  assert.equal(bandFor(choice("x", 0.95)).band, "auto");
  assert.equal(bandFor(choice("x", 0.7)).band, "hitl");
  assert.equal(bandFor(choice("x", 0.3)).band, "abstain");
  assert.equal(bandFor(noul(0.97)).band, "auto"); // certeza 0.97
  assert.equal(bandFor(noul(0.03)).band, "auto"); // certeza 0.97 do "não"
  assert.equal(bandFor(noul(0.55)).band, "abstain"); // indeciso (|p-0.5|<0.1)
});

/* ── classes CRUD das intenções (contrato §3) ────────────────────────── */

test("INTENTS: cada intenção tem a classe CRUD da tabela do contrato", () => {
  assert.equal(intentClass("listar_cards"), "listagem");
  assert.equal(intentClass("resumo_board"), "listagem");
  assert.equal(intentClass("create_card"), "criacao");
  assert.equal(intentClass("create_list"), "criacao");
  assert.equal(intentClass("move_card"), "movimentacao");
  for (const id of ["set_due", "remove_due", "mark_done", "rename_card", "comment_card", "add_checklist_item"]) {
    assert.equal(intentClass(id), "edicao", `${id} é edição`);
  }
  for (const id of ["delete_card", "archive_card"]) assert.equal(intentClass(id), "delecao", `${id} é deleção`);
  assert.equal(intentClass("other"), "outro");
  assert.deepEqual([...LISTING_INTENTS].sort(), ["listar_cards", "resumo_board"]);
  // o id antigo saiu do vocabulário
  assert.equal(INTENTS.query_board, undefined);
  assert.equal(intentClass("query_board"), "outro");
});

/* ── divisão em cláusulas ────────────────────────────────────────────── */

test("splitClauses divide só quando a próxima parte começa com verbo de comando", () => {
  assert.deepEqual(splitClauses("move o gym para terminado e apaga o ghost writer"), [
    "move o gym para terminado",
    "apaga o ghost writer",
  ]);
  assert.equal(splitClauses("cria card ligar para o contador e pedir nota").length, 1); // "pedir" não é comando
  assert.equal(splitClauses("o que tenho para fazer").length, 1);
  assert.equal(splitClauses("cria a, depois cria b, depois cria c, depois cria d, depois cria e, depois cria f").length, 4);
  // vírgula + verbo de comando também divide: «…terminado, move X…» são comandos simultâneos
  assert.deepEqual(splitClauses("move a academia para terminado, move o trabalho para terminado e quero que você mova o leia, move ele pra fazendo"), [
    "move a academia para terminado",
    "move o trabalho para terminado e quero que você mova o leia",
    "move ele pra fazendo",
  ]);
  // frase real do utilizador: 4 partes («, por enquanto,» não divide — não é verbo)
  assert.equal(
    splitClauses("Move a atividade da academia para terminado, move a atividade do trabalhar no Ondocay para terminado e quero que você, por enquanto, mova a atividade do adicionar o Leia ao Ondokai, move ela pra fazendo.").length,
    4,
  );
});

/* ── extração de texto ───────────────────────────────────────────────── */

test("extractCreate separa título, lista e prazo sem comer palavras do título", () => {
  assert.deepEqual(
    (({ name, due }) => ({ name, hasDue: Boolean(due) }))(extractCreate("cria um card chamado revisar contrato na lista backlog", "Backlog")),
    { name: "revisar contrato", hasDue: false },
  );
  const withDue = extractCreate("cria card estudar rust com prazo sexta na lista ideias", "Ideias");
  assert.equal(withDue.name, "estudar rust");
  assert.ok(withDue.due);
  // "para" faz parte do título: só a lista final é removida
  assert.equal(extractCreate("adiciona uma tarefa comprar café para o jantar na lista para fazer hoje", "Para fazer ( hoje)").name, "comprar café para o jantar");
  assert.equal(extractCreate('cria um card "Ligar pro dentista"', null).name, "Ligar pro dentista");
  assert.equal(extractCreate("cria card", null), null);
});

test("lexicalCard acha o card por uma palavra única da fala", () => {
  const built = buildQuestions({ board, transcript: "x" });
  assert.equal(lexicalCard("coloca uma data pro README dia 20", built.cardMap)?.name, "Escrever o README");
  assert.equal(lexicalCard("muda o prazo do cliente", built.cardMap)?.name, "Revisar proposta do cliente");
  assert.equal(lexicalCard("faz alguma coisa", built.cardMap), null);
});

/* ── perguntas da fase 1 (sem query_kind, com portão de colunas) ──────── */

test("buildQuestions: sem query_kind, com col_<i> + colMap e card/lista como opções", () => {
  const { questions, colMap } = buildQuestions({ board, transcript: "x" });
  assert.deepEqual(Object.keys(questions), ["intent", "card", "list", "compound", "clear", "col_0", "col_1", "col_2", "col_3"]);
  assert.equal(questions.query_kind, undefined);
  assert.deepEqual([...colMap.keys()], ["col_0", "col_1", "col_2", "col_3"]);
  assert.equal(colMap.get("col_1").id, list("A Fazer").id);

  // portão: 1 noul por coluna, auto-contido (nome, contagem e até 3 exemplos)
  const gate = questions.col_1;
  assert.equal(gate.type, "noul");
  assert.match(gate.instructions, /da coluna «A Fazer» \(\d+ cards; ex\.: «Revisar proposta do cliente», «Comprar cabo HDMI», «Ligar para o contador»\)\?/);
  assert.deepEqual(gate.criteria, {
    true: "A coluna pode conter cards que respondem ao pedido, ou o pedido fala dela — em caso de dúvida, considere que PODE conter",
    false: "A coluna certamente não tem relação com o pedido",
  });
  const empty = { ...board, lists: [{ id: "l-vazia", name: "Vazia", pos: 1, closed: false }], cards: [] };
  assert.match(buildQuestions({ board: empty, transcript: "x" }).questions.col_0.instructions, /da coluna «Vazia» \(0 cards\)\?/);

  // as perguntas de CRUD continuam iguais
  assert.ok("Escrever o README" in questions.card.criteria && "NENHUM" in questions.card.criteria);
  assert.deepEqual(questions.card.criteria["Escrever o README"], { lista: "Fazendo" });
  assert.ok("Fazendo" in questions.list.criteria && "NENHUMA" in questions.list.criteria);
  assert.ok(Object.keys(questions.card.criteria).length <= 255);
});

test("buildQuestions: nomes de cards repetidos ganham sufixo e sempre cabem em 255 opções", () => {
  const many = { ...board, cards: Array.from({ length: 400 }, (_, i) => ({ ...board.cards[0], id: `x${i}`, name: i % 2 ? "Repetido" : `Card ${i}` })) };
  const { questions } = buildQuestions({ board: many, transcript: "card 7" });
  assert.ok(Object.keys(questions.card.criteria).length <= 251);
  assert.ok("Repetido (2)" in questions.card.criteria);
});

/* ── interpretação: ações ────────────────────────────────────────────── */

test("mover: alta confiança vira ação com ids e banda auto (sem confirmação)", () => {
  const r = clause("move o readme para feito", {
    intent: choice("move_card"),
    card: choice("Escrever o README"),
    list: choice("Feito"),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.band, "auto");
  assert.deepEqual(r.action, { type: "move_card", card: card("Escrever o README").id, list: list("Feito").id });
  assert.ok(r.decisions.find((d) => d.id === "card").used);
});

test("confiança média no card (hitl) propaga para o plano → pede confirmação", () => {
  const r = clause("move o readme para feito", {
    intent: choice("move_card"),
    card: choice("Escrever o README", 0.7),
    list: choice("Feito"),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.band, "hitl");
});

test("guardas moderadas na direção esperada NÃO pedem confirmação (86% 'clara', 87% 'uma ação')", () => {
  const r = clause("move o readme para feito", {
    intent: choice("move_card", 0.95),
    card: choice("Escrever o README", 0.99),
    list: choice("Feito", 0.99),
    clear: noul(0.86),
    compound: noul(0.13),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.band, "auto");
});

test("guardas em dúvida pedem confirmação; guardas fortes bloqueiam", () => {
  const base = { intent: choice("move_card"), card: choice("Escrever o README"), list: choice("Feito") };
  assert.equal(clause("x", { ...base, clear: noul(0.62) }).band, "hitl");
  assert.equal(clause("x", { ...base, compound: noul(0.45) }).band, "hitl");
  assert.equal(clause("x", { ...base, clear: noul(0.4) }).code, "unclear");
  assert.equal(clause("x", { ...base, compound: noul(0.7) }).code, "compound");
});

test("decisões devolvidas à UI: guardas usadas, sem query_kind; colunas no columnGate", () => {
  const move = clause("move o readme para feito", {
    intent: choice("move_card"),
    card: choice("Escrever o README"),
    list: choice("Feito"),
    col_1: noul(0.9),
    col_3: noul(0.05),
  });
  assert.ok(move.decisions.find((d) => d.id === "clear").used);
  assert.equal(move.decisions.find((d) => d.id === "query_kind"), undefined);
  // o portão de colunas sai da cláusula como dado puro (não polui as decisions)
  assert.deepEqual(move.columnGate.find((g) => g.listName === "A Fazer"), { listId: list("A Fazer").id, listName: "A Fazer", p: 0.9, value: true });
  assert.deepEqual(move.columnGate.find((g) => g.listName === "Feito"), { listId: list("Feito").id, listName: "Feito", p: 0.05, value: false });
  assert.equal(move.columnGate.find((g) => g.listName === "Ideias").p, null); // sem resposta = sem informação
  assert.equal(move.columnGate.length, 4);
});

test("o JEV se abstém: intenção fraca, card fraco, 'other', fala confusa, composto", () => {
  assert.equal(clause("hm", { intent: choice("move_card", 0.3) }).code, "low_intent");
  assert.match(clause("hm", { intent: choice("move_card", 0.3) }).reason, /só 30% de confiança na intenção/);
  assert.equal(clause("move x", { intent: choice("move_card"), card: choice("Escrever o README", 0.4), list: choice("Feito") }).code, "low_card");
  assert.equal(clause("bom dia", { intent: choice("other", 1) }).code, "not_a_command");
  assert.equal(clause("asdf", { intent: choice("other", 1), clear: noul(0.05) }).code, "unclear");
  assert.equal(clause("cria x e move y", { intent: choice("create_card"), compound: noul(0.93) }).code, "compound");
});

test("sem card identificado (e sem pronome) o JEV avisa em vez de adivinhar", () => {
  const r = clause("apaga aquele card", { intent: choice("delete_card") });
  assert.equal(r.status, "abstain");
  assert.equal(r.code, "no_card");
});

test("pronome usa o último card, sempre com confirmação (hitl)", () => {
  const last = card("Comprar cabo HDMI");
  const r = clause(
    "muda ele pra feito",
    { intent: choice("move_card"), list: choice("Feito"), pronoun: noul(0.97) },
    { context: { lastCardId: last.id } },
  );
  assert.equal(r.status, "ok");
  assert.equal(r.action.card, last.id);
  assert.equal(r.band, "hitl");
});

test("ajuda lexical: JEV disse NENHUM sem certeza, mas a fala cita um card único → hitl", () => {
  const r = clause("coloca uma data pro README dia 20", {
    intent: choice("set_due"),
    card: choice("NENHUM", 0.7),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.action.card, card("Escrever o README").id);
  assert.equal(r.band, "hitl");
  assert.ok(r.action.due);
});

test("menção parcial: JEV 'nenhum card' com 99% mas a fala cita uma palavra única → candidato com confirmação", () => {
  const r = clause("põe o contador em fazendo", {
    intent: choice("move_card"),
    card: choice("NENHUM", 0.99),
    list: choice("Fazendo"),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.action.card, card("Ligar para o contador").id);
  assert.equal(r.band, "hitl"); // nunca executa às cegas
});

test("JEV duvida do card (40%) mas a fala tem palavra única → usa o candidato lexical, com confirmação", () => {
  const r = clause("muda o prazo do contador pra sexta", { intent: choice("set_due"), card: choice("Escrever o README", 0.4) });
  assert.equal(r.status, "ok");
  assert.equal(r.action.card, card("Ligar para o contador").id); // o palpite fraco do JEV (README) é ignorado
  assert.equal(r.band, "hitl");
});

test("criar card: título/prazo/lista extraídos por código; sem título → abstém", () => {
  const ok = clause("cria card ligar para o dentista amanhã na lista a fazer", {
    intent: choice("create_card"),
    list: choice("A Fazer"),
  });
  assert.equal(ok.action.type, "create_card");
  assert.equal(ok.action.name, "ligar para o dentista");
  assert.equal(ok.action.list, "A Fazer");
  assert.ok(ok.action.due);
  assert.equal(clause("cria card", { intent: choice("create_card") }).code, "no_title");
});

test("prazo: sem data entendida → abstém; remover prazo e concluir não apagam o prazo por engano", () => {
  assert.equal(clause("muda o prazo do readme", { intent: choice("set_due"), card: choice("Escrever o README") }).code, "no_date");
  const done = clause("marca o readme como feito", { intent: choice("mark_done"), card: choice("Escrever o README") });
  assert.deepEqual(done.action, { type: "set_due", card: card("Escrever o README").id, due_complete: true });
  const none = clause("tira o prazo do readme", { intent: choice("remove_due"), card: choice("Escrever o README") });
  assert.deepEqual(none.action, { type: "set_due", card: card("Escrever o README").id });
});

/* ── intenção de listagem: resumo por código, o resto pela cascata ───── */

test("listagem: resumo_board sai por código (describeBoard); listar_cards pede a cascata", () => {
  const overview = clause("o que eu tenho?", { intent: choice("resumo_board") });
  assert.equal(overview.status, "ok");
  assert.equal(overview.band, "auto");
  assert.match(overview.plan.speech, /Board de demonstração/);
  assert.equal(overview.listingQuery, undefined);
  assert.deepEqual(overview.plan.actions, []);

  const listing = clause("procura o card do contador", { intent: choice("listar_cards") });
  assert.equal(listing.status, "ok");
  assert.equal(listing.band, "auto"); // listagem é read-only: nunca confirma
  assert.equal(listing.listingQuery, true);
  assert.equal(listing.action, undefined);
  assert.equal(listing.plan, undefined);
  assert.equal(listing.columnGate.length, 4);
});

/* ── cascata: portão de colunas ──────────────────────────────────────── */

test("cascata: coluna passa com p ≥ 0,35; abaixo disso é podada (board grande)", async () => {
  const calls = [];
  setJevTransport(async (url, opts) => {
    calls.push(opts.body);
    return reply({ c_0: noul(0.9), c_1: noul(0.2), c_2: noul(0.6) })();
  });
  // a poda só acontece quando vale a pena: lotes de 4 → só boards com > 8 cards
  const originalBatch = config.jev.cardBatch;
  config.jev.cardBatch = 4;
  const cascade = await runListingCascade({
    text: "o que tenho?",
    board,
    columnGate: [
      { listId: list("Ideias").id, listName: "Ideias", p: 0.9, value: true },
      { listId: list("A Fazer").id, listName: "A Fazer", p: 0.1, value: false },
      { listId: list("Fazendo").id, listName: "Fazendo", p: 0.2, value: false },
      { listId: list("Feito").id, listName: "Feito", p: 0.4, value: true },
    ],
  });
  config.jev.cardBatch = originalBatch;
  assert.equal(calls.length, 1);
  assert.deepEqual(cascade.listingTrace.kept, ["Ideias", "Feito"]);
  assert.deepEqual(cascade.listingTrace.pruned, ["A Fazer", "Fazendo"]);
  assert.equal(cascade.listingTrace.fallbackColumns, false);
  // candidatos na ordem do board (lista pos, card pos)
  assert.equal(cascade.listingTrace.evaluated, 3);
  assert.deepEqual(cascade.listing.map((item) => item.name), ["Explorar anéis de Júpiter no visual", "Criar o repositório"]);
  assert.equal(cascade.listingTrace.listed, 2);
  assert.equal(cascade.listingTrace.maybe, 0);
  assert.match(cascade.speech, /Em Ideias: Explorar anéis de Júpiter no visual\. Em Feito: Criar o repositório\./);
  setJevTransport(null);
});

test("cascata: consulta temporal NÃO poda colunas — prazos espalham-se por colunas (recall-first)", async () => {
  const originalBatch = config.jev.cardBatch;
  config.jev.cardBatch = 4; // board grande (9 > 2×4): a poda seria permitida, mas o pedido é temporal
  setJevTransport(reply(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c_${i}`, noul(0.1)]))));
  const gate = board.lists.map((entry) => ({ listId: entry.id, listName: entry.name, p: 0.1, value: false }));
  const cascade = await runListingCascade({ text: "o que vence esta semana?", board, columnGate: gate });
  config.jev.cardBatch = originalBatch;
  assert.deepEqual(cascade.listingTrace.pruned, []);
  assert.equal(cascade.listingTrace.gateNote, "temporal");
  assert.equal(cascade.listingTrace.fallbackColumns, true);
  assert.equal(cascade.listingTrace.evaluated, openCardsOf(board).length);
  setJevTransport(null);
});

test("cascata: board pequeno (≤ 2 lotes) não poda colunas — a poda poupa nada e só arrisca", async () => {
  setJevTransport(reply(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c_${i}`, noul(0.1)]))));
  const gate = board.lists.map((entry) => ({ listId: entry.id, listName: entry.name, p: 0.1, value: false }));
  const cascade = await runListingCascade({ text: "o que tenho?", board, columnGate: gate });
  assert.deepEqual(cascade.listingTrace.pruned, []);
  assert.equal(cascade.listingTrace.gateNote, "board-pequeno");
  assert.equal(cascade.listingTrace.evaluated, openCardsOf(board).length);
  setJevTransport(null);
});

test("cascata: se NENHUMA coluna passa, passam todas (fallbackColumns)", async () => {
  setJevTransport(reply(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`c_${i}`, noul(i === 0 ? 0.95 : 0.1)]))));
  const gate = board.lists.map((entry) => ({ listId: entry.id, listName: entry.name, p: 0.2, value: false }));
  const cascade = await runListingCascade({ text: "x", board, columnGate: gate });
  assert.equal(cascade.listingTrace.fallbackColumns, true);
  assert.deepEqual(cascade.listingTrace.kept, ["Ideias", "A Fazer", "Fazendo", "Feito"]);
  assert.deepEqual(cascade.listingTrace.pruned, []);
  assert.equal(cascade.listingTrace.evaluated, openCardsOf(board).length);
  assert.equal(cascade.listing.length, 1);
  setJevTransport(null);
});

test("cascata: coluna/card sem resposta sai como 'sem resposta', nunca como 'não' confiante", async () => {
  const ideias = list("Ideias");
  const onlyIdeias = { ...board, lists: [ideias], cards: board.cards.filter((c) => c.idList === ideias.id) };
  setJevTransport(reply({ c_0: noul(0.9) })); // c_1 não veio na resposta
  const cascade = await runListingCascade({
    text: "x",
    board: onlyIdeias,
    columnGate: [{ listId: ideias.id, listName: "Ideias", p: null, value: null }],
  });
  assert.equal(cascade.listingTrace.fallbackColumns, true); // sem informação, nenhuma coluna passa → passam todas
  assert.deepEqual(
    (({ value, display, band, p }) => ({ value, display, band, p }))(cascade.listingTrace.columns[0]),
    { value: null, display: "sem resposta", band: "abstain", p: null },
  );
  const missing = cascade.listingTrace.cards.find((d) => d.id === "c_1");
  assert.equal(missing.display, "sem resposta");
  assert.equal(missing.p, null);
  assert.equal(missing.maybe, false);
  assert.equal(cascade.listingTrace.listed, 1);
  assert.equal(cascade.listing.length, 1);
  setJevTransport(null);
});

/* ── cascata: lotes e limiares ───────────────────────────────────────── */
test("splitBatches: divide em lotes do tamanho configurado (clamp em 4–24 na config)", () => {
  assert.deepEqual(splitBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(splitBatches([], 16), []);
  assert.equal(splitBatches(Array.from({ length: 40 }, (_, i) => i), 16).length, 3);
  assert.ok(config.jev.cardBatch >= 4 && config.jev.cardBatch <= 24);
  assert.equal(config.jev.listInclude, 0.5);
  assert.equal(config.jev.listMaybe, 0.35);
  assert.equal(config.jev.colInclude, 0.35);
});

test("cascata: 40 cards → 3 lotes (16/16/8), state IDÊNTICO e 1 noul por card, em paralelo", async () => {
  const calls = [];
  const many = {
    ...board,
    name: "Board grande",
    lists: [{ id: "l-many", name: "Tudo", pos: 1, closed: false }],
    cards: Array.from({ length: 40 }, (_, i) => ({ id: `b-${i}`, idList: "l-many", name: `Card ${i}`, desc: "", due: null, labels: [], closed: false, pos: (i + 1) * 1024 })),
  };
  setJevTransport(async (url, opts) => {
    calls.push(opts.body);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const ids = Object.keys(opts.body.questions);
    return reply(Object.fromEntries(ids.map((id) => [id, noul(0.9)])))();
  });
  const started = Date.now();
  const cascade = await runListingCascade({ text: "lista tudo", board: many, columnGate: [] });
  const elapsed = Date.now() - started;

  assert.deepEqual(calls.map((body) => Object.keys(body.questions).length), [16, 16, 8]);
  assert.deepEqual(calls.map((body) => Object.keys(body.questions)[0]), ["c_0", "c_0", "c_0"]);
  assert.deepEqual(calls[1].state, calls[0].state);
  assert.deepEqual(calls[2].state, calls[0].state);
  assert.equal(calls[0].state.comando, "lista tudo");
  assert.equal(calls[0].state.quadro, "Board grande");
  assert.equal(calls[0].state.listas, "Tudo (40 cards)");
  for (const body of calls) {
    for (const question of Object.values(body.questions)) {
      assert.equal(question.type, "noul");
      assert.match(question.instructions, /deve ser LISTADO na resposta ao pedido\?/);
      assert.deepEqual(question.criteria, {
        true: "O card responde ou corresponde ao pedido (em pedidos sobre prazos, use o campo `prazo`: ATRASADO / vence HOJE / vence em N dias)",
        false: "O card nada tem a ver com o pedido (ex.: prazo que não corresponde ao pedido)",
      });
    }
  }
  assert.equal(cascade.listingTrace.batches, 3);
  assert.equal(cascade.listingTrace.evaluated, 40);
  assert.equal(cascade.listingTrace.listed, 40);
  assert.ok(elapsed < 90, `os lotes deveriam correr em paralelo (levou ${elapsed} ms)`);
  setJevTransport(null);
});

test("cascata: limiares sim (≥0,5) / talvez (≥0,35) / não", async () => {
  const single = {
    ...board,
    lists: [list("Ideias")],
    cards: ["Alpha", "Beta", "Gama"].map((name, i) => ({
      id: `t-${i}`, idList: list("Ideias").id, name, desc: "", due: null, labels: [], closed: false, pos: (i + 1) * 1024,
    })),
  };
  setJevTransport(reply({ c_0: noul(0.8), c_1: noul(0.4), c_2: noul(0.34) }));
  const cascade = await runListingCascade({ text: "x", board: single, columnGate: [] });
  assert.equal(cascade.listingTrace.listed, 1);
  assert.equal(cascade.listingTrace.maybe, 1);
  assert.deepEqual(cascade.listing.map((item) => item.maybe), [false, true]);
  assert.equal(cascade.listingTrace.cards.find((d) => d.id === "c_2").maybe, false);
  assert.equal(cascade.listingTrace.cards.find((d) => d.id === "c_2").p, 0.34);
  assert.equal(cascade.speech, "Em Ideias: Alpha. Talvez também: Beta.");
  setJevTransport(null);
});

/* ── fala determinística da listagem ─────────────────────────────────── */

test("listingSpeech: agrupa por coluna, ressalva 'talvez', teto de ~12 e vazio", () => {
  assert.equal(listingSpeech([]), "Não encontrei nada que correspondesse ao pedido.");
  assert.equal(
    listingSpeech([
      { name: "X", list: "A Fazer", maybe: false },
      { name: "Y", list: "A Fazer", maybe: false },
      { name: "Z", list: "Fazendo", maybe: false },
      { name: "W", list: "Feito", maybe: true },
    ]),
    "Em A Fazer: X, Y. Em Fazendo: Z. Talvez também: W.",
  );
  const many = Array.from({ length: 15 }, (_, i) => ({ name: `N${i}`, list: "A Fazer", maybe: false }));
  assert.equal(listingSpeech(many), `Em A Fazer: ${many.slice(0, 12).map((item) => item.name).join(", ")}. E mais 3 cards.`);
});

test("cascata: board sem cards abertos responde por código, sem chamar o JEV", async () => {
  let calls = 0;
  setJevTransport(async () => {
    calls += 1;
    return reply({})();
  });
  const cascade = await runListingCascade({ text: "o que tenho?", board: { ...board, cards: [] }, columnGate: [] });
  assert.equal(cascade.speech, "O quadro não tem cards abertos.");
  assert.deepEqual(cascade.listing, []);
  assert.equal(cascade.listingTrace.evaluated, 0);
  assert.equal(calls, 0);
  setJevTransport(null);
});

test("cardLine: linha compacta com coluna, etiquetas, prazo relativo determinístico e descrição cortada", () => {
  assert.equal(cardLine(card("Explorar anéis de Júpiter no visual"), board), "«Explorar anéis de Júpiter no visual» (coluna: Ideias; descrição: Traço fino + partículas.)");
  assert.match(cardLine(card("Montar o board de voz"), board), /prazo: vence HOJE \(\d{4}-\d{2}-\d{2}\)/);
  assert.match(cardLine(card("Pagar conta de luz"), board), /prazo: ATRASADO \(venceu \d{4}-\d{2}-\d{2}\)/);
  // concluído nunca é "atrasado": o estado do card decide
  assert.match(cardLine(card("Criar o repositório"), board), /prazo: concluído \(\d{4}-\d{2}-\d{2}\)/);
  assert.match(cardLine(card("Comprar cabo HDMI"), board), /prazo: vence amanhã \(\d{4}-\d{2}-\d{2}\)/);

  // etiquetas vêm como objetos no board normalizado (ids também são aceitos)
  const labelled = {
    ...board,
    labels: [{ id: "lb-x", name: "urgente", color: "red" }],
    lists: [list("Ideias")],
    cards: [{ id: "c-x", idList: list("Ideias").id, name: "Card com etiqueta", desc: "", due: null, labels: [{ id: "lb-x", name: "urgente" }], closed: false }],
  };
  assert.match(cardLine(labelled.cards[0], labelled), /etiquetas: urgente/);

  const long = { id: "c-l", idList: list("Ideias").id, name: "N".repeat(120), desc: "D".repeat(200), due: null, labels: [], closed: false };
  const line = cardLine(long, board);
  assert.match(line, /«N{99}…»/);
  assert.match(line, /descrição: D{119}…/);
});

test("buildCardQuestions: 1 noul por card, ids c_<índice do lote>", () => {
  const batch = [card("Explorar anéis de Júpiter no visual"), card("Comprar cabo HDMI")];
  const questions = buildCardQuestions(batch, board);
  assert.deepEqual(Object.keys(questions), ["c_0", "c_1"]);
  for (const question of Object.values(questions)) assert.equal(question.type, "noul");
  assert.match(questions.c_0.instructions, /«Explorar anéis de Júpiter no visual» \(coluna: Ideias; descrição: Traço fino \+ partículas\.\)/);
  assert.match(questions.c_1.instructions, /«Comprar cabo HDMI» \(coluna: A Fazer; prazo: /);
});

/* ── pedido ao JEV: uma chamada por cláusula, perguntas em paralelo ──── */

config.openrouter.apiKey = "test-key";
config.jev.enabled = true;

test("planWithJev: comando composto vira N chamadas EM PARALELO e N ações", async () => {
  const calls = [];
  setJevTransport(async (url, opts) => {
    calls.push(opts.body.state.comando);
    await new Promise((r) => setTimeout(r, 40));
    const isMove = /move/.test(opts.body.state.comando);
    return reply(
      isMove
        ? phase1({ intent: choice("move_card"), card: choice("Escrever o README"), list: choice("Feito") })
        : phase1({ intent: choice("archive_card"), card: choice("Comprar cabo HDMI") }),
    )();
  });
  const t0 = Date.now();
  const r = await planWithJev({ transcript: "move o readme para feito e arquiva o cabo hdmi", board });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, "ok");
  assert.equal(calls.length, 2);
  assert.ok(elapsed < 75, `as duas chamadas deveriam sobrepor (levou ${elapsed} ms)`);
  assert.deepEqual(r.plan.actions.map((a) => a.type), ["move_card", "archive_card"]);
  assert.equal(r.trace.clauses.length, 2);
  assert.equal(r.plan.listing, undefined); // sem cláusula de listagem
  assert.equal(r.trace.listing, undefined); // a UI só mostra o painel de cascata em listagem
  setJevTransport(null);
});

test("planWithJev: listagem devolve plan.listing e trace.listing com a forma do contrato", async () => {
  const calls = [];
  setJevTransport(async (url, opts) => {
    calls.push(opts.body);
    if (isPhase1(opts.body)) {
      return reply(phase1({ intent: choice("listar_cards"), col_0: noul(0.9), col_1: noul(0.05), col_2: noul(0.05), col_3: noul(0.05) }))();
    }
    return reply({ c_0: noul(0.9), c_1: noul(0.4) })();
  });
  const originalBatch = config.jev.cardBatch;
  config.jev.cardBatch = 4; // 9 cards > 2×4: este teste exercita a poda de colunas
  const r = await planWithJev({ transcript: "procura o card dos anéis de júpiter", board });
  config.jev.cardBatch = originalBatch;

  assert.equal(r.status, "ok");
  assert.equal(r.plan.band, "auto");
  assert.equal(r.plan.needsConfirmation, false);
  assert.deepEqual(r.plan.actions, []);
  assert.equal(r.trace.clauses.length, 1);
  assert.equal(r.trace.clauses[0].decisions.some((d) => d.id === "query_kind"), false);

  const trace = r.trace.listing;
  assert.deepEqual(Object.keys(trace), ["columns", "cards", "kept", "pruned", "fallbackColumns", "gateNote", "batches", "evaluated", "listed", "maybe"]);
  assert.deepEqual(trace.kept, ["Ideias"]);
  assert.deepEqual(trace.pruned, ["A Fazer", "Fazendo", "Feito"]);
  assert.equal(trace.fallbackColumns, false);
  assert.equal(trace.batches, 1);
  assert.equal(trace.evaluated, 2);
  assert.equal(trace.listed, 1);
  assert.equal(trace.maybe, 1);
  assert.equal(trace.columns.length, 4);
  assert.deepEqual(
    (({ id, label, type, value, band, p }) => ({ id, label, type, value, band, p }))(trace.columns[0]),
    { id: "col_0", label: "Coluna «Ideias»", type: "noul", value: true, band: "auto", p: 0.9 },
  );
  assert.deepEqual(
    Object.keys(trace.cards[0]).sort(),
    ["band", "confidence", "display", "id", "label", "maybe", "p", "type", "value"].sort(),
  );
  assert.equal(trace.cards[0].id, "c_0");
  assert.equal(trace.cards[0].label, "Card «Explorar anéis de Júpiter no visual»");
  assert.equal(trace.cards[1].maybe, true);

  assert.deepEqual(Object.keys(r.plan.listing[0]), ["id", "name", "list", "due", "maybe"]);
  assert.deepEqual(r.plan.listing[0], { id: card("Explorar anéis de Júpiter no visual").id, name: "Explorar anéis de Júpiter no visual", list: "Ideias", due: null, maybe: false });
  assert.deepEqual(r.plan.listing[1], { id: card("Playlist para o modo foco").id, name: "Playlist para o modo foco", list: "Ideias", due: null, maybe: true });
  assert.equal(r.plan.speech, "Em Ideias: Explorar anéis de Júpiter no visual. Talvez também: Playlist para o modo foco.");
  setJevTransport(null);
});

test("listagem do JEV também guarda a 'última pesquisa' da sessão (ids + consulta)", async () => {
  const sessionId = "jev-listing-session";
  sessionStore.clear(sessionId);
  const savedKey = config.openrouter.apiKey;
  const savedEnabled = config.jev.enabled;
  config.openrouter.apiKey = "test-key";
  config.jev.enabled = true;
  setJevTransport(async (url, opts) => {
    if (isPhase1(opts.body)) {
      return reply(phase1({ intent: choice("listar_cards"), col_0: noul(0.9), col_1: noul(0.05), col_2: noul(0.05), col_3: noul(0.05) }))();
    }
    return reply({ c_0: noul(0.9), c_1: noul(0.4) })();
  });
  const originalBatch = config.jev.cardBatch;
  config.jev.cardBatch = 4; // 9 cards > 2×4: a poda de colunas deixa só «Ideias»
  const said = "procura o card dos anéis de júpiter";
  try {
    const r = await planCommand({ transcript: said, board, context: { sessionId } });
    assert.equal(r.provider, "jev");
    assert.ok(r.listing.length >= 1);

    const stored = sessionStore.getLastSearch(sessionId);
    assert.deepEqual(stored.ids, r.listing.map((item) => item.id));
    // Guarda a TRACE da listagem — nunca o texto cru do comando.
    assert.equal(stored.query.source, "jev-listing");
    assert.ok(stored.query.listed >= 1);
    assert.equal(JSON.stringify(stored.query).includes(said), false);
    assert.equal(typeof stored.at, "number");

    // Sem sessionId não há onde guardar — e nada quebra.
    const semSessao = await planCommand({ transcript: said, board, context: {} });
    assert.equal(semSessao.provider, "jev");
    assert.equal(sessionStore.getLastSearch(null), null);
  } finally {
    config.jev.cardBatch = originalBatch;
    config.openrouter.apiKey = savedKey;
    config.jev.enabled = savedEnabled;
    setJevTransport(null);
    sessionStore.clear(sessionId);
  }
});

test("planWithJev: duas cláusulas de listagem somam o trace e rotulam colunas/cards por cláusula", async () => {
  setJevTransport(async (url, opts) => {
    if (isPhase1(opts.body)) {
      const emIdeias = /ideias/.test(opts.body.state.comando);
      return reply(phase1({
        intent: choice("listar_cards"),
        col_0: noul(emIdeias ? 0.9 : 0.05),
        col_1: noul(0.05),
        col_2: noul(0.05),
        col_3: noul(emIdeias ? 0.05 : 0.9),
      }))();
    }
    const ids = Object.keys(opts.body.questions);
    return reply(Object.fromEntries(ids.map((id) => [id, noul(0.9)])))();
  });
  const originalBatch = config.jev.cardBatch;
  config.jev.cardBatch = 4; // 9 cards > 2×4: este teste exercita a poda de colunas
  const r = await planWithJev({ transcript: "lista o que tenho em ideias e mostra o que tenho em feito", board });
  config.jev.cardBatch = originalBatch;
  assert.equal(r.status, "ok");
  const trace = r.trace.listing;
  assert.equal(trace.columns.length, 8);
  assert.equal(trace.batches, 2);
  assert.equal(trace.evaluated, 3); // 2 cards em Ideias + 1 em Feito
  assert.equal(trace.listed, 3);
  assert.deepEqual(trace.kept, ["Ideias", "Feito"]);
  assert.equal(trace.columns.find((c) => c.id === "col_0").label, "Coluna «Ideias» — «lista o que tenho em ideias»");
  assert.equal(trace.cards[0].label, "Card «Explorar anéis de Júpiter no visual» — «lista o que tenho em ideias»");
  assert.equal(r.plan.listing.length, 3);
  assert.match(r.plan.speech, /Em Ideias: /);
  assert.match(r.plan.speech, /Em Feito: Criar o repositório\./);
  setJevTransport(null);
});

test("planWithJev: erro de créditos vira 'unavailable' com motivo legível (sem exceção)", async () => {
  setJevTransport(async () => ({ status: 402, headers: {}, text: JSON.stringify({ error: { code: 402, message: "no credits" } }), ms: 5 }));
  const r = await planWithJev({ transcript: "move o readme para feito", board });
  assert.equal(r.status, "unavailable");
  assert.equal(r.code, "credits");
  assert.match(r.reason, /sem créditos/);
  setJevTransport(null);
});

test("planWithJev: erro no lote da cascata também vira 'unavailable' (nunca plano parcial)", async () => {
  setJevTransport(async (url, opts) => {
    if (isPhase1(opts.body)) return reply(phase1({ intent: choice("listar_cards"), col_0: noul(0.9) }))();
    throw new Error("ECONNRESET");
  });
  const r = await planWithJev({ transcript: "o que tenho?", board });
  assert.equal(r.status, "unavailable");
  assert.match(r.reason, /o JEV está indisponível/);
  assert.equal(r.trace.clauses.length, 1);
  setJevTransport(null);
});

test("planWithJev: 503 é retentado uma vez e recupera", async () => {
  let n = 0;
  setJevTransport(async () => {
    n += 1;
    if (n === 1) return { status: 503, headers: {}, text: "{}", ms: 5 };
    return reply(phase1({ intent: choice("archive_card"), card: choice("Comprar cabo HDMI") }))();
  });
  const r = await planWithJev({ transcript: "arquiva o cabo hdmi", board });
  assert.equal(r.status, "ok");
  assert.equal(n, 2);
  setJevTransport(null);
});

/* ── planner: System Two (compostos) → JEV → local ───────────────────── */

/** Plano JSON no formato que o System Two devolve. */
const llmPlan = (actions, speech = "Pronto, fiz o que pediu.") =>
  JSON.stringify({ speech, needsConfirmation: false, actions });

/**
 * Stub do OpenRouter (chat/completions): conta as chamadas e devolve `content`
 * (ou um erro HTTP, quando `status !== 200`). Nada de rede de verdade.
 */
function stubChat(content, { status = 200 } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const json =
      status === 200
        ? { model: "google/gemini-3.8-flash", choices: [{ message: { content } }] }
        : { error: { message: "o modelo não aceitou o pedido" } };
    return { ok: status === 200, status, headers: { get: () => null }, text: async () => JSON.stringify(json) };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** Transporte do JEV proibido: qualquer chamada é um erro do teste. */
function forbiddenJev() {
  const calls = [];
  setJevTransport(async (url, opts) => {
    calls.push(opts.body.state.comando);
    throw new Error("o JEV não devia ser chamado neste comando");
  });
  return calls;
}

test("JEV opera → nenhum chat/completions é chamado", async () => {
  const realFetch = globalThis.fetch;
  setJevTransport(reply(phase1({ intent: choice("archive_card"), card: choice("Comprar cabo HDMI") })));
  globalThis.fetch = async (url) => {
    throw new Error(`não devia chamar a rede: ${url}`);
  };
  const r = await planCommand({ transcript: "arquiva o cabo hdmi", board });
  assert.equal(r.provider, "jev");
  assert.equal(r.trace.engine, "jev");
  assert.equal(r.trace.fallback, null);
  assert.equal(r.trace.mimo, null);
  assert.equal(r.trace.llm, null);
  assert.equal(r.band, "auto");
  assert.equal(r.needsConfirmation, false);
  globalThis.fetch = realFetch;
  setJevTransport(null);
});

test("abstenção que NÃO é composta (low_intent) → esclarecimento, sem chat/completions", async () => {
  const realFetch = globalThis.fetch;
  setJevTransport(reply(phase1({ intent: choice("move_card", 0.3) })));
  globalThis.fetch = async (url) => {
    throw new Error(`não devia chamar a rede: ${url}`);
  };
  const r = await planCommand({ transcript: "dá um jeito naquilo", board });
  assert.equal(r.provider, "jev");
  assert.equal(r.trace.engine, "jev");
  assert.equal(r.trace.llm, null);
  assert.equal(r.band, "abstain");
  assert.deepEqual(r.actions, []);
  assert.equal(r.needsConfirmation, false);
  assert.equal(r.trace.mimo, null);
  assert.equal(r.trace.fallback, null);
  assert.equal(r.trace.jev.code, "low_intent");
  assert.match(r.warning, /não consigo operar/);
  assert.match(r.speech, /^não consigo operar.*Pode reformular ou dar mais detalhes\?$/);
  globalThis.fetch = realFetch;
  setJevTransport(null);
});

test("JEV indisponível → fala de indisponibilidade, sem duplicar o prefixo e sem System Two", async () => {
  const realFetch = globalThis.fetch;
  setJevTransport(async () => {
    throw new Error("ECONNRESET");
  });
  globalThis.fetch = async (url) => {
    throw new Error(`não devia chamar a rede: ${url}`);
  };
  const r = await planCommand({ transcript: "cria um card chamado teste de órbita", board });
  assert.equal(r.provider, "jev");
  assert.equal(r.band, "abstain");
  assert.deepEqual(r.actions, []);
  assert.equal(r.trace.llm, null); // indisponível NÃO vai ao System Two
  assert.match(r.speech, /^O JEV está indisponível: sem rede .* Tente novamente em instantes\.$/);
  assert.doesNotMatch(r.speech, /indisponível: o JEV está indisponível/);
  assert.match(r.warning, /o JEV está indisponível/);
  globalThis.fetch = realFetch;
  setJevTransport(null);
});

test("sem JEV (chave ausente) o interpretador local mantém o app vivo, sem rede", async () => {
  const realFetch = globalThis.fetch;
  const savedKey = config.openrouter.apiKey;
  const savedEnabled = config.jev.enabled;
  config.openrouter.apiKey = "";
  config.jev.enabled = false;
  globalThis.fetch = async (url) => {
    throw new Error(`não devia chamar a rede: ${url}`);
  };
  const r = await planCommand({ transcript: "cria um card chamado teste de órbita", board });
  assert.equal(r.provider, "local");
  assert.equal(r.trace.engine, "local");
  assert.equal(r.trace.jev, null);
  assert.equal(r.trace.llm, null);
  assert.equal(r.warning, null);
  assert.equal(r.actions[0].type, "create_card");
  config.openrouter.apiKey = savedKey;
  config.jev.enabled = savedEnabled;
  globalThis.fetch = realFetch;
});

test("criar/apagar sempre pedem confirmação, mesmo com o JEV 100% confiante", async () => {
  setJevTransport(reply(phase1({ intent: choice("delete_card", 1), card: choice("Comprar cabo HDMI", 1) })));
  const r = await planCommand({ transcript: "apaga o cabo hdmi", board });
  assert.equal(r.provider, "jev");
  assert.equal(r.band, "auto");
  assert.equal(r.needsConfirmation, true);
  assert.match(r.speech, /definitiva/);
  setJevTransport(null);

  setJevTransport(reply(phase1({ intent: choice("create_card", 1), list: choice("A Fazer", 1) })));
  const created = await planCommand({ transcript: "cria um card chamado revisar proposta na lista a fazer", board });
  assert.equal(created.actions[0].type, "create_card");
  assert.equal(created.needsConfirmation, true);
  setJevTransport(null);
});

/* ── System Two: comandos simultâneos planeados inteiros pelo LLM ────── */

test("composto (2 cláusulas) → System Two planeia o comando INTEIRO, sem tocar no JEV", async () => {
  const jevCalls = forbiddenJev();
  const chat = stubChat(
    llmPlan([
      { type: "move_card", card: "Escrever o README", list: "Feito" },
      { type: "archive_card", card: "Comprar cabo HDMI" },
    ]),
  );
  const said = "move o readme para feito e arquiva o cabo hdmi";
  try {
    const r = await planCommand({ transcript: said, board });
    assert.equal(jevCalls.length, 0); // composto claro: o JEV nem é consultado
    assert.equal(chat.calls.length, 1);
    assert.match(chat.calls[0].url, /\/chat\/completions$/);
    assert.equal(chat.calls[0].body.model, config.openrouter.model);
    assert.ok(chat.calls[0].body.reasoning, "leva o esforço de raciocínio por padrão");
    assert.match(chat.calls[0].body.messages[1].content, new RegExp(said.slice(0, 20)));
    assert.match(chat.calls[0].body.messages[1].content, /CARDS:/); // recebe o board inteiro

    assert.equal(r.provider, "llm");
    assert.equal(r.model, "google/gemini-3.8-flash");
    assert.equal(r.band, null); // o LLM não devolve confiança
    assert.equal(r.needsConfirmation, false);
    assert.equal(r.warning, null);
    assert.deepEqual(r.actions.map((a) => a.type), ["move_card", "archive_card"]);
    assert.equal(r.trace.engine, "llm");
    assert.equal(r.trace.jev, null);
    assert.equal(r.trace.mimo, null);
    assert.equal(r.trace.fallback, null);
    assert.equal(r.trace.llm.status, "ok");
    assert.equal(r.trace.llm.model, "google/gemini-3.8-flash");
    assert.equal(typeof r.trace.llm.latencyMs, "number");
  } finally {
    chat.restore();
    setJevTransport(null);
  }
});

test("abstenção 'compound' num trecho único → o comando inteiro vai ao System Two", async () => {
  const jevCalls = [];
  setJevTransport(async (url, opts) => {
    jevCalls.push(opts.body.state.comando);
    return reply(phase1({ compound: noul(0.95) }))();
  });
  const chat = stubChat(
    llmPlan([
      { type: "move_card", card: "Escrever o README", list: "Feito" },
      { type: "archive_card", card: "Comprar cabo HDMI" },
    ]),
  );
  const said = "resolve o readme e o cabo hdmi de uma vez";
  try {
    assert.equal(splitClauses(said).length, 1); // o texto é UM trecho...
    const r = await planCommand({ transcript: said, board });
    assert.equal(jevCalls.length, 1); // ...o JEV foi consultado e abstiu por "compound"
    assert.equal(chat.calls.length, 1);
    assert.equal(r.provider, "llm");
    assert.equal(r.band, null);
    assert.equal(r.actions.length, 2);
    assert.equal(r.trace.engine, "llm");
    assert.equal(r.trace.llm.status, "ok");
    assert.equal(r.trace.jev, null);
  } finally {
    chat.restore();
    setJevTransport(null);
  }
});

test("abstenções que NÃO são compostas (no_card, unclear) nunca chamam o chat/completions", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`não devia chamar a rede: ${url}`);
  };
  try {
    setJevTransport(reply(phase1({ intent: choice("delete_card", 1) }))); // card NENHUM → no_card
    const noCard = await planCommand({ transcript: "apaga aquilo lá", board });
    assert.equal(noCard.trace.jev.code, "no_card");
    assert.equal(noCard.band, "abstain");
    assert.deepEqual(noCard.actions, []);
    assert.equal(noCard.trace.llm, null);
    assert.match(noCard.warning, /não identifiquei qual card/);

    setJevTransport(reply(phase1({ clear: noul(0.1) }))); // fala ininteligível → unclear
    const unclear = await planCommand({ transcript: "aquilo do negócio", board });
    assert.equal(unclear.trace.jev.code, "unclear");
    assert.equal(unclear.band, "abstain");
    assert.equal(unclear.trace.llm, null);
  } finally {
    globalThis.fetch = realFetch;
    setJevTransport(null);
  }
});

test("plano do LLM com 3 ações (create/delete/move) → ordem preservada e needsConfirmation true", async () => {
  forbiddenJev();
  const chat = stubChat(
    llmPlan([
      { type: "create_card", name: "Revisar contrato", list: "A Fazer" },
      { type: "delete_card", card: "Comprar cabo HDMI", reason: "pedido da pessoa" },
      { type: "move_card", card: "Escrever o README", list: "Feito" },
    ]),
  );
  try {
    const r = await planCommand({
      transcript: "cria um card revisar contrato, apaga o cabo hdmi e move o readme para feito",
      board,
    });
    assert.equal(r.provider, "llm");
    assert.equal(r.actions.length, 3);
    assert.deepEqual(r.actions.map((a) => a.type), ["create_card", "delete_card", "move_card"]);
    // O JSON do modelo dizia needsConfirmation: false — parsePlan corrige por create/delete.
    assert.equal(r.needsConfirmation, true);
  } finally {
    chat.restore();
    setJevTransport(null);
  }
});

test("System Two falha num composto → cai no JEV por cláusulas e ainda devolve ações", async () => {
  const chat = stubChat("", { status: 400 }); // 400 sem citar "reasoning": não repete
  setJevTransport(async (url, opts) => {
    const isMove = /move/.test(opts.body.state.comando);
    return reply(
      isMove
        ? phase1({ intent: choice("move_card"), card: choice("Escrever o README"), list: choice("Feito") })
        : phase1({ intent: choice("archive_card"), card: choice("Comprar cabo HDMI") }),
    )();
  });
  try {
    const r = await planCommand({ transcript: "move o readme para feito e arquiva o cabo hdmi", board });
    assert.equal(chat.calls.length, 1);
    assert.equal(r.provider, "jev");
    assert.equal(r.trace.engine, "jev");
    assert.equal(r.trace.llm.status, "failed");
    assert.match(r.trace.llm.reason, /OpenRouter/);
    assert.deepEqual(r.actions.map((a) => a.type), ["move_card", "archive_card"]);
    assert.equal(r.warning, null); // o JEV resolveu: sem banner
  } finally {
    chat.restore();
    setJevTransport(null);
  }
});

test("System Two falha E o JEV abstém → esclarecimento com warning sobre a falha do planejador", async () => {
  const chat = stubChat("", { status: 400 });
  setJevTransport(reply(phase1({ intent: choice("delete_card", 1) }))); // no_card nos dois trechos
  const said = "apaga aquilo lá e arquiva o resto";
  try {
    assert.equal(splitClauses(said).length, 2);
    const r = await planCommand({ transcript: said, board });
    assert.equal(r.provider, "jev");
    assert.equal(r.band, "abstain");
    assert.deepEqual(r.actions, []);
    assert.equal(r.trace.llm.status, "failed");
    assert.equal(r.trace.jev.code, "no_card");
    assert.match(r.warning, /não identifiquei qual card/);
    assert.match(r.warning, /planejador do comando inteiro falhou/);
    assert.match(r.speech, /Pode reformular ou dar mais detalhes\?$/);
  } finally {
    chat.restore();
    setJevTransport(null);
  }
});

test("multi-cláusula SEM chave OpenRouter → interpretador local, sem rede", async () => {
  const realFetch = globalThis.fetch;
  const savedKey = config.openrouter.apiKey;
  const savedEnabled = config.jev.enabled;
  config.openrouter.apiKey = "";
  config.jev.enabled = false;
  globalThis.fetch = async (url) => {
    throw new Error(`não devia chamar a rede: ${url}`);
  };
  try {
    const r = await planCommand({ transcript: "cria um card chamado teste de órbita e cria outro chamado teste de cometa", board });
    assert.equal(r.provider, "local");
    assert.equal(r.trace.engine, "local");
    assert.equal(r.trace.jev, null);
    assert.equal(r.trace.llm, null);
    assert.equal(r.actions.length, 1);
  } finally {
    config.openrouter.apiKey = savedKey;
    config.jev.enabled = savedEnabled;
    globalThis.fetch = realFetch;
  }
});

test("System Two: 400 citando 'reasoning' → repete UMA vez sem o campo", async () => {
  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: "reasoning is not supported by this model" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          model: "google/gemini-3.8-flash",
          choices: [{ message: { content: llmPlan([{ type: "create_card", name: "Testar o System Two", list: "A Fazer" }]) } }],
        }),
    };
  };
  forbiddenJev();
  try {
    const r = await planCommand({ transcript: "cria um card de teste e move o readme para feito", board });
    assert.equal(bodies.length, 2);
    assert.ok(bodies[0].reasoning);
    assert.equal(bodies[1].reasoning, undefined); // segunda tentativa sem `reasoning`
    assert.equal(r.provider, "llm");
    assert.equal(r.trace.llm.status, "ok");
    assert.equal(r.actions.length, 1);
  } finally {
    globalThis.fetch = real;
    setJevTransport(null);
  }
});

/* ── configuração do modelo ──────────────────────────────────────────── */

test("config: sem OPENROUTER_MODEL o default é 'auto' (descoberta) com reserva google/gemini-3.8-flash", () => {
  // O .env da máquina pode fixar outro modelo: perguntamos ao config num processo
  // limpo, com a variável vazia (o dotenv não sobrepõe o que já está no ambiente).
  // "auto" = o model-picker escolhe o melhor modelo em GET /models; a reserva é
  // usada quando a descoberta falha (nunca lança).
  const configUrl = new URL("../src/config.js", import.meta.url).href;
  const out = execFileSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(configUrl)}).then(({ config }) => console.log([config.openrouter.model, config.openrouter.modelFallback].join("|")))`],
    { env: { ...process.env, OPENROUTER_MODEL: "", OPENROUTER_MODEL_FALLBACK: "" }, encoding: "utf8" },
  );
  assert.equal(out.trim(), "auto|google/gemini-3.8-flash");
});

/* ── capacidades (UI) ────────────────────────────────────────────────── */

test("capabilities: engine jev|local, fallback none|local, llm = modelo do System Two", () => {
  const saved = config.jev.enabled;
  const savedKey = config.openrouter.apiKey;
  config.openrouter.apiKey = "test-key";
  config.jev.enabled = true;
  let caps = capabilities();
  assert.equal(caps.engine, "jev");
  assert.equal(caps.fallback, "none");
  assert.equal(caps.models.jev, config.jev.model);
  assert.equal(caps.models.llm, config.openrouter.model);
  assert.equal(caps.models.mimo, undefined); // o campo antigo saiu

  config.jev.enabled = false;
  caps = capabilities();
  assert.equal(caps.engine, "local");
  assert.equal(caps.fallback, "local");
  assert.equal(caps.models.jev, null);
  assert.equal(caps.models.llm, config.openrouter.model);

  config.openrouter.apiKey = ""; // sem chave não há System Two
  assert.equal(capabilities().models.llm, null);
  config.openrouter.apiKey = savedKey;
  config.jev.enabled = saved;
});
