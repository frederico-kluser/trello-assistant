import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore, getSessionStore, sessionStore } from "../src/services/session-store.js";

const TTL = 60_000;
const START = 1_700_000_000_000;

/** Relógio mutável: nada de timers reais, o teste controla o tempo. */
function fakeClock(start = START) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => (current += ms),
  };
}

/** Store de teste: TTL curto e sweep desligado (o timer é exercitado à parte). */
function makeStore({ ttlMs = TTL, maxSessions = 500, clock = fakeClock() } = {}) {
  const store = createSessionStore({ ttlMs, maxSessions, sweepIntervalMs: 0, now: clock.now });
  return { store, clock };
}

test("touch cria a sessão e get devolve o registro com os campos esperados", () => {
  const { store, clock } = makeStore();
  const record = store.touch("s1");

  assert.deepEqual(record, { createdAt: START, lastUsedAt: START, lastSearch: null, lastCardId: null });
  assert.equal(store.get("s1"), record);
  assert.equal(store.stats().sessions, 1);
  clock.advance(5_000);
  assert.equal(store.get("s1").lastUsedAt, START, "get não renova a sessão");
});

test("touch renova lastUsedAt sem mexer em createdAt", () => {
  const { store, clock } = makeStore();
  store.touch("s1");
  clock.advance(10_000);
  const record = store.touch("s1");

  assert.equal(record.createdAt, START);
  assert.equal(record.lastUsedAt, START + 10_000);
  assert.equal(store.stats().sessions, 1, "touch em sessão existente não duplica");
});

test("ids inválidos viram no-op: vazio, não-string e maior que 128 caracteres", () => {
  const { store } = makeStore();
  const invalids = ["", null, undefined, 42, {}, [], true, "x".repeat(129)];

  for (const id of invalids) {
    assert.equal(store.touch(id), null, `touch(${String(id)})`);
    assert.equal(store.get(id), null, `get(${String(id)})`);
    assert.equal(store.setLastSearch(id, { ids: ["c1"] }), null, `setLastSearch(${String(id)})`);
    assert.equal(store.getLastSearch(id), null, `getLastSearch(${String(id)})`);
    assert.equal(store.setLastCardId(id, "c1"), null, `setLastCardId(${String(id)})`);
    assert.equal(store.getLastCardId(id), null, `getLastCardId(${String(id)})`);
    assert.equal(store.clear(id), false, `clear(${String(id)})`);
  }
  assert.deepEqual(store.stats(), { sessions: 0, evictions: 0 }, "nada foi criado com id inválido");
});

test("id com exatamente 128 caracteres é aceito", () => {
  const { store } = makeStore();
  const id = "a".repeat(128);

  assert.ok(store.touch(id));
  assert.equal(store.get(id).createdAt, START);
  assert.equal(store.stats().sessions, 1);
});

test("TTL: passado o ttl, get/getLastSearch/getLastCardId devolvem null e a sessão some", () => {
  const { store, clock } = makeStore();
  store.touch("s1");
  store.setLastSearch("s1", { ids: ["c1"], query: { text: "revisar" } });
  store.setLastCardId("s1", "c1");

  clock.advance(TTL);
  assert.equal(store.get("s1").lastCardId, "c1", "no limite exato do ttl ainda está vivo");

  clock.advance(1);
  assert.equal(store.get("s1"), null);
  assert.equal(store.getLastSearch("s1"), null);
  assert.equal(store.getLastCardId("s1"), null);
  assert.equal(store.stats().sessions, 0, "a leitura de um expirado apaga o registro");
});

test("touch em sessão expirada a recria do zero (pesquisa anterior não volta)", () => {
  const { store, clock } = makeStore();
  store.setLastSearch("s1", { ids: ["c1"], query: "revisar" });
  clock.advance(TTL + 1);

  const record = store.touch("s1");
  assert.equal(record.createdAt, START + TTL + 1);
  assert.equal(record.lastSearch, null);
  assert.equal(store.getLastSearch("s1"), null);
});

