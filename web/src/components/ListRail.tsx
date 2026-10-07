import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import type { Board, TCard } from "@/lib/types";
import { dueState, dueText, tidyName } from "./OrbitChip";

const DUE_TONE = { done: "text-success", overdue: "text-destructive", soon: "text-warning", later: "text-muted-foreground" } as const;

interface ListRailProps {
  board: Board;
  activeListId: string | null;
  selectedId: string | null;
  onSelectList: (listId: string | null) => void;
  onSelectCard: (card: TCard) => void;
}

/** Índice completo do board: tudo o que não cabe nos anéis está aqui. */
export function ListRail({ board, activeListId, selectedId, onSelectList, onSelectCard }: ListRailProps) {
  const lists = useMemo(() => board.lists.filter((list) => !list.closed).sort((a, b) => a.pos - b.pos), [board.lists]);
  const cardsByList = useMemo(() => {
    const map = new Map<string, TCard[]>();
    for (const card of board.cards) {
      if (card.closed) continue;
      const bucket = map.get(card.idList) ?? [];
      bucket.push(card);
      map.set(card.idList, bucket);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.pos - b.pos);
    return map;
  }, [board.cards]);
  const max = Math.max(1, ...lists.map((list) => cardsByList.get(list.id)?.length ?? 0));

  return (
    <nav aria-label="Listas do board" className="flex h-full min-h-0 flex-col">
      <header className="px-4 pb-3 pt-4">
        <h2 className="eyebrow">Listas</h2>
      </header>
      <ul className="scrollbar-quiet min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {lists.map((list) => {
          const cards = cardsByList.get(list.id) ?? [];
          const open = activeListId === list.id;
          return (
            <li key={list.id}>
              <button
                type="button"
                onClick={() => onSelectList(open ? null : list.id)}
                aria-expanded={open}
                className={`group grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${open ? "bg-primary/10" : "hover:bg-accent/60"}`}
              >
                <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-90 text-primary" : ""}`} aria-hidden="true" />
                <span className="min-w-0">
                  <span className={`block truncate text-[13px] ${open ? "font-medium text-foreground" : "text-foreground/90"}`}>{tidyName(list.name)}</span>
                  <span aria-hidden="true" className="mt-1.5 block h-[2px] rounded-full bg-muted">
                    <span className={`block h-full rounded-full ${open ? "bg-primary" : "bg-muted-foreground/45"}`} style={{ width: `${(cards.length / max) * 100}%` }} />
                  </span>
                </span>
                <span className="tnum font-mono text-[11px] text-muted-foreground">{cards.length}</span>
              </button>

              <AnimatePresence initial={false}>
                {open && (
                  <motion.ul
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 34 }}
                    className="overflow-hidden"
                  >
                    {cards.length === 0 && <li className="px-9 py-2 text-[12px] text-muted-foreground">Lista vazia.</li>}
                    {cards.map((card) => {
                      const state = dueState(card);
                      return (
                        <li key={card.id}>
                          <button
                            type="button"
                            onClick={() => onSelectCard(card)}
                            aria-pressed={selectedId === card.id}
                            className={`flex w-full items-baseline gap-2 rounded-md py-1.5 pl-9 pr-2.5 text-left transition-colors hover:bg-accent/50 ${selectedId === card.id ? "bg-accent/70" : ""}`}
                          >
                            <span className="line-clamp-2 min-w-0 flex-1 text-pretty text-[12.5px] leading-snug text-foreground/90">{card.name}</span>
                            {card.due && state && <span className={`tnum shrink-0 font-mono text-[10px] ${DUE_TONE[state]}`}>{dueText(card.due)}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </motion.ul>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
