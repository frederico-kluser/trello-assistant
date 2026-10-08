/* Ajudantes de leitura do plano — o papel do System Two (comandos simultâneos). */

import type { LlmTrace, Plan } from "./types";
import { VOICE_FALLBACK_LABEL, isAutoModel } from "./session";

/**
 * «provedor/nome-do-modelo» → «Nome Do Modelo». O front não fixa id de modelo:
 * quem manda é o `model` do evento do plano e, sem ele (ou vindo como "auto"),
 * o rótulo neutro `VOICE_FALLBACK_LABEL`.
 */
export function llmLabel(model?: string | null): string {
  if (isAutoModel(model)) return VOICE_FALLBACK_LABEL;
  const slug = String(model).split("/").filter(Boolean).pop() ?? "";
  return (
    slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || VOICE_FALLBACK_LABEL
  );
}

/** Ações que o plano composto traz (2..N numa só fala). */
export const llmActionCount = (plan: Plan | null): number => plan?.actions.length ?? 0;

/** Porque o System Two falhou, já em frase fechada («sem resposta.» quando não diz). */
export function llmFailureNote(llm: LlmTrace): string {
  const reason = llm.reason?.trim();
  if (!reason) return "sem resposta.";
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

/**
 * Resumo de uma linha de um plano «llm» (System Two) para a legenda e o histórico.
 * Devolve null quando o plano não passou pelo LLM.
 */
export function llmSummary(plan: Plan | null): string | null {
  const llm: LlmTrace | null | undefined = plan?.trace?.llm;
  if (!plan || !llm) return null;
  const model = llmLabel(llm.model ?? plan.model);
  const count = llmActionCount(plan);

  if (llm.status === "failed") {
    const detail = llmFailureNote(llm);
    return plan.trace.jev
      ? `${model} falhou: ${detail} O JEV assumiu o comando.`
      : `${model} falhou: ${detail} Sem plano — reformule o pedido.`;
  }

  return `${model} planejou ${count} ${count === 1 ? "ação" : "ações"} numa só fala.`;
}
