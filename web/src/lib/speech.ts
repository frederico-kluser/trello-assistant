/* Voz do sistema (TTS) + legendas ao vivo do navegador (reserva do STT).
   O áudio de resposta é gratuito: usa a SpeechSynthesis local. */

let cachedVoice: SpeechSynthesisVoice | null = null;
let muted = typeof localStorage !== "undefined" && localStorage.getItem("orbit.muted") === "1";

export const isMuted = () => muted;

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem("orbit.muted", value ? "1" : "0");
  } catch {
    /* modo privado */
  }
  if (value) cancelSpeech();
}

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  if (typeof window === "undefined" || !window.speechSynthesis) return null;

  const voices = window.speechSynthesis.getVoices();
  const ptBr = voices.filter((voice) => voice.lang.toLowerCase().replace("_", "-").startsWith("pt-br"));
  const pt = voices.filter((voice) => voice.lang.toLowerCase().startsWith("pt"));
  // Vozes "natural/online" soam melhor quando existem.
  const best = [...ptBr, ...pt].find((voice) => /natural|google|online/i.test(voice.name));
  cachedVoice = best ?? ptBr[0] ?? pt[0] ?? null;
  return cachedVoice;
}

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Tira emojis, aspas e símbolos que a voz leria em voz alta ("party popper"). */
export function speakable(text: string): string {
  return String(text ?? "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[«»"“”]/g, "")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fala um texto em pt-BR e resolve quando termina (ou na hora se mudo/indisponível). */
export function speak(text: string, { rate = 1.05, pitch = 1 }: { rate?: number; pitch?: number } = {}): Promise<void> {
  return new Promise((resolve) => {
    const clean = speakable(text);
    if (!clean || muted || !speechAvailable()) {
      resolve();
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(clean);
      const voice = pickVoice();
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? "pt-BR";
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    } catch {
      resolve();
    }
  });
}

export function cancelSpeech(): void {
  if (speechAvailable()) window.speechSynthesis.cancel();
}

/* ── Legendas ao vivo (SpeechRecognition do navegador) ─────────────────── */

interface RecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { 0: { transcript: string }; isFinal: boolean; length: number };
  };
}

type RecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export function liveCaptionsAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const supported = "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
  // No celular o reconhecimento disputa o microfone com a gravação: só no desktop.
  const finePointer = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
  return supported && finePointer;
}

export interface LiveCaptions {
  start: () => void;
  /** Para e devolve o texto reconhecido até agora. */
  stop: () => string;
  readonly text: string;
}

/**
 * Legenda ao vivo enquanto a pessoa fala. É um EXTRA: se o navegador bloquear
 * (Brave, sem rede), falha em silêncio e o STT da OpenAI segue sendo a fonte.
 * O texto final serve de reserva se a OpenAI não conseguir transcrever.
 */
export function createLiveCaptions(onText: (text: string) => void): LiveCaptions {
  let active = false;
  let finals = "";
  let interim = "";
  let recognition: InstanceType<RecognitionCtor> | null = null;

  const emit = () => onText(`${finals} ${interim}`.replace(/\s+/g, " ").trim());

  const spawn = () => {
    if (!active || !liveCaptionsAvailable()) return;
    const Ctor = ((window as unknown as Record<string, unknown>).SpeechRecognition ??
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as RecognitionCtor;
    try {
      recognition = new Ctor();
      recognition.lang = "pt-BR";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (result.isFinal) finals += `${result[0].transcript} `;
          else interim += result[0].transcript;
        }
        emit();
      };
      recognition.onerror = (event) => {
        // "network"/"not-allowed": o navegador não oferece o serviço. Sem barulho.
        if (event.error === "network" || event.error === "not-allowed" || event.error === "service-not-allowed") active = false;
      };
      recognition.onend = () => {
        if (active) spawn(); // o Chrome encerra sozinho após pausas
      };
      recognition.start();
    } catch {
      active = false;
    }
  };

  return {
    start() {
      finals = "";
      interim = "";
      active = true;
      spawn();
    },
    stop() {
      active = false;
      try {
        recognition?.stop();
      } catch {
        /* já parado */
      }
      return `${finals} ${interim}`.replace(/\s+/g, " ").trim();
    },
    get text() {
      return `${finals} ${interim}`.replace(/\s+/g, " ").trim();
    },
  };
}
