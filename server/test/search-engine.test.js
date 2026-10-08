/**
 * Busca por características — testes puros (zero rede, zero dependência do .env).
 *
 * O motor é puro: as fixtures abaixo imitam o que readBoard/getBoardComments
 * devolvem. O único trecho que importa trello.js força o backend demo com
 * `setBackend(new DemoBoard())`, de modo que nenhum teste toca a API do Trello
 * nem depende de qual .env está presente.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeText, searchCards } from "../src/services/search-engine.js";
import { DemoBoard, getBackend, getBoardComments, setBackend } from "../src/services/trello.js";
import { getCommentsCached, invalidateComments } from "../src/services/board-cache.js";

const DAY = 24 * 60 * 60 * 1000;
/** Relógio fixo (terça-feira) para os filtros de prazo. */
const NOW = new Date("2026-03-10T12:00:00.000Z");
const at = (days) => new Date(NOW.getTime() + days * DAY).toISOString();

const boardFixture = () => ({
  id: "b1",
  name: "Board de teste",
  lists: [
    { id: "l1", name: "A Fazer", pos: 1, closed: false },
    { id: "l2", name: "Fazendo 🎉", pos: 2, closed: false },
  ],
  cards: [
    {
      id: "c1",
      idList: "l1",
      name: "Pagar conta de luz",
      desc: "Venceu na segunda-feira.",
      due: at(-3),
      closed: false,
      labels: [{ id: "lb-casa", name: "casa", color: "green" }],
    },
    {
      id: "c2",
      idList: "l1",
      name: "Revisar proposta do cliente",
      desc: "",
      due: at(3),
      closed: false,
      labels: [{ id: "lb-trabalho", name: "trabalho", color: "blue" }],
    },
    {
      id: "c3",
      idList: "l1",
      name: "Comprar cabo HDMI",
      desc: "",
      due: at(1),
      closed: false,
      labels: [{ id: "lb-casa", name: "casa", color: "green" }],
    },
    {
      id: "c4",
      idList: "l2",
      name: "Montar o board de voz",
      desc: "STT + MiMo + Trello.",
      due: at(0),
      closed: false,
      labels: [{ id: "lb-urgente", name: "urgente", color: "red" }],
    },
    {
      id: "c5",
      idList: "l2",
      name: "Playlist para o modo foco",
      desc: "",
      due: null,
      closed: false,
      labels: [],
    },
    {
      id: "c6",
      idList: "l1",
      name: "Projeto antigo",
      desc: "nada aqui",
      due: null,
      closed: true,
      labels: [],
    },
  ],
});

const commentsFixture = () => [
  { cardId: "c2", cardName: "Revisar proposta do cliente", text: "Cliente pediu desconto no pagaménto.", at: at(-1), actionId: "a1" },
  { cardId: "c1", cardName: "Pagar conta de luz", text: "Também preciso pagar o aluguel do escritório.", at: at(-1), actionId: "a2" },
  { cardId: "c4", cardName: "Montar o board de voz", text: "Testar o microfone antes da demonstração.", at: at(-1), actionId: "a3" },
  { cardId: "c5", cardName: "Playlist para o modo foco", text: "Ouvir no trello com fones novos.", at: at(-1), actionId: "a4" },
];

const search = (query, extra = {}) =>
  searchCards({ board: boardFixture(), comments: commentsFixture(), query, now: NOW, ...extra });

const ids = (result) => result.items.map((item) => item.id);

/* ───────────────────────────── texto livre ───────────────────────────── */

test("casa pelo NOME do card", () => {
  const result = search({ text: "cabo" });
  assert.deepEqual(ids(result), ["c3"]);
  assert.deepEqual(result.items[0].matchedFields, ["name"]);
  assert.equal(result.items[0].score, 3);
});

test("casa só pela DESCRIÇÃO e devolve descSnippet", () => {
  const result = search({ text: "venceu" });
  assert.deepEqual(ids(result), ["c1"]);
  assert.deepEqual(result.items[0].matchedFields, ["desc"]);
  assert.equal(result.items[0].descSnippet, "Venceu na segunda-feira.");
  assert.equal(result.items[0].score, 2);
});

test("casa só por COMENTÁRIO (texto que não existe em nome/descrição)", () => {
  const result = search({ text: "aluguel" });
  assert.deepEqual(ids(result), ["c1"]);
  assert.deepEqual(result.items[0].matchedFields, ["comment"]);
  assert.equal(result.items[0].score, 1.5);
  assert.equal("descSnippet" in result.items[0], false);
});

