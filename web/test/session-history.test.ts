import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MAX_CONTENT,
  HISTORY_MAX_ENTRIES,
  activityLabel,
  assistantSummary,
  clampContent,
  createSession,
  createSessionHistory,
  matchedFieldLabel,
  matchedFieldLabels,
  newSessionId,
  searchCount,
  searchQueryText,
  searchSummary,
  searchTitle,
  sessionSummary,
  turnCount,
  turnLabel,
} from "../src/lib/session.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Preenche um histórico com `total` entradas alternando pergunta e resposta. */
function fill(history: ReturnType<typeof createSessionHistory>, total: number) {
  for (let i = 0; i < total; i += 1) {
    const role = i % 2 === 0 ? "user" : "assistant";
    history.push(role, `${role === "user" ? "pergunta" : "resposta"} ${i}`);
  }
}

test("histórico: push/toArray/size guardam o papel e a ordem (mais recente por último)", () => {
  const history = createSessionHistory();
  assert.equal(history.size(), 0);
  assert.deepEqual(history.toArray(), []);

  history.push("user", "cria um card chamado revisar proposta");
  history.push("assistant", "Criei o card na lista A fazer.");
  assert.equal(history.size(), 2);
  assert.deepEqual(history.toArray(), [
    { role: "user", content: "cria um card chamado revisar proposta" },
    { role: "assistant", content: "Criei o card na lista A fazer." },
  ]);
});

test("histórico: toArray devolve cópias — mutar o retorno não mexe no que foi guardado", () => {
  const history = createSessionHistory();
  history.push("user", "move o card X para Feito");

  const out = history.toArray();
  out[0].content = "adulterado";
  out.push({ role: "assistant", content: "intruso" });

  assert.equal(history.size(), 1);
  assert.deepEqual(history.toArray(), [{ role: "user", content: "move o card X para Feito" }]);
});

test("histórico: content é truncado em 500 caracteres", () => {
  assert.equal(HISTORY_MAX_CONTENT, 500);
  const history = createSessionHistory();
  const long = "a".repeat(900);
  history.push("user", long);

  const [entry] = history.toArray();
  assert.equal(entry.content.length, 500);
  assert.equal(entry.content, "a".repeat(500));

  assert.equal(clampContent("curto"), "curto");
  assert.equal(clampContent("b".repeat(501)).length, 500);
});

test("histórico: o corte não parte emoji (nunca sobra substituto solto)", () => {
  const emoji = "🙂"; // 2 unidades UTF-16: cabe inteiro ou não entra
  assert.equal(emoji.length, 2);

  // (a) paridade ímpar: o emoji começa no código 499 e seria partido ao meio.
  const odd = `${"a".repeat(499)}${emoji}`;
  assert.equal(odd.length, 501);
  const cutOdd = clampContent(odd);
  assert.equal(cutOdd, "a".repeat(499));
  assert.equal(cutOdd.length, 499); // ≤ 500 e sem o substituto solto
  assert.ok(cutOdd.isWellFormed());

  // (b) só emojis: 300 pares (600 unidades) → 250 inteiros, sem sobra.
  const onlyEmoji = emoji.repeat(300);
  assert.equal(onlyEmoji.length, 600);
  const cutEmoji = clampContent(onlyEmoji);
  assert.equal(cutEmoji, emoji.repeat(250));
  assert.equal(cutEmoji.length, 500);
  assert.ok(cutEmoji.isWellFormed());

  // (c) o mesmo emoji nas duas paridades: ímpar é adiado, par cabe inteiro.
  const straddleOdd = `${"b".repeat(499)}${emoji}${"z".repeat(10)}`;
  const straddleEven = `${"b".repeat(498)}${emoji}${"z".repeat(10)}`;
  const cutStraddleOdd = clampContent(straddleOdd);
  const cutStraddleEven = clampContent(straddleEven);
  assert.equal(cutStraddleOdd.length, 499);
  assert.ok(cutStraddleOdd.isWellFormed());
  assert.equal(cutStraddleEven, `${"b".repeat(498)}${emoji}`);
  assert.equal(cutStraddleEven.length, 500);
  assert.ok(cutStraddleEven.isWellFormed());

  // Entrada já malformada: o substituto que cai na borda também sai.
  assert.equal(clampContent(`${"x".repeat(499)}\ud83d${"y".repeat(20)}`), "x".repeat(499));
});

