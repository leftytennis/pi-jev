import test from "node:test";
import assert from "node:assert/strict";
import {
  FAST_INPUT_COST_CEILING,
  formatUsd,
  modelTier,
  renderCatalog,
  sessionCosts,
  SUMMARY_BUCKET,
} from "../src/catalog.js";
import { registerJevCommands } from "../src/commands.js";
import type { JevClient } from "../src/jev.js";
import type { ToolRouter } from "../src/router.js";
import type { SkillRouter } from "../src/skills.js";
import type { AutoJev } from "../src/auto.js";

function model(overrides: Record<string, unknown> = {}): any {
  return {
    id: "m",
    name: "m",
    api: "openai-completions",
    provider: "p",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 5, output: 15 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  };
}

test("modelTier: reasoning flag wins regardless of cost", () => {
  assert.equal(modelTier(model({ reasoning: true, cost: { input: 0.1, output: 0.4 } })), "reasoning");
});

test("modelTier: cheap non-reasoning model is fast", () => {
  assert.equal(modelTier(model({ cost: { input: FAST_INPUT_COST_CEILING, output: 2 } })), "fast");
});

test("modelTier: expensive non-reasoning model is balanced", () => {
  assert.equal(modelTier(model({ cost: { input: 5, output: 15 } })), "balanced");
});

test("modelTier: missing cost metadata is balanced, not fast", () => {
  assert.equal(modelTier(model({ cost: undefined })), "balanced");
});

function usage(cost: number, tokens: number) {
  return { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: cost } };
}

test("sessionCosts: attributes assistant usage by provider/responseModel and buckets summaries", () => {
  const entries = [
    { type: "message", message: { role: "assistant", provider: "a", model: "m1", usage: usage(1, 100) } },
    { type: "message", message: { role: "assistant", provider: "a", model: "alias", responseModel: "m1", usage: usage(2, 200) } },
    { type: "message", message: { role: "toolResult", usage: usage(0.5, 50) } },
    { type: "compaction", usage: usage(0.25, 25) },
    { type: "message", message: { role: "user" } },
  ];
  const costs = sessionCosts(entries as any);
  assert.deepEqual(costs.lines, [
    { key: "a/m1", cost: 3, tokens: 300 },
    { key: SUMMARY_BUCKET, cost: 0.75, tokens: 75 },
  ]);
  assert.equal(costs.totalCost, 3.75);
  assert.equal(costs.totalTokens, 375);
});

test("sessionCosts: zero-usage lines are dropped", () => {
  const entries = [
    { type: "message", message: { role: "assistant", provider: "a", model: "m1", usage: usage(0, 0) } },
  ];
  assert.deepEqual(sessionCosts(entries as any).lines, []);
});

test("formatUsd: sub-cent costs keep four decimals", () => {
  assert.equal(formatUsd(0.0042), "$0.0042");
  assert.equal(formatUsd(1.5), "$1.50");
  assert.equal(formatUsd(0), "$0.00");
});

function catalogCtx() {
  const models = [
    model({ provider: "anthropic", id: "claude-opus-5-5", reasoning: true, input: ["text", "image"] }),
    model({ provider: "anthropic", id: "claude-haiku-4-5", cost: { input: 0.8, output: 4 } }),
    model({ provider: "unpaid", id: "mystery" }),
  ];
  return {
    model: models[0],
    modelRegistry: {
      getAvailable: () => models,
      getProviderAuthStatus: (provider: string) =>
        provider === "anthropic" ? { configured: true, source: "stored" } : { configured: false },
      getProviderDisplayName: (provider: string) => provider,
    },
    sessionManager: {
      getEntries: () => [
        { type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: usage(1.25, 1000) } },
        { type: "message", message: { role: "assistant", provider: "gone", model: "retired", usage: usage(0.1, 10) } },
      ],
    },
  };
}

test("renderCatalog: lists authenticated models in aligned columns with cost and current marker", () => {
  const text = renderCatalog(catalogCtx() as any);
  assert.equal(text, [
    "Model catalog — 1 provider, 2 models",
    "Price is $ per million tokens, input / output.",
    "",
    "anthropic (auth: stored)",
    "  MODEL               TYPE       CONTEXT  INPUT       PRICE      SESSION",
    "    claude-haiku-4-5  fast       200k     text        $0.8 / $4",
    "    claude-opus-5-5   reasoning  200k     text+image  $5 / $15   $1.25 · 1,000 tok  ← current",
    "",
    "Session cost: $1.35 (1,010 tokens)",
    "  • gone/retired: $0.10 (10 tok)",
    "Not shown: 1 model(s) from 1 provider(s) without configured auth.",
  ].join("\n"));
});