test("acento-insensível nos DOIS sentidos (pagamento ↔ pagaménto)", () => {
  assert.deepEqual(ids(search({ text: "pagamento" })), ["c2"]);
  assert.deepEqual(ids(search({ text: "pagaménto" })), ["c2"]);
  const item = search({ text: "pagamento" }).items[0];
  assert.deepEqual(item.matchedFields, ["comment"]);
});

test("pontuação e emoji são tolerados (na query e nos campos)", () => {
  // emoji no nome da lista, lixo na query
  assert.deepEqual(ids(search({ text: "fazendo 🎉!!" })), ["c4", "c5"]);
  // pontuação na descrição ("STT + MiMo + Trello.") e vírgula na query
  const result = search({ text: "miMo," });
  assert.deepEqual(ids(result), ["c4"]);
  assert.deepEqual(result.items[0].matchedFields, ["desc"]);
});

test("cada campo ADICIONAL atingido pelo mesmo termo soma bônus", () => {
  const result = search({ text: "pagar" });
  assert.deepEqual(ids(result), ["c1"]);
  // nome (3) + comentário (+1) → 4, e nada mais
  assert.deepEqual(result.items[0].matchedFields, ["name", "comment"]);
  assert.equal(result.items[0].score, 4);
});

test("AND de termos: TODOS precisam casar no MESMO card", () => {
  assert.deepEqual(ids(search({ text: "cabo hdmi" })), ["c3"]);
  // "cabo" só em c3 (nome) e "aluguel" só em c1 (comentário) → nenhum card tem os dois
  const none = search({ text: "cabo aluguel" });
  assert.deepEqual(none.items, []);
  assert.equal(none.total, 0);
});

test("ordenação: score DESC e depois nome ASC", () => {
  // "trello": c4 na descrição (2.0) > c5 no comentário (1.5)
  assert.deepEqual(ids(search({ text: "trello" })), ["c4", "c5"]);
  // sem termos, todos empatam em 0 → nome ASC
  assert.deepEqual(ids(search({ text: "" })), ["c3", "c4", "c1", "c5", "c2"]);
});

/* ─────────────────────────── filtros estruturais ─────────────────────────── */

test("filtro por etiquetas exige TODAS (AND) e combina com texto", () => {
  assert.deepEqual(ids(search({ labels: ["casa"] })), ["c3", "c1"]);
  assert.deepEqual(ids(search({ labels: ["urgente"] })), ["c4"]);
  assert.equal(search({ labels: ["casa", "urgente"] }).total, 0);
  assert.equal(search({ text: "cabo", labels: ["trabalho"] }).total, 0);
  assert.deepEqual(ids(search({ text: "cabo", labels: ["casa"] })), ["c3"]);
});

test("filtro por LISTA usa comparação normalizada", () => {
  assert.deepEqual(ids(search({ listName: "A Fazer" })), ["c3", "c1", "c2"]);
  assert.deepEqual(ids(search({ listName: "fazendo 🎉" })), ["c4", "c5"]);
  assert.deepEqual(ids(search({ listName: "a fazer", text: "luz" })), ["c1"]);
  assert.equal(search({ listName: "Inexistente" }).total, 0);
});

test("filtros de prazo (now injetado): overdue/today/week/set/none", () => {
  assert.deepEqual(ids(search({ due: "overdue" })), ["c1"]);
  assert.deepEqual(ids(search({ due: "today" })), ["c4"]);
  assert.deepEqual(ids(search({ due: "week" })), ["c3", "c4", "c2"]);
  assert.deepEqual(ids(search({ due: "set" })), ["c3", "c4", "c1", "c2"]);
  assert.deepEqual(ids(search({ due: "none" })), ["c5"]);
  assert.equal(search({ due: "any" }).total, 5);
  assert.equal(search({ due: "qualquer-coisa" }).total, 5); // modo desconhecido = sem filtro
});

test("arquivados: fora por padrão, SÓ eles com archived:true", () => {
  assert.equal(search({ text: "projeto" }).total, 0);
  const archived = search({ text: "projeto", archived: true });
  assert.deepEqual(ids(archived), ["c6"]);
  assert.equal(archived.items[0].listName, "A Fazer");
  assert.equal(search({ archived: true }).total, 1);
  // textos de descrição do arquivado continuam alcançáveis
  assert.deepEqual(ids(search({ text: "nada aqui", archived: true })), ["c6"]);
});

