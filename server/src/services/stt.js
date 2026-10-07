/**
 * STT — transcrição de áudio com a API da OpenAI
 * (POST /v1/audio/transcriptions). Sem OPENAI_API_KEY o servidor responde
 * 503 com `missing_openai_key` e o front cai no reconhecimento do navegador.
 *
 * Dicas para acertar nomes próprios: o parâmetro `prompt` recebe as listas e
 * os cards do board (nomes próprios, siglas…), o que reduz erros de nomes que
 * o modelo nunca viu.
 */
import { performance } from "node:perf_hooks";
import { config } from "../config.js";
import { request } from "../lib/http.js";
import { AppError, SETUP_GUIDE } from "../lib/errors.js";

const SAFE_MIME = /^(audio|video)\//;

/** Extensão que a OpenAI reconhece, derivada do MIME real da gravação. */
export function extensionFor(mimetype = "", filename = "") {
  const mime = String(mimetype).toLowerCase();
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("flac")) return "flac";
  const fromName = /\.([a-z0-9]{3,4})$/i.exec(filename)?.[1]?.toLowerCase();
  return fromName ?? "webm";
}

/** Vocabulário do board (até ~700 caracteres) para guiar a transcrição. */
export function vocabularyPrompt(board) {
  if (!board) return "";
  const lists = (board.lists ?? []).filter((list) => !list.closed).map((list) => list.name.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim());
  const open = new Set((board.lists ?? []).filter((list) => !list.closed).map((list) => list.id));
  const cards = (board.cards ?? []).filter((card) => !card.closed && open.has(card.idList)).map((card) => card.name);
  let text = `Comando de voz para o Trello em português. Listas: ${lists.join(", ")}. Cards: ${cards.join("; ")}`;
  if (text.length > 700) text = `${text.slice(0, 700).replace(/;[^;]*$/, "")}`;
  return text;
}

export async function transcribeAudio({ buffer, filename, mimetype, prompt = "" }) {
  if (!config.openai.apiKey) {
    throw new AppError("missing_openai_key", "A API STT da OpenAI ainda não está configurada no servidor.", {
      status: 503,
      hint: `Preencha OPENAI_API_KEY em .env — guia: ${SETUP_GUIDE}`,
    });
  }
  if (!buffer?.length) {
    throw new AppError("bad_request", "Não recebi nenhum áudio para transcrever.", { status: 400 });
  }
  if (buffer.length > config.openai.maxUploadBytes) {
    throw new AppError("upload_too_large", "O áudio passa do limite de 25 MB.", { status: 413 });
  }
  // Gravações de ~0,2 s têm poucos bytes: nem vale chamar a OpenAI.
  if (buffer.length < 1500) {
    throw new AppError("audio_too_short", "A gravação ficou curta demais — segure um pouco mais e fale.", { status: 422 });
  }

  const mime = SAFE_MIME.test(mimetype || "") ? mimetype : "audio/webm";
  const started = performance.now();
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), `gravacao.${extensionFor(mime, filename)}`);
  form.append("model", config.openai.sttModel);
  if (config.openai.language) form.append("language", config.openai.language);
  if (prompt) form.append("prompt", prompt);
  form.append("response_format", "json");

  try {
    const { data } = await request(`${config.openai.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.openai.apiKey}` },
      form,
      timeoutMs: 60_000,
      retries: 1,
    });

    const text = String(data?.text ?? "").trim();
    if (!text) {
      throw new AppError("stt_empty", "Não ouvi fala nessa gravação — confira o microfone e tente de novo.", {
        status: 422,
      });
    }
    return { text, provider: "openai", model: config.openai.sttModel, ms: Math.round(performance.now() - started), bytes: buffer.length };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("stt_failed", `Falha ao transcrever com a OpenAI: ${err.message}`, {
      status: 502,
      hint: "Verifique saldo/chave em https://platform.openai.com/usage",
      detail: err.detail ?? null,
    });
  }
}
