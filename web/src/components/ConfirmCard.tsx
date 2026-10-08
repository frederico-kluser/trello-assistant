import { motion } from "motion/react";
import { Mic, ShieldCheck, TriangleAlert } from "lucide-react";
import { HoldToConfirmButton } from "@/components/motion-ui/hold-to-confirm";
import { MultiStateButton } from "@/components/motion-ui/multi-state-button";
import type { Plan } from "@/lib/types";

interface ConfirmCardProps {
  plan: Plan;
  hearing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmação docada: o card citado vem para perto e a órbita continua visível. */
export function ConfirmCard({ plan, hearing, onConfirm, onCancel }: ConfirmCardProps) {
  const destructive = plan.actions.some((action) => action.type === "delete_card");
  const creating = plan.actions.some((action) => action.type === "create_card");
  const uncertain = plan.band === "hitl";
  const heading = destructive ? "Apagar é para sempre" : uncertain ? "Acho que você quer isto" : creating ? "Confirmar criação" : "Confirmar ação";

  return (
    <motion.section
      role="alertdialog"
      aria-labelledby="confirm-heading"
      aria-describedby="confirm-detail"
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 320, damping: 30 }}
      className="hud-solid rounded-2xl p-4"
    >
      <div className="flex items-start gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${destructive ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"}`}>
          {destructive ? <TriangleAlert className="h-[18px] w-[18px]" aria-hidden="true" /> : <ShieldCheck className="h-[18px] w-[18px]" aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="confirm-heading" className="text-[15px] font-semibold text-foreground">
            {heading}
          </h2>
          <ul id="confirm-detail" className="mt-1.5 space-y-1">
            {plan.actions.map((action, index) => (
              <li key={`${action.type}-${index}`} className="text-pretty text-[13.5px] leading-snug text-foreground/90 first-letter:uppercase">
                {action.description}
              </li>
            ))}
          </ul>
          {uncertain && !destructive && (
            <p className="mt-2 text-[12px] text-muted-foreground">O JEV não ficou totalmente seguro, então peço o seu ok antes de mexer no Trello.</p>
          )}
          {plan.warning && <p className="mt-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning">{plan.warning}</p>}
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground" aria-live="polite">
          {destructive ? (
            <>
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
              Por segurança, apagar só confirma segurando o botão (nunca por voz).
            </>
          ) : hearing ? (
            <>
              <span className="inline-flex h-3 items-end gap-[2px]" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <motion.span key={i} className="w-[2px] rounded-full bg-primary" animate={{ height: [4, 12, 4] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12 }} />
                ))}
              </span>
              Ouvindo a sua resposta: diga «sim» ou «cancela»
            </>
          ) : (
            <>
              <Mic className="h-3.5 w-3.5" aria-hidden="true" />
              Ou diga «sim» / «cancela»
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          {/* 44 px de alvo no celular; a partir de lg o botão volta ao tamanho de antes. */}
          <button type="button" onClick={onCancel} className="inline-flex min-h-11 items-center gap-2 rounded-full px-3.5 py-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground active:translate-y-px lg:min-h-0">
            Cancelar <span className="kbd">Esc</span>
          </button>
          {destructive ? (
            <HoldToConfirmButton holdSeconds={1.6} onConfirm={onConfirm} className="min-h-11 rounded-full px-5 py-2.5 text-[13px] font-medium lg:min-h-0" aria-describedby="confirm-detail">
              Segure para apagar
            </HoldToConfirmButton>
          ) : (
            <MultiStateButton state="confirm" feedback="pop" announce="Ação confirmada" onClick={onConfirm} surfaceClassName="bg-primary text-primary-foreground" pillClassName="min-h-11 rounded-full px-5 py-2.5 text-[13px] font-medium lg:min-h-0">
              Confirmar
            </MultiStateButton>
          )}
        </div>
      </div>
    </motion.section>
  );
}