test("histórico: teto de 20 entradas descarta as mais antigas e mantém as últimas", () => {
  const history = createSessionHistory();
  fill(history, 25);

  assert.equal(HISTORY_MAX_ENTRIES, 20);
  assert.equal(history.size(), 20);

  const out = history.toArray();
  assert.equal(out.length, 20);
  assert.deepEqual(out[0], { role: "assistant", content: "resposta 5" }); // 0..4 saíram
  assert.deepEqual(out.at(-1), { role: "user", content: "pergunta 24" });
  assert.ok(out.every((entry, index) => entry.content === `${entry.role === "user" ? "pergunta" : "resposta"} ${index + 5}`));
});

test("histórico: teto é configurável e nunca fica abaixo de 1 entrada", () => {
  const short = createSessionHistory(4);
  fill(short, 9);
  assert.equal(short.size(), 4);
  assert.deepEqual(short.toArray()[0], { role: "assistant", content: "resposta 5" });

  const broken = createSessionHistory(0); // valor inválido volta ao teto do contrato
  fill(broken, HISTORY_MAX_ENTRIES + 3);
  assert.equal(broken.size(), HISTORY_MAX_ENTRIES);
});

test("newSessionId: UUID v4 e diferente a cada chamada (nada é reaproveitado)", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, UUID_V4);
});

test("sessão: createSession dá id novo e histórico vazio — dois carregamentos não se misturam", () => {
  const first = createSession();
  first.history.push("user", "o que tem na lista Hoje?");
  first.history.push("assistant", "Achei 3 cards.");

  const second = createSession(); // simula o F5
  assert.equal(second.history.size(), 0);
  assert.equal(first.history.size(), 2);
  assert.notEqual(second.id, first.id);
  assert.match(second.id, UUID_V4);
});

test("turnos: o contador da sessão não satura com o buffer de 20 entradas", () => {
  const session = createSession();
  assert.equal(session.turns(), 0);

  for (let i = 0; i < 25; i += 1) {
    assert.equal(session.completeExchange(`pergunta ${i}`, `resposta ${i}`), i + 1); // devolve o total
  }

  // O chip de sessão mostra o número REAL de trocas concluídas…
  assert.equal(session.turns(), 25);
  assert.equal(turnLabel(session.turns()), "25 turnos nesta sessão");

  // …enquanto o buffer continua capado em 20 entradas (derivar dele mentiria).
  assert.equal(session.history.size(), HISTORY_MAX_ENTRIES);
  assert.equal(turnCount(session.history.toArray()), 10);
  assert.equal(sessionSummary(session.history.toArray()), "10 turnos nesta sessão");

  // E o que sai no POST é só o buffer, com a última troca no fim.
  const body = session.history.toArray();
  assert.equal(body.length, 20);
  assert.deepEqual(body.at(-2), { role: "user", content: "pergunta 24" });
  assert.deepEqual(body.at(-1), { role: "assistant", content: "resposta 24" });
});

