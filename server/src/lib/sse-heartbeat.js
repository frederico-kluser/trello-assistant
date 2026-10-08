/**
 * Heartbeat de SSE: comentários `: ping` periódicos mantêm o fluxo vivo
 * enquanto o planejador (JEV + OpenAI) fica 10–120 s em silêncio.
 *
 * O Cloudflare (e o cloudflared) corta fluxo SSE ocioso por volta dos 100 s
 * (ou devolve 524). Um comentário SSE reinicia esse relógio de ociosidade e é
 * descartado por qualquer parser de eventos — não vira evento para o cliente.
 * 15 s dá margem folgada (~6× antes do corte) sem poluir o fluxo.
 *
 * Atomicidade: o frame inteiro sai numa única chamada `write` dentro do
 * callback do timer. O Node é single-threaded e o roteador escreve cada evento
 * também numa única chamada síncrona, então um ping NUNCA cai no meio de um
 * `data: {...}\n\n`.
 */

export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Frame de comentário SSE (dois-pontos + linha em branco): o parser ignora. */
export const HEARTBEAT_FRAME = ": ping\n\n";

const noop = () => {};

/** Intervalo válido (ms) ou o padrão — nunca lança. */
function normalizeInterval(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : HEARTBEAT_INTERVAL_MS;
}

/** Dá para escrever? Guarda contra resposta já encerrada/derrubada. */
function isWritable(res) {
  return !res.writableEnded && !res.writableFinished && !res.destroyed && res.writable !== false;
}

/**
 * Liga o ping periódico numa resposta SSE e devolve o `stop()`.
 *
 * Nunca lança: `res` inválido (ou sem `write`) devolve um stop vazio, e uma
 * escrita que falhe (socket morto) é engolida — o desligamento chega pelos
 * eventos de `close`/`finish`/`error` da resposta.
 *
 * @param {import("node:http").ServerResponse | object} res resposta já com headers SSE.
 * @param {object} [options]
 * @param {number} [options.intervalMs] período do ping (padrão 15 s).
 * @param {(chunk: string) => unknown} [options.write] escrita alternativa (testes).
 * @param {typeof setInterval} [options.setInterval] agendador injetável (testes).
 * @param {typeof clearInterval} [options.clearInterval] cancelador injetável (testes).
 * @returns {() => void} stop idempotente.
 */
export function startSseHeartbeat(res, options = {}) {
  if (!res || typeof res !== "object") return noop;

  const { write = null, setInterval: schedule = setInterval, clearInterval: cancel = clearInterval } = options;
  const writer = typeof write === "function" ? write : typeof res.write === "function" ? (chunk) => res.write(chunk) : null;
  if (!writer) return noop;

  let stopped = false;
  const timer = schedule(() => {
    if (stopped || !isWritable(res)) return;
    try {
      writer(HEARTBEAT_FRAME);
    } catch {
      /* stream morto: o stop vem pelos eventos da resposta */
    }
  }, normalizeInterval(options.intervalMs));

  return function stop() {
    if (stopped) return;
    stopped = true;
    cancel(timer);
  };
}
