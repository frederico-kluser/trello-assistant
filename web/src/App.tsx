import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Cpu, Layers, Mic2, WifiOff } from "lucide-react";
import { MotionUIThemeProvider } from "@/components/motion-ui/ui-theme";
import { Confetti, type ConfettiHandle } from "@/components/motion-ui/confetti";
import { Toast, ToastStack, useToastStack } from "@/components/motion-ui/toast-stack";
import motionTheme from "../motion.theme";
import { ApiError, api } from "@/lib/api";
import { cancelSpeech, createRecognizer, recognizerAvailable, speak, type Recognizer } from "@/lib/speech";
import { useRecorder } from "@/hooks/useRecorder";
import type { Board, FeedItem, Phase, Plan, PlannedAction, StatusPayload, TCard, ToastData } from "@/lib/types";
import { OrbitBoard } from "@/components/OrbitBoard";
import { VoiceCore } from "@/components/VoiceCore";
import { PlanPanel } from "@/components/PlanPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const norm = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

/** Associa as referências do plano a ids reais de cards (para o destaque em órbita). */
function resolveCardIds(actions: PlannedAction[], board: Board): Set<string> {
  const ids = new Set<string>();
  for (const action of actions) {
    const ref = String((action.card as string) ?? (action.name as string) ?? "").trim();
    if (!ref) continue;
    const needle = norm(ref);
    const match =
      board.cards.find((card) => card.id === ref) ??
      board.cards.find((card) => norm(card.name) === needle) ??
      board.cards.find((card) => norm(card.name).includes(needle)) ??
      board.cards.find((card) => needle.includes(norm(card.name)) && norm(card.name).length > 3);
    if (match) ids.add(match.id);
  }
  return ids;
}

function ProviderChip({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
      <Icon className="h-3 w-3 text-primary" aria-hidden="true" />
      <span className="uppercase tracking-wider">{label}</span>
      <span className="text-foreground">{value}</span>
    </span>
  );
}