test("sessão: nenhum helper toca localStorage/sessionStorage", () => {
  const boom = () => {
    throw new Error("o front não pode persistir a sessão");
  };
  const trap = { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 };
  Object.defineProperty(globalThis, "localStorage", { value: trap, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: trap, configurable: true });

  try {
    const session = createSession();
    session.history.push("user", "cria um card");
    session.history.push("assistant", assistantSummary("Criei."));
    assert.equal(session.history.size(), 2);
    assert.match(session.id, UUID_V4);
    assert.equal(turnLabel(turnCount(session.history.toArray())), "1 turno nesta sessão");
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
    Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("assistantSummary: fala do plano quando veio; nota curta quando falhou; nunca vazio", () => {
  assert.equal(assistantSummary("  Criei o card revisar proposta.  "), "Criei o card revisar proposta.");
  assert.equal(assistantSummary(null, "Não entendi o pedido."), "Não consegui concluir o comando: Não entendi o pedido.");
  assert.equal(assistantSummary("   ", ""), "Não consegui concluir o comando.");
  assert.equal(assistantSummary(undefined), "Não consegui concluir o comando.");

  const long = assistantSummary("c".repeat(700));
  assert.equal(long.length, 500);
});

test("busca: searchQueryText lê texto solto e critério estruturado", () => {
  assert.equal(searchQueryText("proposta"), "proposta");
  assert.equal(searchQueryText("  proposta  "), "proposta");
  assert.equal(searchQueryText({ campo: "comment", texto: "nota fiscal" }), "campo: comment · texto: nota fiscal");
  assert.equal(searchQueryText({ ignorado: null, vazio: "", aninhado: { a: 1 }, label: "urgente" }), "label: urgente");
  assert.equal(searchQueryText(null), "");
  assert.equal(searchQueryText(undefined), "");
});

test("busca: contagem — os itens na tela mandam, o `count` do servidor cobre o payload enxuto", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(searchCount({ query: "x", count: 3 }, items), 3);
  assert.equal(searchCount({ query: "x", count: 9 }, items), 3); // itens são o que está na tela
  assert.equal(searchCount({ query: "x", count: 9 }, []), 9); // sem itens: vale o servidor
  assert.equal(searchCount({ query: "x", count: 9 }, null), 9);
  assert.equal(searchCount({ query: "x" }, []), 0);
  assert.equal(searchCount(null, []), 0);
  assert.equal(searchCount({ query: "x", count: Number.NaN }, []), 0);
});

test("busca: título e chip em pt-BR, com singular correto", () => {
  assert.equal(activityLabel(1), "1 atividade");
  assert.equal(activityLabel(0), "0 atividades");
  assert.equal(activityLabel(4), "4 atividades");

  assert.equal(searchTitle({ query: "proposta", count: 3 }, []), "3 atividades com “proposta”");
  assert.equal(searchTitle({ query: { texto: "nota" }, count: 1 }, []), "1 atividade com “texto: nota”");
  assert.equal(searchTitle({ query: "", count: 2 }, []), "2 atividades");
  assert.equal(searchTitle({ query: "proposta", count: 3 }, [{ id: "a" }, { id: "b" }]), "2 atividades com “proposta”");

  assert.equal(searchSummary({ query: "proposta", count: 3 }, []), "última pesquisa: 3 atividades");
  assert.equal(searchSummary({ query: "proposta", count: 1 }, []), "última pesquisa: 1 atividade");
  assert.equal(searchSummary(null, []), "última pesquisa: 0 atividades");
});

test("busca: matchedFields vira chip pt-BR, sem repetir e sem quebrar em campo novo", () => {
  assert.equal(matchedFieldLabel("name"), "nome");
  assert.equal(matchedFieldLabel("desc"), "descrição");
  assert.equal(matchedFieldLabel("comment"), "comentário");
  assert.equal(matchedFieldLabel("label"), "label");
  assert.equal(matchedFieldLabel("list"), "lista");
  assert.equal(matchedFieldLabel("checklist"), "checklist"); // campo que o front ainda não conhece

  assert.deepEqual(matchedFieldLabels(["name", "desc", "name"]), ["nome", "descrição"]);
  assert.deepEqual(matchedFieldLabels(["comment", "list"]), ["comentário", "lista"]);
  assert.deepEqual(matchedFieldLabels([]), []);
  assert.deepEqual(matchedFieldLabels(undefined), []);
  assert.deepEqual(matchedFieldLabels(null), []);
});

test("turnos: contagem em pares e rótulo do chip de sessão", () => {
  assert.equal(turnCount([]), 0);
  assert.equal(turnCount([{ role: "user", content: "oi" }]), 0); // pergunta sem resposta ainda não é turno
  assert.equal(turnCount([{ role: "user", content: "oi" }, { role: "assistant", content: "olá" }]), 1);

  const history = createSessionHistory();
  fill(history, 6);
  assert.equal(turnCount(history.toArray()), 3);
  assert.equal(sessionSummary(history.toArray()), "3 turnos nesta sessão");
  assert.equal(turnLabel(1), "1 turno nesta sessão");
  assert.equal(turnLabel(0), "0 turnos nesta sessão");
  assert.equal(turnLabel(Number.NaN), "0 turnos nesta sessão");
});