/* ───────────────────────────── forma/limites ───────────────────────────── */

test("query só estrutural (texto vazio/em branco) funciona", () => {
  assert.deepEqual(ids(search({ due: "overdue" })), ["c1"]);
  assert.equal(search({ text: "   " }).total, 5); // em branco = sem filtro de texto
  assert.equal(search({ text: "" }).total, 5);
  assert.deepEqual(ids(search({ listName: "A Fazer", due: "set" })), ["c3", "c1", "c2"]);
});

test("F4: texto não vazio que normaliza para ZERO termos devolve VAZIO (nunca match-all)", () => {
  assert.deepEqual(search({ text: "日本" }), { items: [], total: 0 });
  assert.deepEqual(search({ text: "日本語のテキスト" }), { items: [], total: 0 });
  assert.deepEqual(search({ text: "!!! 🎉" }), { items: [], total: 0 });
  // com filtro estrutural válido continua vazio: o texto não é ignorado
  assert.deepEqual(search({ text: "日本", listName: "A Fazer" }), { items: [], total: 0 });
  assert.deepEqual(search({ text: "日本", archived: true }), { items: [], total: 0 });
});

test("F5: filtros malformados são COERIDOS, nunca ignorados em silêncio", () => {
  // labels como string simples vira [string]
  assert.deepEqual(ids(search({ labels: "casa" })), ["c3", "c1"]);
  assert.equal(search({ labels: "   " }).total, 5); // string vazia = sem filtro
  assert.equal(search({ labels: 42 }).total, 5); // tipo errado = sem filtro
  // due: string com caixa/espaços é tolerada; modo inválido vira 'any'
  assert.deepEqual(ids(search({ due: "OVERDUE" })), ["c1"]);
  assert.deepEqual(ids(search({ due: " Week " })), ["c3", "c4", "c2"]);
  assert.equal(search({ due: 42 }).total, 5);
  assert.equal(search({ due: "semana" }).total, 5);
  // archived: SÓ o booleano true significa "só arquivados"
  assert.equal(search({ archived: "true" }).total, 5);
  assert.equal(search({ archived: 1 }).total, 5);
  assert.equal(search({ archived: true }).total, 1);
});

test("F3: comments/query malformados não explodem (null, objeto, string, array)", () => {
  const board = boardFixture();
  assert.equal(searchCards({ board, comments: null, query: null }).total, 5);
  assert.equal(searchCards({ board, comments: { nope: true }, query: 42 }).total, 5);
  assert.equal(searchCards({ board, comments: "junk", query: [] }).total, 5);
  assert.equal(searchCards({ board, comments: undefined, query: undefined }).total, 5);
  assert.equal(searchCards({ board: null, comments: null, query: null }).total, 0);
  assert.deepEqual(searchCards(), { items: [], total: 0 });
  // item malformado dentro de um array de comentários é ignorado, sem derrubar a busca
  const junk = [null, 7, { text: "sem cardId" }, { cardId: "c3", text: "cabo reserva" }];
  assert.deepEqual(ids(searchCards({ board, comments: junk, query: { text: "cabo" }, now: NOW })), ["c3"]);
});

test("limit corta os itens e total conta antes do corte (teto 200)", () => {
  const result = search({ text: "", limit: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.total, 5);
  assert.deepEqual(ids(result), ["c3", "c4"]);
  assert.equal(search({ limit: 1000 }).items.length, 5); // clampa em 200, não estoura
  assert.equal(search({ limit: -1 }).items.length, 5); // inválido → padrão 50
});

test("item tem a forma combinada (id, name, listName, labels, due, matchedFields, score)", () => {
  const item = search({ text: "cabo" }).items[0];
  assert.deepEqual(item, {
    id: "c3",
    name: "Comprar cabo HDMI",
    listName: "A Fazer",
    labels: ["casa"],
    due: at(1),
    matchedFields: ["name"],
    score: 3,
  });
});

test("normalizeText exportado: NFD, minúsculas, sem pontuação/emoji, espaços colapsados", () => {
  assert.equal(normalizeText("  Pagaménto!!! 🎉  "), "pagamento");
  assert.equal(normalizeText("A  Fazer ( hoje )"), "a fazer hoje");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(42), "42");
});

