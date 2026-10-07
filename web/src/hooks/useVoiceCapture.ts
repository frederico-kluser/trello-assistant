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
 * Captura de voz: PCM via AudioWorklet → WAV 16 kHz. Detecta fala (para sozinha
 * no silêncio), sobe o ganho de microfones baixos e diz EXATAMENTE por que uma
 * gravação não serve (dispositivo mudo, sem fala, bloqueado) em vez de falhar calado.
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
      };

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

      let sink: GainNode;
      let tap: AudioNode | null = null;
      if (ctx.audioWorklet) {
        try {
          workletUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
          await ctx.audioWorklet.addModule(workletUrl);
          const worklet = new AudioWorkletNode(ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
          worklet.port.onmessage = (event: MessageEvent<{ samples: Float32Array; rms: number; peak: number }>) =>
            onBlock(event.data.samples, event.data.rms, event.data.peak);
          tap = worklet;
        } catch {
          tap = null;
        }
      }
      if (!tap) {
        // Navegadores sem AudioWorklet: ScriptProcessor (obsoleto, mas universal).
        const processor = ctx.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = (event) => {
          const channel = event.inputBuffer.getChannelData(0);
          const copy = new Float32Array(channel);
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < copy.length; i += 1) {
            sum += copy[i] * copy[i];
            peak = Math.max(peak, Math.abs(copy[i]));
          }
          onBlock(copy, Math.sqrt(sum / copy.length), peak);
        };
        tap = processor;
      }

      // O nó precisa estar ligado ao destino para ser processado; o ganho 0 mantém o silêncio.
      sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(tap);
      tap.connect(sink);
      sink.connect(ctx.destination);
      s.nodes.push(tap, sink);

      session.current = s;
      setRecording(true);
      return { ok: true, deviceLabel };
    },
    [getStream, level, refreshDevices],
  );

  const stop = useCallback(async (): Promise<CaptureResult> => {
    const s = session.current;
    if (!s) return { ok: false, reason: "error", peak: 0, deviceLabel: "", message: "Nada estava gravando." };
    session.current = null;
    setRecording(false);
    level.set(0);
    teardown(s);

    const total = s.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of s.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const sampleRate = s.ctx.sampleRate;
    const durationMs = (total / sampleRate) * 1000;
    const peak = s.vad.peak;

    if (peak < DEAD_PEAK) {
      return {
        ok: false,
        reason: "silent",
        peak,
        deviceLabel: s.deviceLabel,
        message: `O microfone «${s.deviceLabel}» não captou som nenhum. Escolha outro no menu do microfone ou confira se ele não está mudo.`,
      };
    }

    const soft = !s.vad.heardSpeech;
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
