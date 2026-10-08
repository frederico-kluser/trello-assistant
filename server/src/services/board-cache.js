/**
 * Cache do board em memória — tira a leitura do Trello (300–800 ms) do caminho
 * crítico da voz. Estratégia:
 *   • leitura serve do cache enquanto "fresca" (TTL curto) e deduplica pedidos
 *     simultâneos (um único GET em voo);
 *   • depois de cada escrita, o resultado devolvido pelo Trello é aplicado ao
 *     cache (patchBoard) — nada de reler o board inteiro para responder;
 *   • uma releitura em background reconcilia com o que mudou fora do app.
 *
 * Comentários: cache próprio (TTL 60 s) porque a leitura é paginada e mais cara
 * que o board. A invalidação é empurrada por trello.js (registerCommentsInvalidator)
 * — o registro vive lá para não fechar um ciclo board-cache → trello → board-cache.
 */
import { getBackend, getBoardComments, registerCommentsInvalidator } from "./trello.js";

const state = { board: null, at: 0, inflight: null };
// `gen` conta invalidações: uma leitura que aterra DEPOIS de uma invalidação
// não pode repovoar o cache com o retrato pré-escrita (ver getCommentsCached).
const commentsState = { data: null, at: 0, inflight: null, gen: 0 };

export async function getBoardCached({ maxAgeMs = 30_000 } = {}) {
  if (state.board && Date.now() - state.at <= maxAgeMs) return state.board;
  if (state.inflight) return state.inflight;
  state.inflight = getBackend()
    .getBoard()
    .then((board) => {
      state.board = board;
      state.at = Date.now();
      return board;
    })
    .finally(() => {
      state.inflight = null;
    });
  return state.inflight;
}

/**
 * Comentários do board (normalizados), com o mesmo padrão do board: TTL de 60 s
 * + deduplicação do pedido em voo. Fonte: trello.getBoardComments().
 *
 * Corrida escrita × leitura: se uma invalidação (comentário gravado ou troca de
 * backend) acontecer com uma leitura em voo, o retrato que chegar atrasado é
 * DESCARTADO — nunca sobrescreve o estado fresco. A próxima leitura relê.
 */
export async function getCommentsCached({ maxAgeMs = 60_000 } = {}) {
  if (commentsState.data && Date.now() - commentsState.at <= maxAgeMs) return commentsState.data;
  if (commentsState.inflight) return commentsState.inflight;
  const gen = commentsState.gen;
  commentsState.inflight = getBoardComments()
    .then((comments) => {
      if (gen === commentsState.gen) {
        commentsState.data = comments;
        commentsState.at = Date.now();
      }
      return comments;
    })
    .finally(() => {
      // só a leitura da geração atual pode libertar o "em voo"
      if (gen === commentsState.gen) commentsState.inflight = null;
    });
  return commentsState.inflight;
}

/** Derruba o cache de comentários (comentário gravado ou troca de backend). */
export function invalidateComments() {
  commentsState.data = null;
  commentsState.at = 0;
  commentsState.inflight = null;
  commentsState.gen += 1;
}

// trello.js avisa sempre que um comentário é gravado; o registro é feito AQUI
// (board-cache → trello) porque o inverso criaria um ciclo de importação.
registerCommentsInvalidator(invalidateComments);

/** Último board em memória (pode estar velho; nunca espera pela rede). */
export const peekBoard = () => state.board;

export const primeBoard = (board) => {
  state.board = board;
  state.at = Date.now();
};

/** Reconcilia com o Trello sem bloquear a resposta. */
export function refreshBoardSoon(delayMs = 1200) {
  const timer = setTimeout(() => {
    getBoardCached({ maxAgeMs: 0 }).catch(() => undefined);
  }, delayMs);
  timer.unref?.();
}

/** Aplica ao board os resultados já devolvidos pelo backend (sem nova leitura). */
export function patchBoard(board, applied) {
  const next = { ...board, cards: [...board.cards], lists: [...board.lists] };
  for (const result of applied) {
    const card = result.card;
    switch (result.type) {
      case "create_card":
        if (card) next.cards.push(card);
        break;
      case "delete_card":
        if (card) next.cards = next.cards.filter((existing) => existing.id !== card.id);
        break;
      case "create_list":
        if (result.list) next.lists.push({ closed: false, pos: next.lists.length + 1, ...result.list });
        break;
      default:
        if (card) {
          next.cards = next.cards.map((existing) =>
            existing.id === card.id
              ? {
                  ...existing,
                  ...card,
                  // a resposta de um PUT não traz checklists: preserva as que já tínhamos
                  checklists: card.checklists?.length ? card.checklists : existing.checklists,
                }
              : existing,
          );
        }
    }
  }
  return next;
}

/** O que o navegador precisa: sem cards arquivados nem listas fechadas (33 KB vs 120 KB). */
export function slimBoard(board) {
  const lists = (board.lists ?? []).filter((list) => !list.closed);
  const open = new Set(lists.map((list) => list.id));
  return { ...board, lists, cards: (board.cards ?? []).filter((card) => !card.closed && open.has(card.idList)) };
}
