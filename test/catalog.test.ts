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

test("renderCatalog: lists authenticated models with tier, cost, and current marker", () => {
  const text = renderCatalog(catalogCtx() as any);
  assert.match(text, /1 authenticated provider\(s\), 2 model\(s\)/);
  assert.match(text, /anthropic \(auth: stored\):/);
  assert.match(text, /claude-opus-5-5 — tier: reasoning · ctx 200k · text\+image · \$5\/\$15 per MTok · session: \$1\.25 \(1,000 tok\)  ← current/);
  assert.match(text, /claude-haiku-4-5 — tier: fast/);
  assert.match(text, /Session cost: \$1\.35 \(1,010 tokens\)/);
  // Usage from a model no longer in the registry still shows up, unmatched.
  assert.match(text, /• gone\/retired: \$0\.10 \(10 tok\)/);
  assert.match(text, /Not shown: 1 model\(s\) from 1 provider\(s\) without configured auth\./);
  assert.doesNotMatch(text, /mystery/);
});

test("renderCatalog: quality tiers shown with basis, default basis omitted", () => {
  const policy = {
    tiers: new Map([
      ["anthropic/claude-opus-5-5", { tier: 5, basis: "configured" }],
      ["anthropic/claude-haiku-4-5", { tier: 2, basis: "price-inferred" }],
    ]),
    exclude: new Set<string>(),
  };
  const text = renderCatalog(catalogCtx() as any, policy as any);
  assert.match(text, /claude-opus-5-5 — tier: reasoning · ctx 200k · text\+image · \$5\/\$15 per MTok · quality: 5\/5 \(configured\) · routing: frontier only/);
  assert.match(text, /claude-haiku-4-5 — tier: fast · ctx 200k · text · \$0\.8\/\$4 per MTok · quality: 2\/5 \(price-inferred\) · routing: enabled/);
  // Without a policy the rows are byte-identical to before.
  assert.doesNotMatch(renderCatalog(catalogCtx() as any), /quality:|routing:/);
});

test("renderCatalog: labels enabled, frontier, excluded, and superseded models", () => {
  const models = [
    model({ provider: "anthropic", id: "claude-opus-5-5" }),
    model({ provider: "anthropic", id: "claude-opus-5" }),
    model({ provider: "anthropic", id: "claude-fable-5-1" }),
    model({ provider: "anthropic", id: "claude-sonnet-5-5" }),
    model({ provider: "anthropic", id: "claude-sonnet-5" }),
  ];
  const ctx = {
    ...catalogCtx(), model: models[0],
    modelRegistry: {
      getAvailable: () => models,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderDisplayName: (provider: string) => provider,
    },
  };
  const policy = {
    tiers: new Map([
      ["anthropic/claude-opus-5-5", { tier: 4, basis: "configured" }],
      ["anthropic/claude-opus-5", { tier: 4, basis: "configured" }],
      ["anthropic/claude-fable-5-1", { tier: 5, basis: "configured" }],
      ["anthropic/claude-sonnet-5-5", { tier: 3, basis: "configured" }],
      ["anthropic/claude-sonnet-5", { tier: 3, basis: "configured" }],
    ]),
    exclude: new Set(["anthropic/claude-sonnet-5-5"]),
  };
  const text = renderCatalog(ctx as any, policy as any);
  assert.match(text, /5 model\(s\): 2 enabled · 1 frontier-only · 1 suppressed · 1 excluded/);
  assert.match(text, /claude-opus-5-5 .* routing: enabled/);
  assert.match(text, /claude-opus-5 .* routing: suppressed by claude-opus-5-5/);
  assert.match(text, /claude-fable-5-1 .* routing: frontier only/);
  assert.match(text, /claude-sonnet-5-5 .* routing: excluded/);
  assert.match(text, /claude-sonnet-5 .* routing: enabled/, "an excluded latest version does not suppress the older one");
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
  assert.match(calls[0].message, /Model catalog — 1 authenticated provider\(s\), 2 model\(s\): 0 enabled · 1 frontier-only · 0 suppressed · 1 excluded/);
  assert.match(calls[0].message, /claude-opus-5-5 .* quality: 5\/5 \(configured\) · routing: frontier only/);
  assert.match(calls[0].message, /claude-haiku-4-5 .* routing: excluded/);

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
