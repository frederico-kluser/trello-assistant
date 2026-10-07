import { useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ShieldCheck, TriangleAlert, X } from "lucide-react";
import { Backdrop, useFocusTrap, useScrollLock } from "@/components/motion-ui/overlay";
import { HoldToConfirmButton } from "@/components/motion-ui/hold-to-confirm";
import { MultiStateButton } from "@/components/motion-ui/multi-state-button";
import type { Plan } from "@/lib/types";

interface ConfirmDialogProps {
  open: boolean;
  plan: Plan | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Modal de confirmação — sempre presente antes de criar ou apagar cards. */
export function ConfirmDialog({ open, plan, onConfirm, onCancel }: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useScrollLock(open);
  useFocusTrap({ active: open, container: panelRef, onEscape: onCancel });

  const destructive = Boolean(plan?.actions.some((action) => action.type === "delete_card"));
  const creating = Boolean(plan?.actions.some((action) => action.type === "create_card"));

  return (
    <AnimatePresence>
      {open && plan && (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
          <Backdrop
            opacity={0.72}
            className="bg-background/80"
            label="Fechar confirmação"
            onClick={onCancel}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            className="glass-strong relative w-full max-w-md rounded-2xl p-5"
            initial={{ opacity: 0, y: 32, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 305, damping: 33 }}
          >
            <header className="flex items-start gap-3">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  destructive ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"
                }`}
              >
                {destructive ? (
                  <TriangleAlert className="h-4.5 w-4.5" aria-hidden="true" />
                ) : (
                  <ShieldCheck className="h-4.5 w-4.5" aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="confirm-title" className="text-base font-semibold text-foreground">
                  {destructive ? "Apagar é para sempre" : creating ? "Confirmar criação" : "Confirmar ação"}
                </h2>
                <p className="mt-1 text-pretty text-sm text-muted-foreground">{plan.speech}</p>
              </div>
              <button
                type="button"
                onClick={onCancel}
                aria-label="Cancelar"
                className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </header>

            <ul className="mt-4 space-y-2">
              {plan.actions.map((action, index) => (
                <li
                  key={`${action.type}-${index}`}
                  className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm text-foreground"
                >
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                  <span className="text-pretty">{action.description}</span>
                </li>
              ))}
            </ul>

            {plan.warning && (
              <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">{plan.warning}</p>
            )}

            <footer className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-full px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancelar
              </button>

              {destructive ? (
                <HoldToConfirmButton
                  holdSeconds={1.8}
                  onConfirm={onConfirm}
                  onCancel={onCancel}
                  className="rounded-full px-5 py-2.5 text-sm font-medium"
                  aria-describedby="confirm-title"
                >
                  Segure para apagar
                </HoldToConfirmButton>
              ) : (
                <MultiStateButton
                  state="confirm"
                  feedback="pop"
                  announce="Ação confirmada"
                  onClick={onConfirm}
                  surfaceClassName="bg-primary text-primary-foreground"
                  pillClassName="rounded-full px-5 py-2.5 text-sm font-medium"
                >
                  Confirmar
                </MultiStateButton>
              )}
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}