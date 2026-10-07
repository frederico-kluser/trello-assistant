import { ChevronDown, ExternalLink, Wrench } from "lucide-react";
import type { MissingSetup } from "@/lib/types";

interface SetupChecklistProps {
  missing: MissingSetup[];
  guide: string;
}

/** Checklist honesta do que falta configurar (chaves/credenciais). */
export function SetupChecklist({ missing, guide }: SetupChecklistProps) {
  if (missing.length === 0) return null;

  return (
    <details className="group rounded-xl border border-warning/30 bg-warning/5 p-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-warning">
        <Wrench className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-pretty">
          {missing.length === 1 ? "Falta 1 configuração" : `Faltam ${missing.length} configurações`} para o modo completo
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>

      <ul className="mt-3 space-y-2">
        {missing.map((item) => (
          <li key={item.key} className="rounded-lg bg-background/40 px-3 py-2">
            <p className="font-mono text-xs text-primary">{item.key}</p>
            <p className="mt-0.5 text-xs text-foreground">{item.what}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{item.impact}</p>
            <a
              href={item.where}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
            >
              {item.where}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>

      <a
        href={guide}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
      >
        Abrir o guia passo a passo
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>
    </details>
  );
}