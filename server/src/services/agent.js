/**
 * System Two — LLM (OpenRouter). A voz do assistente é escolhida por
 * `services/model-picker.js`: OPENROUTER_MODEL fixo (pinned) ou "auto" (melhor
 * modelo descoberto, com reserva) — resolvida a CADA comando.
 *
 * Planeja os COMANDOS COMPOSTOS: quando a fala traz várias ações ("move A para
 * terminado, move B para terminado e move C para fazendo"), o comando INTEIRO
 * vai para este serviço, que devolve o plano completo — o JEV (System One)
 * continua a resolver os comandos únicos. Não é "reserva para quando o JEV se
 * abstém": abstenções por clareza/card continuam a pedir esclarecimento.
 *
 * Recebe também o HISTÓRICO da sessão (turnos reais) e a última pesquisa, para
 * dar continuidade ("essas atividades", "aquele card que a gente criou").
 * Futuro: gerar texto (nome/descrição/"motivações") nos fluxos de criar/editar.
 *
 * Contrato: a fala + snapshot do board (+ histórico + última pesquisa) entram;
 * sai um plano JSON { speech, needsConfirmation, actions[] }. Em falha lança
 * MimoError.
 */
import { performance } from "node:perf_hooks";
import { config } from "../config.js";
import { HttpError, request } from "../lib/http.js";
import { describeAction, normalizeActions, requiresConfirmation } from "../domain/actions.js";
import { resetModelCache, resolveChatModel } from "./model-picker.js";

/** Ação de LEITURA do vocabulário: busca por característica (não vai ao executor). */
export const SEARCH_ACTION = "search_cards";

/** Teto de turnos de histórico aceitos e de caracteres por turno (anti-payload). */
export const HISTORY_MAX_TURNS = 20;
export const HISTORY_MAX_CHARS = 500;

const HISTORY_ROLES = new Set(["user", "assistant"]);

/**
 * Normaliza o histórico vindo do cliente: só turnos `user`/`assistant` com texto,
 * no máximo os HISTORY_MAX_TURNS mais RECENTES, cada um cortado em HISTORY_MAX_CHARS.
 * Entrada inválida degrada para [] (nunca lança) — a rota e o serviço usam isto.
 */
export function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const turns = [];
  for (const item of raw) {
    const role = String(item?.role ?? "").trim();
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    if (!HISTORY_ROLES.has(role) || !content) continue;
    turns.push({ role, content: content.slice(0, HISTORY_MAX_CHARS) });
  }
  return turns.slice(-HISTORY_MAX_TURNS);
}

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
   {"type":"search_cards","text":"...","labels":["..."],"due":"...","listName":"..."}
   As nove primeiras alteram o quadro. A décima, "search_cards", é LEITURA: procure
   cards por característica (assunto no nome/descrição/comentário, etiqueta, prazo
   ou coluna) — preencha só os campos que a pessoa indicou ("text" é o assunto dito,
   ex.: "pagamento"; "due" aceita any|set|none|overdue|today|week) e deixe
   "actions" SEM nenhuma ação de escrita. O servidor faz a busca e responde.
4. Referencie cards e listas pelos NOMES que aparecem no board (nome parcial serve).
   A fala vem de RECONHECIMENTO DE VOZ e os nomes chegam BORRADOS: pese a PRONÚNCIA
   e o contexto do pedido, não só a grafia. Ex.: "Ondocay" é "Ondokai"; "Leia" é
   "Laya"; "a atividade da academia" é o card do ginásio. Escolha o item do board
   que SOA como o que foi dito e faz sentido no pedido. Isto vale também para nomes
   citados em turnos anteriores da conversa.
5. Datas: converta "amanhã", "sexta", "dia 20", "20/08" em ISO-8601 em UTC
   (AAAA-MM-DD quando a hora não importa; ISO completo com "Z" quando a pessoa diz
   uma hora — ex.: "2026-08-20T12:00:00.000Z"). Sem ano, use o ano atual. Hoje é {{TODAY}}.