test("TTL é renovado pelo touch: sessão ociosa sobrevive se for usada a tempo", () => {
  const { store, clock } = makeStore();
  store.touch("s1");

  clock.advance(TTL - 1);
  store.touch("s1"); // renovação dentro da janela
  clock.advance(TTL - 1);
  assert.ok(store.get("s1"), "2*(ttl-1) depois da criação, mas < ttl desde o último uso");

  clock.advance(2);
  assert.equal(store.get("s1"), null, "sem novo toque, expira ttl depois do último uso");
});

test("setLastSearch guarda ids+query e usa o relógio como at padrão", () => {
  const { store, clock } = makeStore();
  clock.advance(1_234);

  const stored = store.setLastSearch("s1", { ids: ["c1", "c2"], query: { text: "proposta", list: "Fazendo" } });

  assert.deepEqual(stored, { ids: ["c1", "c2"], query: { text: "proposta", list: "Fazendo" }, at: START + 1_234 });
  assert.deepEqual(store.getLastSearch("s1"), stored);
  assert.equal(store.get("s1").lastSearch.at, START + 1_234);
});

test("setLastSearch aceita query string, at explícito e cria a sessão se não existir", () => {
  const { store, clock } = makeStore();
  clock.advance(500);

  const stored = store.setLastSearch("nova", { ids: ["c9"], query: "atrasadas", at: 42 });

  assert.deepEqual(stored, { ids: ["c9"], query: "atrasadas", at: 42 });
  assert.equal(store.stats().sessions, 1, "setLastSearch faz touch");
  assert.equal(store.get("nova").createdAt, START + 500);
});

test("setLastSearch substitui a pesquisa anterior (slot único, sem histórico)", () => {
  const { store, clock } = makeStore();
  store.setLastSearch("s1", { ids: ["c1", "c2"], query: "primeira" });
  clock.advance(1_000);
  store.setLastSearch("s1", { ids: ["c3"], query: "segunda" });

  const last = store.getLastSearch("s1");
  assert.deepEqual(last.ids, ["c3"]);
  assert.equal(last.query, "segunda");
  assert.equal(last.at, START + 1_000);
});

test("setLastSearch degrada entrada ruim em vez de lançar", () => {
  const { store } = makeStore();
  store.setLastSearch("s1", {});
  assert.deepEqual(store.getLastSearch("s1"), { ids: [], query: null, at: START });
  store.setLastSearch("s1", undefined);
  assert.deepEqual(store.getLastSearch("s1").ids, []);
  store.setLastSearch("s1", { ids: ["ok", 7, null, ""], query: 123 });
  assert.deepEqual(store.getLastSearch("s1"), { ids: ["ok"], query: null, at: START });
});

test("getLastSearch devolve null quando nunca houve pesquisa", () => {
  const { store } = makeStore();
  store.touch("s1");
  assert.equal(store.getLastSearch("s1"), null);
  assert.equal(store.getLastSearch("inexistente"), null);
});

test("setLastCardId/getLastCardId fazem roundtrip e renovam o TTL", () => {
  const { store, clock } = makeStore();
  store.touch("s1");
  assert.equal(store.getLastCardId("s1"), null);

  clock.advance(TTL - 1);
  assert.equal(store.setLastCardId("s1", "card-42"), "card-42");
  assert.equal(store.getLastCardId("s1"), "card-42");
  assert.equal(store.get("s1").lastUsedAt, START + TTL - 1, "escrever conta como uso");

  clock.advance(2);
  assert.equal(store.getLastCardId("s1"), "card-42", "o write anterior renovou a janela");
});

test("setLastCardId com cardId inválido degrada para null", () => {
  const { store } = makeStore();
  store.setLastCardId("s1", "c1");
  assert.equal(store.setLastCardId("s1", 123), null);
  assert.equal(store.getLastCardId("s1"), null);
  assert.equal(store.setLastCardId("s1", ""), null);
});

