import { CalendarDays, ExternalLink, ListChecks } from "lucide-react";
import type { Board, TCard } from "@/lib/types";
import { dueState, dueText, labelClass, tidyName } from "./OrbitChip";

const DUE_TONE = { done: "text-success", overdue: "text-destructive", soon: "text-warning", later: "text-muted-foreground" } as const;

interface CardPanelProps {
  card: TCard | null;
  board: Board;
  disabled: boolean;
  onCommand: (text: string) => void;
}

/** Detalhes do card selecionado + atalhos que passam pelo mesmo caminho da voz (JEV). */
export function CardPanel({ card, board, disabled, onCommand }: CardPanelProps) {
  if (!card) {
    return (
      <div className="flex h-full flex-col justify-center gap-2 px-1 py-6 text-center">
        <p className="text-sm font-medium text-foreground">Nenhum card selecionado</p>
        <p className="mx-auto max-w-[30ch] text-pretty text-[13px] leading-relaxed text-muted-foreground">Toque num card da órbita ou da lista ao lado para ver os detalhes.</p>
      </div>
    );
  }

  const list = board.lists.find((entry) => entry.id === card.idList);
  const items = card.checklists.flatMap((entry) => entry.items);
  const done = items.filter((item) => item.state === "complete").length;
  const state = dueState(card);
  const others = board.lists.filter((entry) => !entry.closed && entry.id !== card.idList).slice(0, 4);

  const actions: { label: string; text: string }[] = [
    { label: card.dueComplete ? "Reabrir" : "Concluir", text: card.dueComplete ? `reabre o card ${card.name}` : `marca o card ${card.name} como feito` },
    { label: "Prazo amanhã", text: `coloca prazo amanhã no card ${card.name}` },
    ...others.map((entry) => ({ label: `Mover para ${tidyName(entry.name)}`, text: `move o card ${card.name} para ${entry.name}` })),
    { label: "Arquivar", text: `arquiva o card ${card.name}` },
  ];

  return (
    <article className="space-y-4" aria-label={`Card ${card.name}`}>
      <header>
        <p className="eyebrow mb-1">{list ? tidyName(list.name) : "Card"}</p>
        <h3 className="text-pretty text-[17px] font-semibold leading-snug text-foreground">{card.name}</h3>
      </header>

      {(card.labels.length > 0 || card.due) && (
        <div className="flex flex-wrap items-center gap-2">
          {card.labels.map((label) => (
            <span key={label.id} className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <span aria-hidden="true" className={`h-2 w-2 rounded-full ${labelClass(label.color)}`} />
              {label.name || label.color}
            </span>
          ))}
          {card.due && state && (
            <span className={`tnum inline-flex items-center gap-1.5 text-[12px] ${DUE_TONE[state]}`}>
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              {dueText(card.due)}
              {state === "done" ? " (concluído)" : state === "overdue" ? " (atrasado)" : ""}
            </span>
          )}
        </div>
      )}

      {card.desc && <p className="line-clamp-5 text-pretty text-[13px] leading-relaxed text-muted-foreground">{card.desc}</p>}

      {items.length > 0 && (
        <section>
          <p className="mb-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="tnum">
              {done}/{items.length}
            </span>{" "}
            na checklist
          </p>
          <ul className="space-y-1">
            {items.slice(0, 6).map((item) => (
              <li key={item.id} className={`text-[12.5px] ${item.state === "complete" ? "text-muted-foreground line-through" : "text-foreground/90"}`}>
                {item.name}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4 className="eyebrow mb-2">Atalhos</h4>
        <div className="flex flex-wrap gap-1.5">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={disabled}
              onClick={() => onCommand(action.text)}
              className="rounded-md border border-border bg-secondary/60 px-2.5 py-1.5 text-[12px] text-foreground transition-colors hover:border-primary/50 hover:bg-secondary active:translate-y-px disabled:opacity-40"
            >
              {action.label}
            </button>
          ))}
        </div>
      </section>

      <a href={card.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground underline-offset-4 hover:text-primary hover:underline">
        Abrir no Trello <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>
    </article>
  );
}
