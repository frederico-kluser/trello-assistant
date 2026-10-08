/**
 * Store de sessão EM MEMÓRIA, por `sessionId` gerado pelo cliente (o id morre
 * no refresh do navegador — não é cookie, não é persistente, não vai a disco).
 *
 * Para que serve: dar continuidade entre comandos de voz. "apaga esse último
 * card que você criou" só faz sentido se o servidor lembrar (a) a última
 * pesquisa e (b) o último card tocado. Este módulo guarda exatamente isso:
 *
 *   { createdAt, lastUsedAt, lastSearch: { ids, query, at } | null,
 *     lastCardId: string | null }
 *
 * Regras de operação (quem consome — rotas/planner — não precisa saber disto):
 *   • TTL: o registro vive enquanto `now() - lastUsedAt <= ttlMs`. Passou disso,
 *     está expirado: qualquer leitura o apaga e devolve null. Um `touch` num
 *     registro expirado o recria do zero (sessão nova).
 *   • LRU: ao INSERIR uma sessão nova com o store cheio (maxSessions), sai a de
 *     `lastUsedAt` mais antigo; empate desempata pela ordem de inserção. Antes
 *     disso os expirados são recolhidos: vaga de sessão morta não é "despejo".
 *   • Sweep: um setInterval opcional recolhe expirados. O timer é `unref()`'d,
 *     então nunca segura o processo (testes/CLI saem normalmente).
 *   • Nunca lança: entrada inválida degrada para null/false.
 *
 * Zero dependências de config/Trello: o relógio é injetável para teste.
 */

/** Ids são opacos, mas limitados: nada de payload gigante virando chave de Map. */
const MAX_ID_LENGTH = 128;

const DEFAULTS = Object.freeze({
  ttlMs: 6 * 60 * 60 * 1000, // 6 h
  maxSessions: 500,
  sweepIntervalMs: 15 * 60 * 1000, // 15 min
});

const positiveNumber = (value, fallback) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

/** Id válido = string não vazia de até 128 caracteres. */
const isValidId = (id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH;

/** Objeto simples = nem null, nem array, nem primitivo (o que dá para desestruturar). */
const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const normalizeIds = (ids) =>
  Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id.length > 0) : [];

const normalizeQuery = (query) => {
  if (typeof query === "string") return query;
  if (query && typeof query === "object") return query;
  return null;
};

const normalizeCardId = (cardId) => (typeof cardId === "string" && cardId.length > 0 ? cardId : null);

/**
 * Cria um store isolado (relógio próprio, timer próprio). Devolve a API pública.
 *
 * @param {object} [options]                  opções inválidas (null, primitivo) caem nos padrões.
 * @param {number} [options.ttlMs]            tempo de vida por inatividade.
 * @param {number} [options.maxSessions]      teto de sessões simultâneas (LRU).
 * @param {number|null} [options.sweepIntervalMs] intervalo do sweep; 0/null desliga.
 * @param {() => number} [options.now]        relógio injetável (testes).
 */
export function createSessionStore(options) {
  const {
    ttlMs = DEFAULTS.ttlMs,
    maxSessions = DEFAULTS.maxSessions,
    sweepIntervalMs = DEFAULTS.sweepIntervalMs,
    now = () => Date.now(),
  } = isPlainObject(options) ? options : {};
  const ttl = positiveNumber(ttlMs, DEFAULTS.ttlMs);
  const capacity = Math.floor(positiveNumber(maxSessions, DEFAULTS.maxSessions));
  const sweepEvery = positiveNumber(sweepIntervalMs, 0); // 0/null → sem timer
  const clock = typeof now === "function" ? now : () => Date.now();

  /** @type {Map<string, {createdAt:number,lastUsedAt:number,lastSearch:object|null,lastCardId:string|null}>} */
  const sessions = new Map();
  let evictions = 0;

  const isExpired = (record) => clock() - record.lastUsedAt > ttl;

  /** Expira na leitura: registro velho é apagado, não só ignorado. */
  const live = (id) => {
    if (!isValidId(id)) return null;
    const record = sessions.get(id);
    if (!record) return null;
    if (isExpired(record)) {
      sessions.delete(id);
      return null;
    }
    return record;
  };

  /** Recolhe expirados. Devolve quantos saíram — não conta como despejo. */
  const prune = () => {
    let removed = 0;
    for (const [id, record] of sessions) {
      if (isExpired(record)) {
        sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  };

  /** LRU: a sessão viva com `lastUsedAt` mais antigo (empate = inserida antes). */
  const oldestId = () => {
    let victim = null;
    let victimAt = Infinity;
    for (const [id, record] of sessions) {
      if (record.lastUsedAt < victimAt) {
        victimAt = record.lastUsedAt;
        victim = id;
      }
    }
    return victim;
  };

  /** Cria ou renova a sessão. Registro expirado conta como inexistente. */
  const touch = (id) => {
    if (!isValidId(id)) return null;
    const at = clock();
    let record = sessions.get(id);
    if (record && isExpired(record)) {
      sessions.delete(id); // sessão morta não é ressuscitada: nasce outra
      record = null;
    }
    if (record) {
      record.lastUsedAt = at;
      return record;
    }
    if (sessions.size >= capacity) {
      // vaga ocupada por sessão morta não custa despejo: recolhe antes de decidir
      prune();
      const victim = sessions.size >= capacity ? oldestId() : null;
      if (victim !== null) {
        sessions.delete(victim);
        evictions += 1;
      }
    }
    record = { createdAt: at, lastUsedAt: at, lastSearch: null, lastCardId: null };
    sessions.set(id, record);
    return record;
  };

  /** Remove todos os expirados. Devolve quantos saíram (útil em teste/log). */
  function sweep() {
    return prune();
  }

  const timer = sweepEvery > 0 ? setInterval(sweep, sweepEvery) : null;
  timer?.unref?.(); // nunca segura o event loop (testes, CLI, shutdown)

  return {
    touch,

    get: (id) => live(id),

    /**
     * Substitui a última pesquisa — é UM slot, não histórico.
     * Payload que não seja objeto simples, ou com `ids` não-array, é no-op:
     * devolve null sem criar/alterar sessão.
     */
    setLastSearch: (id, payload) => {
      if (!isPlainObject(payload)) return null;
      const { ids, query, at } = payload;
      if (ids !== undefined && !Array.isArray(ids)) return null;
      const record = touch(id);
      if (!record) return null;
      const stored = {
        ids: normalizeIds(ids),
        query: normalizeQuery(query),
        at: typeof at === "number" && Number.isFinite(at) ? at : clock(),
      };
      record.lastSearch = stored;
      return stored;
    },

    getLastSearch: (id) => live(id)?.lastSearch ?? null,

    setLastCardId: (id, cardId) => {
      const record = touch(id);
      if (!record) return null;
      record.lastCardId = normalizeCardId(cardId);
      return record.lastCardId;
    },

    getLastCardId: (id) => live(id)?.lastCardId ?? null,

    /** Apaga a sessão inteira. `false` se não havia nada (ou id inválido). */
    clear: (id) => (isValidId(id) ? sessions.delete(id) : false),

    stats: () => ({ sessions: sessions.size, evictions }),

    sweep,

    /** Encerra o sweep periódico (o store continua utilizável). */
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

/** Singleton do processo — a API de sessão usada pelas rotas. */
export const sessionStore = createSessionStore();

/** Acesso ao singleton (mesmo objeto; existe para injeção futura em testes). */
export function getSessionStore() {
  return sessionStore;
}
