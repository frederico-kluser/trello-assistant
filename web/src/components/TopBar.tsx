import { useState } from "react";
import { Mic, RefreshCw, Volume2, VolumeX } from "lucide-react";
import type { StatusPayload } from "@/lib/types";
import type { VoiceCapture } from "@/hooks/useVoiceCapture";
import { MicMenu } from "./MicMenu";

export type EngineState = "idle" | "active" | "ok" | "warn" | "down";

const DOT: Record<EngineState, string> = {
  idle: "bg-muted-foreground/50",
  active: "bg-primary animate-pulse",
  ok: "bg-success",
  warn: "bg-warning",
  down: "bg-destructive",
};

const short = (model: string | null) => (model ? model.split("/").pop()!.replace("-transcribe", "") : "");

function EngineChip({ label, model, state, title }: { label: string; model: string | null; state: EngineState; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-muted-foreground">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[state]}`} />
      <span className="font-medium text-foreground/90">{label}</span>
      {model && <span className="hidden font-mono text-[10.5px] xl:inline">{short(model)}</span>}
    </span>
  );
}

interface TopBarProps {
  status: StatusPayload | null;
  boardName: string;
  cardCount: number;
  sttState: EngineState;
  jevState: EngineState;
  mimoState: EngineState;
  syncedAt: number | null;
  refreshing: boolean;
  muted: boolean;
  capture: VoiceCapture;
  guide: string;
  onRefresh: () => void;
  onToggleMute: () => void;
}

const ago = (ms: number) => (ms < 8000 ? "agora" : ms < 60_000 ? `há ${Math.round(ms / 1000)} s` : `há ${Math.round(ms / 60_000)} min`);

export function TopBar({ status, boardName, cardCount, sttState, jevState, mimoState, syncedAt, refreshing, muted, capture, guide, onRefresh, onToggleMute }: TopBarProps) {
  const [micOpen, setMicOpen] = useState(false);
  const caps = status?.capabilities;
  const deviceLabel = capture.devices.find((device) => device.id === capture.deviceId)?.label;

  return (
    <header className="relative z-[70] flex h-[52px] shrink-0 items-center gap-3 border-b border-border/70 px-3 md:px-4">
      <a href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Trello Orbit">
        <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="13" fill="var(--color-primary)" />
          <ellipse cx="32" cy="32" rx="29" ry="10" fill="none" stroke="var(--color-primary)" strokeWidth="3" opacity="0.55" transform="rotate(-18 32 32)" />
        </svg>
        <span className="text-[15px] font-semibold tracking-tight text-foreground">
          Trello <span className="text-gradient-copper">Orbit</span>
        </span>
      </a>

      <div className="mx-auto flex min-w-0 items-center gap-2 text-[13px]">
        <span className="truncate font-medium text-foreground">{boardName || "…"}</span>
        <span className="tnum hidden font-mono text-[11px] text-muted-foreground sm:inline">{cardCount} cards</span>
        {caps?.board === "demo" && <span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warning">demo</span>}
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Atualizar o board agora"
          title={syncedAt ? `Atualizado ${ago(Date.now() - syncedAt)}` : "Atualizar"}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground active:translate-y-px"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
      </div>

      <div className="hidden items-center md:flex" aria-label="Motores em uso">
        <EngineChip label="Voz" model={caps?.models.stt ?? null} state={sttState} title="Transcrição (OpenAI)" />
        <EngineChip label="JEV" model={caps?.models.jev ?? null} state={jevState} title="Classifica a intenção, o card e a lista em milissegundos" />
        <EngineChip label="MiMo" model={caps?.models.mimo ?? null} state={mimoState} title="Reserva: só entra quando o JEV se abstém" />
      </div>

      <div className="relative flex shrink-0 items-center gap-1">
        <button
          type="button"
          data-mic-trigger
          onClick={() => setMicOpen((value) => !value)}
          aria-expanded={micOpen}
          aria-label="Configurar microfone"
          className={`inline-flex h-8 max-w-[11rem] items-center gap-2 rounded-md px-2.5 text-[12px] transition-colors active:translate-y-px ${micOpen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
        >
          <Mic className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden truncate lg:inline">{deviceLabel ?? "Microfone"}</span>
          {capture.permission === "denied" && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />}
        </button>
        <button
          type="button"
          onClick={onToggleMute}
          aria-pressed={muted}
          aria-label={muted ? "Ativar voz de resposta" : "Silenciar voz de resposta"}
          className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground active:translate-y-px"
        >
          {muted ? <VolumeX className="h-4 w-4" aria-hidden="true" /> : <Volume2 className="h-4 w-4" aria-hidden="true" />}
        </button>
        <a href={guide} target="_blank" rel="noreferrer" className="hidden h-8 items-center rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground lg:inline-flex">
          Guia
        </a>
        <MicMenu open={micOpen} capture={capture} onClose={() => setMicOpen(false)} />
      </div>
    </header>
  );
}
