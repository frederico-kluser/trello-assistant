#!/usr/bin/env node
/**
 * Eval do pipeline com chamadas REAIS (precisa de OPENROUTER_API_KEY). Mede, sobre
 * o board demo, quantos comandos o planner resolve certo, quantas listagens vêm
 * COMPLETAS (nenhum card esperado omitido) e se alguma vez ele AGE errado — o
 * único erro grave.
 *
 * Comandos ÚNICOS vão direto ao `planWithJev`; os COMPOSTOS (`n:` no commands.json,
 * várias ações numa fala) passam pelo `planCommand` inteiro, porque o caminho
 * deles saiu do JEV: quem planeia o comando completo é o System Two (Gemini 3.8
 * Flash), com o JEV por cláusulas como plano B. Sem fallback genérico: as
 * restantes abstenções (clareza/card/lista) pedem esclarecimento — seguro (nada é
 * executado às cegas), mas é falta de cobertura, não é resposta; fica contado no
 * resumo, não reprova a suíte.
 *
 *   npm run eval:jev            # todos os casos (≈ $0.003)
 *   npm run eval:jev -- --json  # saída para máquina
 *
 * Exit 1 se houver QUALQUER "acted-wrong" ou "listing-miss": agir errado e
 * omitir um card esperado são as duas barras que o eval não deixa passar.
 *
 * Rode depois de mexer nas perguntas/rubricas em services/jev-planner.js ou no
 * roteamento de compostos em services/planner.js.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { planWithJev } from "../src/services/jev-planner.js";
import { planCommand } from "../src/services/planner.js";
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

/** Comparação tolerante de nomes (acentos/caixa/espaços) — o caso escreve o nome exato, mas não queremos falso negativo por formatação. */
const norm = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const namesOf = (listing) => (Array.isArray(listing) ? listing : []).map((item) => item?.name).filter(Boolean);

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

/**
 * Roda UM caso. Comandos compostos (`n:` = várias ações numa fala) passam pelo
 * `planCommand` inteiro — o caminho deles saiu do `planWithJev`: o System Two
 * planeia o comando completo e o JEV por cláusulas é o plano B. O veredicto
 * abaixo continua a comparar `r.plan.actions.length === c.n`, então adaptamos a
 * forma (o planCommand devolve fala/ações no topo, não em `plan`).
 */
async function runCase(c) {
  if (!c.n) return planWithJev({ transcript: c.say, board });
  const r = await planCommand({ transcript: c.say, board });
  return {
    status: r.actions.length ? "ok" : "abstain",
    code: r.actions.length ? null : (r.warning ?? "sem ações"),
    plan: { speech: r.speech, actions: r.actions, band: r.band, needsConfirmation: r.needsConfirmation },
    trace: { engine: r.trace?.engine ?? null, latencyMs: r.trace?.totalMs ?? null, clauses: r.trace?.jev?.clauses ?? r.trace?.clauses ?? [] },
    provider: r.provider,
    model: r.model,
  };
}