6. Devolva TODAS as ações pedidas, na ORDEM em que foram ditas — inclusive 3 ou
   mais numa só fala, e mesmo que sejam de tipos diferentes (ex.: editar a descrição
   de um card, marcar o prazo de outro e comentar num terceiro = 3 ações de 3 tipos).
   Não resuma, não junte duas ações numa e não descarte nenhuma: a quantidade de
   ações da sua resposta tem de bater com a do pedido.
7. Pedidos de informação ("o que tenho?", "quais cards?") NÃO são ações: devolva "actions": [] e responda no "speech" usando o board.
8. NUNCA invente lista ou card que não existe no board. Se estiver ambíguo, devolva "actions": [] e peça esclarecimento no "speech".
9. "needsConfirmation" é true SOMENTE para create_card / delete_card ou quando há ambiguidade. Ações de mover/editar/prazo/comentar são diretas.
10. "speech" sempre em português do Brasil, na primeira pessoa ("Vou criar…", "Movendo…", "O card X já está…").
11. delete_card é destrutivo: deixe isso claro no "speech".
12. As mensagens ANTERIORES a esta são turnos REAIS desta mesma sessão (o que a
   pessoa pediu e o que o app respondeu). Resolva por elas as referências ao que já
   foi dito — "do último pedido", "aquele card que a gente criou", "isso", "ele" —
   em vez de pedir esclarecimento. O board e a última pesquisa da mensagem atual
   continuam a ser a fonte da verdade sobre o que existe.
