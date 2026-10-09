/**
 * Pergunta de DESBLOQUEIO — quando o sistema não consegue completar a tarefa
 * (abstenção do JEV, referência ambígua/desconhecida na execução, falta de
 * card/lista/data/texto), em vez de morrer em "reformule", o app gera UMA
 * pergunta COM OPÇÕES: o LLM redige a pergunta e escolhe opções concretas
 * (nomes reais do board quando aplicável); sem chave ou sem resposta válida,
 * cai num fallback determinístico (nunca lança).
 *
 * Contrato da pergunta (o front mostra botões e a escolha volta como
 * `context.answer` em /api/agent, ou remenda a ação em /api/actions):
 *   { prompt: string, options: [{ label: string, value: string }] }
 *
 * `label` é o que a pessoa vê/toca; `value` é o texto que, respondido, completa
 * a tarefa (nome/id de card ou lista, data em linguagem natural, texto pedido).
 * `options: []` é válido: pergunta aberta, respondida por voz ou texto.
 */
import { config } from "../config.js";
import { request } from "../lib/http.js";
import { resolveChatModel } from "./model-picker.js";

/** Erros de execução que viram pergunta com opções em vez de erro seco. */
export const QUESTION_CODES = new Set(["ambiguous_reference", "unknown_reference", "bad_request"]);

const MAX_OPTIONS = 5;

/** Normaliza o JSON do modelo para o contrato `{ prompt, options }`. Aceita null/lixo. */
export function parseQuestion(raw) {
  let data = raw;
  if (typeof raw === "string") {
    // Conteúdo bruto do modelo: JSON direto ou com cercas de código/ruído à volta.
    const text = raw.trim();
    if (!text) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const candidate = fenced ? fenced[1] : text;
    try {
      data = JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start === -1 || end <= start) return null;
      try {
        data = JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  if (!data || typeof data !== "object") return null;
  const prompt = String(data.prompt ?? data.question ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!prompt) return null;
  const options = [];
  for (const item of Array.isArray(data.options) ? data.options : []) {
    const label = String(typeof item === "string" ? item : item?.label ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const value = String(typeof item === "string" ? item : item?.value ?? label).replace(/\s+/g, " ").trim().slice(0, 240);
    if (label && value) options.push({ label, value });
    if (options.length >= MAX_OPTIONS) break;
  }
  return { prompt, options };
}

/**
 * Candidatos vindos de várias fontes — `{id, name}`, `{name}`, `"nome"` — para
 * `{ id, name, value }` (o `value` é o que resolve a referência: id quando há).
 */
export function normalizeCandidates(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name) out.push({ id: null, name, value: name });
      continue;
    }
    const name = String(item?.name ?? "").trim();
    if (!name) continue;
    const id = item?.id ? String(item.id) : null;
    out.push({ id, name, value: id ?? name });
    if (out.length >= 12) break;
  }
  return out;
}

