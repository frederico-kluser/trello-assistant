import { motion } from "motion/react";
import type { ReactNode } from "react";
import { AlertTriangle, Check, CircleDashed, Loader2, Minus, Search, X } from "lucide-react";
import type { Band, Decision, JevTrace, ListingItem, LlmTrace, PipelineStep, Plan, PlanSearch } from "@/lib/types";
import { llmActionCount, llmFailureNote, llmLabel } from "@/lib/plan";
import { matchedFieldLabels, searchCount, searchSummary, searchTitle, turnLabel } from "@/lib/session";

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);

const STEP_LABEL: Record<PipelineStep["key"], string> = {
  stt: "Voz para texto",
  jev: "JEV classifica",
  trello: "Trello executa",
};

const BAND: Record<Band, { label: string; bar: string; chip: string }> = {
  auto: { label: "direto", bar: "bg-success", chip: "text-success" },
  hitl: { label: "confirmar", bar: "bg-warning", chip: "text-warning" },
  abstain: { label: "abstém-se", bar: "bg-destructive", chip: "text-destructive" },
};

const MAX_LISTED_NAMES = 12;

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

/** Contagens da cascata de listagem — nunca as 40+ decisões de card, só o resumo. */
function ListingBlock({ jev, plan }: { jev: JevTrace; plan: Plan | null }) {
  const listing = jev.listing;
  if (!listing) return null;
  const cards = plan?.listing ?? [];
  // Numa busca por característica os cards são renderizados pelo `SearchBlock`,
  // com os campos que casaram — aqui ficam só as contagens da cascata.
  const searchActive = Boolean(plan?.search);
  const columns = listing.kept.length + listing.pruned.length;
  const batches = `${listing.batches} ${listing.batches === 1 ? "lote" : "lotes"}`;

  return (
    <section aria-label="Listagem em cascata">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h3 className="eyebrow">Listagem</h3>
        <span className="tnum font-mono text-[10px] text-muted-foreground">{batches}</span>
      </div>

      {(listing.columns.length > 0 || columns > 0) && (
        <>
          <p className="mb-2 flex items-baseline justify-between font-mono text-[10.5px] text-muted-foreground">
            <span>Portão de colunas</span>
            {columns > 0 && (
              <span className="tnum">
                {listing.kept.length} de {columns}
              </span>
            )}
          </p>
          <ul className="space-y-3">
            {listing.columns.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} />
            ))}
          </ul>
        </>
      )}

      <p className="mt-3 text-pretty text-[12px] leading-snug text-muted-foreground">
        <span className="tnum font-mono text-foreground">{listing.listed}</span> de <span className="tnum font-mono">{listing.evaluated}</span> cards listados em {batches}
        {listing.maybe > 0 ? (
          <>
            {" · "}
            <span className="tnum font-mono text-warning">{listing.maybe}</span> com ressalva
          </>
        ) : null}
        .
      </p>

      {listing.fallbackColumns && <p className="mt-1 text-[12px] text-muted-foreground">Portão de colunas aprovou tudo — filtro fino por card.</p>}

      {cards.length > 0 && !searchActive && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {cards.slice(0, MAX_LISTED_NAMES).map((card) => (
            <li key={card.id} title={card.list} className="inline-flex items-baseline gap-1.5 rounded-md border border-border/70 bg-card/40 px-2 py-0.5 text-[12px] text-foreground/90">
              <span className="max-w-[16ch] truncate">{card.name}</span>
              {card.maybe && <span className="font-mono text-[9.5px] uppercase tracking-wider text-warning">talvez</span>}
            </li>
          ))}
          {cards.length > MAX_LISTED_NAMES && <li className="px-1 py-0.5 text-[12px] text-muted-foreground">e mais {cards.length - MAX_LISTED_NAMES}</li>}
        </ul>
      )}
    </section>
  );
}

