/**
 * Gravação comprimida (webm/opus → mp4/AAC → WAV legado).
 *
 * O PCM cru a 16 kHz custa ~32 KB/s (um comando de 10–30 s vira 320–960 KB) e
 * não sobrevive a um uplink de 3G (~200 kbps) atrás de um túnel Cloudflare.
 * Aqui ficam SÓ as decisões puras (nada de MediaRecorder no carregamento do
 * módulo): qual MIME pedir, qual extensão isso gera e quanto isso pesa. Quem
 * grava de verdade é o hook, que injeta as dependências do navegador.
 *
 * Ordem de preferência:
 *   1. `audio/webm;codecs=opus` — baseline do MediaRecorder no Android/Chrome e
 *      no Safari só a partir do 18.4 (mar/2025).
 *   2. `audio/mp4` — o único formato que o Safari no iOS < 18.4 sabe gravar (AAC).
 *   3. `null` — nenhum dos dois: o hook segue no caminho WAV de sempre.
 */

/** Teto de formatos que a OpenAI aceita em /v1/audio/transcriptions (ver server/src/services/stt.js). */
export const RECORDER_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"] as const;

/**
 * Quanto esperar pelo `onstop` do MediaRecorder. Ele SEMPRE dispara (mesmo sem
 * áudio), mas um navegador travado sem ele deixaria o microfone vivo para
 * sempre: passado este teto, `stopRecorder` derruba tudo na força e ainda
 * resolve com o que já chegou. 2 s é folgado — o flush real leva ~1 bloco.
 */
export const RECORDER_STOP_TIMEOUT_MS = 2_000;

/**
 * 32 kbps: faixa ideal para FALA em opus (24–32 kbps). Um comando de 10 s ≈ 40 KB,
 * contra ~320 KB do WAV — cabe em 3G sem cortar a inteligibilidade.
 */
export const RECORDER_BITRATE = 32_000;

export type RecorderMime = (typeof RECORDER_MIME_CANDIDATES)[number];

/** Assinatura do MediaRecorder.isTypeSupported (injetável para teste). */
export type IsTypeSupported = (mime: string) => boolean;

/**
 * MediaRecorder.isTypeSupported lido NA HORA DA CHAMADA (nunca no topo do módulo,
 * que também roda em Node nos testes) e tolerante a implementação quebrada.
 */
function browserSupportsType(mime: string): boolean {
  try {
    return globalThis.MediaRecorder?.isTypeSupported?.(mime) ?? false;
  } catch {
    return false;
  }
}

/** Primeiro formato comprimido que este navegador grava — ou null para o caminho WAV. */
export function pickRecorderMime(isTypeSupported: IsTypeSupported = browserSupportsType): RecorderMime | null {
  for (const mime of RECORDER_MIME_CANDIDATES) {
    if (isTypeSupported(mime)) return mime;
  }
  return null;
}

/** Extensão derivada do MIME REAL (nunca fixa: o servidor nomeia o arquivo com ela). */
export function recorderExtFor(mime: string | null | undefined): "webm" | "m4a" | "wav" {
  const value = String(mime ?? "").toLowerCase();
  if (!value) return "wav";
  if (value.includes("webm")) return "webm";
  if (value.includes("mp4") || value.includes("m4a") || value.includes("aac")) return "m4a";
  if (value.includes("ogg") || value.includes("opus")) return "webm";
  return "wav";
}

/** Quanto um clipe de `seconds` ocupa no bitrate dado (matemática pura, sem navegador). */
export function estimateCompressedBytes(seconds: number, bitrate = RECORDER_BITRATE): number {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const safeBitrate = Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0;
  return Math.max(1, Math.round((safeSeconds * safeBitrate) / 8));
}

/**
 * Caminho comprimido só quando o navegador grava comprimido E o modo cru está
 * desligado: "cru" é o modo de quem quer o PCM sem tratamento (sem cancelamento
 * de eco, sem normalização) — esse público continua no pipeline WAV.
 */
export function shouldUseRecorder(mime: string | null | undefined, rawMode: boolean): boolean {
  return Boolean(mime) && !rawMode;
}

export interface CompressedRecorder {
  mime: RecorderMime;
  /** true enquanto captura (dataavailable alimenta o Blob final). */
  readonly recording: boolean;
  /** Liga o MediaRecorder. Lança se o navegador recusar o mime/bitrate. */
  start: () => void;
  /** Encerra e resolve com o Blob comprimido (tipo = mime pedido, para o front nomear o arquivo). */
  stop: () => Promise<Blob>;
  /**
   * Encerra NA MARRA: tenta `stop()` uma última vez, ignora o `onstop` e resolve
   * com os pedaços que já chegaram. Nunca lança. Usado só quando o `onstop`
   * atrasa demais (ver `stopRecorder`).
   */
  forceStop: () => Promise<Blob>;
  /** Chamado quando o MediaRecorder falha sozinho (o hook avisa o usuário). */
  onError?: (err: unknown) => void;
  /** Chamado no onstop (limpeza/telemetria). */
  onStop?: () => void;
  /** Já recebeu algum pedaço? (um clipe sem pedaço nenhum é gravação vazia) */
  readonly hasChunks: boolean;
}

