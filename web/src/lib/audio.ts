/**
 * Áudio da voz: PCM → WAV 16 kHz mono, detecção de fala (VAD) e aparagem de
 * silêncio. Sem MediaRecorder: o PCM bruto funciona em qualquer navegador e
 * dá acesso às amostras (nível, "o microfone captou algo?", quando parar).
 */

export const TARGET_RATE = 16_000;

/** Conversão de taxa por média de janela (downsample) ou interpolação linear (upsample). */
export function resample(input: Float32Array, fromRate: number, toRate = TARGET_RATE): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = i * ratio;
    const end = Math.min(input.length, start + ratio);
    if (ratio > 1) {
      let sum = 0;
      let count = 0;
      for (let j = Math.floor(start); j < end; j += 1) {
        sum += input[j];
        count += 1;
      }
      out[i] = count ? sum / count : 0;
    } else {
      const base = Math.floor(start);
      const frac = start - base;
      out[i] = input[base] * (1 - frac) + (input[Math.min(base + 1, input.length - 1)] ?? 0) * frac;
    }
  }
  return out;
}

/** WAV PCM 16-bit mono (cabeçalho de 44 bytes). */
export function encodeWav(samples: Float32Array, sampleRate = TARGET_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Microfone baixo é causa clássica de transcrição vazia: sobe o ganho (até 10×) até o pico ~0,7. */
export function normalize(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < 0.004 || peak >= 0.35) return samples;
  const gain = Math.min(10, 0.7 / peak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain;
  return out;
}

export interface VadOptions {
  /** Silêncio (depois de ouvir fala) que encerra a gravação sozinha. */
  silenceMs: number;
  /** Fala mínima para considerar que a pessoa falou. */
  minSpeechMs: number;
  /** Duração máxima. */
  maxMs: number;
  /** Se ninguém falar até aqui, desiste. */
  noSpeechMs: number;
}

export const DEFAULT_VAD: VadOptions = { silenceMs: 1100, minSpeechMs: 220, maxMs: 30_000, noSpeechMs: 9_000 };

export type VadVerdict = "continue" | "stop" | "no_speech" | "max";

/** Janela inicial em que o ruído de fundo é medido (mediana) antes de decidir o que é fala. */
const CALIBRATE_MS = 320;

/**
 * Detector de fala por energia (RMS). Os primeiros ~320 ms calibram o piso de
 * ruído pela MEDIANA (robusta a um início de fala); um zumbido constante vira
 * "piso", não "fala", e o limiar sobe junto. O piso estimado tem teto de 3% para
 * que quem fala logo ao clicar ainda seja detectado.
 */
export class VoiceActivity {
  floor = 0.004;
  heardSpeech = false;
  speechMs = 0;
  silenceMs = 0;
  totalMs = 0;
  peak = 0;
  private readonly options: VadOptions;
  private calibration: number[] = [];
  private calibrated = false;

  constructor(options: VadOptions = DEFAULT_VAD) {
    this.options = options;
  }

  get threshold() {
    return Math.min(0.085, Math.max(0.012, this.floor * 3.2));
  }

  isSpeech(rms: number) {
    return rms > this.threshold;
  }

  push(rms: number, peak: number, blockMs: number): VadVerdict {
    this.totalMs += blockMs;
    this.peak = Math.max(this.peak, peak);

    if (!this.calibrated) {
      this.calibration.push(rms);
      if (this.totalMs >= CALIBRATE_MS) {
        const sorted = [...this.calibration].sort((a, b) => a - b);
        this.floor = Math.min(0.03, Math.max(0.0008, sorted[Math.floor(sorted.length / 2)]));
        this.calibrated = true;
      }
      return this.totalMs >= this.options.maxMs ? "max" : "continue"; // calibrando: ainda não decide
    }

    const speech = this.isSpeech(rms);
    if (speech) {
      this.speechMs += blockMs;
      this.silenceMs = 0;
      if (this.speechMs >= this.options.minSpeechMs) this.heardSpeech = true;
    } else {
      this.silenceMs += blockMs;
      this.floor = this.floor * 0.97 + Math.max(0.0008, rms) * 0.03; // acompanha o ruído que muda devagar
    }

    if (this.totalMs >= this.options.maxMs) return "max";
    if (this.heardSpeech && this.silenceMs >= this.options.silenceMs) return "stop";
    if (!this.heardSpeech && this.totalMs >= this.options.noSpeechMs) return "no_speech";
    return "continue";
  }
}

/** Mantém 300 ms antes da 1ª fala e 450 ms depois da última (menos bytes, STT mais rápido). */
export function trimToSpeech(samples: Float32Array, rate: number, speechBlocks: { startMs: number; endMs: number }[]): Float32Array {
  if (!speechBlocks.length) return samples;
  const firstMs = Math.max(0, speechBlocks[0].startMs - 300);
  const lastMs = speechBlocks[speechBlocks.length - 1].endMs + 450;
  const from = Math.floor((firstMs / 1000) * rate);
  const to = Math.min(samples.length, Math.ceil((lastMs / 1000) * rate));
  return samples.subarray(from, Math.max(from + 1, to));
}

/** Worklet que entrega blocos de ~1024 amostras + RMS/pico (código como string → Blob URL). */
export const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        let sum = 0, peak = 0;
        for (let j = 0; j < this.n; j++) { const v = this.buf[j]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
        this.port.postMessage({ samples: this.buf.slice(0), rms: Math.sqrt(sum / this.n), peak });
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;
