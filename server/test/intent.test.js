import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePtDate, parseTranscriptLocally } from "../src/services/intent.js";

const board = {
  name: "Demo",
  lists: [
    { id: "l1", name: "A Fazer", closed: false },
    { id: "l2", name: "Fazendo", closed: false },
  ],
  cards: [
    { id: "c1", idList: "l1", name: "Revisar proposta", closed: false },
    { id: "c2", idList: "l2", name: "Montar o board de voz", closed: false },
  ],
};

test("criar card com lista e prazo", () => {
  const plan = parseTranscriptLocally("cria um card chamado comprar cabo hdmi na lista a fazer com prazo amanhã", board);
  assert.equal(plan.actions[0]?.type, "create_card");
  assert.equal(plan.actions[0]?.name, "comprar cabo hdmi");
  assert.equal(plan.actions[0]?.list, "a fazer");
  assert.ok(plan.actions[0]?.due);
  assert.equal(plan.needsConfirmation, true);
});

test("criar lista não vira create_card", () => {
  const plan = parseTranscriptLocally("cria uma lista chamada Espera", board);
  assert.equal(plan.actions[0]?.type, "create_list");
  assert.equal(plan.actions[0]?.name, "Espera");
});

test("apagar card pede confirmação e avisa que é definitivo", () => {
  const plan = parseTranscriptLocally("apaga o card revisar proposta", board);
  assert.equal(plan.actions[0]?.type, "delete_card");
  assert.equal(plan.needsConfirmation, true);
  assert.match(plan.speech, /definitiva/i);
});

test("mover card para outra lista", () => {
  const plan = parseTranscriptLocally("move revisar proposta para fazendo", board);
  assert.equal(plan.actions[0]?.type, "move_card");
  assert.equal(plan.actions[0]?.card, "revisar proposta");
  assert.equal(plan.actions[0]?.list, "fazendo");
  assert.equal(plan.needsConfirmation, false);
});

test("definir prazo sem ação destrutiva", () => {
  const plan = parseTranscriptLocally("coloca prazo sexta no card montar o board de voz", board);
  assert.equal(plan.actions[0]?.type, "set_due");
  assert.ok(plan.actions[0]?.due);
});

test("pedido de informação não gera ação", () => {
  const plan = parseTranscriptLocally("o que eu tenho para fazer?", board);
  assert.equal(plan.actions.length, 0);
  assert.match(plan.speech, /card/i);
});

test("comando incompreensível devolve instrução de ajuda", () => {
  const plan = parseTranscriptLocally("blá blá blá", board);
  assert.equal(plan.actions.length, 0);
  assert.match(plan.speech, /cria um card/i);
});

test("parsePtDate entende amanhã e dias da semana", () => {
  const tomorrow = parsePtDate("amanhã");
  const diff = (new Date(tomorrow) - new Date()) / 86400000;
  assert.ok(diff > 0.9 && diff < 1.1);

  const friday = parsePtDate("sexta-feira");
  assert.ok(friday);
  assert.equal(new Date(friday).getDay(), 5);
});