test("board/comentários ausentes não explodem (busca vazia)", () => {
  assert.deepEqual(searchCards({}), { items: [], total: 0 });
  assert.deepEqual(searchCards({ board: boardFixture() }).total, 5); // sem comentários: só nome/desc
});

/* ───────────────── modo demo: mesma busca, sem rede e sem .env ───────────────── */

test("backend demo: getBoardComments devolve comentários semeados e a busca acha por eles", async () => {
  setBackend(new DemoBoard());
  const comments = await getBoardComments({ force: true });
  assert.ok(comments.length >= 3, "demo deve ter comentários semeados");
  assert.ok(comments.every((c) => c.cardId && c.text && c.actionId && c.at));

  const board = await getBackend().getBoard(); // demo é forçado: nunca vai à rede
  const result = searchCards({ board, comments, query: { text: "aluguel" } });
  assert.deepEqual(ids(result), ["c-9"]);
  assert.deepEqual(result.items[0].matchedFields, ["comment"]);
  assert.equal(result.items[0].listName, "A Fazer");
});

test("gravar comentário invalida o cache de comentários (fio trello → board-cache)", async () => {
  const demo = new DemoBoard();
  setBackend(demo);

  const before = await getCommentsCached();
  assert.equal(await getCommentsCached(), before, "segunda leitura deve vir do cache (mesma referência)");

  await demo.addComment("c-2", "Comprar filtro de linha.");

  const after = await getCommentsCached();
  assert.notEqual(after, before, "cache deve ter sido invalidado pela escrita");
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((c) => c.cardId === "c-2" && c.text === "Comprar filtro de linha."));
});

/* ───────────────── regressões de corrida (reparo 1: F1/F2) ───────────────── */

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** DemoBoard com a 1ª leitura de comentários pendurada num portão (teste de corrida). */
class GatedCommentsDemo extends DemoBoard {
  constructor(gate) {
    super();
    this.gate = gate;
    this.calls = 0;
  }

  getBoardComments() {
    this.calls += 1;
    return this.calls === 1 ? this.gate.promise : super.getBoardComments();
  }
}

const stubBackend = (text, cardId) => ({
  kind: "stub",
  getBoard: async () => boardFixture(),
  getBoardComments: async () => [{ cardId, cardName: cardId, text, at: at(0), actionId: `a-${cardId}` }],
  addComment: async () => {},
});

test("F1: leitura em voo que aterra APÓS a invalidação não repovoa o cache (regressão)", async () => {
  const gate = deferred();
  const demo = new GatedCommentsDemo(gate);
  setBackend(demo);
  invalidateComments(); // base limpa: isola a corrida em voo do cache do teste anterior
  // retrato PRÉ-escrita (lido fora do cache, sem consumir a leitura com portão)
  const preWrite = await DemoBoard.prototype.getBoardComments.call(demo);

  const inflight = getCommentsCached(); // 1ª leitura: fica pendurada no portão
  await demo.addComment("c-2", "Comentário novo pós-escrita."); // invalida com leitura em voo
  gate.resolve(preWrite); // o retrato pré-escrita chega ATRASADO
  const late = await inflight;
  assert.equal(late.length, preWrite.length, "quem pediu antes da escrita recebe o retrato que pediu");

  // A PRÓXIMA leitura não pode servir o retrato velho que aterrou depois
  const next = await getCommentsCached();
  assert.equal(next.length, preWrite.length + 1, "leitura atrasada NÃO pode repovoar o cache");
  assert.ok(
    next.some((c) => c.cardId === "c-2" && c.text === "Comentário novo pós-escrita."),
    "deve reler do backend, com o comentário novo",
  );
});

test("F2: setBackend invalida os comentários e não serve a lista do backend anterior (regressão)", async () => {
  setBackend(stubBackend("comentário do backend A", "c1"));
  const fromA = await getCommentsCached();
  assert.equal(fromA[0].text, "comentário do backend A");
  assert.equal((await getCommentsCached())[0].text, "comentário do backend A", "estava em cache");

  setBackend(stubBackend("MARCADOR do backend B", "c2"));
  const fromB = await getCommentsCached();
  assert.equal(fromB.length, 1);
  assert.equal(fromB[0].text, "MARCADOR do backend B");
  assert.ok(fromB.every((c) => !c.text.includes("backend A")), "não pode sobrar a lista do backend A");
});
