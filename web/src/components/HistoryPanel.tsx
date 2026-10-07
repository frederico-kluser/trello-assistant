import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CheckCircle2, Cpu, Info, Mic, Sparkles, Zap } from "lucide-react";
import type { FeedItem } from "@/lib/types";

const ICON = {
  you: Mic,
  jev: Zap,
  mimo: Cpu,
  plan: Sparkles,
  done: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

const TONE: Record<FeedItem["kind"], string> = {
  you: "text-foreground",
  jev: "text-primary",
  mimo: "text-primary",
  plan: "text-muted-foreground",
  done: "text-success",
  error: "text-destructive",
  info: "text-muted-foreground",
};

const time = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function HistoryPanel({ feed }: { feed: FeedItem[] }) {
  if (!feed.length) {
    return (
      <div className="flex h-full flex-col justify-center gap-2 px-1 py-6 text-center">
        <p className="text-sm font-medium text-foreground">Sem histórico ainda</p>
        <p className="mx-auto max-w-[30ch] text-pretty text-[13px] leading-relaxed text-muted-foreground">Cada comando, decisão e resultado fica registrado aqui.</p>
      </div>
    );
  }
  return (
    <ol className="space-y-3" aria-label="Histórico de comandos">
      <AnimatePresence initial={false}>
        {feed.map((item) => {
          const Icon = ICON[item.kind];
          return (
            <motion.li
              key={item.id}
              layout="position"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="flex gap-2.5"
            >
              <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${TONE[item.kind]}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className={`text-pretty text-[13px] leading-snug ${item.kind === "you" ? "font-medium text-foreground" : "text-foreground/85"}`}>{item.text}</p>
                <p className="tnum font-mono text-[10px] text-muted-foreground">{time(item.at)}</p>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
