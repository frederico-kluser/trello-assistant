/**
 * STT — transcrição de áudio com a API da OpenAI
 * (POST /v1/audio/transcriptions). Sem OPENAI_API_KEY o servidor responde
 * 503 com `missing_openai_key` e o front cai no reconhecimento do navegador.
 */
import { config } from "../config.js";
import { request } from "../lib/http.js";
import { AppError, SETUP_GUIDE } from "../lib/errors.js";

const SAFE_MIME = /^(audio|video)\//;

export async function transcribeAudio({ buffer, filename, mimetype }) {
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

  const mime = SAFE_MIME.test(mimetype || "") ? mimetype : "audio/webm";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), filename || "gravacao.webm");
  form.append("model", config.openai.sttModel);
  if (config.openai.language) form.append("language", config.openai.language);
  form.append("response_format", "json");

  try {
    const { data } = await request(`${config.openai.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.openai.apiKey}` },
      form,
      timeoutMs: 90_000,
      retries: 1,
    });

    const text = String(data?.text ?? "").trim();
    if (!text) {
      throw new AppError("stt_empty", "A transcrição veio vazia — tente falar mais perto do microfone.", {
        status: 422,
      });
    }
    return { text, provider: "openai", model: config.openai.sttModel };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("stt_failed", `Falha ao transcrever com a OpenAI: ${err.message}`, {
      status: 502,
      hint: "Verifique saldo/chave em https://platform.openai.com/usage",
      detail: err.detail ?? null,
    });
  }
}