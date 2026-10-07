import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { WifiOff } from "lucide-react";
import { MotionUIThemeProvider } from "@/components/motion-ui/ui-theme";
import { Confetti, type ConfettiHandle } from "@/components/motion-ui/confetti";
import { Toast, ToastStack, useToastStack } from "@/components/motion-ui/toast-stack";
import motionTheme from "../motion.theme";
import { ApiError, api } from "@/lib/api";
import { cancelSpeech, createLiveCaptions, isMuted, setMuted, speak, type LiveCaptions } from "@/lib/speech";
import { useVoiceCapture, type AutoStopReason } from "@/hooks/useVoiceCapture";
import type { Board, FeedItem, JevTrace, Phase, PipelineStep, Plan, PlanTrace, PlannedAction, StatusPayload, TCard, ToastData } from "@/lib/types";
import { OrbitStage, type PulseSignal } from "@/components/OrbitStage";
import { Planet } from "@/components/Planet";
import { CommandDock, type Caption } from "@/components/CommandDock";
import { TopBar, type EngineState } from "@/components/TopBar";
import { ListRail } from "@/components/ListRail";
import { DecisionPanel } from "@/components/DecisionPanel";
import { HistoryPanel } from "@/components/HistoryPanel";
import { CardPanel } from "@/components/CardPanel";
import { SetupChecklist } from "@/components/SetupChecklist";
import { tidyName } from "@/components/OrbitChip";

const norm = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