/** Chip discreto no vocabulário dos chips da órbita: borda, fundo do card, dado em mono. */
function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/50 px-2 py-0.5 text-[10.5px] text-muted-foreground">
      {children}
    </span>
  );
}

/** Sessão desta aba: quantos turnos e, depois de uma busca, quantas atividades ela achou. */
function SessionChips({ turns, search, items }: { turns: number; search: PlanSearch | null; items: ListingItem[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Sessão">
      <Chip title="A conversa vive só nesta aba: recarregar a página começa uma sessão nova.">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">sessão</span>
        <span className="tnum">{turnLabel(turns)}</span>
      </Chip>
      {search && <Chip title="Resultados da última busca por característica.">{searchSummary(search, items)}</Chip>}
    </div>
  );
}

/**
 * Resultados de uma busca por característica, no mesmo bloco de listagem do
 * painel. Todos os campos novos são opcionais: sem `matchedFields`, `descSnippet`
 * ou `listName` o item ainda aparece — só com o nome.
 */
function SearchBlock({ search, items }: { search: PlanSearch; items: ListingItem[] }) {
  const total = searchCount(search, items);

  return (
    <section aria-label="Resultados da busca">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="eyebrow">Resultados da busca</h3>
        <span className="tnum shrink-0 font-mono text-[10px] text-muted-foreground">{total}</span>
      </div>

      <p className="mb-2.5 flex items-center gap-1.5 text-pretty text-[12.5px] text-muted-foreground">
        <Search className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
        {searchTitle(search, items)}
      </p>

      {items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {total > 0 ? "A busca achou resultados, mas os detalhes não vieram neste evento." : "Não achei nenhuma atividade com essa característica."}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, index) => {
            const chips = matchedFieldLabels(item.matchedFields);
            const listName = item.listName ?? item.list;
            return (
              <li
                key={item.id || `${item.name}-${index}`}
                title={typeof item.score === "number" ? `Relevância ${item.score.toFixed(2)}` : undefined}
                className="rounded-lg border border-border/80 bg-card/40 px-3 py-2"
              >
                <p className="text-pretty text-[13px] font-medium leading-snug text-foreground">{item.name}</p>
                {item.descSnippet && <p className="mt-1 line-clamp-2 text-pretty text-[12px] leading-snug text-muted-foreground">{item.descSnippet}</p>}
                {(listName || item.maybe || chips.length > 0) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {listName && <Chip title="Lista do card">{listName}</Chip>}
                    {item.maybe && <Chip title="Casaram com ressalva">talvez</Chip>}
                    {chips.map((chip) => (
                      <Chip key={chip} title="Onde a busca casou">
                        {chip}
                      </Chip>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface DecisionPanelProps {
  steps: PipelineStep[];
  models: { stt: string; jev: string | null; llm?: string | null };
  transcript: string | null;
  jev: JevTrace | null;
  plan: Plan | null;
  /** Turnos concluídos nesta sessão (histórico em memória: morre no F5). */
  sessionTurns?: number;
  suggestions: string[];
  onPick: (text: string) => void;
}

/**
 * System Two (a melhor voz disponível): quando a fala tem várias ações, é ele que
 * planeia o comando inteiro. Com `status: "failed"` o JEV pode ter assumido —
 * as decisões dele aparecem logo abaixo, e o bloco diz isso.
 */
function LlmBlock({ llm, plan, jevTookOver }: { llm: LlmTrace; plan: Plan | null; jevTookOver: boolean }) {
  const failed = llm.status === "failed";
  const count = llmActionCount(plan);
  const model = llmLabel(llm.model ?? plan?.model);

  return (
    <section aria-label="Comandos simultâneos">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="eyebrow">Comandos simultâneos</h3>
        {!failed && llm.latencyMs !== undefined && <span className="tnum font-mono text-[10px] text-muted-foreground">{fmtMs(llm.latencyMs)}</span>}
      </div>

      <p className="text-pretty text-[13px] leading-snug text-foreground">
        <span className="font-semibold">{model}</span>{" "}
        {failed ? (
          <>não conseguiu planear o comando: {llmFailureNote(llm)}</>
        ) : (
          <>
            planejou <span className="tnum font-mono">{count}</span> {count === 1 ? "ação" : "ações"}
            {llm.latencyMs !== undefined && (
              <>
                {" · "}
                <span className="tnum font-mono">{fmtMs(llm.latencyMs)}</span>
              </>
            )}
            .
          </>
        )}
      </p>

      <p className="mt-1.5 text-pretty text-[12px] leading-snug text-muted-foreground">
        {failed
          ? jevTookOver
            ? "O JEV assumiu o comando — as decisões dele estão abaixo."
            : "Sem plano para este comando: reformule o pedido."
          : "System Two: uma fala com várias ações — o comando inteiro é planeado de uma vez."}
      </p>
    </section>
  );
}

/** Pipeline ao vivo + quem planeou (JEV ou System Two) e, nas listagens, como filtrou colunas e cards. */
export function DecisionPanel({ steps, models, transcript, jev, plan, sessionTurns = 0, suggestions, onPick }: DecisionPanelProps) {
  const trace = plan?.trace ?? null;
  // Comando composto: o JEV nem é consultado, então `trace.jev` vem null.
  const verdict = jev ?? trace?.jev ?? null;
  const llm = trace?.llm ?? null;
  // Busca por característica do último comando (o evento pode não trazer nada disto).
  const search = plan?.search ?? null;
  const items = plan?.listing ?? [];
  // Voz que respondeu: só quando o LLM participou — num plano "jev" o `plan.model`
  // é o modelo do classificador, que não é voz nenhuma.
  const voiceLabel = llm || plan?.provider === "llm" ? llmLabel(llm?.model ?? plan?.model) : null;
  const idle = !transcript && steps.every((step) => step.state === "idle");
  const modelOf: Record<PipelineStep["key"], string | null> = {
    stt: models.stt,
    jev: llm?.status === "ok" ? (llm.model ?? models.llm ?? null) : models.jev,
    trello: null,
  };
  const stepLabel = (key: PipelineStep["key"]) => (key === "jev" && llm?.status === "ok" ? "System Two planeja" : STEP_LABEL[key]);

  // Sem fallback genérico: o banner nasce do `warning` do plano (abstenção/indisponibilidade do JEV).
  const warning = plan?.warning?.trim() ?? "";
  const jevDown = Boolean(verdict && verdict.status !== "ok");
  const showAlert = Boolean(warning) || jevDown;
  const alertMessage = warning
    ? warning
    : verdict
      ? `${verdict.status === "unavailable" ? "Não estou disponível agora" : "Não consigo operar com segurança"}${
          verdict.reason ? `: ${verdict.reason.replace(/^(não consigo operar( sozinho)?:\s*|o jev está indisponível:\s*)/i, "")}.` : "."
        }`
      : "";
  const alertNote = plan
    ? plan.actions.length === 0
      ? "Nada foi executado: reformule o pedido e eu decido outra vez."
      : plan.provider === "local"
        ? "Sem chave do OpenRouter: usei o interpretador local pt-BR."
        : null
    : null;

  if (idle) {
    return (
      <div className="flex h-full flex-col gap-6">
        <div>
          <p className="text-[15px] font-semibold text-foreground">Nada decidido ainda</p>
          <p className="mt-1.5 max-w-[34ch] text-pretty text-[13px] leading-relaxed text-muted-foreground">
            Fale um comando. Aqui aparece, pergunta por pergunta, o que o JEV entendeu, com que confiança — e, nas listagens, como cortou colunas e cards.
            Num comando com várias ações, aparece o que o System Two planeou.
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
                <span className="text-foreground">O JEV decide</span> a intenção (criar, editar, mover, apagar ou listar), o card e a lista numa chamada, em cerca de meio segundo.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="tnum font-mono text-[11px] text-primary">3</span>
              <span>
                <span className="text-foreground">Se for listagem</span>, a cascata aprova as colunas e avalia os cards em lotes de 16 — você vê as contagens aqui.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="tnum font-mono text-[11px] text-primary">4</span>
              <span>
                <span className="text-foreground">Se a fala tem várias ações</span>, o comando inteiro vai ao <span className="text-foreground">System Two</span> (a melhor voz disponível), que devolve o plano com 2..N ações — o JEV nem é consultado.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="tnum font-mono text-[11px] text-primary">5</span>
              <span>
                <span className="text-foreground">Sem fallback genérico</span>: quando o JEV se abstém ou está indisponível, ele pede para você reformular e nada é executado — a exceção é o comando com várias ações, que vai ao System Two.
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
      {/* sessão: turnos desta aba (um F5 zera) e, depois de uma busca, o que ela achou */}
      <SessionChips turns={sessionTurns} search={search} items={items} />

      {/* pipeline */}
      <section aria-label="Etapas do comando">
        <h3 className="eyebrow mb-2.5">Pipeline</h3>
        <ol className="space-y-2">
          {steps.map((step) => (
            <li key={step.key} className={`flex items-center gap-2.5 ${step.state === "skipped" || step.state === "idle" ? "opacity-55" : ""}`}>
              <StepMark state={step.state} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-foreground">{stepLabel(step.key)}</p>
                {(step.note || modelOf[step.key]) && (
                  <p className="truncate font-mono text-[10px] text-muted-foreground">{step.note ?? modelOf[step.key]}</p>
                )}
              </div>
              {step.ms !== undefined && <span className="tnum font-mono text-[12px] text-muted-foreground">{fmtMs(step.ms)}</span>}
            </li>
          ))}
        </ol>
        {(voiceLabel || trace) && (
          <div className="mt-3 space-y-1.5 border-t border-border/70 pt-2.5">
            {voiceLabel && (
              <p className="flex items-baseline justify-between gap-3 text-[12px] text-muted-foreground">
                <span>Voz que respondeu</span>
                <span className="truncate font-mono text-[10.5px] text-foreground" title="Modelo que o servidor escolheu para este plano">
                  {voiceLabel}
                </span>
              </p>
            )}
            {trace && (
              <p className="flex items-baseline justify-between gap-3 text-[12px] text-muted-foreground">
                <span>Do texto ao plano</span>
                <span className="tnum font-mono text-foreground">{fmtMs(trace.totalMs)}</span>
              </p>
            )}
          </div>
        )}
      </section>

      {transcript && (
        <section aria-label="O que você disse">
          <h3 className="eyebrow mb-1.5">Você disse</h3>
          <p className="text-pretty text-[14px] leading-snug text-foreground">“{transcript}”</p>
        </section>
      )}

      {/* a voz do JEV quando não consegue operar — sem fallback genérico, é ele que pede esclarecimento */}
      {showAlert && (
        <section className="rounded-lg border border-warning/30 bg-warning/[0.06] p-3" aria-live="polite">
          <h3 className="eyebrow mb-1 text-warning">JEV</h3>
          <p className="text-pretty text-[13px] leading-snug text-foreground">{alertMessage}</p>
          {alertNote && <p className="mt-1.5 text-[12px] text-muted-foreground">{alertNote}</p>}
        </section>
      )}

      {/* busca por característica: os resultados no mesmo bloco de listagem, com os campos que casaram */}
      {search && <SearchBlock search={search} items={items} />}

      {/* comando simultâneo: quem planeou foi o System Two (e, se ele falhou, o JEV seguiu daqui) */}
      {llm && <LlmBlock llm={llm} plan={plan} jevTookOver={Boolean(verdict)} />}

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

      {/* cascata de listagem: colunas + contagens (sem despejar 100 decisões de card) */}
      {verdict && <ListingBlock jev={verdict} plan={plan} />}
    </div>
  );
}
