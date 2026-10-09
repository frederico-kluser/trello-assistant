/**
 * Contrato da pergunta de desbloqueio no front: a resposta viaja em
 * `context.answer` (/api/agent) e a pergunta gerada na execução chega no
 * `detail` do erro (/api/actions) — pronta para virar botões.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, api } from "../src/lib/api.ts";
import type { PlanQuestion } from "../src/lib/types.ts";

const QUESTION: PlanQuestion = {
  prompt: "Qual card você quer mover?",
  options: [
    { label: "Revisar README", value: "Revisar README" },
    { label: "Comprar cabo HDMI", value: "Comprar cabo HDMI" },
  ],
};

const PLAN = {
  speech: QUESTION.prompt,
  needsConfirmation: false,
  actions: [],
  question: QUESTION,
  provider: "jev",
  model: null,
  band: "abstain",
  warning: null,
  listing: [],
  search: null,
  trace: {},
};

type FetchCall = { url: string; body: unknown };

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const call = { url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return Promise.resolve().then(() => handler(call));
  }) as typeof globalThis.fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("api.agent leva a resposta à pergunta em context.answer", async () => {
  // JSON simples (sem ?stream=1): o mesmo payload entra pelo fallback do SSE.
  const stub = stubFetch(() => jsonResponse({ ...PLAN, type: "plan" }));
  try {
    const plan = await api.agent(
      "move para feito",
      { lastCardId: null, answer: { question: QUESTION.prompt, chosen: "Revisar README" } },
      () => undefined,
      { sessionId: "s-q", history: [] },
      { maxRetries: 0 },
    );
    const body = stub.calls.at(-1)!.body as { context: { answer: { question: string; chosen: string } } };
    assert.equal(body.context.answer.chosen, "Revisar README");
    assert.equal(body.context.answer.question, QUESTION.prompt);
    assert.equal(plan.question?.prompt, QUESTION.prompt); // a pergunta volta no plano
  } finally {
    stub.restore();
  }
});

test("api.execute envia o transcript original para a pergunta de desbloqueio", async () => {
  const stub = stubFetch(() => jsonResponse({ ok: true, results: [], board: { cards: [], lists: [] } }));
  try {
    await api.execute([{ type: "move_card", description: "mover", requiresConfirmation: false, card: "x", list: "y" }], true, "move para feito");
    const body = stub.calls[0].body as { transcript: string };
    assert.equal(body.transcript, "move para feito");
  } finally {
    stub.restore();
  }
});

test("erro de execução com pergunta → ApiError.question e detail (failedIndex/field)", async () => {
  const stub = stubFetch(() =>
    jsonResponse(
      {
        error: {
          code: "ambiguous_reference",
          message: "«revisar» bate com mais de um card.",
          hint: null,
          detail: { field: "card", failedIndex: 1, question: QUESTION, candidates: [{ id: "c1", name: "Revisar README" }] },
        },
      },
      422,
    ),
  );
  try {
    await api.execute([], true, "apaga revisar");
    assert.fail("devia ter lançado");
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "ambiguous_reference");
    assert.equal(err.question?.prompt, QUESTION.prompt);
    assert.equal(err.detail?.failedIndex, 1);
    assert.equal(err.detail?.field, "card");
  } finally {
    stub.restore();
  }
});

test("erro sem pergunta → ApiError.question é null (fluxo de erro comum)", async () => {
  const stub = stubFetch(() => jsonResponse({ error: { code: "trello_unauthorized", message: "Token inválido." } }, 401));
  try {
    await api.execute([], true);
    assert.fail("devia ter lançado");
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.question, null);
    assert.equal(err.detail, null);
  } finally {
    stub.restore();
  }
});
