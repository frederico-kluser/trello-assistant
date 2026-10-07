import { useCallback, useEffect, useRef, useState } from "react";
import { useMotionValue, type MotionValue } from "motion/react";

export interface RecorderState {
  supported: boolean;
  recording: boolean;
  level: MotionValue<number>;
  error: string | null;
  start: () => Promise<boolean>;
  stop: () => Promise<Blob | null>;
}

const pickMimeType = (): string => {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
};

/** Gravador do microfone com medidor de nível (para animar o botão). */
export function useRecorder(): RecorderState {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const level = useMotionValue(0);

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const rafId = useRef<number | null>(null);
  const chunks = useRef<BlobPart[]>([]);

  const teardown = useCallback(() => {
    if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    rafId.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void audioContext.current?.close().catch(() => undefined);
    audioContext.current = null;
    analyser.current = null;
    level.set(0);
  }, [level]);

  useEffect(() => teardown, [teardown]);

  const meterLoop = useCallback(() => {
    const node = analyser.current;
    if (!node) return;
    const buffer = new Uint8Array(node.frequencyBinCount);
    node.getByteTimeDomainData(buffer);

    let peak = 0;
    for (const sample of buffer) {
      peak = Math.max(peak, Math.abs(sample - 128) / 128);
    }
    // suaviza o medidor para não "vibrar"
    level.set(Math.min(1, peak * 1.6));
    rafId.current = requestAnimationFrame(meterLoop);
  }, [level]);

  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Este navegador não permite gravar áudio.");
      return false;
    }

    try {
      const streamLocal = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      stream.current = streamLocal;

      const context = new AudioContext();
      audioContext.current = context;
      const source = context.createMediaStreamSource(streamLocal);
      const analyserNode = context.createAnalyser();
      analyserNode.fftSize = 1024;
      source.connect(analyserNode);
      analyser.current = analyserNode;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(streamLocal, mimeType ? { mimeType } : undefined);
      mediaRecorder.current = recorder;
      chunks.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      recorder.start();
      setRecording(true);
      meterLoop();
      return true;
    } catch (err) {
      teardown();
      setError(
        (err as Error)?.name === "NotAllowedError"
          ? "Permissão de microfone negada. Libere o acesso no navegador."
          : "Não consegui abrir o microfone.",
      );
      return false;
    }
  }, [level, meterLoop, teardown]);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const recorder = mediaRecorder.current;
    if (!recorder) {
      teardown();
      return null;
    }

    const blob = await new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        resolve(chunks.current.length ? new Blob(chunks.current, { type: recorder.mimeType || "audio/webm" }) : null);
      };
      recorder.stop();
    });

    mediaRecorder.current = null;
    setRecording(false);
    teardown();
    return blob;
  }, [teardown]);

  return {
    supported: typeof window !== "undefined" && typeof MediaRecorder !== "undefined",
    recording,
    level,
    error,
    start,
    stop,
  };
}