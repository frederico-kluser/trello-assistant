import { Router } from "express";
import multer from "multer";
import { capabilities, config, missingSetup } from "../config.js";
import { AppError, SETUP_GUIDE } from "../lib/errors.js";
import { transcribeAudio } from "../services/stt.js";
import { planFromTranscript } from "../services/agent.js";
import { applyAction, describeAction, normalizeActions, requiresConfirmation } from "../domain/actions.js";
import { getBackend } from "../services/trello.js";

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
    boardName = (await backend.getBoard()).name;
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

apiRouter.get("/board", async (_req, res) => {
  const board = await getBackend().getBoard();
  res.json({ board });
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
  });
  res.json(result);
});

/* ── Texto → plano de ações (OpenRouter MiMo 2.6 Pro) ─────────────────── */

apiRouter.post("/agent", async (req, res) => {
  const transcript = String(req.body?.transcript ?? "").trim();
  if (!transcript) {
    throw new AppError("bad_request", "Envie o texto transcrito em «transcript».", { status: 400 });
  }

  const backend = getBackend();
  const board = await backend.getBoard();
  const plan = await planFromTranscript({ transcript, board });

  const actions = normalizeActions(plan.actions).map((action) => ({
    ...action,
    description: describeAction(action, board),
    requiresConfirmation: requiresConfirmation(action),
  }));

  res.json({
    speech: plan.speech,
    needsConfirmation: plan.needsConfirmation || actions.some((action) => action.requiresConfirmation),
    actions,
    provider: plan.provider,
    model: plan.model ?? null,
    warning: plan.warning ?? null,
    board,
  });
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
  const results = [];
  for (const action of actions) {
    const board = await backend.getBoard(); // snapshot fresco p/ resolver referências
    const result = await applyAction(action, { board, backend });
    results.push({ ok: true, type: result.type, message: result.message, cardId: result.card?.id ?? null });
  }

  const board = await backend.getBoard();
  res.json({ ok: true, results, board });
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