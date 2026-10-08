/**
 * System Two — LLM (OpenRouter, padrão google/gemini-3.8-flash).
 *
 * Planeja os COMANDOS COMPOSTOS: quando a fala traz várias ações ("move A para
 * terminado, move B para terminado e move C para fazendo"), o comando INTEIRO
 * vai para este serviço, que devolve o plano completo — o JEV (System One)
 * continua a resolver os comandos únicos. Não é "reserva para quando o JEV se
 * abstém": abstenções por clareza/card continuam a pedir esclarecimento.
 * Futuro: gerar texto (nome/descrição/"motivações") nos fluxos de criar/editar.
 *
 * Contrato: a fala + snapshot do board entram; sai um plano JSON
 * { speech, needsConfirmation, actions[] }. Em falha lança MimoError.
 */
import { performance } from "node:perf_hooks";
import { config } from "../config.js";
import { HttpError, request } from "../lib/http.js";
import { describeAction, normalizeActions, requiresConfirmation } from "../domain/actions.js";

export class MimoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MimoError";
    this.code = code;
  }
}

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
   A fala vem de RECONHECIMENTO DE VOZ e os nomes chegam BORRADOS: pese a PRONÚNCIA
   e o contexto do pedido, não só a grafia. Ex.: "Ondocay" é "Ondokai"; "Leia" é
   "Laya"; "a atividade da academia" é o card do ginásio. Escolha o item do board
   que SOA como o que foi dito e faz sentido no pedido.
5. Datas: converta "amanhã", "sexta", "dia 20", "20/08" em ISO-8601 (AAAA-MM-DD). Sem ano, use o ano atual. Hoje é {{TODAY}}..
6. Devolva TODAS as ações pedidas, na ORDEM em que foram ditas — inclusive 3 ou
   mais numa só fala. Não resuma, não junte duas ações numa e não descarte
   nenhuma: a quantidade de ações da sua resposta tem de bater com a do pedido.
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

/**
 * O 400/422 fala de `reasoning`? Nem todo modelo aceita `reasoning: { effort }`
 * e o OpenRouter recusa o corpo inteiro — nesse caso vale repetir sem o campo.
 */
function rejectsReasoning(err) {
  if (!(err instanceof HttpError) || (err.status !== 400 && err.status !== 422)) return false;
  const detail = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail ?? "");
  return /reasoning/i.test(detail) || /reasoning/i.test(err.message);
}

/**
 * @returns {Promise<{plan:{speech:string,actions:object[],needsConfirmation:boolean}, model:string, latencyMs:number}>}
 * @throws {MimoError}
 */
export async function planWithMimo({ transcript, board, context = {} }) {
  if (!config.openrouter.apiKey) throw new MimoError("no_key", "falta OPENROUTER_API_KEY");
  const text = String(transcript ?? "").trim();
  const last = context.lastCardId ? board.cards?.find((card) => card.id === context.lastCardId) : null;
  const started = performance.now();

  const messages = [
    { role: "system", content: SYSTEM_PROMPT.replace("{{TODAY}}", TODAY()) },
    {
      role: "user",
      content: `${boardDigest(board)}${last ? `\n\nÚLTIMO CARD CITADO (use para "ele/ela/esse card"): "${last.name}"` : ""}\n\nO QUE A PESSOA FALOU:\n${text}`,
    },
  ];
  // `reasoning` é opcional: o modelo pode não o suportar (ver `rejectsReasoning`).
  const body = (reasoning) => ({
    model: config.openrouter.model,
    messages,
    temperature: 0.2,
    max_tokens: config.openrouter.maxTokens,
    response_format: { type: "json_object" },
    // Esforço de raciocínio no máximo (padrão): o modelo pensa o máximo antes de
    // responder. Os reasoning tokens entram no orçamento de max_tokens e são
    // cobrados como output.
    ...(reasoning ? { reasoning: { effort: config.openrouter.reasoningEffort } } : {}),
  });
  const send = (reasoning) =>
    request(`${config.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openrouter.apiKey}`,
        "http-referer": config.app.url,
        "x-openrouter-title": config.app.name,
      },
      json: body(reasoning),
      // Pensar fundo custa latência: damos folga antes de degradar.
      timeoutMs: 120_000,
      retries: 1,
    });

  let data;
  try {
    ({ data } = await send(true));
  } catch (err) {
    if (!rejectsReasoning(err)) throw new MimoError("request_failed", `o OpenRouter não respondeu (${err.message})`);
    // O modelo recusou o campo `reasoning`: repetimos UMA vez sem ele.
    try {
      ({ data } = await send(false));
    } catch (retryErr) {
      throw new MimoError("request_failed", `o OpenRouter não respondeu (${retryErr.message})`);
    }
  }

  const plan = parsePlan(data?.choices?.[0]?.message?.content ?? "", { transcript: text, board });
  if (!plan) throw new MimoError("invalid_json", "a resposta do modelo não veio em JSON válido");
  return { plan, model: data?.model ?? config.openrouter.model, latencyMs: Math.round(performance.now() - started) };
}