/**
 * Grava a MESMA MediaStream que o VAD já está analisando, em paralelo: o worklet
 * continua entregando RMS/pico (para parar sozinho e acusar microfone mudo) e o
 * MediaRecorder só monta os pedaços comprimidos.
 */
export function createCompressedRecorder(
  stream: MediaStream,
  options: { mime?: RecorderMime | null; bitrate?: number } & Pick<CompressedRecorder, "onError" | "onStop"> = {},
): CompressedRecorder {
  const Recorder = globalThis.MediaRecorder;
  if (typeof Recorder !== "function") throw new Error("MediaRecorder indisponível neste navegador.");
  const mime = options.mime ?? pickRecorderMime();
  if (!mime) throw new Error("Nenhum formato de áudio comprimido disponível.");
  const bitrate = options.bitrate ?? RECORDER_BITRATE;

  const recorder = new Recorder(stream, { mimeType: mime, audioBitsPerSecond: bitrate });
  const chunks: Blob[] = [];
  let recording = false;
  let settled = false;
  let resolveResult: ((blob: Blob) => void) | null = null;

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data?.size) chunks.push(event.data);
  };
  recorder.onerror = (event: Event) => {
    options.onError?.((event as unknown as { error?: unknown }).error ?? event);
  };
  // A promessa é criada JÁ, antes do start: o onstop sempre encontra quem resolver.
  const result = new Promise<Blob>((resolve) => {
    resolveResult = resolve;
  });

  /** Fecha a gravação com os pedaços que existirem (idempotente). */
  const finish = () => {
    recording = false;
    if (settled) return;
    settled = true;
    // O tipo vem do mime PEDIDO (não do recorder.mimeType): é dele que o upload
    // deriva 'gravacao.webm' / 'gravacao.m4a'.
    resolveResult?.(new Blob(chunks, { type: mime }));
  };

  recorder.onstop = () => {
    options.onStop?.();
    finish();
  };

  /**
   * Caminho SEM onstop (navegador travado): tenta parar uma última vez, ignora
   * o resultado e resolve com o que já chegou. Nunca lança.
   */
  const forceStop = () => {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* já parado */
    }
    finish();
    return result;
  };

  return {
    mime,
    get recording() {
      return recording;
    },
    get hasChunks() {
      return chunks.length > 0;
    },
    start: () => {
      recorder.start();
      recording = true;
    },
    stop: () => {
      if (settled) return result;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* já parado: o onstop acima resolve */
        }
      }
      return result;
    },
    forceStop,
    onError: options.onError,
    onStop: options.onStop,
  };
}

/** Resultado do encerramento: o Blob e se ele saiu do caminho normal. */
export interface StopRecorderResult {
  blob: Blob;
  /** true = o `onstop` não veio a tempo e a parada foi forçada. */
  timedOut: boolean;
  /** true = sem pedaço nenhum (o hook trata como falha, nunca como upload vazio). */
  empty: boolean;
}

/**
 * Encerra a gravação SEM NUNCA PENDER: corre o `stop()` contra um teto de tempo.
 * Se o `onstop` não vier, força a parada e resolve com os pedaços que já
 * chegaram — o hook derruba stream/contexto em seguida, então o microfone não
 * fica vivo esperando um evento que talvez nunca chegue.
 */
export async function stopRecorder(
  recorder: Pick<CompressedRecorder, "stop" | "forceStop">,
  timeoutMs = RECORDER_STOP_TIMEOUT_MS,
): Promise<StopRecorderResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<{ kind: "timeout"; blob: null }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout", blob: null }), Math.max(1, timeoutMs));
  });

  try {
    // O stop() normal é o caminho feliz (onstop → Blob com o último pedaço).
    // Um stop() que REJEITA conta como travado: o clipe já gravado não se perde.
    const attempt = recorder
      .stop()
      .then((blob) => ({ kind: "blob" as const, blob }))
      .catch(() => ({ kind: "failed" as const, blob: null }));
    const winner = await Promise.race([attempt, expiry]);
    if (winner.kind === "blob") {
      return { blob: winner.blob, timedOut: false, empty: winner.blob.size === 0 };
    }
    // Travou: força, resolve com o que existe e deixa o hook derrubar o stream.
    const blob = await recorder.forceStop();
    return { blob, timedOut: true, empty: blob.size === 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Extensão que o upload deve usar para este mime ('gravacao.webm' / 'gravacao.m4a'). */
export function recorderFileName(mime: string | null | undefined): string {
  return `gravacao.${recorderExtFor(mime)}`;
}
