import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useTransform } from "motion/react";
import { Check, Mic, Play, Square, TriangleAlert } from "lucide-react";
import type { VoiceCapture } from "@/hooks/useVoiceCapture";

type TestState = "idle" | "starting" | "live" | "error";

/** Medidor de teste: abre o microfone escolhido e mostra o nível, sem gravar nada. */
function useMicTest(active: boolean, deviceId: string, raw: boolean) {
  const level = useMotionValue(0);
  const [state, setState] = useState<TestState>("idle");
  const [label, setLabel] = useState("");
  const [dead, setDead] = useState(false);

  useEffect(() => {
    if (!active) {
      setState("idle");
      setDead(false);
      level.set(0);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    setState("starting");
    setDead(false);

    (async () => {
      try {
        const base: MediaTrackConstraints = { channelCount: 1, echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw };
        stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base });
        if (cancelled) return;
        setLabel(stream.getAudioTracks()[0]?.label ?? "");
        ctx = new AudioContext();
        await ctx.resume().catch(() => undefined);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);
        const startedAt = performance.now();
        let peak = 0;
        setState("live");
        const loop = () => {
          analyser.getFloatTimeDomainData(buffer);
          let max = 0;
          for (const sample of buffer) max = Math.max(max, Math.abs(sample));
          peak = Math.max(peak, max);
          level.set(Math.min(1, max * 2.6));
          if (performance.now() - startedAt > 1800) setDead(peak < 0.012);
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch {
        if (!cancelled) setState("error");
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      void ctx?.close().catch(() => undefined);
      level.set(0);
    };
  }, [active, deviceId, raw, level]);

  return { level, state, label, dead };
}

interface MicMenuProps {
  open: boolean;
  capture: VoiceCapture;
  onClose: () => void;
}

export function MicMenu({ open, capture, onClose }: MicMenuProps) {
  const [testing, setTesting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const test = useMicTest(open && testing, capture.deviceId, capture.raw);
  const width = useTransform(test.level, (value) => `${Math.round(value * 100)}%`);

  useEffect(() => {
    if (!open) {
      setTesting(false);
      return;
    }
    void capture.refreshDevices();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node) && !(event.target as HTMLElement).closest("[data-mic-trigger]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, onClose, capture]);

  const options = [{ id: "", label: "Padrão do sistema" }, ...capture.devices.filter((device) => device.id && device.id !== "default")];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          role="dialog"
          aria-label="Configurar microfone"
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          className="hud-solid absolute right-0 top-full z-[80] mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl p-4"
        >
          <h2 className="mb-3 text-sm font-semibold text-foreground">Microfone</h2>

          <fieldset className="space-y-0.5">
            <legend className="sr-only">Dispositivo de entrada</legend>
            {options.map((device) => {
              const selected = capture.deviceId === device.id;
              return (
                <label
                  key={device.id || "default"}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${selected ? "bg-primary/10 text-foreground" : "text-foreground/80 hover:bg-accent/60"}`}
                >
                  <input type="radio" name="mic-device" className="sr-only" checked={selected} onChange={() => capture.setDeviceId(device.id)} />
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-input"}`} aria-hidden="true">
                    {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 truncate">{device.label}</span>
                </label>
              );
            })}
          </fieldset>

          <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-accent/40">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]" checked={capture.raw} onChange={(event) => capture.setRaw(event.target.checked)} />
            <span>
              <span className="block text-[13px] text-foreground">Áudio bruto</span>
              <span className="block text-pretty text-[12px] leading-snug text-muted-foreground">Desliga cancelamento de eco, ruído e ganho automático. Ative se o microfone sai mudo ou baixo.</span>
            </span>
          </label>

          <div className="mt-3 border-t border-border/70 pt-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] text-foreground">Teste de nível</p>
              <button
                type="button"
                onClick={() => setTesting((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2.5 py-1 text-[12px] transition-colors hover:border-primary/50 active:translate-y-px"
              >
                {testing ? <Square className="h-3 w-3 fill-current" aria-hidden="true" /> : <Play className="h-3 w-3 fill-current" aria-hidden="true" />}
                {testing ? "Parar" : "Testar"}
              </button>
            </div>
            <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={100}>
              <motion.div className={`h-full rounded-full ${test.dead ? "bg-destructive" : "bg-primary"}`} style={{ width }} />
            </div>
            <p className="mt-2 min-h-[2.4em] text-pretty text-[12px] leading-snug text-muted-foreground" aria-live="polite">
              {!testing && "Fale algo durante o teste: a barra tem que mexer."}
              {testing && test.state === "starting" && "Abrindo o microfone…"}
              {testing && test.state === "error" && "Não consegui abrir este microfone."}
              {testing && test.state === "live" && !test.dead && `Captando em «${test.label || "microfone padrão"}».`}
              {testing && test.dead && (
                <span className="inline-flex items-start gap-1.5 text-destructive">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Sem sinal em «{test.label}». Escolha outro dispositivo ou ative o áudio bruto.
                </span>
              )}
            </p>
          </div>

          {capture.permission === "denied" && (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-destructive/10 p-2.5 text-[12px] leading-snug text-destructive">
              <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              O navegador bloqueou o microfone neste site. Clique no cadeado ao lado do endereço e libere.
            </p>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
