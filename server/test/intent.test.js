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

// quarta-feira, 7/out/2026 15:00 (hora local) — relógio fixo para testes determinísticos
const NOW = new Date(2026, 9, 7, 15, 0, 0);
const ymd = (iso) => {
  const d = new Date(iso);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()];
};

test("parsePtDate: amanhã, depois de amanhã e hoje (prazo útil, não 'agora+24h')", () => {
  assert.deepEqual(ymd(parsePtDate("amanhã", NOW)), [2026, 10, 8, 12]);
  assert.deepEqual(ymd(parsePtDate("depois de amanhã", NOW)), [2026, 10, 9, 12]);
  assert.deepEqual(ymd(parsePtDate("hoje", NOW)), [2026, 10, 7, 23]);
});

test("parsePtDate: dias da semana respeitam o 'que vem'", () => {
  assert.deepEqual(ymd(parsePtDate("sexta-feira", NOW)), [2026, 10, 9, 12]);
  assert.deepEqual(ymd(parsePtDate("sexta que vem", NOW)), [2026, 10, 16, 12]);
  assert.equal(new Date(parsePtDate("sexta-feira", NOW)).getDay(), 5);
});

test("parsePtDate: 'dia 20' sozinho, 'dia 3' (já passou → mês seguinte) e dd/mm", () => {
  assert.deepEqual(ymd(parsePtDate("dia 20", NOW)), [2026, 10, 20, 12]);
  assert.deepEqual(ymd(parsePtDate("dia 3", NOW)), [2026, 11, 3, 12]);
  assert.deepEqual(ymd(parsePtDate("20/08", NOW)), [2026, 8, 20, 12]);
  assert.deepEqual(ymd(parsePtDate("15 de dezembro", NOW)), [2026, 12, 15, 12]);
});

test("parsePtDate: relativos ('daqui a 3 dias', 'semana que vem') ", () => {
  assert.deepEqual(ymd(parsePtDate("daqui a 3 dias", NOW)), [2026, 10, 10, 12]);
  assert.deepEqual(ymd(parsePtDate("em 2 semanas", NOW)), [2026, 10, 21, 12]);
  assert.deepEqual(ymd(parsePtDate("semana que vem", NOW)), [2026, 10, 14, 12]);
  assert.equal(parsePtDate("blá blá", NOW), null);
});
