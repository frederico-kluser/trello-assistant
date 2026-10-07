import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Pencil, TriangleAlert } from "lucide-react";
import type { Phase, Plan } from "@/lib/types";
import { ConfirmCard } from "./ConfirmCard";

export type Caption =
  | { kind: "hint" }
  | { kind: "listening"; text: string }
  | { kind: "working"; title: string }
  | { kind: "heard"; transcript: string; status?: string; tone?: "neutral" | "warn" }
  | { kind: "error"; message: string; hint?: string; action?: { label: string; run: () => void } };

interface CommandDockProps {
  phase: Phase;
  caption: Caption;
  plan: Plan | null;
  hearing: boolean;
  disabled: boolean;
  examples: string[];
  draft: string;
  onDraft: (text: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function CaptionView({ caption, onEdit }: { caption: Caption; onEdit: (text: string) => void }) {
  if (caption.kind === "hint") {
    return (
      <p className="text-center text-[17px] font-medium leading-snug text-foreground/90 sm:text-xl">
        Toque no planeta e diga o que fazer
        <span className="mt-1.5 block text-[13px] font-normal text-muted-foreground">
          ou aperte <span className="kbd">Espaço</span>. Eu paro de ouvir sozinho quando você termina.
        </span>
      </p>
    );
  }
  if (caption.kind === "listening") {
    return (
      <p className="min-h-[2.6rem] text-center text-xl font-medium leading-snug text-foreground sm:text-2xl" aria-live="polite">
        {caption.text ? (
          <>
            {caption.text}
            <span className="animate-blink ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-primary" aria-hidden="true" />
          </>
        ) : (
          <span className="text-muted-foreground">Ouvindo… fale agora</span>
        )}
      </p>
    );
  }
  if (caption.kind === "working") {
    return (
      <div className="flex flex-col items-center gap-2" aria-live="polite">
        <p className="text-lg font-medium text-foreground/90">{caption.title}</p>
        <span className="shimmer-bar h-1 w-40 rounded-full bg-muted" aria-hidden="true" />
      </div>
    );
  }
  if (caption.kind === "heard") {
    return (
      <div className="flex flex-col items-center gap-1.5" aria-live="polite">
        <p className="group text-pretty text-center text-xl font-medium leading-snug text-foreground sm:text-2xl">
          “{caption.transcript}”
          <button type="button" onClick={() => onEdit(caption.transcript)} aria-label="Editar o texto e reenviar" className="ml-2 inline-grid h-6 w-6 translate-y-[-1px] place-items-center rounded-md align-middle text-muted-foreground opacity-60 transition hover:bg-accent/60 hover:text-foreground hover:opacity-100">
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </p>
        {caption.status && <p className={`text-pretty text-center text-[13px] ${caption.tone === "warn" ? "text-warning" : "text-muted-foreground"}`}>{caption.status}</p>}
      </div>
    );
  }
  return (
    <div role="alert" className="flex flex-col items-center gap-1.5 text-center">
      <p className="flex items-start gap-2 text-pretty text-[15px] font-medium text-destructive">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {caption.message}
      </p>
      {caption.hint && <p className="max-w-[48ch] text-pretty text-[13px] text-muted-foreground">{caption.hint}</p>}
      {caption.action && (
        <button type="button" onClick={caption.action.run} className="mt-1 rounded-md border border-border bg-secondary/60 px-3 py-1.5 text-[12.5px] text-foreground transition-colors hover:border-primary/50 active:translate-y-px">
          {caption.action.label}
        </button>
      )}
    </div>
  );
}

/** Dock inferior: legenda ao vivo, confirmação inline e entrada de texto. */
export function CommandDock({ phase, caption, plan, hearing, disabled, examples, draft, onDraft, inputRef, onSubmit, onConfirm, onCancel }: CommandDockProps) {
  const setDraft = onDraft;
  const [editing, setEditing] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const busy = phase === "transcribing" || phase === "thinking" || phase === "executing";

  useEffect(() => {
    if (editing !== null) editRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (caption.kind !== "heard") setEditing(null);
  }, [caption.kind]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || disabled) return;
    onSubmit(text);
    onDraft("");
  };

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    const text = (editing ?? "").trim();
    setEditing(null);
    if (text) onSubmit(text);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-3 md:pb-5">
      <div className="pointer-events-auto flex w-full max-w-[46rem] flex-col gap-3">
        <AnimatePresence mode="wait" initial={false}>
          {plan && phase === "confirming" ? (
            <ConfirmCard key="confirm" plan={plan} hearing={hearing} onConfirm={onConfirm} onCancel={onCancel} />
          ) : (
            <motion.div key={caption.kind} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
              {editing !== null ? (
                <form onSubmit={submitEdit} className="mx-auto flex max-w-[40rem] items-center gap-2">
                  <input
                    ref={editRef}
                    value={editing}
                    onChange={(event) => setEditing(event.target.value)}
                    onKeyDown={(event) => event.key === "Escape" && setEditing(null)}
                    aria-label="Corrigir o que foi entendido"
                    className="min-w-0 flex-1 rounded-lg border border-primary/60 bg-card/80 px-3 py-2 text-lg text-foreground focus:outline-none"
                  />
                  <button type="submit" className="rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground active:translate-y-px">
                    Reenviar
                  </button>
                </form>
              ) : (
                <CaptionView caption={caption} onEdit={setEditing} />
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <form onSubmit={submit} className="hud mx-auto flex w-full items-center gap-2 rounded-full py-1.5 pl-4 pr-1.5">
          <label htmlFor="command-input" className="sr-only">
            Digite um comando para o Trello
          </label>
          <input
            id="command-input"
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Ou digite: ${examples[0] ?? "cria um card chamado revisar proposta"}`}
            autoComplete="off"
            disabled={busy || disabled}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground/80 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!draft.trim() || busy || disabled}
            aria-label="Enviar comando"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition active:translate-y-px disabled:bg-secondary disabled:text-muted-foreground"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.4} aria-hidden="true" />
          </button>
        </form>

        {phase === "idle" && caption.kind === "hint" && examples.length > 0 && (
          <ul className="hidden flex-wrap items-center justify-center gap-1.5 sm:flex xl:hidden" aria-label="Exemplos de comandos">
            {examples.map((example) => (
              <li key={example}>
                <button type="button" onClick={() => setDraft(example)} className="rounded-full border border-border/80 bg-card/40 px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground active:translate-y-px">
                  {example}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
