import { memo, useMemo, useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CalendarDays, ListChecks } from "lucide-react";
import type { TCard } from "@/lib/types";

/** Etiquetas do Trello → tokens do tema (nenhum literal de cor). */
const LABEL_CLASS: Record<string, string> = {
  red: "bg-destructive",
  orange: "bg-primary",
  yellow: "bg-warning",
  green: "bg-success",
  blue: "bg-chart-2",
  sky: "bg-chart-2",
  purple: "bg-chart-3",
  pink: "bg-chart-4",
  lime: "bg-chart-5",
  black: "bg-muted-foreground",
};

export const labelClass = (color: string | null) => LABEL_CLASS[color ?? ""] ?? "bg-muted-foreground";

/** "Para fazer ( hoje)" → "Para fazer (hoje)"; remove emojis. */
export const tidyName = (name: string) =>
  name
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+/g, " ")
    .trim();

export const dueText = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");

export const dueState = (card: TCard): "done" | "overdue" | "soon" | "later" | null => {
  if (!card.due) return null;
  if (card.dueComplete) return "done";
  const ms = new Date(card.due).getTime() - Date.now();
  if (ms < 0) return "overdue";
  return ms < 36 * 3600 * 1000 ? "soon" : "later";
};

const DUE_TONE = {
  done: "text-success",
  overdue: "text-destructive",
  soon: "text-warning",
  later: "text-muted-foreground",
} as const;

export interface OrbitChipProps {
  card: TCard;
  ringIndex: number;
  listName: string;
  width: number;
  compact: boolean;
  focused: boolean;
  selected: boolean;
  register: (id: string, el: HTMLElement | null) => void;
  onSelect: (card: TCard) => void;
  onHover: (ringIndex: number) => void;
}

/**
 * Card em órbita. O elemento externo é posicionado por um loop rAF direto no DOM
 * (sem re-render por frame); o interno só cuida de entrada/saída e estados.
 */
export const OrbitChip = memo(function OrbitChip({
  card,
  ringIndex,
  listName,
  width,
  compact,
  focused,
  selected,
  register,
  onSelect,
  onHover,
}: OrbitChipProps) {
  const reduce = useReducedMotion();
  const items = useMemo(() => card.checklists.flatMap((list) => list.items), [card.checklists]);
  const done = items.filter((item) => item.state === "complete").length;
  const state = dueState(card);
  const barLabel = card.labels[0];

  return (
    <div
      ref={(el) => {
        register(card.id, el);
        return () => register(card.id, null);
      }}
      className="pointer-events-none absolute left-0 top-0 will-change-transform"
      style={{ width, opacity: 0 }}
    >
      <motion.button
        type="button"
        onClick={() => onSelect(card)}
        onPointerEnter={() => onHover(ringIndex)}
        onPointerLeave={() => onHover(-1)}
        onFocus={() => onHover(ringIndex)}
        onBlur={() => onHover(-1)}
        aria-label={`Card ${card.name}, lista ${listName}${card.due ? `, prazo ${dueText(card.due)}` : ""}`}
        aria-pressed={selected}
        data-focused={focused}
        data-selected={selected}
        initial={reduce ? false : { opacity: 0, scale: 0.4, filter: "blur(8px)" }}
        animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
        exit={{ opacity: 0, scale: 0.2, filter: "blur(12px)", transition: { duration: 0.42 } }}
        transition={{ type: "spring", stiffness: 260, damping: 28 }}
        className="orbit-chip pointer-events-auto relative block w-full overflow-hidden rounded-lg text-left"
      >
        {barLabel && <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${labelClass(barLabel.color)}`} />}
        <span className={`block ${compact ? "px-2 py-1" : "px-2.5 py-1.5"} ${barLabel ? "pl-3" : ""}`}>
          <span className={`line-clamp-2 text-pretty font-medium leading-[1.25] text-card-foreground ${compact ? "text-[10.5px]" : "text-[12px]"}`}>
            {card.name}
          </span>
          {(focused || selected) && (
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9.5px] text-muted-foreground">
              <span className="truncate">{tidyName(listName)}</span>
              {card.due && state && (
                <span className={`tnum inline-flex items-center gap-1 ${DUE_TONE[state]}`}>
                  <CalendarDays className="h-2.5 w-2.5" aria-hidden="true" />
                  {dueText(card.due)}
                </span>
              )}
              {items.length > 0 && (
                <span className="tnum inline-flex items-center gap-1">
                  <ListChecks className="h-2.5 w-2.5" aria-hidden="true" />
                  {done}/{items.length}
                </span>
              )}
            </span>
          )}
        </span>
      </motion.button>
    </div>
  );
});

/** Marcador "+N" no fim do anel: abre a lista completa no trilho. */
export const MoreChip = memo(function MoreChip({
  id,
  count,
  listName,
  register,
  onOpen,
}: {
  id: string;
  count: number;
  listName: string;
  register: (id: string, el: HTMLElement | null) => void;
  onOpen: () => void;
}) {
  return (
    <div
      ref={(el) => {
        register(id, el);
        return () => register(id, null);
      }}
      className="pointer-events-none absolute left-0 top-0 will-change-transform"
      style={{ opacity: 0 }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Mais ${count} cards na lista ${listName}. Abrir a lista`}
        className="orbit-chip tnum pointer-events-auto rounded-full px-2.5 py-1 font-mono text-[11px] text-primary"
      >
        +{count}
      </button>
    </div>
  );
});

/** Hook utilitário: mantém um Map de elementos registrados (para o loop rAF). */
export function useElementRegistry() {
  const map = useRef(new Map<string, HTMLElement>());
  const register = useRef((id: string, el: HTMLElement | null) => {
    if (el) map.current.set(id, el);
    else map.current.delete(id);
  });
  return { map, register: register.current };
}