const started = Date.now();
const results = await pool(cases, 6, async (c) => {
    const r = await runCase(c);
    const first = r.trace?.clauses?.[0];
    const action = r.plan?.actions?.[0];
    const intent = first?.decisions?.find((d) => d.id === "intent")?.display ?? null;
    // Caso de listagem = tem lista de cards esperados (mesmo vazia) e/ou cards proibidos.
    const isListing = Array.isArray(c.listingIncludes) || Array.isArray(c.listingExcludes);
    const listing = namesOf(r.plan?.listing);
    let verdict;
    let detail = null;

    if (c.reject || c.ambiguous) {
      const refused = r.status !== "ok" || (c.ambiguous && r.plan?.band !== "auto");
      verdict = refused ? "ok" : "acted-wrong";
      if (!refused) detail = "devia recusar e montou plano";
    } else if (c.summary) {
      // Resumo do board: basta haver fala de resumo — não exige plan.listing.
      verdict = r.status === "ok" && r.plan?.speech ? "ok" : "abstained";
      if (verdict === "abstained") detail = `sem fala de resumo (${r.code ?? r.status})`;
    } else if (isListing) {
      if (r.status !== "ok") {
        verdict = r.status === "unavailable" ? "unavailable" : "abstained";
        detail = `${r.code ?? r.status} — listagem não respondida`;
      } else if (!Array.isArray(r.plan?.listing) && !(r.trace?.listing?.evaluated > 0)) {
        // O plano só traz `listing` quando algo passa; ausência é legítima se a
        // cascata rodou (trace.listing.evaluated > 0). Sem isso, a consulta não
        // foi tratada como listagem (virou ação/resumo) — é falha.
        verdict = "listing-miss";
        detail = "sem plan.listing e a cascata não rodou (não foi tratado como listagem)";
      } else {
        const seen = new Set(listing.map(norm));
        const missing = (c.listingIncludes ?? []).filter((name) => !seen.has(norm(name)));
        const unwanted = (c.listingExcludes ?? []).filter((name) => seen.has(norm(name)));
        verdict = missing.length === 0 && unwanted.length === 0 ? "ok" : "listing-miss";
        detail = missing.length
          ? `faltou: ${missing.join(", ")}`
          : unwanted.length
            ? `não devia listar: ${unwanted.join(", ")}`
            : `${listing.length} listados`;
      }
    } else if (r.status === "unavailable") {
      verdict = "unavailable";
      detail = r.code ?? r.status;
    } else if (r.status !== "ok") {
      verdict = "abstained";
      detail = `${r.code ?? r.status} — pede esclarecimento`;
    } else if (c.n) {
      const got = r.plan.actions.length;
      verdict = got === c.n ? "ok" : "acted-wrong";
      if (got !== c.n) detail = `esperado ${c.n} ações, veio ${got}`;
    } else {
      const typeOk = action?.type === c.type;
      const cardOk = !c.card || nameOf(action?.card) === c.card;
      const listOk = !c.list || listOf(action?.list) === c.list || action?.list === c.list;
      verdict = typeOk && cardOk && listOk ? "ok" : "acted-wrong";
      if (verdict === "acted-wrong") {
        const want = `${c.type}${c.card ? ` «${c.card}»` : ""}${c.list ? ` → ${c.list}` : ""}`;
        const got = action ? `${action.type}${action.card ? ` «${nameOf(action.card) ?? action.card}»` : ""}${action.list ? ` → ${listOf(action.list) ?? action.list}` : ""}` : "nenhuma ação";
        detail = `esperado ${want}, veio ${got}`;
      }
    }
    return {
      say: c.say,
      kind: c.reject || c.ambiguous ? "guard" : c.summary ? "summary" : isListing ? "listing" : "crud",
      verdict,
      detail,
      status: r.status,
      code: r.code ?? null,
      provider: r.provider ?? null,
      band: r.plan?.band ?? null,
      intent,
      listing,
      speech: c.summary ? (r.plan?.speech ?? null) : null,
      ms: r.trace?.latencyMs ?? null,
    };
});

const count = (v) => results.filter((r) => r.verdict === v).length;
const latencies = results.map((r) => r.ms).filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b);
const summary = {
  total: results.length,
  ok: count("ok"),
  abstained: count("abstained"),
  unavailable: count("unavailable"),
  listingMiss: count("listing-miss"),
  actedWrong: count("acted-wrong"),
  viaLlm: results.filter((r) => r.provider === "llm").length,
  wallMs: Date.now() - started,
  p50ms: latencies[Math.floor(latencies.length / 2)] ?? null,
};

if (asJson) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  const MARK = { ok: "✔", abstained: "↪", unavailable: "…", "listing-miss": "✖", "acted-wrong": "‼" };
  for (const r of results) {
    // Composto planeado pelo System Two (LLM): vale dizer quem planeou.
    const tail = [r.provider === "llm" ? "System Two" : null, r.detail ?? r.band].filter(Boolean).join(" · ");
    console.log(`${MARK[r.verdict] ?? "?"} ${r.say.padEnd(64)} ${String(r.intent ?? "-").padEnd(16)} ${tail}`);
  }
  console.log("");
  for (const r of results.filter((x) => x.verdict === "acted-wrong" || x.verdict === "listing-miss")) {
    console.log(`${MARK[r.verdict]} ${r.say} → ${r.detail ?? r.verdict}`);
  }
  console.log(`\n${summary.ok}/${summary.total} corretos · ${summary.viaLlm} compostos pelo System Two · ${summary.abstained} pedem esclarecimento · ${summary.unavailable} indisponíveis · ${summary.listingMiss} listagens incompletas · ${summary.actedWrong} AGIU ERRADO · p50 ${summary.p50ms} ms`);
}
// Agir errado é o erro grave; listagem incompleta também reprova (omitir card esperado é barra de qualidade).
process.exit(summary.actedWrong === 0 && summary.listingMiss === 0 ? 0 : 1);