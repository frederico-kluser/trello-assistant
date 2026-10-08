import { useCallback, useEffect, useRef, useState } from "react";
import { useMotionValue, type MotionValue } from "motion/react";
import {
  DEFAULT_VAD,
  TARGET_RATE,
  VoiceActivity,
  WORKLET_SOURCE,
  encodeWav,
  normalize,
  resample,
  trimToSpeech,
} from "@/lib/audio";
import { createCaptureChain, type CaptureChain } from "@/lib/capture-chain";
import {
  RECORDER_BITRATE,
  createCompressedRecorder,
  pickRecorderMime,
  shouldUseRecorder,
  stopRecorder,
  type CompressedRecorder,
} from "@/lib/recorder";

export interface MicDevice {
  id: string;
  label: string;
}

export type AutoStopReason = "stop" | "no_speech" | "max";

export type CaptureResult =
  | { ok: true; blob: Blob; durationMs: number; speechMs: number; peak: number; deviceLabel: string; soft: boolean }
  | { ok: false; reason: "silent" | "no_speech" | "error"; peak: number; deviceLabel: string; message: string };

/** Pico abaixo disto = o microfone escolhido não está captando som nenhum. */
const DEAD_PEAK = 0.012;

const store = {
  get: (key: string) => (typeof localStorage === "undefined" ? null : localStorage.getItem(key)),
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* modo privado */
    }
  },
};

let workletUrl: string | null = null;

function explain(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "O navegador bloqueou o microfone. Clique no cadeado ao lado do endereço e libere o acesso (a página precisa de HTTPS ou localhost).";
  }
  if (name === "NotFoundError") return "Nenhum microfone foi encontrado neste computador.";
  if (name === "NotReadableError") return "O microfone está em uso por outro programa. Feche o outro app e tente de novo.";
  return "Não consegui abrir o microfone.";
}

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  nodes: AudioNode[];
  chunks: Float32Array[];
  speech: { startMs: number; endMs: number }[];
  vad: VoiceActivity;
  deviceLabel: string;
  autoFired: boolean;
  onAuto?: (reason: AutoStopReason) => void;
  /** Preenchido só no caminho comprimido (webm/opus ou mp4/AAC). */
  recorder: CompressedRecorder | null;
  /** O MediaRecorder reclamou sozinho: o clipe pode estar truncado. */
  recorderFailed: boolean;
  /** Caminho de PCM ligado (worklet ou script-processor) — telemetria/diagnóstico. */
  tap?: CaptureChain["tap"];
}

export interface VoiceCapture {
  supported: boolean;
  recording: boolean;
  level: MotionValue<number>;
  devices: MicDevice[];
  deviceId: string;
  raw: boolean;
  permission: PermissionState | "unknown";
  start: (onAuto?: (reason: AutoStopReason) => void) => Promise<{ ok: true; deviceLabel: string } | { ok: false; message: string }>;
  stop: () => Promise<CaptureResult>;
  cancel: () => void;
  setDeviceId: (id: string) => void;
  setRaw: (value: boolean) => void;
  refreshDevices: () => Promise<void>;
}

/**
 * Captura de voz. Detecta fala (para sozinha no silêncio), sobe o ganho de
 * microfones baixos e diz EXATAMENTE por que uma gravação não serve
 * (dispositivo mudo, sem fala, bloqueado) em vez de falhar calado.
 *
 * DOIS caminhos, decididos em `start()`:
 *   • COMPRIMIDO (padrão) — MediaRecorder grava a MESMA MediaStream que o
 *     AudioWorklet analisa para o VAD: webm/opus no Chrome/Android e Safari
 *     18.4+, mp4/AAC no iOS antigo. ~4 KB/s em vez de ~32 KB/s, o que faz um
 *     comando de 10–30 s caber num uplink de 3G. O Blob sai com o tipo do
 *     contêiner ('audio/webm;codecs=opus' / 'audio/mp4') e o upload o nomeia
 *     'gravacao.webm' / 'gravacao.m4a'.
 *   • WAV 16 kHz — modo cru (localStorage 'orbit.mic.raw') ou navegador sem
 *     MediaRecorder: pipeline PCM de sempre, byte a byte (trim → normalize →
 *     encodeWav).
 */
