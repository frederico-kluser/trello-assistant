/**
 * Orquestrador do plano: System Two (compostos) → JEV → interpretador local.
 *
 *  1. Comandos SIMULTÂNEOS (a fala tem 2+ cláusulas com verbo de comando) vão ao
 *     System Two (planWithMimo), que planeja o comando INTEIRO: várias ações numa
 *     só fala saem num plano único, na ordem pedida.
 *  2. Comandos ÚNICOS são do JEV (System One): ele classifica e resolve a
 *     cláusula numa cascata (intenção CRUD → colunas → cards), e o plano sai
 *     pronto. Se ele se abstém com `compound` (um trecho que afinal juntava 2+
 *     ações), o System Two recebe o comando inteiro.
 *  3. As restantes abstenções (clareza, card, lista, indisponibilidade) NÃO têm
 *     fallback genérico: respondemos com `actions: []`, banda `abstain`,
 *     `warning` com o motivo e uma fala de esclarecimento. Se o próprio System
 *     Two falhou num composto, o `warning` diz isso e ainda tentamos o JEV por
 *     cláusulas (compostos limpos podem sair por lá).
 *  4. Sem chave OpenRouter (JEV desligado), o interpretador local pt-BR mantém o
 *     app vivo.
 *
 * O `trace` devolvido alimenta o painel "Decisões" da UI: o que o JEV decidiu,
 * com que confiança, por que (não) operou e quanto tempo cada degrau levou.
 * `trace.llm` é o degrau do System Two; as chaves `mimo` e `fallback` ficam
 * sempre `null` (compatibilidade da UI).
 */
import { performance } from "node:perf_hooks";
import { config } from "../config.js";
import { splitClauses, planWithJev } from "./jev-planner.js";
import { planWithMimo } from "./agent.js";
import { parseTranscriptLocally } from "./intent.js";
import { describeAction, normalizeActions, requiresConfirmation } from "../domain/actions.js";

const ms = (since) => Math.round(performance.now() - since);

export async function planCommand({ transcript, board, context = {}, onEvent = () => {} }) {
  const started = performance.now();
  const text = String(transcript ?? "").trim();
  const trace = { engine: "local", totalMs: 0, jev: null, mimo: null, fallback: null, llm: null };

  if (!text) {
    return {
      speech: "Não ouvi nada. Pode repetir?",
      actions: [],
      needsConfirmation: false,
      provider: "local",
      model: null,
      warning: null,
      band: null,
      trace,
    };
  }

  const finish = (result) => {
    trace.totalMs = ms(started);
    return { warning: null, band: null, model: null, ...result, trace };
  };

  /* System Two — planeja o comando INTEIRO (uma fala, todas as ações). */
  const planWithLlm = async () => {
    const llm = await planWithMimo({ transcript: text, board, context });
    trace.engine = "llm";
    trace.jev = null; // o plano não vem do JEV: não há veredito dele para mostrar
    trace.llm = { status: "ok", model: llm.model, latencyMs: llm.latencyMs };
    onEvent({ type: "llm", llm: trace.llm });
    return finish({
      speech: llm.plan.speech,
      actions: llm.plan.actions,
      needsConfirmation: llm.plan.needsConfirmation,
      provider: "llm",
      model: llm.model,
      band: null,
    });
  };

  /** Registra a falha do System Two no trace (honestidade do painel) e devolve a nota do warning. */
  const noteLlmFailure = (err) => {
    const reason = err?.message ?? "erro desconhecido";
    // `status: "failed"` é o vocabulário da UI (web/src/lib/types.ts → LlmTrace).
    trace.llm = { status: "failed", model: config.openrouter.model, latencyMs: ms(started), reason };
    onEvent({ type: "llm", llm: trace.llm });
    return ` O planejador do comando inteiro falhou (${reason}).`;
  };

  /* 1) Comandos SIMULTÂNEOS → o System Two planeja tudo de uma vez. */
  const simultaneous = splitClauses(text).length > 1;
  let llmError = null;
  let llmNote = "";
  if (simultaneous && config.openrouter.apiKey) {
    try {
      return await planWithLlm();
    } catch (err) {
      // Sem o System Two ainda dá para resolver compostos limpos cláusula a cláusula.
      llmError = err;
      llmNote = noteLlmFailure(err);
    }
  }

  /* 2) JEV — System One (comando único; ou composto limpo, após falha do LLM) */
  if (config.jev.enabled) {
    const jev = await planWithJev({ transcript: text, board, context });
    trace.jev = { status: jev.status, code: jev.code ?? null, reason: jev.reason ?? null, ...jev.trace };
    // O motor desta resposta é o JEV mesmo quando ele se abstém: é dele o motivo.
    trace.engine = "jev";
    // O navegador vê o veredito do JEV na hora (~0,5 s).
    onEvent({ type: "jev", jev: trace.jev });
    if (jev.status === "ok") {
      return finish({
        speech: jev.plan.speech,
        actions: jev.plan.actions,
        needsConfirmation: jev.plan.needsConfirmation,
        provider: "jev",
        model: jev.trace.model,
        band: jev.plan.band,
        ...(jev.plan.listing ? { listing: jev.plan.listing } : {}),
      });
    }

    /* 3) Abstenção por composto num trecho só → o comando inteiro vai ao System Two. */
    if (jev.code === "compound" && config.openrouter.apiKey && !llmError) {
      try {
        return await planWithLlm();
      } catch (err) {
        llmError = err;
        llmNote = noteLlmFailure(err);
      }
    }

    // 4) Sem fallback genérico: abstenção/indisponibilidade viram pedido de esclarecimento.
    const reason = String(jev.reason ?? "motivo desconhecido");
    const speech =
      jev.status === "unavailable"
        ? `O JEV está indisponível: ${reason.replace(/^o JEV está indisponível:\s*/i, "")} Tente novamente em instantes.`
        : `${reason} Pode reformular ou dar mais detalhes?`;
    return finish({
      speech,
      actions: [],
      needsConfirmation: false,
      provider: "jev",
      model: jev.trace.model,
      band: "abstain",
      warning: llmError ? `${reason}.${llmNote}` : reason,
    });
  }

  /* 5) Interpretador local — o app nunca fica inutilizável sem chaves */
  const local = parseTranscriptLocally(text, board);
  const actions = normalizeActions(local.actions).map((action) => ({
    ...action,
    description: describeAction(action, board),
    requiresConfirmation: requiresConfirmation(action),
  }));
  trace.engine = "local";
  return finish({
    speech: local.speech,
    actions,
    needsConfirmation: local.needsConfirmation,
    provider: "local",
  });
}
