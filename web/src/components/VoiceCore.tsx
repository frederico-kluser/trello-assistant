import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { CornerDownLeft, Loader2, Mic, Send, Square, Volume2 } from "lucide-react";
import type { Phase } from "@/lib/types";

const STATUS_COPY: Record<Phase, string> = {
  idle: "Toque para falar — ou digite abaixo",
  listening: "Ouvindo… toque para parar",
  transcribing: "Transcrevendo sua fala…",
  thinking: "Pensando no que fazer…",
  confirming: "Aguardando sua confirmação",
  executing: "Executando no Trello…",
  speaking: "Respondendo em áudio…",
  error: "Algo deu errado — tente de novo",
};

const EXAMPLES = [
  "cria card comprar café na lista a fazer",
  "move revisar proposta para fazendo",
  "coloca prazo amanhã no card revisar proposta",
];

interface VoiceCoreProps {
  phase: Phase;
  level: MotionValue<number>;
  recording: boolean;
  listeningSupported: boolean;
  onStart: () => void;
  onStop: () => void;
  onSubmitText: (text: string) => void;
  disabled?: boolean;
}

/** O "planeta" central: botão de record com medidor de áudio e entrada de texto. */
export function VoiceCore({
  phase,
  level,
  recording,
  listeningSupported,
  onStart,
  onStop,
  onSubmitText,
  disabled = false,
}: VoiceCoreProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const levelScale = useTransform(level, [0, 1], [1, 1.18]);
  const levelGlow = useTransform(level, [0, 1], [0.35, 0.9]);

  const busy = phase === "transcribing" || phase === "thinking" || phase === "executing" || phase === "speaking";
  const canRecord = listeningSupported && !disabled && (phase === "idle" || phase === "listening" || phase === "error");

  const submitDraft = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    onSubmitText(text);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") setDraft("");
  };

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4">
      <div className="relative flex h-36 w-36 items-center justify-center md:h-44 md:w-44">
        {/* halos */}
        <motion.div
          aria-hidden="true"
          className="absolute inset-0 rounded-full border border-primary/25"
          animate={recording ? { scale: [1, 1.35, 1], opacity: [0.55, 0, 0.55] } : { scale: 1, opacity: 0.25 }}
          transition={recording ? { duration: 2.2, repeat: Infinity, ease: "easeOut" } : { duration: 0.4 }}
        />
        <motion.div
          aria-hidden="true"
          className="absolute inset-4 rounded-full bg-primary/10 blur-xl"
          style={{ opacity: levelGlow }}
        />

        <motion.button
          type="button"
          onClick={recording ? onStop : onStart}
          disabled={!canRecord}
          aria-label={recording ? "Parar gravação" : "Gravar comando de voz"}
          aria-live="polite"
          className={`glow-copper relative flex h-24 w-24 items-center justify-center rounded-full transition-colors md:h-28 md:w-28 ${
            recording ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"
          } ${canRecord ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}
          style={{ scale: recording ? levelScale : 1 }}
          whileTap={canRecord ? { scale: 0.94 } : undefined}
        >
          {phase === "transcribing" || phase === "thinking" || phase === "executing" ? (
            <Loader2 className="h-9 w-9 animate-spin" aria-hidden="true" />
          ) : phase === "speaking" ? (
            <Volume2 className="h-9 w-9" aria-hidden="true" />
          ) : recording ? (
            <Square className="h-8 w-8 fill-current" aria-hidden="true" />
          ) : (
            <Mic className="h-9 w-9" aria-hidden="true" />
          )}
        </motion.button>

        {/* medidor de onda */}
        {recording && (
          <div aria-hidden="true" className="absolute -bottom-1 flex h-6 items-end gap-1">
            {[0, 1, 2, 3, 4, 5, 6].map((index) => (
              <motion.span
                key={index}
                className="w-1 origin-bottom rounded-full bg-primary"
                style={{ height: 18 }}
                animate={{ scaleY: [0.35, 1, 0.35] }}
                transition={{
                  duration: 0.9 + (index % 3) * 0.18,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: index * 0.09,
                }}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-pretty text-center text-sm text-muted-foreground" role="status">
        {STATUS_COPY[phase]}
      </p>

      {/* exemplos clicáveis — descoberta progressiva da gramática de comandos */}
      <ul className="flex flex-wrap items-center justify-center gap-1.5">
        {EXAMPLES.map((example) => (
          <li key={example}>
            <button
              type="button"
              onClick={() => setDraft(example)}
              className="rounded-full border border-border bg-card/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              {example}
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={submitDraft} className="w-full">
        <label className="sr-only" htmlFor="voice-command">
          Digite um comando para o Trello
        </label>
        <div className="glass flex items-center gap-2 rounded-full px-4 py-2">
          <input
            id="voice-command"
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder='Ex.: "cria card comprar café na lista a fazer"'
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            disabled={busy}
          />
          <button
            type="submit"
            disabled={!draft.trim() || busy}
            aria-label="Enviar comando digitado"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground transition-colors hover:bg-accent disabled:opacity-40"
          >
            {draft.trim() ? <Send className="h-4 w-4" aria-hidden="true" /> : <CornerDownLeft className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </form>
    </div>
  );
}