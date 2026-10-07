import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { setJevTransport } from "../src/services/jev.js";
import {
  bandFor,
  buildQuestions,
  extractCreate,
  interpretClause,
  lexicalCard,
  planWithJev,
  splitClauses,
} from "../src/services/jev-planner.js";
import { planCommand } from "../src/services/planner.js";
import { DemoBoard } from "../src/services/trello.js";

const board = await new DemoBoard().getBoard();
const card = (name) => board.cards.find((c) => c.name === name);
const list = (name) => board.lists.find((l) => l.name === name);

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
  query_kind: choice("not_query"),
  ...over,
});

const clause = (text, a, extra = {}) => {
  const built = buildQuestions({ board, transcript: text, context: extra.context ?? {} });
  return interpretClause({ text, answers: answers(a), built, board });
};

/* ── bandas ──────────────────────────────────────────────────────────── */

test("bandFor: choice usa confidence; noul usa certeza e rejeita o indeciso", () => {
  assert.equal(bandFor(choice("x", 0.95)).band, "auto");
  assert.equal(bandFor(choice("x", 0.7)).band, "hitl");
  assert.equal(bandFor(choice("x", 0.3)).band, "abstain");
  assert.equal(bandFor(noul(0.97)).band, "auto"); // certeza 0.97
  assert.equal(bandFor(noul(0.03)).band, "auto"); // certeza 0.97 do "não"
  assert.equal(bandFor(noul(0.55)).band, "abstain"); // indeciso (|p-0.5|<0.1)
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

test("decisões devolvidas à UI: guardas marcadas como usadas; query_kind só em consultas", () => {
  const move = clause("move o readme para feito", { intent: choice("move_card"), card: choice("Escrever o README"), list: choice("Feito") });
  assert.ok(move.decisions.find((d) => d.id === "clear").used);
  assert.equal(move.decisions.find((d) => d.id === "query_kind"), undefined);
  const query = clause("o que tenho?", { intent: choice("query_board"), query_kind: choice("overview") });
  assert.ok(query.decisions.find((d) => d.id === "query_kind").used);
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

test("consultas: visão geral e conteúdo de lista saem sem ação; o resto cai no MiMo", () => {
  const overview = clause("o que eu tenho?", { intent: choice("query_board"), query_kind: choice("overview") });
  assert.equal(overview.status, "ok");
  assert.match(overview.plan.speech, /Board de demonstração/);
  const contents = clause("o que tem em fazendo?", { intent: choice("query_board"), query_kind: choice("list_contents"), list: choice("Fazendo") });
  assert.match(contents.plan.speech, /Em Fazendo você tem 2 cards: Montar o board de voz, Escrever o README/);
  assert.equal(clause("quanto vence essa semana?", { intent: choice("query_board"), query_kind: choice("due_dates") }).code, "query_complex");
});

/* ── pedido ao JEV: uma chamada, perguntas em paralelo ───────────────── */

test("buildQuestions: card/lista como opções reais + NENHUM/NENHUMA, tudo em 1 mapa", () => {
  const { questions } = buildQuestions({ board, transcript: "x" });
  assert.deepEqual(Object.keys(questions), ["intent", "card", "list", "query_kind", "compound", "clear"]);
  assert.ok("Escrever o README" in questions.card.criteria && "NENHUM" in questions.card.criteria);
  assert.ok("Fazendo" in questions.list.criteria && "NENHUMA" in questions.list.criteria);
  assert.deepEqual(questions.card.criteria["Escrever o README"], { lista: "Fazendo" });
  assert.ok(Object.keys(questions.card.criteria).length <= 255);
});

test("buildQuestions: nomes de cards repetidos ganham sufixo e sempre cabem em 255 opções", () => {
  const many = { ...board, cards: Array.from({ length: 400 }, (_, i) => ({ ...board.cards[0], id: `x${i}`, name: i % 2 ? "Repetido" : `Card ${i}` })) };
  const { questions } = buildQuestions({ board: many, transcript: "card 7" });
  assert.ok(Object.keys(questions.card.criteria).length <= 251);
  assert.ok("Repetido (2)" in questions.card.criteria);
});

/* ── ponta a ponta com transporte falso (sem rede) ───────────────────── */

config.openrouter.apiKey = "test-key";
config.jev.enabled = true;

const reply = (a, ms = 5) => async () => ({ status: 200, headers: {}, text: JSON.stringify({ answers: a, model: "typesafe/jev-1.13-test", usage: { input_tokens: 100, cost: 0.000004 } }), reusedSocket: true, ms });

test("planWithJev: comando composto vira N chamadas EM PARALELO e N ações", async () => {
  const calls = [];
  setJevTransport(async (url, opts) => {
    calls.push(opts.body.state.comando);
    await new Promise((r) => setTimeout(r, 40));
    const isMove = /move/.test(opts.body.state.comando);
    return reply(
      isMove
        ? answers({ intent: choice("move_card"), card: choice("Escrever o README"), list: choice("Feito") })
        : answers({ intent: choice("archive_card"), card: choice("Comprar cabo HDMI") }),
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

test("planWithJev: 503 é retentado uma vez e recupera", async () => {
  let n = 0;
  setJevTransport(async () => {
    n += 1;
    if (n === 1) return { status: 503, headers: {}, text: "{}", ms: 5 };
    return reply(answers({ intent: choice("archive_card"), card: choice("Comprar cabo HDMI") }))();
  });
  const r = await planWithJev({ transcript: "arquiva o cabo hdmi", board });
  assert.equal(r.status, "ok");
  assert.equal(n, 2);
  setJevTransport(null);
});

/* ── cadeia de reserva: JEV → MiMo → local ───────────────────────────── */

const realFetch = globalThis.fetch;
const mimoReply = (plan) => async () =>
  new Response(JSON.stringify({ model: "xiaomi/mimo-test", choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200 });

test("JEV opera → MiMo NÃO é chamado", async () => {
  setJevTransport(reply(answers({ intent: choice("archive_card"), card: choice("Comprar cabo HDMI") })));
  globalThis.fetch = async () => {
    throw new Error("o MiMo não devia ser chamado");
  };
  const r = await planCommand({ transcript: "arquiva o cabo hdmi", board });
  assert.equal(r.provider, "jev");
  assert.equal(r.trace.engine, "jev");
  assert.equal(r.trace.fallback, null);
  assert.equal(r.band, "auto");
  assert.equal(r.needsConfirmation, false);
  globalThis.fetch = realFetch;
  setJevTransport(null);
});

test("JEV se abstém → MiMo assume e o trace explica por quê (nas palavras do JEV)", async () => {
  setJevTransport(reply(answers({ intent: choice("move_card", 0.3) })));
  globalThis.fetch = mimoReply({ speech: "Qual card você quer mover?", needsConfirmation: false, actions: [] });
  const r = await planCommand({ transcript: "dá um jeito naquilo", board });
  assert.equal(r.provider, "mimo");
  assert.equal(r.trace.engine, "mimo");
  assert.equal(r.trace.fallback.from, "jev");
  assert.equal(r.trace.fallback.code, "low_intent");
  assert.match(r.trace.fallback.reason, /não consigo operar/);
  assert.equal(r.speech, "Qual card você quer mover?");
  globalThis.fetch = realFetch;
  setJevTransport(null);
});

test("JEV indisponível (rede) → MiMo; MiMo também cai → interpretador local", async () => {
  setJevTransport(async () => {
    throw new Error("ECONNRESET");
  });
  globalThis.fetch = async () => new Response("{}", { status: 500 });
  const r = await planCommand({ transcript: "cria um card chamado teste de órbita", board });
  assert.equal(r.provider, "local-fallback");
  assert.equal(r.trace.engine, "local");
  assert.equal(r.actions[0].type, "create_card");
  assert.match(r.warning, /JEV e MiMo não conseguiram operar/);
  globalThis.fetch = realFetch;
  setJevTransport(null);
});

test("criar/apagar sempre pedem confirmação, mesmo com o JEV 100% confiante", async () => {
  setJevTransport(reply(answers({ intent: choice("delete_card", 1), card: choice("Comprar cabo HDMI", 1) })));
  const r = await planCommand({ transcript: "apaga o cabo hdmi", board });
  assert.equal(r.provider, "jev");
  assert.equal(r.band, "auto");
  assert.equal(r.needsConfirmation, true);
  assert.match(r.speech, /definitiva/);
  setJevTransport(null);
});