test("renderCatalog: groups models by routing status, highest quality first", () => {
  const models = [
    model({ provider: "anthropic", id: "claude-opus-5-5" }),
    model({ provider: "anthropic", id: "claude-opus-5" }),
    model({ provider: "anthropic", id: "claude-opus-4-8" }),
    model({ provider: "anthropic", id: "claude-fable-5-1", cost: { input: 0, output: 0 } }),
    model({ provider: "anthropic", id: "claude-sonnet-5-5" }),
    model({ provider: "anthropic", id: "claude-sonnet-5" }),
    model({ provider: "anthropic", id: "claude-haiku-4-5" }),
  ];
  const ctx = {
    ...catalogCtx(), model: models[1],
    modelRegistry: {
      getAvailable: () => models,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderDisplayName: (provider: string) => provider,
    },
    sessionManager: { getEntries: () => [] },
  };
  const policy = {
    tiers: new Map([
      ["anthropic/claude-opus-5-5", { tier: 4, basis: "configured" }],
      ["anthropic/claude-opus-5", { tier: 4, basis: "configured" }],
      ["anthropic/claude-opus-4-8", { tier: 3, basis: "configured" }],
      ["anthropic/claude-fable-5-1", { tier: 5, basis: "configured" }],
      ["anthropic/claude-sonnet-5-5", { tier: 3, basis: "configured" }],
      ["anthropic/claude-sonnet-5", { tier: 3, basis: "configured" }],
      ["anthropic/claude-haiku-4-5", { tier: 1, basis: "price-inferred" }],
    ]),
    exclude: new Set(["anthropic/claude-sonnet-5-5"]),
  };
  assert.equal(renderCatalog(ctx as any, policy as any), [
    "Model catalog — 1 provider, 7 models",
    "Routing: 3 eligible · 1 frontier only · 2 suppressed · 1 excluded",
    "Quality runs 1–5 and ranks models for routing; * means inferred from price, not set in the tier file.",
    "Price is $ per million tokens, input / output.",
    "",
    "anthropic (auth: stored)",
    "  MODEL               QUALITY  TYPE      CONTEXT  INPUT  PRICE",
    "  Eligible",
    "    claude-opus-5-5   4        balanced  200k     text   $5 / $15",
    "    claude-sonnet-5   3        balanced  200k     text   $5 / $15",
    "    claude-haiku-4-5  1*       balanced  200k     text   $5 / $15",
    "  Frontier only — used when a prompt asks for a frontier model",
    "    claude-fable-5-1  5        fast      200k     text   $0",
    "  Suppressed — a newer version is used instead",
    "    claude-opus-5 (current), claude-opus-4-8 → claude-opus-5-5",
    "  Excluded by the tier file",
    "    claude-sonnet-5-5",
    "",
    "Session cost: $0.00 (0 tokens)",
  ].join("\n"));
});

test("renderCatalog: no policy means no routing groups or quality column", () => {
  const text = renderCatalog(catalogCtx() as any);
  assert.doesNotMatch(text, /Routing:|QUALITY|Eligible|Suppressed/);
});

test("/jev catalog: command renders the catalog through ctx.ui.notify", async () => {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi: any = {
    registerCommand: (_name: string, options: any) => {
      handler = options.handler;
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
  };
  registerJevCommands(
    pi,
    { isConfigured: () => true, getKeyOrigin: () => "env", stats: { requestsCount: 0, totalTokens: 0 } } as unknown as JevClient,
    {} as ToolRouter,
    {} as SkillRouter,
    { enabled: false, setEnabled() {} } as unknown as AutoJev,
    {
      enabled: true,
      setEnabled() {},
      catalogPolicy: () => ({
        tiers: new Map([
          ["anthropic/claude-opus-5-5", { tier: 5, basis: "configured" }],
          ["anthropic/claude-haiku-4-5", { tier: 2, basis: "configured" }],
        ]),
        exclude: new Set(["anthropic/claude-haiku-4-5"]),
      }),
    } as any
  );
  assert.ok(handler);

  const calls: Array<{ message: string; level?: string }> = [];
  const ctx = { ...catalogCtx(), ui: { notify: (message: string, level?: string) => calls.push({ message, level }) } };
  await handler!("catalog", ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, "info");
  assert.match(calls[0].message, /^Model catalog — 1 provider, 2 models\nRouting: 0 eligible · 1 frontier only · 0 suppressed · 1 excluded/);
  assert.match(calls[0].message, /Frontier only — used when a prompt asks for a frontier model\n    claude-opus-5-5 +5 /);
  assert.match(calls[0].message, /Excluded by the tier file\n    claude-haiku-4-5\n/);

  // A registry failure surfaces as an error, never a silent no-op.
  const broken = {
    ...ctx,
    modelRegistry: { ...ctx.modelRegistry, getAvailable: () => { throw new Error("registry offline"); } },
  };
  await handler!("catalog", broken);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].level, "error");
  assert.match(calls[1].message, /registry offline/);
});