/** Associa as referências do plano a ids reais de cards (para o card "vir para perto"). */
function resolveCardIds(actions: PlannedAction[], board: Board): Set<string> {
  const ids = new Set<string>();
  for (const action of actions) {
    const ref = String((action.card as string) ?? "").trim();
    if (!ref) continue;
    const needle = norm(ref);
    const match =
      board.cards.find((card) => card.id === ref) ??
      board.cards.find((card) => norm(card.name) === needle) ??
      board.cards.find((card) => norm(card.name).includes(needle));
    if (match) ids.add(match.id);
  }
  return ids;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** Resumo de uma linha do que o JEV decidiu (para a legenda e o histórico). */
function jevSummary(jev: JevTrace): string {
  if (jev.status === "unavailable") return `JEV indisponível: ${jev.reason ?? "sem resposta"}. Chamando o MiMo 2.6 Pro.`;
  if (jev.status === "abstain") return `JEV: ${jev.reason ?? "não consigo operar"}. Chamando o MiMo 2.6 Pro.`;
  const used = (jev.clauses[0]?.decisions ?? []).filter((decision) => decision.used && decision.type === "choice");
  const parts = used.map((decision) => tidyName(String(decision.display)));
  const min = Math.min(...used.map((decision) => decision.confidence), 1);
  return `JEV decidiu: ${parts.join(" · ")} (${pct(min)}).`;
}

type Tab = "decisoes" | "historico" | "card" | "listas";

const STEPS_IDLE: PipelineStep[] = [
  { key: "stt", state: "idle" },
  { key: "jev", state: "idle" },
  { key: "mimo", state: "idle", note: "só se o JEV se abstiver" },
  { key: "trello", state: "idle" },
];

const useViewportWidth = () => {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
};

export default function App() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [caption, setCaption] = useState<Caption>({ kind: "hint" });
  const [transcript, setTranscript] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);
  const [hearing, setHearing] = useState(false);
  const [steps, setSteps] = useState<PipelineStep[]>(STEPS_IDLE);
  const [jevLive, setJevLive] = useState<JevTrace | null>(null);
  const [trace, setTrace] = useState<PlanTrace | null>(null);
  const [mimoActive, setMimoActive] = useState(false);
  const [engines, setEngines] = useState<{ stt: EngineState; jev: EngineState; mimo: EngineState }>({ stt: "idle", jev: "idle", mimo: "idle" });
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [focusIds, setFocusIds] = useState<Set<string>>(() => new Set());
  const [pulse, setPulse] = useState<PulseSignal | null>(null);
  const [tab, setTab] = useState<Tab>("decisoes");
  const [muted, setMutedState] = useState(isMuted);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState("");

  const capture = useVoiceCapture();
  const viewport = useViewportWidth();
  const { toasts, add: addToast, dismiss } = useToastStack();
  const [toastData, setToastData] = useState<ToastData[]>([]);

  const confettiRef = useRef<ConfettiHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const feedId = useRef(0);
  const pulseKey = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const boardRef = useRef<Board | null>(null);
  const lastCardRef = useRef<string | null>(null);
  const transcriptRef = useRef("");
  const captionsRef = useRef<LiveCaptions | null>(null);
  const finishing = useRef(false);
  const modeRef = useRef<"command" | "confirm">("command");
  const pendingRef = useRef<Plan | null>(null);
  const finishRef = useRef<(mode: "command" | "confirm", reason?: AutoStopReason | "manual") => Promise<void>>(async () => undefined);

  phaseRef.current = phase;
  boardRef.current = board;
  pendingRef.current = pendingPlan;

  /* ── utilidades de UI ─────────────────────────────────────── */

  const pushFeed = useCallback((kind: FeedItem["kind"], text: string) => {
    feedId.current += 1;
    const item: FeedItem = { id: feedId.current, kind, text, at: new Date().toISOString() };
    setFeed((prev) => [item, ...prev].slice(0, 60));
  }, []);

  const pushToast = useCallback(
    (text: string, tone: ToastData["tone"]) => {
      const id = addToast();
      setToastData((prev) => [{ id, text, tone }, ...prev].slice(0, 8));
      window.setTimeout(() => dismiss(id), 5500);
    },
    [addToast, dismiss],
  );

  const patchStep = useCallback((key: PipelineStep["key"], patch: Partial<PipelineStep>) => {
    setSteps((prev) => prev.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  }, []);

  const setEngine = useCallback((key: "stt" | "jev" | "mimo", state: EngineState) => {
    setEngines((prev) => ({ ...prev, [key]: state }));
  }, []);

  const say = useCallback((text: string) => {
    setSpeaking(true);
    return speak(text).finally(() => setSpeaking(false));
  }, []);

  const heard = useCallback((status?: string, tone?: "neutral" | "warn") => {
    setCaption({ kind: "heard", transcript: transcriptRef.current, status, tone });
  }, []);

  /* ── carga do board ───────────────────────────────────────── */

  const loadBoard = useCallback(
    async (fresh: boolean) => {
      setRefreshing(true);
      try {
        const next = await api.board(fresh);
        setBoard(next);
        setSyncedAt(Date.now());
        setBootError(null);
      } catch (err) {
        if (!boardRef.current) setBootError((err as Error).message);
      } finally {
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [statusPayload, boardPayload] = await Promise.all([api.status(), api.board()]);
        if (cancelled) return;
        setStatus(statusPayload);
        setBoard(boardPayload);
        setSyncedAt(Date.now());
        if (boardPayload.demo) pushFeed("info", "Modo demonstração: o board é fictício até você conectar o Trello.");
        api.warm();
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

  // Mantém a órbita "viva": reconcilia com mudanças feitas fora do app.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible" && phaseRef.current === "idle") void loadBoard(true);
    }, 25_000);
    return () => window.clearInterval(id);
  }, [loadBoard]);

  /* ── execução ─────────────────────────────────────────────── */

  const execute = useCallback(
    async (plan: Plan) => {
      setPhase("executing");
      setPendingPlan(null);
      setHearing(false);
      patchStep("trello", { state: "active" });
      heard("Executando no Trello…");
      const started = performance.now();
      try {
        const response = await api.execute(plan.actions, true);
        const ms = performance.now() - started;
        setBoard(response.board);
        setSyncedAt(Date.now());
        patchStep("trello", { state: "done", ms });

        const messages = response.results.map((result) => result.message);
        pushFeed("done", messages.join(" · "));
        for (const message of messages) pushToast(message, "success");

        const created = response.results.some((result) => result.type === "create_card");
        const deleted = response.results.some((result) => result.type === "delete_card");
        pulseKey.current += 1;
        setPulse({ key: pulseKey.current, tone: created ? "create" : deleted ? "delete" : "ok" });
        if (created) confettiRef.current?.burst();

        const touched = response.results.map((result) => result.cardId).filter((id): id is string => Boolean(id));
        setFocusIds(new Set(deleted ? [] : touched));
        if (touched.length && !deleted) lastCardRef.current = touched[touched.length - 1];
        window.setTimeout(() => setFocusIds(new Set()), 4200);

        const spoken = response.results.map((result) => result.spoken).join(" ");
        heard(spoken || "Feito.");
        setPhase("idle");
        void say(`Feito. ${spoken}`); // fala depois e sem travar: um novo comando interrompe
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Não consegui executar as ações no Trello.";
        patchStep("trello", { state: "failed" });
        pushFeed("error", message);
        setCaption({ kind: "error", message, hint: err instanceof ApiError ? (err.hint ?? undefined) : undefined });
        setPhase("idle");
      }
    },
    [heard, patchStep, pushFeed, pushToast, say],
  );

  const cancelPlan = useCallback(
    (reason = "Ação cancelada. Nada foi alterado.") => {
      capture.cancel();
      captionsRef.current?.stop();
      setHearing(false);
      setPendingPlan(null);
      setFocusIds(new Set());
      setPhase("idle");
      pushFeed("info", reason);
      heard(reason);
      void say("Cancelado. Não alterei nada.");
    },
    [capture, heard, pushFeed, say],
  );

  const confirmPlan = useCallback(() => {
    const plan = pendingRef.current;
    if (!plan) return;
    capture.cancel();
    cancelSpeech();
    void execute(plan);
  }, [capture, execute]);

  /* ── voz ──────────────────────────────────────────────────── */

  const startVoice = useCallback(
    async (mode: "command" | "confirm") => {
      cancelSpeech();
      setSpeaking(false);
      api.warm();
      const result = await capture.start((reason) => void finishRef.current(mode, reason));
      if (!result.ok) {
        setCaption({
          kind: "error",
          message: "Não consegui ouvir você.",
          hint: result.message,
          action: { label: "Abrir ajustes do microfone", run: () => document.querySelector<HTMLButtonElement>("[data-mic-trigger]")?.click() },
        });
        return;
      }
      modeRef.current = mode;
      if (mode === "confirm") {
        setHearing(true);
        return;
      }
      transcriptRef.current = "";
      setTranscript(null);
      setJevLive(null);
      setTrace(null);
      setMimoActive(false);
      setSteps(STEPS_IDLE);
      setEngines({ stt: "idle", jev: "idle", mimo: "idle" });
      setPhase("listening");
      setCaption({ kind: "listening", text: "" });
      setTab("decisoes");
      const captions = createLiveCaptions((text) => setCaption({ kind: "listening", text }));
      captionsRef.current = captions;
      captions.start();
    },
    [capture],
  );

  const runCommand = useCallback(
    async (text: string, source: "voz" | "texto" | "navegador" = "texto") => {
      cancelSpeech();
      transcriptRef.current = text;
      setTranscript(text);
      setPhase("thinking");
      setPendingPlan(null);
      setHearing(false);
      setJevLive(null);
      setTrace(null);
      setMimoActive(false);
      setFocusIds(new Set());
      setTab("decisoes");
      setSteps((prev) => [
        source === "texto" ? { key: "stt", state: "skipped", note: "texto digitado" } : prev[0],
        { key: "jev", state: "active" },
        { key: "mimo", state: "idle", note: "só se o JEV se abstiver" },
        { key: "trello", state: "idle" },
      ]);
      setEngine("jev", "active");
      setEngine("mimo", "idle");
      pushFeed("you", text);
      heard("JEV analisando…");

      try {
        const plan = await api.agent(text, { lastCardId: lastCardRef.current }, (event) => {
          if (event.type === "jev") {
            setJevLive(event.jev);
            const ok = event.jev.status === "ok";
            patchStep("jev", { state: ok ? "done" : event.jev.status === "abstain" ? "warn" : "failed", ms: event.jev.latencyMs, note: ok ? undefined : event.jev.status === "abstain" ? "se absteve" : "indisponível" });
            setEngine("jev", ok ? "ok" : event.jev.status === "abstain" ? "warn" : "down");
            const summary = jevSummary(event.jev);
            pushFeed("jev", summary);
            heard(summary, ok ? "neutral" : "warn");
          } else if (event.type === "mimo") {
            setMimoActive(true);
            patchStep("mimo", { state: "active", note: "raciocínio máximo" });
            setEngine("mimo", "active");
            pushFeed("mimo", "MiMo 2.6 Pro assumiu e está raciocinando.");
          }
        });

        setTrace(plan.trace);
        if (plan.trace.engine === "jev") patchStep("mimo", { state: "skipped", note: "não precisou" });
        if (plan.trace.mimo?.status === "ok") {
          patchStep("mimo", { state: "done", ms: plan.trace.mimo.latencyMs, note: undefined });
          setEngine("mimo", "ok");
        } else if (plan.trace.mimo?.status === "failed") {
          patchStep("mimo", { state: "failed", note: "falhou" });
          setEngine("mimo", "down");
        }
        if (plan.warning) pushFeed("info", plan.warning);

        const current = boardRef.current;
        const ids = current ? resolveCardIds(plan.actions, current) : new Set<string>();
        setFocusIds(ids);
        if (ids.size) {
          const first = [...ids][0];
          lastCardRef.current = first;
        }

        if (plan.actions.length === 0) {
          heard(plan.speech);
          pushFeed("plan", plan.speech);
          setPhase("idle");
          void say(plan.speech);
          return;
        }

        pushFeed("plan", plan.actions.map((action) => action.description).join(" · "));

        if (plan.needsConfirmation) {
          setPendingPlan(plan);
          setPhase("confirming");
          heard(undefined);
          const destructive = plan.actions.some((action) => action.type === "delete_card");
          await say(plan.speech);
          // Voz só para o que é reversível: depois de "Apagar", o eco do TTS poderia virar um "sim" falso.
          if (!destructive && !isMuted() && phaseRef.current === "confirming" && pendingRef.current === plan) {
            window.setTimeout(() => {
              if (phaseRef.current === "confirming" && pendingRef.current === plan && !capture.recording) void startVoice("confirm");
            }, 350);
          }
          return;
        }

        // banda "auto": executa já; a fala vem depois, sem travar
        await execute(plan);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Não consegui entender o pedido.";
        patchStep("jev", { state: "failed" });
        pushFeed("error", message);
        setCaption({ kind: "error", message, hint: err instanceof ApiError ? (err.hint ?? undefined) : undefined });
        setPhase("idle");
      }
    },
    [capture.recording, execute, heard, patchStep, pushFeed, say, setEngine, startVoice],
  );

  const finishListening = useCallback(
    async (mode: "command" | "confirm", reason?: AutoStopReason | "manual") => {
      if (finishing.current) return;
      finishing.current = true;
      try {
        const live = captionsRef.current?.stop() ?? "";
        captionsRef.current = null;
        const result = await capture.stop();

        if (mode === "confirm") {
          setHearing(false);
          if (!result.ok) return; // sem fala: os botões continuam na tela
          const pending = pendingRef.current;
          try {
            const stt = await api.stt(result.blob);
            const answer = await api.confirm(stt.text, pending?.speech ?? "");
            pushFeed("you", `${stt.text} (resposta)`);
            if (!pendingRef.current) return;
            if (answer.decision === "yes") confirmPlan();
            else if (answer.decision === "no") cancelPlan();
            else pushToast("Não entendi o sim ou o não. Toque em Confirmar ou Cancelar.", "info");
          } catch {
            pushToast("Não consegui ouvir a resposta. Use os botões.", "info");
          }
          return;
        }

        if (!result.ok) {
          if (live) {
            patchStep("stt", { state: "warn", note: "legenda do navegador" });
            await runCommand(live, "navegador");
            return;
          }
          setPhase("idle");
          const silent = result.reason === "silent";
          setCaption({
            kind: "error",
            message: silent ? "O microfone não captou som." : reason === "no_speech" ? "Não ouvi ninguém falar." : "Não consegui ouvir você.",
            hint: result.message,
            action: { label: "Testar o microfone", run: () => document.querySelector<HTMLButtonElement>("[data-mic-trigger]")?.click() },
          });
          pushFeed("error", result.message);
          return;
        }

        setPhase("transcribing");
        setCaption({ kind: "working", title: "Transcrevendo…" });
        patchStep("stt", { state: "active" });
        setEngine("stt", "active");
        const started = performance.now();
        try {
          const stt = await api.stt(result.blob);
          patchStep("stt", { state: "done", ms: performance.now() - started, note: stt.model });
          setEngine("stt", "ok");
          await runCommand(stt.text, "voz");
        } catch (err) {
          // A OpenAI falhou: se o navegador entendeu algo, usa essa legenda como reserva.
          if (live) {
            patchStep("stt", { state: "warn", ms: performance.now() - started, note: "reserva: navegador" });
            setEngine("stt", "warn");
            pushFeed("info", "A transcrição da OpenAI falhou; usei a legenda do navegador.");
            await runCommand(live, "navegador");
            return;
          }
          patchStep("stt", { state: "failed" });
          setEngine("stt", "down");
          const emptyish = err instanceof ApiError && (err.code === "stt_empty" || err.code === "audio_too_short");
          setPhase("idle");
          setCaption({
            kind: "error",
            message: emptyish ? "Não entendi nenhuma fala nessa gravação." : err instanceof ApiError ? err.message : "Falha ao transcrever o áudio.",
            hint: emptyish
              ? `O microfone «${result.deviceLabel}» captou som (pico ${pct(result.peak)}), mas sem fala reconhecível. Fale mais perto ou teste outro dispositivo.`
              : err instanceof ApiError
                ? (err.hint ?? undefined)
                : undefined,
            action: { label: "Ajustes do microfone", run: () => document.querySelector<HTMLButtonElement>("[data-mic-trigger]")?.click() },
          });
          pushFeed("error", err instanceof ApiError ? err.message : "Falha ao transcrever o áudio.");
        }
      } finally {
        finishing.current = false;
      }
    },
    [cancelPlan, capture, confirmPlan, patchStep, pushFeed, pushToast, runCommand, setEngine],
  );
  finishRef.current = finishListening;

  const togglePlanet = useCallback(() => {
    if (capture.recording) {
      void finishListening(modeRef.current, "manual");
      return;
    }
    if (phaseRef.current === "confirming") {
      void startVoice("confirm");
      return;
    }
    if (phaseRef.current === "idle") void startVoice("command");
  }, [capture.recording, finishListening, startVoice]);

  /* ── teclado: Espaço fala, Enter confirma, Esc cancela ─────── */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if (event.key === "Escape") {
        if (capture.recording) {
          capture.cancel();
          captionsRef.current?.stop();
          captionsRef.current = null;
          setHearing(false);
          if (modeRef.current === "command") {
            setPhase("idle");
            setCaption({ kind: "hint" });
          }
          return;
        }
        if (phaseRef.current === "confirming") cancelPlan();
        return;
      }
      if (typing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === "Space" && target?.tagName !== "BUTTON") {
        event.preventDefault();
        togglePlanet();
      } else if (event.key === "Enter" && phaseRef.current === "confirming" && target?.tagName !== "BUTTON") {
        const destructive = pendingRef.current?.actions.some((action) => action.type === "delete_card");
        if (!destructive) confirmPlan(); // apagar exige segurar o botão: nunca por tecla
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelPlan, capture, confirmPlan, togglePlanet]);

  /* ── seleção ──────────────────────────────────────────────── */

  const selectedCard = useMemo<TCard | null>(() => board?.cards.find((card) => card.id === selectedCardId) ?? null, [board, selectedCardId]);

  const onSelectCard = useCallback((card: TCard) => {
    setSelectedCardId((prev) => (prev === card.id ? null : card.id));
    lastCardRef.current = card.id;
    setTab("card");
  }, []);

  const onSelectList = useCallback((listId: string | null) => {
    setActiveListId((prev) => (prev === listId ? null : listId));
    if (listId) setTab("listas");
  }, []);

  const toggleMute = useCallback(() => {
    setMuted(!isMuted());
    setMutedState(isMuted());
  }, []);

  /* ── derivados ────────────────────────────────────────────── */

  const examples = useMemo(() => {
    if (!board) return [];
    const lists = board.lists.filter((list) => !list.closed);
    const card = board.cards.find((entry) => !entry.closed && lists.some((list) => list.id === entry.idList));
    const out = ["cria um card chamado revisar proposta"];
    if (card && lists.length > 1) {
      const target = lists.find((list) => list.id !== card.idList) ?? lists[0];
      out.unshift(`move ${card.name} para ${tidyName(target.name)}`);
    }
    if (lists[0]) out.push(`o que tem na lista ${tidyName(lists[0].name)}?`);
    return out.slice(0, 3);
  }, [board]);

  const cardCount = board?.cards.filter((card) => !card.closed).length ?? 0;
  // O dock cresce com o que mostra: no celular sem exemplos; ≥1280 px os exemplos vão para o painel direito.
  const bottomInset = viewport < 640 ? 138 : viewport >= 1280 ? 156 : 184;
  const planetPhase: Phase = speaking && phase === "idle" ? "speaking" : phase;

  const panelMissing = status?.missing ?? [];

  const tabs: { id: Tab; label: string; mobileOnly?: boolean }[] = [
    { id: "decisoes", label: "Decisões" },
    { id: "historico", label: "Histórico" },
    { id: "card", label: "Card" },
    { id: "listas", label: "Listas", mobileOnly: true },
  ];

  return (
    <MotionUIThemeProvider theme={motionTheme}>
      <div className="grain flex h-dvh min-h-[560px] flex-col overflow-hidden bg-background max-lg:h-auto max-lg:min-h-dvh max-lg:overflow-visible">
        <TopBar
          status={status}
          boardName={board?.name ?? status?.boardName ?? ""}
          cardCount={cardCount}
          sttState={engines.stt}
          jevState={engines.jev}
          mimoState={engines.mimo}
          syncedAt={syncedAt}
          refreshing={refreshing}
          muted={muted}
          capture={capture}
          guide={status?.guide ?? "/docs/TRELLO-GUIA-COMPLETO.md"}
          onRefresh={() => void loadBoard(true)}
          onToggleMute={toggleMute}
        />

        {bootError && (
          <div role="alert" className="flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
            <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="text-pretty">
              Não consegui falar com o servidor ({bootError}). Suba o backend com <code className="font-mono">npm start</code> em <code className="font-mono">server/</code>.
            </span>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1 max-lg:flex-col">
          {/* trilho esquerdo: o board inteiro */}
          <aside className="hud scrollbar-quiet hidden w-[17rem] shrink-0 border-y-0 border-l-0 xl:block 2xl:w-[18.5rem]">
            {board && <ListRail board={board} activeListId={activeListId} selectedId={selectedCardId} onSelectList={onSelectList} onSelectCard={onSelectCard} />}
          </aside>

          {/* palco: a órbita ocupa toda a área livre */}
          <main className="relative min-h-0 flex-1 max-lg:h-[68dvh] max-lg:min-h-[460px] max-lg:flex-none">
            {board ? (
              <OrbitStage board={board} focusIds={focusIds} selectedId={selectedCardId} activeListId={activeListId} bottomInset={bottomInset} pulse={pulse} onSelectCard={onSelectCard} onSelectList={onSelectList}>
                {(planetSize) => (
                  <Planet phase={planetPhase} level={capture.level} size={planetSize} disabled={Boolean(bootError) || !capture.supported || phase === "transcribing" || phase === "thinking" || phase === "executing"} onToggle={togglePlanet} />
                )}
              </OrbitStage>
            ) : (
              <div className="stage-bg grid h-full place-items-center">
                <div className="flex flex-col items-center gap-3 text-center" aria-live="polite">
                  <span className="shimmer-bar h-24 w-24 rounded-full bg-muted" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">{bootError ? "Sem conexão com o servidor." : "Carregando o seu board…"}</p>
                </div>
              </div>
            )}

            <CommandDock
              phase={phase}
              caption={caption}
              plan={pendingPlan}
              hearing={hearing}
              disabled={Boolean(bootError)}
              examples={examples}
              draft={draft}
              onDraft={setDraft}
              inputRef={inputRef}
              onSubmit={(text) => void runCommand(text, "texto")}
              onConfirm={confirmPlan}
              onCancel={() => cancelPlan()}
            />
          </main>

          {/* trilho direito: decisões, histórico, card */}
          <aside className="hud flex min-h-0 w-[20rem] shrink-0 flex-col border-y-0 border-r-0 max-lg:w-full max-lg:border-x-0 max-lg:border-b-0 xl:w-[22rem] 2xl:w-[25rem]">
            <div role="tablist" aria-label="Painéis" className="relative flex shrink-0 gap-1 border-b border-border/70 px-2 pt-2">
              {tabs.map((entry) => (
                <button
                  key={entry.id}
                  role="tab"
                  type="button"
                  aria-selected={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                  className={`relative px-3 pb-2.5 pt-1.5 text-[13px] transition-colors ${entry.mobileOnly ? "xl:hidden" : ""} ${tab === entry.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {entry.label}
                  {entry.id === "historico" && feed.length > 0 && <span className="tnum ml-1.5 font-mono text-[10px] text-muted-foreground">{feed.length}</span>}
                  {tab === entry.id && <motion.span layoutId="tab-underline" className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-primary" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
                </button>
              ))}
            </div>

            <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto p-4 max-lg:max-h-[70dvh] max-lg:min-h-[18rem]" role="tabpanel">
              {panelMissing.length > 0 && tab === "decisoes" && (
                <div className="mb-4">
                  <SetupChecklist missing={panelMissing} guide={status?.guide ?? "/docs/TRELLO-GUIA-COMPLETO.md"} />
                </div>
              )}
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} className="h-full">
                  {tab === "decisoes" && (
                    <DecisionPanel
                      steps={steps}
                      models={status?.capabilities.models ?? { stt: "", jev: null, mimo: null }}
                      transcript={transcript}
                      jev={jevLive}
                      trace={trace}
                      mimoActive={mimoActive}
                      suggestions={examples}
                      onPick={(text) => {
                        setDraft(text);
                        inputRef.current?.focus();
                      }}
                    />
                  )}
                  {tab === "historico" && <HistoryPanel feed={feed} />}
                  {tab === "card" && board && <CardPanel card={selectedCard} board={board} disabled={phase !== "idle"} onCommand={(text) => void runCommand(text, "texto")} />}
                  {tab === "listas" && board && <ListRail board={board} activeListId={activeListId} selectedId={selectedCardId} onSelectList={onSelectList} onSelectCard={onSelectCard} />}
                </motion.div>
              </AnimatePresence>
            </div>
          </aside>
        </div>
      </div>

      <Confetti ref={confettiRef} className="pointer-events-none fixed inset-0 z-[95]" />

      <ToastStack className="right-3! left-auto! mx-0! bottom-4! z-[96] w-[min(20rem,calc(100vw-1.5rem))]! md:right-4!">
        {toasts.map((id) => {
          const data = toastData.find((toast) => toast.id === id);
          return (
            <Toast key={id} className="hud-solid flex items-start gap-2 rounded-xl px-4 py-3 text-sm">
              <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${data?.tone === "error" ? "bg-destructive" : data?.tone === "info" ? "bg-muted-foreground" : "bg-success"}`} />
              <span className="text-pretty text-foreground first-letter:uppercase">{data?.text ?? "…"}</span>
            </Toast>
          );
        })}
      </ToastStack>

      <div aria-live="polite" role="status" className="sr-only">
        {phase === "listening" ? "Ouvindo" : phase === "transcribing" ? "Transcrevendo" : phase === "thinking" ? "Analisando o comando" : phase === "executing" ? "Executando no Trello" : phase === "confirming" ? "Aguardando confirmação" : "Pronto"}
      </div>
    </MotionUIThemeProvider>
  );
}
