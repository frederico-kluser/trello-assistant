/**
 * Pergunta de desbloqueio: quando a tarefa não se completa, o sistema pergunta
 * COM OPÇÕES (LLM primeiro, fallback determinístico) em vez de morrer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  fallbackQuestion,
  generateQuestion,
  normalizeCandidates,
  parseQuestion,
  questionFromError,
  topCards,
} from "../src/services/question.js";
import { AppError } from "../src/lib/errors.js";

// Modelo FIXO (caminho "pinned"): o stub de fetch só vê o chat/completions.
config.openrouter.apiKey = "test-key";
config.openrouter.model = "test/pinned-model";

const board = {
  name: "Teste",
  lists: [
    { id: "l1", name: "A Fazer", closed: false },
    { id: "l2", name: "Fazendo", closed: false },
  ],
  cards: [
    { id: "c1", idList: "l1", name: "Revisar proposta do cliente", closed: false, labels: [] },
    { id: "c2", idList: "l2", name: "Revisar README", closed: false, labels: [] },
    { id: "c3", idList: "l1", name: "Comprar cabo HDMI", closed: false, labels: [] },
    { id: "c4", idList: "l1", name: "Card arquivado", closed: true, labels: [] },
  ],
};

/** Stub do chat/completions: devolve `content` (ou lança, quando `down`). */
function stubChat(content, { down = false } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (down) throw new Error("sem rede");
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ model: "served/by-provider", choices: [{ message: { content } }] }),
    };
  };
  return { calls, restore: () => void (globalThis.fetch = real) };
}

/* ── parseQuestion ────────────────────────────────────────────────────── */

test("parseQuestion normaliza prompt/opções e corta ruído", () => {
  const q = parseQuestion({
    prompt: "  Qual  card  você quer? ",
    options: [{ label: " Revisar README ", value: "Revisar README" }, "Comprar cabo HDMI", { label: "" }, { label: "Só label" }],
  });
  assert.equal(q.prompt, "Qual card você quer?");
  assert.deepEqual(q.options, [
    { label: "Revisar README", value: "Revisar README" },
    { label: "Comprar cabo HDMI", value: "Comprar cabo HDMI" },
    { label: "Só label", value: "Só label" },
  ]);
});

test("parseQuestion rejeita lixo e aceita pergunta aberta (options: [])", () => {
  assert.equal(parseQuestion(null), null);
  assert.equal(parseQuestion("texto solto"), null);
  assert.equal(parseQuestion({ options: [{ label: "a", value: "a" }] }), null); // sem prompt
  const open = parseQuestion({ question: "Qual é o nome do card?" });
  assert.deepEqual(open, { prompt: "Qual é o nome do card?", options: [] });
});

test("parseQuestion aceita o conteúdo BRUTO do modelo (string JSON, com cercas e ruído)", () => {
  const direct = parseQuestion('{"prompt":"Qual lista?","options":[{"label":"A Fazer","value":"A Fazer"}]}');
  assert.equal(direct.prompt, "Qual lista?");
  const fenced = parseQuestion('```json\n{"prompt":"Qual lista?","options":[]}\n```');
  assert.deepEqual(fenced, { prompt: "Qual lista?", options: [] });
  const noisy = parseQuestion('Aqui está: {"prompt":"Qual lista?","options":[]} pronto!');
  assert.equal(noisy.prompt, "Qual lista?");
  assert.equal(parseQuestion('{"prompt": quebrado'), null);
});

/* ── candidatos e fallback ────────────────────────────────────────────── */

test("normalizeCandidates aceita strings, {name} e {id,name}; value usa o id quando há", () => {
  assert.deepEqual(normalizeCandidates(["Revisar README", { name: "Comprar cabo HDMI" }, { id: "c1", name: "Revisar proposta do cliente" }, {}]), [
    { id: null, name: "Revisar README", value: "Revisar README" },
    { id: null, name: "Comprar cabo HDMI", value: "Comprar cabo HDMI" },
    { id: "c1", name: "Revisar proposta do cliente", value: "c1" },
  ]);
});

test("fallbackQuestion com candidatos: pergunta objetiva + opções fechadas", () => {
  const q = fallbackQuestion({
    code: "ambiguous_reference",
    reason: "«revisar» bate com mais de um card",
    board,
    candidates: [{ id: "c1", name: "Revisar proposta do cliente" }, { id: "c2", name: "Revisar README" }],
    field: "card",
  });
  assert.match(q.prompt, /Você quis dizer um destes\?$/);
  assert.deepEqual(q.options, [
    { label: "Revisar proposta do cliente", value: "c1" },
    { label: "Revisar README", value: "c2" },
  ]);
});