test("clear apaga a sessão e devolve boolean", () => {
  const { store } = makeStore();
  store.setLastSearch("s1", { ids: ["c1"], query: "x" });
  store.touch("s2");

  assert.equal(store.clear("s1"), true);
  assert.equal(store.get("s1"), null);
  assert.equal(store.getLastSearch("s1"), null);
  assert.equal(store.clear("s1"), false, "segunda vez não havia nada para apagar");
  assert.equal(store.clear("nunca-existiu"), false);
  assert.deepEqual(store.stats(), { sessions: 1, evictions: 0 }, "só s2 continua");
});

test("LRU: ao inserir com o store cheio, sai a sessão com lastUsedAt mais antigo", () => {
  const { store, clock } = makeStore({ maxSessions: 3 });
  store.touch("a");
  clock.advance(1_000);
  store.touch("b");
  clock.advance(1_000);
  store.touch("c");

  clock.advance(1_000);
  store.touch("a"); // a vira a mais recente; b passa a ser a mais antiga
  clock.advance(1_000);
  store.touch("d"); // estoura a capacidade

  assert.equal(store.get("b"), null, "b era a mais antiga");
  assert.ok(store.get("a") && store.get("c") && store.get("d"));
  assert.deepEqual(store.stats(), { sessions: 3, evictions: 1 });
});

test("LRU: empate de lastUsedAt desempata pela ordem de inserção", () => {
  const { store } = makeStore({ maxSessions: 2 });
  store.touch("primeira"); // mesmo instante do relógio congelado
  store.touch("segunda");
  store.touch("terceira");

  assert.equal(store.get("primeira"), null);
  assert.ok(store.get("segunda") && store.get("terceira"));
  assert.equal(store.stats().evictions, 1);
});

test("sessão expirada não conta para a capacidade: é recolhida antes do LRU", () => {
  const { store, clock } = makeStore({ maxSessions: 2 });
  store.touch("velha");
  clock.advance(TTL + 1);
  store.touch("nova1");
  store.touch("nova2");

  assert.equal(store.stats().sessions, 2);
  assert.equal(store.stats().evictions, 0, "nada foi despejado: a vaga veio do expirado");
  assert.equal(store.get("velha"), null);
});

test("touch em sessão existente no limite não despeja ninguém", () => {
  const { store, clock } = makeStore({ maxSessions: 2 });
  store.touch("a");
  store.touch("b");
  clock.advance(1_000);
  store.touch("a");
  clock.advance(1_000);
  store.touch("b");

  assert.deepEqual(store.stats(), { sessions: 2, evictions: 0 });
  assert.ok(store.get("a") && store.get("b"));
});

test("stats conta sessões vivas (expiradas só saem na leitura/sweep)", () => {
  const { store, clock } = makeStore();
  assert.deepEqual(store.stats(), { sessions: 0, evictions: 0 });
  store.touch("a");
  store.touch("b");
  assert.deepEqual(store.stats(), { sessions: 2, evictions: 0 });

  clock.advance(TTL + 1);
  assert.equal(store.stats().sessions, 2, "stats não varre; o sweep é quem recolhe");
  store.sweep();
  assert.deepEqual(store.stats(), { sessions: 0, evictions: 0 });
});

test("sweep manual remove só os expirados e devolve quantos saíram", () => {
  const { store, clock } = makeStore();
  store.touch("velha");
  clock.advance(TTL + 1);
  store.touch("nova");
  store.setLastSearch("nova", { ids: ["c1"], query: "revisar" });

  assert.equal(store.sweep(), 1);
  assert.equal(store.get("velha"), null);
  assert.deepEqual(store.getLastSearch("nova"), { ids: ["c1"], query: "revisar", at: START + TTL + 1 });
  assert.equal(store.sweep(), 0, "segunda passada não acha nada");
  assert.deepEqual(store.stats(), { sessions: 1, evictions: 0 });
});

