import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Bot, CheckCircle2, Info, Sparkles, User } from "lucide-react";
import type { Board, FeedItem, Plan, TCard } from "@/lib/types";
import { FocusCard } from "./FocusCard";
import { SetupChecklist } from "./SetupChecklist";
import type { MissingSetup } from "@/lib/types";

interface PlanPanelProps {
  board: Board | null;
  plan: Plan | null;
  feed: FeedItem[];
  selectedCard: TCard | null;
  missing: MissingSetup[];
  guide: string;
  agentLabel: string;
}

const FEED_ICON = {
  you: User,
  plan: Sparkles,
  done: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Painel de voo: transcrição, plano, cards em destaque e histórico. */
export function PlanPanel({ board, plan, feed, selectedCard, missing, guide, agentLabel }: PlanPanelProps) {
  const listName = (card: TCard) => board?.lists.find((list) => list.id === card.idList)?.name;

  return (
    <aside className="glass scrollbar-quiet flex h-full min-h-0 flex-col gap-4 rounded-2xl p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Painel de voo</h2>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 font-mono text-[10px] text-secondary-foreground">
          <Bot className="h-3 w-3" aria-hidden="true" />
          {agentLabel}
        </span>
      </header>

      {missing.length > 0 && <SetupChecklist missing={missing} guide={guide} />}

      {/* plano atual */}
      <AnimatePresence mode="wait">
        {plan && (
          <motion.section
            key={plan.speech}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: "spring", stiffness: 305, damping: 33 }}
            className="rounded-xl border border-border bg-card/60 p-3"
            aria-live="polite"
          >
            <p className="text-pretty text-sm text-foreground">{plan.speech}</p>
            {plan.actions.length > 0 && (
              <ul className="mt-2.5 space-y-1.5">
                {plan.actions.map((action, index) => (
                  <li key={`${action.type}-${index}`} className="flex items-start gap-2 text-xs">
                    <span
                      className={`mt-0.5 rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${
                        action.requiresConfirmation
                          ? "bg-warning/15 text-warning"
                          : "bg-primary/15 text-primary"
                      }`}
                    >
                      {action.requiresConfirmation ? "confirmar" : "direto"}
                    </span>
                    <span className="text-pretty text-muted-foreground">{action.description}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              via {plan.provider === "openrouter" ? plan.model ?? agentLabel : plan.provider === "local" ? "interpretador local" : "fallback local"}
            </p>
          </motion.section>
        )}
      </AnimatePresence>

      {/* card selecionado */}
      <AnimatePresence mode="popLayout">
        {selectedCard && (
          <motion.div
            key={selectedCard.id}
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -6 }}
            transition={{ type: "spring", stiffness: 305, damping: 33 }}
          >
            <FocusCard card={selectedCard} listName={listName(selectedCard)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* histórico */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Histórico</h3>
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {feed.map((item) => {
              const Icon = FEED_ICON[item.kind];
              return (
                <motion.li
                  key={item.id}
                  layout
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ type: "spring", stiffness: 305, damping: 33 }}
                  className="flex items-start gap-2 text-xs"
                >
                  <Icon
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                      item.kind === "error"
                        ? "text-destructive"
                        : item.kind === "done"
                          ? "text-success"
                          : item.kind === "you"
                            ? "text-primary"
                            : "text-muted-foreground"
                    }`}
                    aria-hidden="true"
                  />
                  <p className="flex-1 text-pretty text-muted-foreground">
                    {item.text}
                    <span className="ml-1.5 font-mono text-[9px] tabular-nums text-muted-foreground/60">
                      {timeLabel(item.at)}
                    </span>
                  </p>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      </div>
    </aside>
  );
}