test("fallbackQuestion por código: data, card, lista e aberta", () => {
  const date = fallbackQuestion({ code: "no_date", reason: "não entendi a data" });
  assert.match(date.prompt, /Qual é\?$/);
  assert.ok(date.options.some((o) => o.value === "amanhã"));

  const card = fallbackQuestion({ code: "no_card", reason: "não identifiquei qual card você quer", board });
  assert.match(card.prompt, /Qual destes\?$/);
  assert.equal(card.options[0].label, "Revisar proposta do cliente"); // parecido primeiro
  assert.ok(card.options.every((o) => o.label !== "Card arquivado"));

  const list = fallbackQuestion({ code: "no_list", reason: "", board });
  assert.deepEqual(list.options.map((o) => o.value), ["A Fazer", "Fazendo"]);

  const text = fallbackQuestion({ code: "no_text", reason: "não captei o texto" });
  assert.deepEqual(text.options, []);

  const generic = fallbackQuestion({ code: "not_a_command", reason: "não reconheço isso como um comando", board });
  assert.match(generic.prompt, /O que você quer fazer\?$/);
  assert.ok(generic.options.length >= 2);
});

test("topCards: tokens da fala primeiro; sem nada em comum, os primeiros abertos", () => {
  assert.equal(topCards(board, "a proposta do cliente")[0].name, "Revisar proposta do cliente");
  assert.equal(topCards(board, "zzz")[0].name, "Revisar proposta do cliente");
  assert.equal(topCards(board, "").length, 3); // o arquivado nunca entra
});

/* ── generateQuestion: LLM primeiro, fallback resiliente ──────────────── */

test("generateQuestion usa a pergunta do LLM quando ela é válida", async () => {
  const chat = stubChat(JSON.stringify({ prompt: "Qual card você quer mover?", options: [{ label: "Revisar README", value: "Revisar README" }] }));
  try {
    const q = await generateQuestion({ transcript: "move para fazendo", board, code: "no_card", reason: "não identifiquei qual card" });
    assert.equal(q.prompt, "Qual card você quer mover?");
    assert.deepEqual(q.options, [{ label: "Revisar README", value: "Revisar README" }]);
    // o modelo recebe o board real para não inventar opções
    assert.match(chat.calls[0].body.messages[1].content, /Revisar proposta do cliente/);
  } finally {
    chat.restore();
  }
});

test("generateQuestion cai no fallback com rede em baixo, JSON inválido ou sem prompt", async () => {
  for (const content of ["não é json", JSON.stringify({ options: [] }), JSON.stringify({ prompt: "", options: [] })]) {
    const chat = stubChat(content);
    try {
      const q = await generateQuestion({ transcript: "apaga o card", board, code: "no_card", reason: "não identifiquei qual card" });
      assert.match(q.prompt, /Qual destes\?$/);
    } finally {
      chat.restore();
    }
  }
  const down = stubChat("", { down: true });
  try {
    const q = await generateQuestion({ transcript: "apaga o card", board, code: "no_card", reason: "não identifiquei qual card" });
    assert.match(q.prompt, /Qual destes\?$/);
  } finally {
    down.restore();
  }
});

test("generateQuestion com candidatos FECHADOS: só aceita values conhecidos (senão, fallback)", async () => {
  const candidates = [{ id: "c1", name: "Revisar proposta do cliente" }, { id: "c2", name: "Revisar README" }];
  // o modelo tenta inventar um value: a opção cai e o resto vale
  const chat = stubChat(JSON.stringify({ prompt: "Qual destes?", options: [{ label: "Inventado", value: "outro" }, { label: "Revisar README", value: "c2" }] }));
  try {
    const q = await generateQuestion({ transcript: "revisar", board, code: "ambiguous_reference", reason: "bate com dois", candidates, field: "card" });
    assert.deepEqual(q.options, [{ label: "Revisar README", value: "c2" }]);
  } finally {
    chat.restore();
  }
  // sem NENHUMA opção válida, o fallback determinístico assume
  const bad = stubChat(JSON.stringify({ prompt: "Qual destes?", options: [{ label: "Inventado", value: "outro" }] }));
  try {
    const q = await generateQuestion({ transcript: "revisar", board, code: "ambiguous_reference", reason: "bate com dois", candidates, field: "card" });
    assert.deepEqual(q.options, [
      { label: "Revisar proposta do cliente", value: "c1" },
      { label: "Revisar README", value: "c2" },
    ]);
  } finally {
    bad.restore();
  }
});

test("questionFromError usa os candidatos do detail do AppError", async () => {
  const savedKey = config.openrouter.apiKey;
  config.openrouter.apiKey = ""; // sem LLM: fallback puro
  try {
    const err = new AppError("ambiguous_reference", "«revisar» bate com mais de um card.", {
      status: 422,
      detail: { field: "card", candidates: [{ id: "c1", name: "Revisar proposta do cliente" }] },
    });
    const q = await questionFromError(err, { transcript: "apaga revisar", board });
    assert.match(q.prompt, /Você quis dizer um destes\?$/);
    assert.deepEqual(q.options, [{ label: "Revisar proposta do cliente", value: "c1" }]);
  } finally {
    config.openrouter.apiKey = savedKey;
  }
});