export function useVoiceCapture(): VoiceCapture {
  const [recording, setRecording] = useState(false);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [deviceId, setDeviceIdState] = useState(() => store.get("orbit.mic.device") ?? "");
  const [raw, setRawState] = useState(() => store.get("orbit.mic.raw") === "1");
  const [permission, setPermission] = useState<PermissionState | "unknown">("unknown");
  const level = useMotionValue(0);

  const session = useRef<Session | null>(null);
  const deviceRef = useRef(deviceId);
  const rawRef = useRef(raw);
  deviceRef.current = deviceId;
  rawRef.current = raw;

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    setDevices(
      all
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({ id: device.deviceId, label: device.label || `Microfone ${index + 1}` })),
    );
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);

    let status: PermissionStatus | null = null;
    const onChange = () => status && setPermission(status.state);
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((result) => {
        status = result;
        setPermission(result.state);
        result.addEventListener("change", onChange);
      })
      .catch(() => undefined);

    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
      status?.removeEventListener("change", onChange);
    };
  }, [refreshDevices]);

  const teardown = useCallback((s: Session) => {
    for (const node of s.nodes) {
      try {
        node.disconnect();
      } catch {
        /* já desconectado */
      }
    }
    s.stream.getTracks().forEach((track) => track.stop());
    void s.ctx.close().catch(() => undefined);
  }, []);

  useEffect(
    () => () => {
      if (session.current) teardown(session.current);
      session.current = null;
    },
    [teardown],
  );

  const getStream = useCallback(async (): Promise<MediaStream> => {
    const processing = !rawRef.current;
    const base: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: processing,
      noiseSuppression: processing,
      autoGainControl: processing,
    };
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: deviceRef.current ? { ...base, deviceId: { exact: deviceRef.current } } : base,
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (deviceRef.current && (name === "OverconstrainedError" || name === "NotFoundError")) {
        // O dispositivo salvo sumiu (fone desconectado): volta ao padrão do sistema.
        store.set("orbit.mic.device", "");
        setDeviceIdState("");
        return navigator.mediaDevices.getUserMedia({ audio: base });
      }
      throw err;
    }
  }, []);

  const start = useCallback<VoiceCapture["start"]>(
    async (onAuto) => {
      if (session.current) return { ok: false, message: "Já estou gravando." };
      if (!navigator.mediaDevices?.getUserMedia) {
        return { ok: false, message: "Este navegador não permite acessar o microfone. Abra por HTTPS ou localhost." };
      }

      let stream: MediaStream;
      try {
        stream = await getStream();
      } catch (err) {
        return { ok: false, message: explain(err) };
      }
      void refreshDevices(); // os nomes dos dispositivos só aparecem depois da permissão

      const deviceLabel = stream.getAudioTracks()[0]?.label || "microfone padrão";

      let ctx: AudioContext;
      let source: MediaStreamAudioSourceNode;
      try {
        ctx = new AudioContext({ sampleRate: TARGET_RATE });
        source = ctx.createMediaStreamSource(stream);
      } catch {
        // Firefox não liga nós de taxas diferentes: usa a taxa nativa e reamostramos depois.
        ctx = new AudioContext();
        source = ctx.createMediaStreamSource(stream);
      }
      await ctx.resume().catch(() => undefined);

      const s: Session = {
        stream,
        ctx,
        nodes: [source],
        chunks: [],
        speech: [],
        vad: new VoiceActivity(DEFAULT_VAD),
        deviceLabel,
        autoFired: false,
        onAuto,
        recorder: null,
        recorderFailed: false,
      };

      // ── Ligação da captura, BLINDADA (F2) ──────────────────────────────
      // Recorder comprimido + VAD podem falhar em qualquer passo (mime recusado,
      // worklet indisponível, connect lançando). Se algo estourar DEPOIS do
      // stream aberto, o microfone NÃO pode ficar vivo: derruba tudo antes de
      // rejeitar, para o chamador poder tentar de novo sem reiniciar a página.
      let chain: CaptureChain;
      const onBlock = (samples: Float32Array, rms: number, peak: number) => {
        if (session.current !== s) return;
        const blockMs = (samples.length / ctx.sampleRate) * 1000;
        const startMs = s.vad.totalMs;
        s.chunks.push(samples);
        const verdict = s.vad.push(rms, peak, blockMs);
        if (s.vad.isSpeech(rms)) s.speech.push({ startMs, endMs: startMs + blockMs });
        level.set(Math.min(1, peak * 2.4));
        if (verdict !== "continue" && !s.autoFired) {
          s.autoFired = true;
          s.onAuto?.(verdict);
        }
      };
      try {
        // ── Caminho COMPRIMIDO (webm/opus ou mp4/AAC) ────────────────────
        // O AudioWorklet continua dono do VAD (RMS/pico, microfone mudo, parada
        // automática) e o MediaRecorder consome a MESMA MediaStream em paralelo:
        // o upload cai de ~32 KB/s (WAV 16 kHz) para ~4 KB/s. Modo cru e
        // navegador sem MediaRecorder seguem no pipeline WAV, byte a byte.
        const recorderMime = pickRecorderMime();
        if (shouldUseRecorder(recorderMime, rawRef.current)) {
          try {
            s.recorder = createCompressedRecorder(stream, {
              mime: recorderMime,
              bitrate: RECORDER_BITRATE,
              onError: () => {
                s.recorderFailed = true;
              },
            });
            s.recorder.start();
          } catch {
            s.recorder = null; // qualquer recusa do navegador volta para o WAV
          }
        }

        workletUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
        chain = await createCaptureChain({ ctx, source, workletUrl, onBlock });
        s.nodes.push(...chain.nodes);
      } catch (err) {
        // Mic vivo na mão: recorder primeiro (para o flush), depois stream e contexto.
        try {
          s.recorder?.stop();
        } catch {
          /* já parado */
        }
        s.recorder = null;
        teardown(s);
        return { ok: false, message: `Não consegui preparar a captura de áudio neste navegador. ${explain(err)}`.trim() };
      }
      s.tap = chain.tap;

      session.current = s;
      setRecording(true);
      return { ok: true, deviceLabel };
    },
    [getStream, level, refreshDevices, teardown],
  );

  const stop = useCallback(async (): Promise<CaptureResult> => {
    const s = session.current;
    if (!s) return { ok: false, reason: "error", peak: 0, deviceLabel: "", message: "Nada estava gravando." };
    session.current = null;
    setRecording(false);
    level.set(0);

    const peak = s.vad.peak;

    if (peak < DEAD_PEAK) {
      s.recorder?.stop(); // não deixa o MediaRecorder pendurado
      teardown(s);
      return {
        ok: false,
        reason: "silent",
        peak,
        deviceLabel: s.deviceLabel,
        message: `O microfone «${s.deviceLabel}» não captou som nenhum. Escolha outro no menu do microfone ou confira se ele não está mudo.`,
      };
    }

    const soft = !s.vad.heardSpeech;

    // ── Caminho COMPRIMIDO: o Blob do MediaRecorder já É o upload ────────
    // trimToSpeech/normalize/encodeWav não se aplicam a um contêiner opus/AAC.
    if (s.recorder) {
      const recorder = s.recorder;
      // stopRecorder NUNCA pendura: se o onstop não vier (navegador travado), ele
      // força a parada e devolve o que já chegou — e o teardown logo abaixo
      // derruba stream/contexto, então o microfone não fica vivo.
      const { blob, timedOut, empty } = await stopRecorder(recorder);
      const failed = s.recorderFailed;
      teardown(s);
      if (failed || empty) {
        // Sem contêiner confiável não há o que enviar: o app cai na legenda do
        // navegador (mesmo caminho do { ok: false, reason: 'error' }).
        return {
          ok: false,
          reason: "error",
          peak,
          deviceLabel: s.deviceLabel,
          message: timedOut
            ? "A gravação não terminou a tempo neste navegador — tente de novo (a gravação ficou curta demais para enviar)."
            : "A gravação comprimida falhou neste navegador — tente de novo ou use o modo cru nas configurações do microfone.",
        };
      }
      return {
        ok: true,
        blob, // blob.type = mime pedido → o front nomeia 'gravacao.webm' / 'gravacao.m4a'
        durationMs: s.vad.totalMs,
        speechMs: s.vad.speechMs,
        peak,
        deviceLabel: s.deviceLabel,
        soft,
      };
    }

    const total = s.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of s.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const sampleRate = s.ctx.sampleRate;
    const durationMs = (total / sampleRate) * 1000;

    const focused = soft ? merged : trimToSpeech(merged, sampleRate, s.speech);
    const pcm = normalize(resample(focused, sampleRate));
    return {
      ok: true,
      blob: encodeWav(pcm),
      durationMs: (pcm.length / TARGET_RATE) * 1000,
      speechMs: s.vad.speechMs,
      peak,
      deviceLabel: s.deviceLabel,
      soft: soft && durationMs > 0,
    };
  }, [level, teardown]);

  const cancel = useCallback(() => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    setRecording(false);
    level.set(0);
    s.recorder?.stop(); // descarta sem esperar: o Blob vai para o lixo junto
    teardown(s);
  }, [level, teardown]);

  const setDeviceId = useCallback((id: string) => {
    store.set("orbit.mic.device", id);
    setDeviceIdState(id);
  }, []);

  const setRaw = useCallback((value: boolean) => {
    store.set("orbit.mic.raw", value ? "1" : "0");
    setRawState(value);
  }, []);

  return {
    supported: typeof window !== "undefined" && typeof AudioContext !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
    recording,
    level,
    devices,
    deviceId,
    raw,
    permission,
    start,
    stop,
    cancel,
    setDeviceId,
    setRaw,
    refreshDevices,
  };
}