13. Quando a mensagem atual trouxer uma secção "ÚLTIMA PESQUISA", esses são os cards
   encontrados na última busca da sessão: "essas atividades", "os da última
   pesquisa", "todos eles" referem-se EXATAMENTE a esses cards (e a mais nenhum).
   Para agir sobre eles, escreva "card": "@lastSearch" na ação — o servidor expande
   o marcador numa ação por card. Não invente nem escreva os nomes um a um.`;

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

/**
 * Os cards da última pesquisa da sessão (nomes + ids reais do board), para o
 * modelo poder dizer "@lastSearch" em vez de inventar nomes. Vazio = não injeta.
 */
function lastSearchDigest(lastSearch, board) {
  const ids = Array.isArray(lastSearch?.ids) ? lastSearch.ids : [];
  if (!ids.length) return "";
  const cards = ids.map((id) => board.cards?.find((card) => card.id === id)).filter(Boolean);
  if (!cards.length) return "";
  const lines = cards.map((card) => `- "${card.name}" (id: ${card.id})`);
  return `\n\nÚLTIMA PESQUISA (${cards.length} ${cards.length === 1 ? "atividade" : "atividades"} — "essas atividades", "os da última pesquisa" e o marcador "@lastSearch" referem-se a estes cards):\n${lines.join("\n")}`;
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

/**
 * `search_cards` (leitura) não existe no executor do domínio — `normalizeActions`
 * o descartaria. Aqui ele é saneado e MANTIDO na posição em que o modelo o pôs;
 * o planner é quem o executa (e o tira do plano final).
 */
function sanitizeSearchAction(item) {
  const action = { type: SEARCH_ACTION };
  if (typeof item.text === "string" && item.text.trim()) action.text = item.text.trim();
  if (typeof item.listName === "string" && item.listName.trim()) action.listName = item.listName.trim();
  if (typeof item.due === "string" && item.due.trim()) action.due = item.due.trim();
  if (Array.isArray(item.labels)) {
    const labels = item.labels.map((label) => String(label).trim()).filter(Boolean);
    if (labels.length) action.labels = labels;
  }
  return action;
}

/** Normaliza preservando a ORDEM falada, inclusive com ações de leitura no meio. */
export function normalizePlanActions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (String(item?.type ?? "").trim() === SEARCH_ACTION) {
      out.push(sanitizeSearchAction(item ?? {}));
      continue;
    }
    out.push(...normalizeActions([item]));
  }
  return out;
}

export function parsePlan(content, { transcript, board }) {
  const json = extractJson(content);
  if (!json || typeof json !== "object") return null;

  const actions = normalizePlanActions(json.actions);
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
 * O modelo RESOLVIDO não atende `/chat/completions` (descontinuado, sem provider):
 * vale descartar a escolha e resolver outra antes de desistir.
 */
function rejectsModel(err) {
  return err instanceof HttpError && (err.status === 404 || err.status === 503);
}

/** @returns {Promise<{plan:{speech:string,actions:object[],needsConfirmation:boolean}, model:string, servedModel:string, latencyMs:number}>} */
export async function planWithMimo({ transcript, board, context = {} }) {
  if (!config.openrouter.apiKey) throw new MimoError("no_key", "falta OPENROUTER_API_KEY");
  const text = String(transcript ?? "").trim();
  const last = context.lastCardId ? board.cards?.find((card) => card.id === context.lastCardId) : null;
  const started = performance.now();

  // A voz do assistente: escolhida A CADA comando pelo model-picker (pinned/auto,
  // com cache interno). Nunca lança — o pior caso é o modelo de reserva.
  let { modelId } = await resolveChatModel();

  const userContent = `${boardDigest(board)}${last ? `\n\nÚLTIMO CARD CITADO (use para "ele/ela/esse card"): "${last.name}"` : ""}${lastSearchDigest(context.lastSearch, board)}\n\nO QUE A PESSOA FALOU:\n${text}`;
  // Histórico REAL da sessão entre o system e o turno atual (turnos verbatim).
  const messages = [
    { role: "system", content: SYSTEM_PROMPT.replace("{{TODAY}}", TODAY()) },
    ...normalizeHistory(context.history).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: userContent },
  ];
  // `reasoning` é opcional: o modelo pode não o suportar (ver `rejectsReasoning`).
  const body = (reasoning, model) => ({
    model,
    messages,
    temperature: 0.2,
    max_tokens: config.openrouter.maxTokens,
    response_format: { type: "json_object" },
    // Esforço de raciocínio no máximo (padrão): o modelo pensa o máximo antes de
    // responder. Os reasoning tokens entram no orçamento de max_tokens e são
    // cobrados como output.
    ...(reasoning ? { reasoning: { effort: config.openrouter.reasoningEffort } } : {}),
  });
  const send = (reasoning, model) =>
    request(`${config.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openrouter.apiKey}`,
        "http-referer": config.app.url,
        "x-openrouter-title": config.app.name,
      },
      json: body(reasoning, model),
      // Pensar fundo custa latência: damos folga antes de degradar.
      timeoutMs: 120_000,
      retries: 1,
    });

  /** Uma tentativa completa contra um modelo: com `reasoning` e, se ele for recusado, sem. */
  const callModel = async (model) => {
    try {
      return await send(true, model);
    } catch (err) {
      if (!rejectsReasoning(err)) throw err;
      // O modelo recusou o campo `reasoning`: repetimos UMA vez sem ele.
      return send(false, model);
    }
  };

  let data;
  try {
    ({ data } = await callModel(modelId));
  } catch (err) {
    if (!rejectsModel(err)) throw new MimoError("request_failed", `o OpenRouter não respondeu (${err.message})`);
    // Escolha ruim (modelo descontinuado/sem provider): descarta o cache e resolve
    // OUTRA vez — o catálogo pode ter mudado (o campeão saiu) — e repete UMA vez.
    resetModelCache();
    const retryModel = (await resolveChatModel()).modelId;
    try {
      ({ data } = await callModel(retryModel));
    } catch (retryErr) {
      throw new MimoError("request_failed", `o OpenRouter não respondeu (${retryErr.message})`);
    }
    modelId = retryModel;
  }

  const plan = parsePlan(data?.choices?.[0]?.message?.content ?? "", { transcript: text, board });
  if (!plan) throw new MimoError("invalid_json", "a resposta do modelo não veio em JSON válido");
  // `model` é o id RESOLVIDO (a voz desta sessão); `servedModel` é quem atendeu.
  return {
    plan,
    model: modelId,
    servedModel: data?.model ?? modelId,
    latencyMs: Math.round(performance.now() - started),
  };
}
