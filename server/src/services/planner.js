/**
 * Orquestrador do plano: JEV → MiMo 2.6 Pro → interpretador local.
 *
 *  1. JEV classifica tudo numa chamada paralela (~400 ms). Se opera → pronto.
 *  2. Se o JEV se abstém (ele mesmo diz por quê) ou está indisponível,
 *     o MiMo 2.6 Pro (System Two, raciocínio máximo) assume — só nesse caso.
 *  3. Sem OpenRouter, ou se o MiMo falhar, o interpretador local mantém o app vivo.
 *
 * O `trace` devolvido alimenta o painel "Decisões" da UI: o que o JEV decidiu,
 * com que confiança, por que (não) operou e quanto tempo cada degrau levou.
 */
import { performance } from "node:perf_hooks";
import { config } from "../config.js";
import { planWithJev } from "./jev-planner.js";
import { MimoError, planWithMimo } from "./agent.js";
import { parseTranscriptLocally } from "./intent.js";
import { describeAction, normalizeActions, requiresConfirmation } from "../domain/actions.js";

const ms = (since) => Math.round(performance.now() - since);

export async function planCommand({ transcript, board, context = {}, onEvent = () => {} }) {
  const started = performance.now();
  const text = String(transcript ?? "").trim();
  const trace = { engine: "local", totalMs: 0, jev: null, mimo: null, fallback: null };

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

  /* 1) JEV — System One */
  if (config.jev.enabled) {
    const jev = await planWithJev({ transcript: text, board, context });
    trace.jev = { status: jev.status, code: jev.code ?? null, reason: jev.reason ?? null, ...jev.trace };
    // O navegador vê o veredito do JEV na hora (~0,5 s), mesmo que o MiMo leve segundos.
    onEvent({ type: "jev", jev: trace.jev });
    if (jev.status === "ok") {
      trace.engine = "jev";
      return finish({
        speech: jev.plan.speech,
        actions: jev.plan.actions,
        needsConfirmation: jev.plan.needsConfirmation,
        provider: "jev",
        model: jev.trace.model,
        band: jev.plan.band,
      });
    }
    trace.fallback = { from: "jev", to: config.openrouter.apiKey ? "mimo" : "local", code: jev.code, reason: jev.reason };
  }

  /* 2) MiMo 2.6 Pro — System Two (reserva) */
  if (config.openrouter.apiKey) {
    const mimoStarted = performance.now();
    onEvent({ type: "mimo", status: "started", model: config.openrouter.model, reason: trace.fallback?.reason ?? null });
    try {
      const mimo = await planWithMimo({ transcript: text, board, context });
      trace.engine = "mimo";
      trace.mimo = { status: "ok", model: mimo.model, latencyMs: mimo.latencyMs };
      return finish({
        speech: mimo.plan.speech,
        actions: mimo.plan.actions,
        needsConfirmation: mimo.plan.needsConfirmation,
        provider: "mimo",
        model: mimo.model,
      });
    } catch (err) {
      trace.mimo = { status: "failed", latencyMs: ms(mimoStarted), reason: err instanceof MimoError ? err.message : String(err?.message ?? err) };
      trace.fallback = { ...(trace.fallback ?? { from: "mimo" }), to: "local", mimoReason: trace.mimo.reason };
    }
  }

  /* 3) Interpretador local — o app nunca fica inutilizável */
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
    provider: config.jev.enabled || config.openrouter.apiKey ? "local-fallback" : "local",
    warning: config.openrouter.apiKey
      ? `JEV e MiMo não conseguiram operar (${trace.fallback?.reason ?? trace.mimo?.reason ?? "motivo desconhecido"}); usei o interpretador local.`
      : null,
  });
}
