import { motion, useSpring, useTransform, type MotionValue } from "motion/react";
import { Loader2, Mic, Square, Volume2 } from "lucide-react";
import type { Phase } from "@/lib/types";

const LABEL: Record<Phase, string> = {
  idle: "Falar",
  listening: "Ouvindo",
  transcribing: "Transcrevendo",
  thinking: "Pensando",
  confirming: "Confirmar?",
  executing: "Executando",
  speaking: "Falando",
};

interface PlanetProps {
  phase: Phase;
  level: MotionValue<number>;
  size: number;
  disabled?: boolean;
  onToggle: () => void;
}

/** O planeta é o botão de gravar: respira em repouso e reage ao volume da voz. */
export function Planet({ phase, level, size, disabled = false, onToggle }: PlanetProps) {
  const smooth = useSpring(level, { stiffness: 380, damping: 26, mass: 0.6 });
  const scale = useTransform(smooth, [0, 1], [1, 1.14]);
  const halo = useTransform(smooth, [0, 1], [0.35, 1]);
  const listening = phase === "listening";
  const busy = phase === "transcribing" || phase === "thinking" || phase === "executing";
  const canPress = !disabled && (phase === "idle" || phase === "listening" || phase === "confirming" || phase === "speaking");

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      {/* ondas de voz */}
      {listening &&
        [0, 1, 2].map((i) => (
          <motion.span
            key={i}
            aria-hidden="true"
            className="absolute inset-0 rounded-full border border-primary/40"
            initial={{ scale: 1, opacity: 0.5 }}
            animate={{ scale: [1, 1.9], opacity: [0.5, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut", delay: i * 0.8 }}
          />
        ))}
      <motion.span aria-hidden="true" className="absolute -inset-5 rounded-full bg-primary/15 blur-2xl" style={{ opacity: listening ? halo : 0.35 }} />

      {/* arco giratório enquanto pensa */}
      {busy && (
        <svg aria-hidden="true" className="animate-spin-slow absolute -inset-3" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="48" fill="none" stroke="var(--color-primary)" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="60 242" />
        </svg>
      )}

      <motion.button
        type="button"
        onClick={onToggle}
        disabled={!canPress}
        data-phase={phase}
        data-testid="mic-button"
        aria-label={listening ? "Parar de gravar" : phase === "idle" ? "Gravar comando de voz" : LABEL[phase]}
        className="planet grid place-items-center text-primary-foreground disabled:cursor-default"
        style={{ width: size, height: size, scale: listening ? scale : 1 }}
        whileHover={canPress && !listening ? { scale: 1.04 } : undefined}
        whileTap={canPress ? { scale: 0.96 } : undefined}
        transition={{ type: "spring", stiffness: 400, damping: 28 }}
      >
        {busy ? (
          <Loader2 className="animate-spin-slow" style={{ width: size * 0.3, height: size * 0.3 }} aria-hidden="true" />
        ) : phase === "speaking" ? (
          <Volume2 style={{ width: size * 0.3, height: size * 0.3 }} aria-hidden="true" />
        ) : listening ? (
          <Square className="fill-current" style={{ width: size * 0.26, height: size * 0.26 }} aria-hidden="true" />
        ) : (
          <Mic style={{ width: size * 0.3, height: size * 0.3 }} strokeWidth={1.8} aria-hidden="true" />
        )}
      </motion.button>
    </div>
  );
}
