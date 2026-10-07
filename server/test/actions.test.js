import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAction,
  findCard,
  findList,
  normalizeActions,
  requiresConfirmation,
  toIsoDate,
} from "../src/domain/actions.js";
import { DemoBoard } from "../src/services/trello.js";

const boardFixture = () => ({
  name: "Teste",
  lists: [
    { id: "l1", name: "A Fazer", closed: false },
    { id: "l2", name: "Fazendo", closed: false },
  ],
  cards: [
    { id: "c1", idList: "l1", name: "Revisar proposta do cliente", closed: false, labels: [] },
    { id: "c2", idList: "l2", name: "Revisar README", closed: false, labels: [] },
    { id: "c3", idList: "l1", name: "Comprar cabo HDMI", closed: true, labels: [] },
  ],
});

test("findCard resolve por nome parcial", () => {
  const card = findCard(boardFixture(), "proposta");
  assert.equal(card.id, "c1");
});

test("findCard é ambíguo quando bate em dois cards", () => {
  assert.throws(() => findCard(boardFixture(), "revisar"), /mais de um card/);
});

test("findCard acusa referência desconhecida", () => {
  assert.throws(() => findCard(boardFixture(), "nada disso existe"), /Não encontrei/);
});

test("findList resolve por trecho do nome", () => {
  assert.equal(findList(boardFixture(), "fazendo").id, "l2");
});

test("findList ignora pontuação e emojis nos nomes reais dos boards", () => {
  const board = {
    lists: [
      { id: "l1", name: "Para fazer ( hoje)", closed: false },
      { id: "l2", name: "Para fazer ( amanha)", closed: false },
      { id: "l3", name: "Fazendo 🎉", closed: false },
    ],
    cards: [],
  };
  assert.equal(findList(board, "para fazer hoje").id, "l1");
  assert.equal(findList(board, "amanha").id, "l2");
  assert.equal(findList(board, "fazendo").id, "l3");
  // as duas listas "Para fazer (…)" tornam a referência ambígua — e a mensagem é gramatical
  assert.throws(() => findList(board, "para fazer"), /mais de uma lista/);
});

test("toIsoDate aceita ISO, BR e ignora lixo", () => {
  assert.ok(toIsoDate("2026-08-20"));
  assert.ok(toIsoDate("20/08/2026"));
  assert.equal(toIsoDate("sem data aqui"), null);
});

test("normalizeActions descarta tipos desconhecidos", () => {
  const actions = normalizeActions([
    { type: "create_card", name: "X" },
    { type: "hack_the_planet" },
    null,
  ]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "create_card");
});

test("criar e apagar exigem confirmação; mover não", () => {
  assert.equal(requiresConfirmation({ type: "create_card" }), true);
  assert.equal(requiresConfirmation({ type: "delete_card" }), true);
  assert.equal(requiresConfirmation({ type: "move_card" }), false);
  assert.equal(requiresConfirmation({ type: "set_due" }), false);
});

test("applyAction cria, move, define prazo e apaga no board demo", async () => {
  const backend = new DemoBoard();

  const created = await applyAction(
    { type: "create_card", name: "Testar órbita", list: "a fazer", due: "2026-09-01" },
    { board: await backend.getBoard(), backend },
  );
  assert.equal(created.card.name, "Testar órbita");
  assert.ok(created.card.due);

  const board1 = await backend.getBoard();
  const moved = await applyAction(
    { type: "move_card", card: "órbita", list: "fazendo" },
    { board: board1, backend },
  );
  assert.equal(moved.card.idList, "l-doing");

  const board2 = await backend.getBoard();
  const dueSet = await applyAction(
    { type: "set_due", card: "órbita", due: "2026-09-10" },
    { board: board2, backend },
  );
  assert.ok(String(dueSet.card.due).startsWith("2026-09-10"));

  const board3 = await backend.getBoard();
  await applyAction({ type: "delete_card", card: "órbita" }, { board: board3, backend });
  const board4 = await backend.getBoard();
  assert.equal(board4.cards.some((card) => card.name === "Testar órbita"), false);
});

test("applyAction recusa card inexistente com AppError", async () => {
  const backend = new DemoBoard();
  await assert.rejects(
    applyAction({ type: "move_card", card: "fantasma", list: "fazendo" }, { board: await backend.getBoard(), backend }),
    /Não encontrei nenhum card/,
  );
});