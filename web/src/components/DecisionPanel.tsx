import { motion } from "motion/react";
import { AlertTriangle, Check, CircleDashed, Loader2, Minus, X } from "lucide-react";
import type { Band, Decision, JevTrace, PipelineStep, PlanTrace } from "@/lib/types";

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);

const STEP_LABEL: Record<PipelineStep["key"], string> = {
  stt: "Voz para texto",
  jev: "JEV classifica",
  mimo: "MiMo 2.6 Pro (reserva)",
  trello: "Trello executa",
};

const BAND: Record<Band, { label: string; bar: string; chip: string }> = {
  auto: { label: "direto", bar: "bg-success", chip: "text-success" },
  hitl: { label: "confirmar", bar: "bg-warning", chip: "text-warning" },
  abstain: { label: "abstém-se", bar: "bg-destructive", chip: "text-destructive" },
};

function StepMark({ state }: { state: PipelineStep["state"] }) {
  const base = "grid h-5 w-5 shrink-0 place-items-center rounded-full";
  if (state === "active") {
    return (
      <span className={`${base} bg-primary/15 text-primary`}>
        <Loader2 className="h-3 w-3 animate-spin-slow" aria-hidden="true" />
      </span>
    );
  }
  if (state === "done") {
    return (
      <span className={`${base} bg-success/15 text-success`}>
        <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  }
  if (state === "warn") {
    return (
      <span className={`${base} bg-warning/15 text-warning`}>
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className={`${base} bg-destructive/15 text-destructive`}>
        <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  }
  if (state === "skipped") {
    return (
      <span className={`${base} text-muted-foreground/60`}>
        <Minus className="h-3 w-3" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={`${base} text-muted-foreground/50`}>
      <CircleDashed className="h-3 w-3" aria-hidden="true" />
    </span>
  );
}

function DecisionRow({ decision }: { decision: Decision }) {
  const band = BAND[decision.band];
  const used = decision.used !== false;
  return (
    <li className={`grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1 ${used ? "" : "opacity-45"}`}>
      <div className="min-w-0">
        <p className="eyebrow">{decision.label}</p>
        <p className="truncate text-[13px] font-medium text-foreground" title={decision.display}>
          {decision.display}
        </p>
      </div>
      <div className="text-right">
        <p className={`tnum font-mono text-[12px] ${band.chip}`}>{Math.round(decision.confidence * 100)}%</p>
        <p className={`font-mono text-[9.5px] uppercase tracking-wider ${band.chip}`}>{band.label}</p>
      </div>
      <div className="col-span-2 h-[3px] overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <motion.div
          className={`h-full rounded-full ${band.bar}`}
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(2, decision.confidence * 100)}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
      </div>
    </li>
  );
}

interface DecisionPanelProps {
  steps: PipelineStep[];
  models: { stt: string; jev: string | null; mimo: string | null };
  transcript: string | null;
  jev: JevTrace | null;
  trace: PlanTrace | null;
  mimoActive: boolean;
  suggestions: string[];
  onPick: (text: string) => void;
}

/** Pipeline ao vivo + o que o JEV decidiu (e por que cedeu a vez ao MiMo, quando cede). */
export function DecisionPanel({ steps, models, transcript, jev, trace, mimoActive, suggestions, onPick }: DecisionPanelProps) {
  const verdict = jev ?? trace?.jev ?? null;
  const fallback = trace?.fallback ?? (verdict && verdict.status !== "ok" && mimoActive ? { from: "jev", to: "mimo", code: verdict.code ?? undefined, reason: verdict.reason ?? undefined } : null);
  const idle = !transcript && steps.every((step) => step.state === "idle");
  const modelOf: Record<PipelineStep["key"], string | null> = { stt: models.stt, jev: models.jev, mimo: models.mimo, trello: null };

  if (idle) {
    return (
      <div className="flex h-full flex-col gap-6">
        <div>
          <p className="text-[15px] font-semibold text-foreground">Nada decidido ainda</p>
          <p className="mt-1.5 max-w-[34ch] text-pretty text-[13px] leading-relaxed text-muted-foreground">
            Fale um comando. Aqui aparece, pergunta por pergunta, o que o JEV entendeu, com que confiança e quando ele passa a vez ao MiMo.
          </p>
        </div>

        <section aria-label="Como funciona">
          <h3 className="eyebrow mb-2.5">Como cada comando é resolvido</h3>
          <ol className="space-y-3 text-[13px] leading-snug text-muted-foreground">
            <li className="flex gap-3">
              <span className="tnum font-mono text-[11px] text-primary">1</span>
              <span>
                <span className="text-foreground">Voz vira texto</span> (OpenAI), com os nomes das suas listas e cards como dica.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="tnum font-mono text-[11px] text-primary">2</span>
              <span>
                <span className="text-foreground">O JEV decide</span> a intenção, o card e a lista em uma chamada, em cerca de meio segundo.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="tnum font-mono text-[11px] text-primary">3</span>
              <span>
                <span className="text-foreground">O MiMo 2.6 Pro só entra</span> quando o JEV diz que não consegue operar com segurança.
              </span>
            </li>
          </ol>
        </section>

        {suggestions.length > 0 && (
          <section aria-label="Experimente dizer">
            <h3 className="eyebrow mb-2.5">Experimente dizer</h3>
            <ul className="space-y-1.5">
              {suggestions.map((text) => (
                <li key={text}>
                  <button type="button" onClick={() => onPick(text)} className="w-full rounded-lg border border-border/80 bg-card/40 px-3 py-2 text-left text-[13px] text-foreground/90 transition-colors hover:border-primary/50 hover:bg-card/70 active:translate-y-px">
                    {text}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* pipeline */}
      <section aria-label="Etapas do comando">
        <h3 className="eyebrow mb-2.5">Pipeline</h3>
        <ol className="space-y-2">
          {steps.map((step) => (
            <li key={step.key} className={`flex items-center gap-2.5 ${step.state === "skipped" || step.state === "idle" ? "opacity-55" : ""}`}>
              <StepMark state={step.state} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-foreground">{STEP_LABEL[step.key]}</p>
                {(step.note || modelOf[step.key]) && (
                  <p className="truncate font-mono text-[10px] text-muted-foreground">{step.note ?? modelOf[step.key]}</p>
                )}
              </div>
              {step.ms !== undefined && <span className="tnum font-mono text-[12px] text-muted-foreground">{fmtMs(step.ms)}</span>}
            </li>
          ))}
        </ol>
        {trace && (
          <p className="mt-3 flex items-baseline justify-between border-t border-border/70 pt-2.5 text-[12px] text-muted-foreground">
            <span>Do texto ao plano</span>
            <span className="tnum font-mono text-foreground">{fmtMs(trace.totalMs)}</span>
          </p>
        )}
      </section>

      {transcript && (
        <section aria-label="O que você disse">
          <h3 className="eyebrow mb-1.5">Você disse</h3>
          <p className="text-pretty text-[14px] leading-snug text-foreground">“{transcript}”</p>
        </section>
      )}

      {/* a voz do JEV quando não consegue operar */}
      {verdict && verdict.status !== "ok" && (
        <section className="rounded-lg border border-warning/30 bg-warning/[0.06] p-3" aria-live="polite">
          <h3 className="eyebrow mb-1 text-warning">JEV</h3>
          <p className="text-pretty text-[13px] leading-snug text-foreground">
            {verdict.status === "unavailable" ? "Não estou disponível agora" : "Não consigo operar com segurança"}
            {verdict.reason ? `: ${verdict.reason.replace(/^(não consigo operar( sozinho)?:\s*|o jev está indisponível:\s*)/i, "")}.` : "."}
          </p>
          {fallback && (
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              {fallback.to === "mimo" ? "O MiMo 2.6 Pro assumiu, com raciocínio máximo." : "Usei o interpretador local."}
            </p>
          )}
        </section>
      )}

      {/* decisões por pergunta */}
      {verdict && verdict.clauses.length > 0 && (
        <section aria-label="Decisões do JEV">
          <div className="mb-2.5 flex items-baseline justify-between">
            <h3 className="eyebrow">Decisões do JEV</h3>
            {verdict.latencyMs !== undefined && (
              <span className="tnum font-mono text-[10px] text-muted-foreground">
                {fmtMs(verdict.latencyMs)}
                {verdict.reusedSocket ? " · socket quente" : ""}
              </span>
            )}
          </div>
          <div className="space-y-4">
            {verdict.clauses.map((clause, index) => (
              <div key={`${clause.text}-${index}`}>
                {verdict.clauses.length > 1 && (
                  <p className="mb-2 truncate font-mono text-[10.5px] text-muted-foreground">
                    {index + 1}. “{clause.text}”
                  </p>
                )}
                <ul className="space-y-3">
                  {clause.decisions.map((decision) => (
                    <DecisionRow key={decision.id} decision={decision} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {verdict.usage && (
            <p className="tnum mt-3 font-mono text-[10px] text-muted-foreground">
              {verdict.usage.input_tokens} tokens de entrada · ${verdict.usage.cost.toFixed(5)}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
