import { CalendarDays, ExternalLink, ListChecks } from "lucide-react";
import { BorderBeam } from "@/components/motion-ui/border-beam";
import type { TCard } from "@/lib/types";

interface FocusCardProps {
  card: TCard;
  listName?: string;
}

const dueLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });

/** Card em destaque — o referenciado pela fala ganha holofote e borda animada. */
export function FocusCard({ card, listName }: FocusCardProps) {
  const items = card.checklists.flatMap((list) => list.items);
  const done = items.filter((item) => item.state === "complete").length;

  return (
    <BorderBeam duration={7} size={140} className="rounded-xl">
      <article className="glass rounded-xl p-3">
        <header className="flex items-start justify-between gap-2">
          <h3 className="text-pretty text-sm font-semibold leading-snug text-card-foreground">{card.name}</h3>
          <a
            href={card.url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:text-primary"
            aria-label={`Abrir «${card.name}» no Trello`}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </header>

        {card.desc && <p className="mt-1.5 line-clamp-2 text-pretty text-xs text-muted-foreground">{card.desc}</p>}

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {listName && (
            <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-secondary-foreground">
              {listName}
            </span>
          )}
          {card.due && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] tabular-nums ${
                card.dueComplete ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
              }`}
            >
              <CalendarDays className="h-2.5 w-2.5" aria-hidden="true" />
              {dueLabel(card.due)}
            </span>
          )}
          {items.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
              <ListChecks className="h-2.5 w-2.5" aria-hidden="true" />
              {done}/{items.length}
            </span>
          )}
          {card.labels.map((label) => (
            <span key={label.id} className="rounded-full bg-accent px-2 py-0.5 text-[10px] text-accent-foreground">
              {label.name || label.color || "etiqueta"}
            </span>
          ))}
        </div>
      </article>
    </BorderBeam>
  );
}