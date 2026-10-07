/* Voz do sistema (TTS) + reconhecimento do navegador (fallback de STT).
   O áudio de resposta é sempre gratuito: usa a API de SpeechSynthesis local. */

let cachedVoice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  if (typeof window === "undefined" || !window.speechSynthesis) return null;

  const voices = window.speechSynthesis.getVoices();
  const ptBr = voices.filter((voice) => voice.lang.toLowerCase().startsWith("pt-br"));
  const pt = voices.filter((voice) => voice.lang.toLowerCase().startsWith("pt"));
  cachedVoice = ptBr[0] ?? pt[0] ?? null;
  return cachedVoice;
}

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Fala um texto em pt-BR e resolve quando termina (ou imediatamente se indisponível). */
export function speak(text: string, { rate = 1.02, pitch = 1 }: { rate?: number; pitch?: number } = {}): Promise<void> {
  return new Promise((resolve) => {
    const clean = String(text ?? "").trim();
    if (!clean || !speechAvailable()) {
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

/* ── Reconhecimento do navegador (fallback quando não há chave OpenAI) ── */

interface RecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { 0: { transcript: string }; isFinal: boolean };
  };
}

export interface Recognizer {
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export interface RecognizerHandlers {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
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

export function recognizerAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
  );
}

export function createRecognizer(handlers: RecognizerHandlers): Recognizer | null {
  if (!recognizerAvailable()) return null;
  const Ctor = ((window as unknown as Record<string, unknown>).SpeechRecognition ??
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as RecognitionCtor;

  const recognition = new Ctor();
  recognition.lang = "pt-BR";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = "";

  recognition.onresult = (event) => {
    let partial = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) {
        finalText += `${result[0].transcript} `;
      } else {
        partial += result[0].transcript;
      }
    }
    if (partial) handlers.onPartial?.(partial);
  };

  recognition.onerror = (event) => {
    handlers.onError?.(event.error ?? "erro desconhecido");
  };

  recognition.onend = () => {
    const text = finalText.trim();
    if (text) handlers.onFinal(text);
  };

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
  };
}