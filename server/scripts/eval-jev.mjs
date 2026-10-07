#!/usr/bin/env node
/**
 * Eval do JEV com chamadas REAIS (precisa de OPENROUTER_API_KEY). Mede, sobre o
 * board demo, quantos comandos o planner resolve certo, quantos ele recusa
 * (o JEV se abstém → MiMo) e se alguma vez ele AGE errado — o único erro grave.
 *
 *   npm run eval:jev            # todos os casos (≈ $0.003)
 *   npm run eval:jev -- --json  # saída para máquina
 *
 * Rode depois de mexer nas perguntas/rubricas em services/jev-planner.js.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { planWithJev } from "../src/services/jev-planner.js";
import { DemoBoard } from "../src/services/trello.js";

if (!config.openrouter.apiKey) {
  console.error("Erro: falta OPENROUTER_API_KEY — Solução: preencha em .env (o JEV usa a mesma chave do OpenRouter).");
  process.exit(3);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(here, "..", "evals", "commands.json"), "utf8"));
const board = await new DemoBoard().getBoard();
const asJson = process.argv.includes("--json");
const nameOf = (id) => board.cards.find((card) => card.id === id)?.name;
const listOf = (id) => board.lists.find((list) => list.id === id)?.name;

/** No máximo 6 chamadas simultâneas: o eval mede qualidade, não estresse (429/timeout viram "indisponível"). */
async function pool(items, size, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await worker(items[index]);
      }
    }),
  );
  return out;
}

const started = Date.now();
const results = await pool(cases, 6, async (c) => {
    const r = await planWithJev({ transcript: c.say, board });
    const first = r.trace.clauses?.[0];
    const action = r.plan?.actions?.[0];
    let verdict;
    if (c.reject || c.ambiguous) {
      const refused = r.status !== "ok" || (c.ambiguous && r.plan.band !== "auto");
      verdict = refused ? "ok" : "acted-wrong";
    } else if (r.status === "unavailable") {
      verdict = "unavailable";
    } else if (r.status !== "ok") {
      verdict = "abstained";
    } else if (c.n) {
      verdict = r.plan.actions.length === c.n ? "ok" : "acted-wrong";
    } else {
      const typeOk = c.type === "query" ? r.plan.actions.length === 0 : action?.type === c.type;
      const cardOk = !c.card || nameOf(action?.card) === c.card;
      const listOk = !c.list || listOf(action?.list) === c.list || action?.list === c.list;
      verdict = typeOk && cardOk && listOk ? "ok" : "acted-wrong";
    }
    return { say: c.say, verdict, status: r.status, code: r.code ?? null, band: r.plan?.band ?? null, ms: r.trace.latencyMs, intent: first?.decisions?.find((d) => d.id === "intent")?.display };
});

const count = (v) => results.filter((r) => r.verdict === v).length;
const summary = {
  total: results.length,
  ok: count("ok"),
  abstained: count("abstained"),
  unavailable: count("unavailable"),
  actedWrong: count("acted-wrong"),
  wallMs: Date.now() - started,
  p50ms: results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)],
};

if (asJson) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  for (const r of results) {
    const mark = r.verdict === "ok" ? "✔" : r.verdict === "abstained" ? "↪" : r.verdict === "unavailable" ? "…" : "✖";
    console.log(`${mark} ${r.say.padEnd(66)} ${String(r.intent ?? "-").padEnd(18)} ${r.verdict === "abstained" ? `abstém-se (${r.code})` : (r.band ?? "")}`);
  }
  console.log(`\n${summary.ok}/${summary.total} corretos · ${summary.abstained} abstenções (vão para o MiMo) · ${summary.unavailable} indisponíveis · ${summary.actedWrong} AGIU ERRADO · JEV p50 ${summary.p50ms} ms`);
}
// Abster-se é seguro (o MiMo resolve); agir errado não é.
process.exit(summary.actedWrong === 0 ? 0 : 1);