export default function App() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [focusIds, setFocusIds] = useState<Set<string>>(() => new Set());
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  const feedId = useRef(0);
  const recognizerRef = useRef<Recognizer | null>(null);
  const confettiRef = useRef<ConfettiHandle>(null);
  const { toasts, add: addToast, dismiss } = useToastStack();
  const [toastData, setToastData] = useState<ToastData[]>([]);
  const recorder = useRecorder();

  const pushFeed = useCallback((kind: FeedItem["kind"], text: string) => {
    feedId.current += 1;
    const item: FeedItem = { id: feedId.current, kind, text, at: new Date().toISOString() };
    setFeed((prev) => [item, ...prev].slice(0, 40));
  }, []);

  const pushToast = useCallback(
    (text: string, tone: ToastData["tone"]) => {
      const id = addToast();
      setToastData((prev) => [{ id, text, tone }, ...prev].slice(0, 8));
      window.setTimeout(() => dismiss(id), 6000);
    },
    [addToast, dismiss],
  );

  /* ── boot ─────────────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [statusPayload, boardPayload] = await Promise.all([api.status(), api.board()]);
        if (cancelled) return;
        setStatus(statusPayload);
        setBoard(boardPayload);
        if (boardPayload.demo) {
          pushFeed("info", "Modo demonstração ativo — o board é fictício até você conectar o Trello.");
        }
      } catch (err) {
        if (cancelled) return;
        setBootError((err as Error).message);
        pushFeed("error", `Servidor indisponível: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushFeed]);

  /* ── execução das ações ───────────────────────────────────── */
  const execute = useCallback(
    async (planObj: Plan, confirmed: boolean) => {
      setPhase("executing");
      try {
        const response = await api.execute(planObj.actions, confirmed);
        setBoard(response.board);

        const messages = response.results.map((result) => result.message);
        pushFeed("done", messages.join(" · "));
        for (const message of messages) pushToast(message, "success");

        if (response.results.some((result) => result.type === "create_card")) {
          confettiRef.current?.burst();
        }
        if (response.results.some((result) => result.type === "move_card" || result.type === "set_due")) {
          pushToast("Precisou corrigir? Fale «move o card para a lista anterior» ou «muda o prazo».", "info");
        }

        const touched = new Set(
          response.results.map((result) => result.cardId).filter((id): id is string => Boolean(id)),
        );
        setFocusIds(touched);
        setDialogOpen(false);
        setPendingPlan(null);

        setPhase("speaking");
        await speak(`Feito. ${messages.join(". ")}.`);
        setPhase("idle");
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Não consegui executar as ações no Trello.";
        pushFeed("error", message);
        pushToast(message, "error");
        setPhase("error");
      }
    },
    [pushFeed, pushToast],
  );

  /* ── fluxo principal: fala → plano ───────────────────────── */
  const runCommand = useCallback(
    async (text: string) => {
      cancelSpeech();
      pushFeed("you", text);
      setPhase("thinking");
      setPlan(null);
      try {
        const response = await api.agent(text);
        setBoard(response.board);

        const nextPlan: Plan = {
          speech: response.speech,
          actions: response.actions,
          needsConfirmation: response.needsConfirmation,
          provider: response.provider,
          model: response.model,
          warning: response.warning,
        };
        setPlan(nextPlan);
        setFocusIds(resolveCardIds(nextPlan.actions, response.board));

        if (nextPlan.actions.length === 0) {
          setPhase("speaking");
          await speak(nextPlan.speech);
          setPhase("idle");
          return;
        }

        if (nextPlan.needsConfirmation) {
          setPendingPlan(nextPlan);
          setDialogOpen(true);
          setPhase("confirming");
          pushFeed("plan", nextPlan.actions.map((action) => action.description).join(" · "));
          void speak(nextPlan.speech);
          return;
        }

        pushFeed("plan", nextPlan.actions.map((action) => action.description).join(" · "));
        setPhase("speaking");
        await speak(nextPlan.speech);
        await execute(nextPlan, true);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Não consegui entender o pedido.";
        pushFeed("error", message);
        pushToast(message, "error");
        setPhase("error");
      }
    },
    [execute, pushFeed, pushToast],
  );

  /* ── fallback: reconhecimento do navegador ───────────────── */
  const startBrowserRecognition = useCallback(() => {
    if (!recognizerAvailable()) {
      pushFeed("error", "Este navegador não tem reconhecimento de voz — digite o comando abaixo.");
      setPhase("idle");
      return;
    }
    const recognizer = createRecognizer({
      onPartial: (partial) => pushFeed("info", `Ouvindo: ${partial}`),
      onFinal: (text) => void runCommand(text),
      onError: (message) => {
        pushFeed("error", `Reconhecimento do navegador: ${message}`);
        setPhase("idle");
      },
    });
    recognizerRef.current = recognizer;
    recognizer?.start();
    setPhase("listening");
    pushFeed("info", "Gravando com o reconhecimento do navegador…");
  }, [pushFeed, runCommand]);

  /* ── gravação ─────────────────────────────────────────────── */
  const handleRecordToggle = useCallback(async () => {
    if (phase === "listening" || phase === "error") {
      const blob = await recorder.stop();
      recognizerRef.current?.stop();
      if (!blob) {
        setPhase("idle");
        return;
      }
      setPhase("transcribing");
      try {
        const result = await api.stt(blob);
        pushFeed("info", `Transcrito pela OpenAI (${result.model}).`);
        await runCommand(result.text);
      } catch (err) {
        if (err instanceof ApiError && err.code === "missing_openai_key") {
          pushFeed("info", "STT da OpenAI não configurado — usando o reconhecimento do navegador.");
          pushToast("Configure OPENAI_API_KEY para transcrição pela OpenAI.", "info");
          startBrowserRecognition();
          return;
        }
        const message = err instanceof ApiError ? err.message : "Falha ao transcrever o áudio.";
        pushFeed("error", message);
        pushToast(message, "error");
        setPhase("error");
      }
      return;
    }

    cancelSpeech();
    const started = await recorder.start();
    if (started) {
      setPhase("listening");
      pushFeed("info", "Gravando… fale o que quer fazer no Trello.");
    }
  }, [phase, pushFeed, pushToast, recorder, runCommand, startBrowserRecognition]);

  const selectedCard = useMemo<TCard | null>(
    () => board?.cards.find((card) => card.id === selectedCardId) ?? null,
    [board, selectedCardId],
  );

  const agentLabel = status
    ? status.capabilities.agent === "openrouter"
      ? status.capabilities.models.agent
      : "interpretador local"
    : "…";

  const sttLabel = status ? (status.capabilities.stt === "openai" ? status.capabilities.models.stt : "navegador") : "…";
  const boardLabel = status ? (status.capabilities.board === "trello" ? "Trello" : "demo") : "…";

  return (
    <MotionUIThemeProvider theme={motionTheme}>
      <div className="mx-auto flex min-h-dvh w-full max-w-[1400px] flex-col gap-4 px-4 pb-8 pt-4 md:gap-6 md:px-8">
        {/* header */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <svg width="38" height="38" viewBox="0 0 64 64" aria-hidden="true">
              <circle cx="32" cy="32" r="13" fill="var(--color-primary)" />
              <ellipse
                cx="32"
                cy="32"
                rx="29"
                ry="10"
                fill="none"
                stroke="var(--color-chart-2)"
                strokeWidth="3"
                opacity="0.7"
                transform="rotate(-18 32 32)"
              />
            </svg>
            <div>
              <h1 className="text-xl font-bold leading-none">
                Trello <span className="text-gradient-copper">Orbit</span>
              </h1>
              <p className="text-xs text-muted-foreground">pilote seu board por voz</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ProviderChip icon={Mic2} label="stt" value={sttLabel} />
            <ProviderChip icon={Cpu} label="agente" value={agentLabel} />
            <ProviderChip icon={Layers} label="board" value={boardLabel} />
            {board?.demo && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-warning">
                modo demo
              </span>
            )}
          </div>
        </header>

        {bootError && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="text-pretty">
              Não consegui falar com o servidor ({bootError}). Suba o backend com <code className="font-mono">npm start</code> em{" "}
              <code className="font-mono">server/</code>.
            </span>
          </div>
        )}

        {/* palco */}
        <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr] lg:gap-6">
          <section className="flex min-h-0 flex-col gap-4">
            {board ? (
              <OrbitBoard
                board={board}
                focusIds={focusIds}
                selectedCardId={selectedCardId}
                onSelectCard={(card) => setSelectedCardId((prev) => (prev === card.id ? null : card.id))}
              >
                <VoiceCore
                  phase={phase}
                  level={recorder.level}
                  recording={recorder.recording}
                  listeningSupported={recorder.supported || recognizerAvailable()}
                  onStart={handleRecordToggle}
                  onStop={handleRecordToggle}
                  onSubmitText={(text) => void runCommand(text)}
                  disabled={Boolean(bootError) || phase === "executing"}
                />
              </OrbitBoard>
            ) : (
              <div className="glass flex min-h-[320px] items-center justify-center rounded-3xl">
                <div className="text-center">
                  <AlertTriangle className="mx-auto h-6 w-6 text-warning" aria-hidden="true" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    {bootError ? "Sem conexão com o servidor." : "Carregando seu board…"}
                  </p>
                </div>
              </div>
            )}

            <p className="text-center text-xs text-muted-foreground">
              Diga coisas como «cria card revisar proposta na lista a fazer com prazo amanhã» ou «move revisar proposta para
              fazendo». Criações e exclusões sempre pedem confirmação.
            </p>
          </section>

          <PlanPanel
            board={board}
            plan={plan}
            feed={feed}
            selectedCard={selectedCard}
            missing={status?.missing ?? []}
            guide={status?.guide ?? "docs/PROXIMOS-PASSOS.html"}
            agentLabel={agentLabel}
          />
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            STT: OpenAI · Análise: OpenRouter MiMo 2.6 Pro · Board: Trello — credenciais só no servidor, nunca no navegador.
          </span>
          <a
            href={status?.guide ?? "docs/PROXIMOS-PASSOS.html"}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:text-primary hover:underline"
          >
            Guia de configuração
          </a>
        </footer>
      </div>

      {/* confirmação de ações */}
      <ConfirmDialog
        open={dialogOpen}
        plan={pendingPlan}
        onConfirm={() => {
          if (pendingPlan) void execute(pendingPlan, true);
        }}
        onCancel={() => {
          setDialogOpen(false);
          setPendingPlan(null);
          setPhase("idle");
          pushFeed("info", "Ação cancelada — nada foi alterado.");
          void speak("Cancelado. Não alterei nada.");
        }}
      />

      {/* celebração de criação */}
      <Confetti ref={confettiRef} className="pointer-events-none fixed inset-0 z-[60]" />

      {/* toasts */}
      <ToastStack className="fixed bottom-4 left-1/2 z-[70] w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2">
        {toasts.map((id) => {
          const data = toastData.find((toast) => toast.id === id);
          return (
            <Toast key={id} className="glass-strong flex items-start gap-2 rounded-xl px-4 py-3 text-sm">
              <span
                className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                  data?.tone === "error" ? "bg-destructive" : data?.tone === "info" ? "bg-chart-2" : "bg-success"
                }`}
                aria-hidden="true"
              />
              <span className="text-pretty text-foreground">{data?.text ?? "…"}</span>
            </Toast>
          );
        })}
      </ToastStack>

      {/* estado global para leitores de tela */}
      <div aria-live="polite" role="status" className="sr-only">
        {phase === "listening"
          ? "Gravando"
          : phase === "transcribing"
            ? "Transcrevendo"
            : phase === "thinking"
              ? "Planejando ações"
              : phase === "executing"
                ? "Executando ações no Trello"
                : phase === "confirming"
                  ? "Aguardando confirmação"
                  : "Pronto"}
      </div>
    </MotionUIThemeProvider>
  );
}