/**
 * Cache do board em memória — tira a leitura do Trello (300–800 ms) do caminho
 * crítico da voz. Estratégia:
 *   • leitura serve do cache enquanto "fresca" (TTL curto) e deduplica pedidos
 *     simultâneos (um único GET em voo);
 *   • depois de cada escrita, o resultado devolvido pelo Trello é aplicado ao
 *     cache (patchBoard) — nada de reler o board inteiro para responder;
 *   • uma releitura em background reconcilia com o que mudou fora do app.
 */
import { getBackend } from "./trello.js";

const state = { board: null, at: 0, inflight: null };

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