test("sweepIntervalMs 0/null não cria timer e stop() é seguro", () => {
  const clock = fakeClock();
  for (const sweepIntervalMs of [0, null]) {
    const store = createSessionStore({ ttlMs: TTL, sweepIntervalMs, now: clock.now });
    store.touch("s1");
    assert.equal(store.get("s1").createdAt, START);
    assert.equal(store.sweep(), 0);
    store.stop();
    assert.equal(store.get("s1").createdAt, START, "store segue utilizável depois do stop");
  }
});

test("store com sweep periódico tem timer unref'd (o processo não fica preso) e stop() o encerra", () => {
  const clock = fakeClock();
  const store = createSessionStore({ ttlMs: TTL, sweepIntervalMs: 10, now: clock.now });
  store.touch("s1");
  assert.equal(store.get("s1").createdAt, START);
  store.stop();
  assert.equal(typeof store.stop, "function");
});

test("stores são independentes entre si (sem estado de módulo compartilhado)", () => {
  const { store: one } = makeStore();
  const { store: two } = makeStore();
  one.touch("s1");

  assert.equal(one.stats().sessions, 1);
  assert.equal(two.stats().sessions, 0);
  assert.equal(two.get("s1"), null);
});

test("singleton de módulo: getSessionStore() devolve o mesmo sessionStore", () => {
  assert.equal(getSessionStore(), sessionStore);
  assert.equal(typeof sessionStore.touch, "function");
  assert.equal(typeof sessionStore.sweep, "function");
  assert.equal(sessionStore.get("id-que-nao-existe"), null);
});

test("setLastSearch com payload null devolve null sem lançar e sem mexer no estado", () => {
  const { store } = makeStore();
  store.touch("s1");
  store.setLastSearch("s1", { ids: ["c1"], query: "antes", at: 7 });
  const before = { ...store.get("s1") };

  assert.equal(store.setLastSearch("s1", null), null);
  assert.deepEqual(store.get("s1"), before, "registro intacto: lastSearch e lastUsedAt não mudam");
  assert.deepEqual(store.getLastSearch("s1"), { ids: ["c1"], query: "antes", at: 7 });
  assert.equal(store.setLastSearch("nova", null), null, "payload inválido não faz touch");
  assert.deepEqual(store.stats(), { sessions: 1, evictions: 0 });
});

test("setLastSearch com payload não-objeto ou ids não-array é no-op silencioso", () => {
  const { store } = makeStore();
  const stored = store.setLastSearch("s1", { ids: ["c1"], query: "antes" });

  for (const payload of [42, "nope", true, [], { ids: 42 }, { ids: "nope" }, { ids: null }]) {
    assert.equal(store.setLastSearch("s1", payload), null, `payload ${JSON.stringify(payload)}`);
  }

  assert.deepEqual(store.getLastSearch("s1"), stored, "a pesquisa anterior continua intacta");
  assert.equal(store.setLastSearch("nova", 42), null);
  assert.equal(store.get("nova"), null, "nenhuma sessão nasce de payload inválido");
  assert.deepEqual(store.stats(), { sessions: 1, evictions: 0 });
});

test("createSessionStore(null) cai nas opções padrão e devolve um store utilizável", () => {
  const store = createSessionStore(null);

  const record = store.touch("s1");
  assert.equal(record, store.get("s1"));
  assert.equal(typeof record.createdAt, "number");
  assert.equal(store.getLastSearch("s1"), null);

  store.setLastSearch("s1", { ids: ["c1"], query: "revisar" });
  assert.deepEqual(store.getLastSearch("s1").ids, ["c1"]);
  assert.equal(store.getLastCardId("s1"), null);
  assert.deepEqual(store.stats(), { sessions: 1, evictions: 0 });
  store.stop();
});
