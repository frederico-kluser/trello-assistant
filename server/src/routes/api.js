import { Router } from "express";
import multer from "multer";
import { capabilities, config, missingSetup } from "../config.js";
import { AppError, SETUP_GUIDE } from "../lib/errors.js";
import { transcribeAudio, vocabularyPrompt } from "../services/stt.js";
import { planCommand } from "../services/planner.js";
import { classifyConfirmation } from "../services/jev-planner.js";
import { warmJev } from "../services/jev.js";
import { applyAction, describeAction, normalizeActions, requiresConfirmation } from "../domain/actions.js";
import { getBackend } from "../services/trello.js";
import { getBoardCached, patchBoard, peekBoard, primeBoard, refreshBoardSoon, slimBoard } from "../services/board-cache.js";

export const apiRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.openai.maxUploadBytes },
});

/* ── Estado ───────────────────────────────────────────────────────────── */

apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true, app: config.app.name, time: new Date().toISOString() });
});

/** O que o app está usando e o que falta configurar (sem expor segredos). */
apiRouter.get("/status", async (_req, res) => {
  const backend = getBackend();
  let boardName = "—";
  try {
    boardName = (await getBoardCached({ maxAgeMs: 60_000 })).name;
  } catch {
    /* board indisponível ainda */
  }
  res.json({
    capabilities: capabilities(),
    backend: backend.kind,
    boardName,
    missing: missingSetup(),
    guide: SETUP_GUIDE,
  });
});

apiRouter.get("/board", async (req, res) => {
  const board = await getBoardCached({ maxAgeMs: req.query.fresh ? 0 : 30_000 });
  res.json({ board: slimBoard(board) });
});

/**
 * Chamado quando a gravação COMEÇA: enquanto a pessoa fala (2–4 s) o servidor
 * aquece o socket do JEV e atualiza o board — quando o texto chegar, tudo já está quente.
 */
apiRouter.post("/warm", (_req, res) => {
  res.status(202).json({ ok: true });
  void Promise.allSettled([getBoardCached({ maxAgeMs: 10_000 }), warmJev()]);
});

/* ── Voz → texto (STT OpenAI) ─────────────────────────────────────────── */

apiRouter.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    throw new AppError("bad_request", "Envie o áudio no campo «audio» (multipart/form-data).", { status: 400 });
  }
  const result = await transcribeAudio({
    buffer: req.file.buffer,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    prompt: vocabularyPrompt(peekBoard()),
  });
  res.json(result);
});

/* ── Texto → plano de ações (JEV → MiMo → local) ──────────────────────── */

/**
 * Com `?stream=1` a resposta é um fluxo SSE: o navegador recebe o veredito do
 * JEV na hora (~0,5 s) e, se ele se abstiver, vê "MiMo assumiu" enquanto o
 * raciocínio máximo (alguns segundos) ainda corre. Sem o parâmetro, JSON único.
 */
apiRouter.post("/agent", async (req, res) => {
  const transcript = String(req.body?.transcript ?? "").trim();
  if (!transcript) {
    throw new AppError("bad_request", "Envie o texto transcrito em «transcript».", { status: 400 });
  }
  const context = {
    lastCardId: typeof req.body?.context?.lastCardId === "string" ? req.body.context.lastCardId : null,
  };

  const board = await getBoardCached({ maxAgeMs: 30_000 });
  const stream = req.query.stream === "1";

  if (stream) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
  }
  const send = (event) => {
    if (stream) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const plan = await planCommand({ transcript, board, context, onEvent: send });
    const actions = normalizeActions(plan.actions).map((action) => ({
      ...action,
      description: action.description ?? describeAction(action, board),
      requiresConfirmation: requiresConfirmation(action),
    }));
    const payload = {
      speech: plan.speech,
      needsConfirmation: plan.needsConfirmation || actions.some((action) => action.requiresConfirmation),
      actions,
      provider: plan.provider,
      model: plan.model ?? null,
      band: plan.band ?? null,
      warning: plan.warning ?? null,
      listing: plan.listing ?? [],
      trace: plan.trace,
    };
    if (stream) {
      send({ type: "plan", ...payload });
      res.end();
    } else {
      res.json(payload);
    }
  } catch (err) {
    if (!stream) throw err;
    send({
      type: "error",
      error: { code: err instanceof AppError ? err.code : "internal_error", message: err instanceof AppError ? err.message : "Erro interno do servidor." },
    });
    res.end();
  }
});

/** "sim" / "cancela" falados depois de uma pergunta de confirmação — classificados pelo JEV. */
apiRouter.post("/confirm", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) throw new AppError("bad_request", "Envie a resposta falada em «text».", { status: 400 });
  res.json(await classifyConfirmation(text, { pending: String(req.body?.pending ?? "") }));
});

/* ── Execução das ações (com confirmação obrigatória) ─────────────────── */

apiRouter.post("/actions", async (req, res) => {
  const actions = normalizeActions(req.body?.actions);
  const confirmed = req.body?.confirmed === true;

  if (!actions.length) {
    throw new AppError("bad_request", "Nenhuma ação para executar.", { status: 400 });
  }

  // Trava de segurança: criar/apagar exige confirmação explícita do front.
  if (!confirmed && actions.some(requiresConfirmation)) {
    throw new AppError("confirmation_required", "Esta ação precisa de confirmação antes de executar.", {
      status: 428,
    });
  }

  const backend = getBackend();
  let board = await getBoardCached({ maxAgeMs: 30_000 });
  const results = [];
  for (const action of actions) {
    // O resultado devolvido pelo Trello é aplicado ao cache: a próxima ação do
    // plano já enxerga o efeito da anterior, sem reler o board inteiro.
    const applied = await applyAction(action, { board, backend });
    board = patchBoard(board, [applied]);
    results.push({ ok: true, type: applied.type, message: applied.message, spoken: applied.spoken, cardId: applied.card?.id ?? null });
  }

  primeBoard(board);
  refreshBoardSoon(); // reconcilia em background com o que mudou fora do app
  res.json({ ok: true, results, board: slimBoard(board) });
});

/* ── Setup helper: listar boards do usuário ───────────────────────────── */

apiRouter.get("/trello/boards", async (_req, res) => {
  const backend = getBackend();
  if (backend.kind !== "trello") {
    throw new AppError("missing_trello_credentials", "O Trello ainda não está configurado no servidor.", {
      status: 503,
      hint: `Preencha TRELLO_API_KEY e TRELLO_API_TOKEN — guia: ${SETUP_GUIDE}`,
    });
  }
  res.json({ boards: await backend.listBoards() });
});