const norm = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Cards abertos mais parecidos com a fala (tokens em comum); sem nenhum, os primeiros. */
export function topCards(board, transcript, limit = MAX_OPTIONS) {
  const cards = (board?.cards ?? []).filter((card) => !card.closed);
  const spoken = new Set(norm(transcript).split(" ").filter((token) => token.length >= 3));
  const score = (card) => norm(card.name).split(" ").filter((token) => token.length >= 3 && spoken.has(token)).length;
  const hits = cards
    .map((card) => ({ card, score: score(card) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.card);
  return (hits.length ? hits : cards).slice(0, limit);
}

/** Opções de exemplo a partir do board real (para "não entendi o pedido"). */
function exampleCommands(board, limit = 3) {
  const lists = (board?.lists ?? []).filter((list) => !list.closed);
  const cards = (board?.cards ?? []).filter((card) => !card.closed);
  const out = ["cria um card chamado revisar proposta"];
  if (lists[0]) out.push(`o que tem na lista ${lists[0].name}?`);
  if (cards[0] && lists[1]) out.push(`move ${cards[0].name} para ${lists[1].name}`);
  else if (cards[0]) out.push(`coloca prazo amanhã no card ${cards[0].name}`);
  return out.slice(0, limit).map((text) => ({ label: text, value: text }));
}

const DATE_OPTIONS = [
  { label: "Hoje", value: "hoje" },
  { label: "Amanhã", value: "amanhã" },
  { label: "Sexta-feira", value: "sexta-feira" },
  { label: "Próxima segunda-feira", value: "próxima segunda-feira" },
];

/**
 * Fallback determinístico: pergunta + opções sem LLM. Sempre sai algo útil —
 * com candidatos prontos (ambiguidade), com o board (card/lista) ou aberto.
 */
export function fallbackQuestion({ code = "", reason = "", board = {}, candidates = [], field = null, transcript = "" } = {}) {
  const base = String(reason ?? "").replace(/\s+/g, " ").trim().replace(/[.:;]+$/, "");
  const list = normalizeCandidates(candidates);
  const isList = field === "list";
  const refLabel = isList ? "lista" : "card";

  if (list.length) {
    return {
      prompt: `${base || `Não identifiquei qual ${refLabel} você quer`}. Você quis dizer um destes?`,
      options: list.slice(0, MAX_OPTIONS).map(({ name, value }) => ({ label: name, value })),
    };
  }

  switch (code) {
    case "no_date":
      return { prompt: "Não entendi a data do prazo. Qual é?", options: DATE_OPTIONS };
    case "no_title":
      return { prompt: "Não captei o nome do card. Qual é o nome?", options: [] };
    case "no_text":
      return { prompt: "Não captei o texto completo. Pode dizer de novo?", options: [] };
    case "no_card":
    case "low_card":
    case "unknown_reference": {
      const options = topCards(board, transcript).map((card) => ({ label: card.name, value: card.name }));
      return {
        prompt: `${base || `Não identifiquei qual ${refLabel} você quer`}. Qual destes?`,
        options: options.slice(0, MAX_OPTIONS),
      };
    }
    case "no_list":
    case "low_list": {
      const options = (board?.lists ?? [])
        .filter((list) => !list.closed)
        .slice(0, MAX_OPTIONS)
        .map((list) => ({ label: list.name, value: list.name }));
      return { prompt: `${base || "Não identifiquei para qual lista"}. Qual destes?`, options };
    }
    default:
      return {
        prompt: `${base ? `${base}. ` : ""}O que você quer fazer?`,
        options: exampleCommands(board),
      };
  }
}

/**
 * Pergunta com opções gerada pelo LLM (System Two). Sem chave, sem rede ou com
 * resposta inválida, devolve o `fallbackQuestion` — nunca lança.
 *
 * Com `candidates` (valores FECHADOS — ex.: ambiguidade na execução), as opções
 * só são aceites se repetirem exatamente esses valores; deixa o fallback falar.
 */
export async function generateQuestion({ transcript = "", board = {}, code = "", reason = "", candidates = [], field = null } = {}) {
  const fixed = normalizeCandidates(candidates);
  const local = fallbackQuestion({ code, reason, board, candidates: fixed, field, transcript });
  if (!config.openrouter.apiKey) return local;

  try {
    const { modelId } = await resolveChatModel();
    const lines = [
      `PEDIDO ORIGINAL: "${String(transcript ?? "").replace(/\s+/g, " ").trim().slice(0, 500)}"`,
      `MOTIVO DA FALHA: ${local.prompt}`,
    ];
    if (field) lines.push(`CAMPO EM FALTA: ${field === "list" ? "lista" : field === "card" ? "card" : field}`);
    if (fixed.length) {
      lines.push("", "CANDIDATOS (use EXATAMENTE estes valores em \"value\"):");
      for (const candidate of fixed) lines.push(`- value: ${candidate.value} → label: ${candidate.name}`);
    }
    lines.push("", "LISTAS:", ...(board?.lists ?? []).filter((list) => !list.closed).map((list) => `- ${list.name}`));
    const cards = (board?.cards ?? []).filter((card) => !card.closed).slice(0, 120);
    if (cards.length) {
      lines.push("", "CARDS ABERTOS:");
      for (const card of cards) {
        const listName = (board?.lists ?? []).find((list) => list.id === card.idList)?.name ?? "?";
        lines.push(`- "${card.name}" (lista: ${listName})`);
      }
    }

    const { data } = await request(`${config.openrouter.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openrouter.apiKey}`,
        "http-referer": config.app.url,
        "x-openrouter-title": config.app.name,
      },
      json: {
        model: modelId,
        temperature: 0.3,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Você ajuda um assistente de voz do Trello ("Trello Orbit") a DESBLOQUEAR uma tarefa que não pôde ser completada.
Gere UMA pergunta curta (pt-BR, tom natural, 1–2 frases, será falada em voz alta) e 2 a 5 OPÇÕES de resposta que permitam COMPLETAR a tarefa original.
Responda SOMENTE com JSON válido: {"prompt": "...", "options": [{"label": "...", "value": "..."}]}
Regras:
- "label": o que a pessoa vê e toca (máx. 60 caracteres, sem aspas).
- "value": o texto exato que, respondido, completa a tarefa (nome real de card/lista, data em linguagem natural, ou o texto que faltava).
- Quando a dúvida for sobre qual card ou qual lista, use SOMENTE itens que existam no board enviado.
- Com CANDIDATOS indicados, use exatamente os "value" deles (pode omitir opções; nunca invente valores).
- Sem opções que façam sentido (ex.: falta texto livre), devolva "options": [] e peça o texto na pergunta.`,
          },
          { role: "user", content: lines.join("\n") },
        ],
      },
      timeoutMs: 30_000,
      retries: 0,
    });

    const parsed = parseQuestion(data?.choices?.[0]?.message?.content ?? "");
    if (!parsed) return local;
    if (fixed.length) {
      const allowed = new Set(fixed.map((candidate) => candidate.value));
      parsed.options = parsed.options.filter((option) => allowed.has(option.value));
      if (!parsed.options.length) return local;
    }
    return parsed;
  } catch (err) {
    void err; // sem LLM não há drama: o fallback determinístico responde
    return local;
  }
}

/** Pergunta a partir de um AppError da execução (candidatos no `detail`). */
export function questionFromError(err, { transcript = "", board = {} } = {}) {
  const detail = err?.detail ?? {};
  return generateQuestion({
    transcript,
    board,
    code: String(err?.code ?? ""),
    reason: String(err?.message ?? ""),
    candidates: detail.candidates ?? detail.suggestions ?? [],
    field: detail.field ?? null,
  });
}
