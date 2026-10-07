/**
 * Trello Orbit — servidor (proxy de credenciais + estático do front).
 * As chaves ficam só aqui; o navegador conversa apenas com /api/*.
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { capabilities, config } from "./config.js";
import { AppError } from "./lib/errors.js";
import { apiRouter } from "./routes/api.js";
import { getBoardCached } from "./services/board-cache.js";
import { warmJev } from "./services/jev.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.use("/api", apiRouter);

/* Guias e documentação (docs/) — inclui o passo a passo pós-setup. */
app.use("/docs", express.static(path.join(config.repoRoot, "docs"), { maxAge: "1h" }));

/* Front compilado (web/dist) — presente após `npm run build` em web/. */
const webDist = path.join(config.repoRoot, "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(
    express.static(webDist, {
      maxAge: "1h",
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) res.setHeader("cache-control", "no-cache");
      },
    }),
  );
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

/* 404 JSON para rotas desconhecidas. */
app.use((req, res) => {
  res.status(404).json({
    error: { code: "not_found", message: `Rota desconhecida: ${req.method} ${req.path}` },
  });
});

/* Handler de erros — contrato estável { error: { code, message, hint, detail } }. */
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const isMulter = err?.name === "MulterError";
  const status = err instanceof AppError ? err.status : isMulter ? 413 : err.status ?? 500;
  const code = err instanceof AppError ? err.code : isMulter ? "upload_too_large" : "internal_error";
  const message = err instanceof AppError ? err.message : isMulter ? "O arquivo enviado é grande demais." : "Erro interno do servidor.";

  if (!(err instanceof AppError) && status >= 500) {
    console.error("[trello-orbit]", err);
  }
  res.status(status).json({
    error: {
      code,
      message,
      hint: err instanceof AppError ? err.hint : null,
      detail: err instanceof AppError ? err.detail : null,
    },
  });
});

app.listen(config.port, () => {
  const caps = capabilities();
  console.log(`\n  ✦ Trello Orbit · http://localhost:${config.port}`);
  console.log(`    STT: ${caps.stt} · Motor: ${caps.engine}${caps.models.jev ? ` (${caps.models.jev})` : ""} · Reserva: ${caps.fallback}${caps.models.mimo ? ` (${caps.models.mimo})` : ""} · Board: ${caps.board}\n`);
  // Pré-aquece o cache do board e o socket do JEV: o 1º comando já sai rápido.
  void Promise.allSettled([getBoardCached(), warmJev()]);
});
