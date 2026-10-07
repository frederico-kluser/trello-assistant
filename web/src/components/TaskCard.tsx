import { motion, useReducedMotion } from "motion/react";
import { CalendarDays, ListChecks } from "lucide-react";
import type { TCard } from "@/lib/types";

/** Etiquetas do Trello → tokens semânticos do tema (nenhum literal de cor). */
const LABEL_CLASS: Record<string, string> = {
  red: "bg-destructive",
  orange: "bg-warning",
  yellow: "bg-warning",
  green: "bg-success",
  blue: "bg-chart-2",
  sky: "bg-chart-2",
  purple: "bg-chart-3",
  pink: "bg-chart-4",
  lime: "bg-chart-5",
  black: "bg-muted-foreground",
};

const labelClass = (color: string | null) => LABEL_CLASS[color ?? ""] ?? "bg-muted-foreground";

const dueLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });

const isOverdue = (iso: string, complete: boolean) => !complete && new Date(iso).getTime() < Date.now();

export interface TaskCardProps {
  card: TCard;
  focused?: boolean;
  dimmed?: boolean;
  floatDelay?: number;
  onSelect?: (card: TCard) => void;
}

/** Chip de card que flutua dentro da órbita. */
export function TaskCard({ card, focused = false, dimmed = false, floatDelay = 0, onSelect }: TaskCardProps) {
  const reduce = useReducedMotion();
  const checklistItems = card.checklists.flatMap((list) => list.items);
  const doneItems = checklistItems.filter((item) => item.state === "complete").length;

  return (
    <motion.button
      type="button"
      onClick={() => onSelect?.(card)}
      aria-label={`Abrir card ${card.name}${card.due ? `, prazo ${dueLabel(card.due)}` : ""}`}
      initial={{ opacity: 0, scale: 0.72, filter: "blur(6px)" }}
      animate={{
        opacity: dimmed && !focused ? 0.4 : 1,
        scale: focused ? 1.06 : 1,
        filter: focused ? "blur(0px) brightness(1.12)" : "blur(0px)",
      }}
      exit={{ opacity: 0, scale: 0.5, filter: "blur(10px)" }}
      transition={{ type: "spring", stiffness: 305, damping: 33 }}
      className="glass group pointer-events-auto w-40 cursor-pointer rounded-xl p-2.5 text-left md:w-44"
    >
      <motion.div
        animate={reduce ? undefined : { y: [0, -5, 0] }}
        transition={{ duration: 6 + (floatDelay % 4), repeat: Infinity, ease: "easeInOut", delay: floatDelay }}
      >
        <p className="line-clamp-2 text-pretty text-[13px] font-medium leading-snug text-card-foreground">
          {card.name}
        </p>

        {(card.labels.length > 0 || card.due || checklistItems.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {card.labels.slice(0, 3).map((label) => (
              <span
                key={label.id}
                role="img"
                aria-label={`etiqueta ${label.name || label.color || ""}`}
                title={label.name || label.color || "etiqueta"}
                className={`h-1.5 w-5 rounded-full ${labelClass(label.color)}`}
              />
            ))}

            {card.due && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                  isOverdue(card.due, card.dueComplete)
                    ? "bg-destructive/15 text-destructive"
                    : card.dueComplete
                      ? "bg-success/15 text-success"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                <CalendarDays className="h-2.5 w-2.5" aria-hidden="true" />
                {dueLabel(card.due)}
              </span>
            )}

            {checklistItems.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                <ListChecks className="h-2.5 w-2.5" aria-hidden="true" />
                {doneItems}/{checklistItems.length}
              </span>
            )}
          </div>
        )}
      </motion.div>

      {focused && (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-primary/70"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        />
      )}
    </motion.button>
  );
}