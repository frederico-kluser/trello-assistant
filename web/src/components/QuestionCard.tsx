import { motion } from "motion/react";
import { HelpCircle, Mic } from "lucide-react";
import type { PlanQuestion } from "@/lib/types";

interface QuestionCardProps {
  question: PlanQuestion;
  hearing: boolean;
  onPick: (value: string) => void;
  onCancel: () => void;
}

/**
 * Pergunta de desbloqueio docada: a tarefa não se completou e o sistema pergunta
 * COM OPÇÕES (botões) — a resposta também pode ser falada ou digitada. Uma
 * escolha completa o pedido original; nada de modal a bloquear a órbita.
 */
export function QuestionCard({ question, hearing, onPick, onCancel }: QuestionCardProps) {
  return (
    <motion.section
      role="dialog"
      aria-labelledby="question-heading"
      aria-describedby="question-detail"
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      className="hud-solid rounded-2xl p-4"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
          <HelpCircle className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="question-heading" className="text-pretty text-[15px] font-semibold text-foreground">
            {question.prompt}
          </h2>
          {question.options.length > 0 && (
            <ul id="question-detail" className="mt-2.5 flex flex-wrap gap-2" aria-label="Opções de resposta">
              {question.options.map((option) => (
                <li key={option.value}>
                  <button
                    type="button"
                    onClick={() => onPick(option.value)}
                    className="inline-flex min-h-11 items-center rounded-full border border-border/80 bg-secondary/60 px-4 py-2 text-left text-[13px] text-foreground transition-colors hover:border-primary/60 hover:bg-accent/60 active:translate-y-px lg:min-h-0"
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground" aria-live="polite">
          {hearing ? (
            <>
              <span className="inline-flex h-3 items-end gap-[2px]" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <motion.span key={i} className="w-[2px] rounded-full bg-primary" animate={{ height: [4, 12, 4] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12 }} />
                ))}
              </span>
              Ouvindo a sua resposta…
            </>
          ) : (
            <>
              <Mic className="h-3.5 w-3.5" aria-hidden="true" />
              Ou diga a sua resposta
            </>
          )}
        </p>
        <button type="button" onClick={onCancel} className="inline-flex min-h-11 items-center gap-2 rounded-full px-3.5 py-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground active:translate-y-px lg:min-h-0">
          Cancelar <span className="kbd">Esc</span>
        </button>
      </div>
    </motion.section>
  );
}
