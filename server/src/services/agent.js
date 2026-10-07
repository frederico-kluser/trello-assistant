/**
 * Agente de planeamento — OpenRouter (xiaomi/mimo-v2.6-pro).
 * Contrato: a fala do usuário + snapshot do board entra; sai um plano JSON
 *   { speech, needsConfirmation, actions[] }
 * Sem OPENROUTER_API_KEY (ou em falha), degrada para o interpretador local
 * em src/services/intent.js — o app nunca fica inutilizável.
 */
import { config } from "../config.js";
import { request } from "../lib/http.js";
import { describeAction, normalizeActions, requiresConfirmation } from "../domain/actions.js";
import { parseTranscriptLocally } from "./intent.js";

const TODAY = () => new Date().toISOString().slice(0, 10);

const SYSTEM_PROMPT = `Você é o "Piloto de bordo" do Trello Orbit.
Sua tarefa: transformar o que a pessoa FALOU em ações sobre o board do Trello e numa frase curta de resposta falada.

REGRAS
1. Responda SOMENTE com um objeto JSON válido. Sem texto fora do JSON, sem cercas de código.
2. Formato exato:
{
  "speech": "o que o app vai falar para a pessoa (pt-BR, 1 a 2 frases, tom natural)",
  "needsConfirmation": true|false,
  "actions": [ { ... } ]
}
3. Tipos de ação (use SOMENTE estes):
   {"type":"create_card","name":"...","list":"...","desc":"...","due":"AAAA-MM-DD","labels":["..."],"position":"top|bottom"}
   {"type":"delete_card","card":"...","reason":"..."}
   {"type":"move_card","card":"...","list":"...","position":"top|bottom"}
   {"type":"update_card","card":"...","name":"...","desc":"...","add_labels":[...],"remove_labels":[...]}
   {"type":"set_due","card":"...","due":"AAAA-MM-DD ou ISO completo","due_complete":true|false}
   {"type":"comment_card","card":"...","text":"..."}
   {"type":"archive_card","card":"..."}
   {"type":"create_list","name":"..."}
   {"type":"add_checklist_item","card":"...","checklist":"...","text":"..."}
4. Referencie cards e listas pelos NOMES que aparecem no board (nome parcial serve).
5. Datas: converta "amanhã", "sexta", "dia 20", "20/08" em ISO-8601 (AAAA-MM-DD). Sem ano, use o ano atual. Hoje é {{TODAY}}..
6. Várias ações numa mesma fala devem ser devolvidas TODAS, na ordem pedida.
7. Pedidos de informação ("o que tenho?", "quais cards?") NÃO são ações: devolva "actions": [] e responda no "speech" usando o board.
8. NUNCA invente lista ou card que não existe no board. Se estiver ambíguo, devolva "actions": [] e peça esclarecimento no "speech".
9. "needsConfirmation" é true SOMENTE para create_card / delete_card ou quando há ambiguidade. Ações de mover/editar/prazo/comentar são diretas.
10. "speech" sempre em português do Brasil, na primeira pessoa ("Vou criar…", "Movendo…", "O card X já está…").
11. delete_card é destrutivo: deixe isso claro no "speech".`;

function boardDigest(board) {
  const lines = [`BOARD: ${board.name}${board.demo ? " (modo demonstração)" : ""}`, "", "LISTAS:"];
  for (const list of board.lists) {
    lines.push(`- ${list.name}`);
  }
  lines.push("", "CARDS:");
  for (const card of board.cards) {
    const list = board.lists.find((l) => l.id === card.idList)?.name ?? "?";
    const labels = card.labels?.map((l) => l.name || l.color).filter(Boolean).join(", ");
    const due = card.due ? ` · prazo ${String(card.due).slice(0, 10)}${card.dueComplete ? " (concluído)" : ""}` : "";
    const flags = card.closed ? " · ARQUIVADO" : "";
    lines.push(`- "${card.name}" | lista: ${list}${labels ? ` | etiquetas: ${labels}` : ""}${due}${flags} | id: ${card.id}`);
  }
  return lines.join("\n");
}

/** Extrai o JSON do texto do modelo com tolerância a cercas de código e ruído. */
export function extractJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    /* tenta recortar o objeto mais externo */
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parsePlan(content, { transcript, board }) {
  const json = extractJson(content);
  if (!json || typeof json !== "object") return null;

  const actions = normalizeActions(json.actions);
  const speechSource = typeof json.speech === "string" ? json.speech.trim() : "";
  const speech =
    speechSource ||
    (actions.length
      ? `Vou ${actions.map((action) => describeAction(action, board)).join(" e ")}.`
      : "Entendi, mas não encontrei nenhuma ação clara nesse pedido.");

  return {
    speech,
    actions,
    needsConfirmation: json.needsConfirmation === true || actions.some(requiresConfirmation),
  };
}

export async function planFromTranscript({ transcript, board }) {
  const text = String(transcript ?? "").trim();
  if (!text) {
    return { speech: "Não ouvi nada. Pode repetir?", actions: [], needsConfirmation: false, provider: "local" };
  }

  if (!config.openrouter.apiKey) {
    return { ...parseTranscriptLocally(text, board), provider: "local" };
  }

  try {
    const { data } = await request(`${config.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openrouter.apiKey}`,
        "http-referer": config.app.url,
        "x-openrouter-title": config.app.name,
      },
      json: {
        model: config.openrouter.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT.replace("{{TODAY}}", TODAY()) },
          { role: "user", content: `${boardDigest(board)}\n\nO QUE A PESSOA FALOU:\n${text}` },
        ],
        temperature: 0.2,
        max_tokens: config.openrouter.maxTokens,
        response_format: { type: "json_object" },
        // Esforço de raciocínio no máximo (padrão): o modelo pensa o máximo
        // antes de responder. Os reasoning tokens entram no orçamento de
        // max_tokens e são cobrados como output.
        reasoning: { effort: config.openrouter.reasoningEffort },
      },
      // Pense profundo custa latência: damos folga antes de degradar.
      timeoutMs: 120_000,
      retries: 1,
    });

    const content = data?.choices?.[0]?.message?.content ?? "";
    const plan = parsePlan(content, { transcript: text, board });
    if (!plan) {
      return {
        ...parseTranscriptLocally(text, board),
        provider: "local-fallback",
        warning: "A resposta do modelo não veio em JSON válido; usei o interpretador local.",
      };
    }
    return { ...plan, provider: "openrouter", model: data?.model ?? config.openrouter.model };
  } catch (err) {
    return {
      ...parseTranscriptLocally(text, board),
      provider: "local-fallback",
      warning: `O OpenRouter não respondeu (${err.message}); usei o interpretador local.`,
    };
  }
}