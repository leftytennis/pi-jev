import test from "node:test";
import assert from "node:assert/strict";
import { classifyModelError, classifyModelNeed, AutoModelRouter, describeRouteStatus, parseDurationMs, parseResetHeader, quotaWindowFor, DEFAULT_QUOTA_WINDOW_MS, generationOf, compareGeneration, familyOf, requestsFrontierModel, scopeMatchesModel, applyModelTierPolicy } from "../src/model-router.js";
import { JevClient } from "../src/jev.js";
import { parseTierOverlay, type TierTable } from "../src/tiers.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id, provider: "test", name: id, api: "test", baseUrl: "", reasoning: false,
  input: ["text"], cost: { input: 1, output: 1 }, contextWindow: 128000, maxTokens: 4096, ...extra,
}) as any;

test("classifies model needs by task signals", () => {
  assert.equal(classifyModelNeed("plan a security decision").profile, "reasoning");
  assert.equal(classifyModelNeed("inspect this screenshot", 0, true).profile, "vision");
  assert.equal(classifyModelNeed("review the entire codebase").profile, "long-context");
  assert.equal(classifyModelNeed("hi, list files").profile, "fast");
});

test("classifies provider limit errors", () => {
  assert.equal(classifyModelError(new Error("429 rate limit")), "rate-limit");
  assert.equal(classifyModelError(new Error("context window exceeded")), "context-limit");
  assert.equal(classifyModelError(new Error("quota exceeded")), "quota");
});

test("abstains in subagent child sessions to protect the launch model contract", async () => {
  let selected = 0;
  const fast = model("fast");
  const reasoning = model("reasoning", { reasoning: true, contextWindow: 200000 });
  const pi: any = { setModel: async () => { selected++; } };
  const ctx: any = {
    model: fast,
    modelRegistry: { getAvailable: () => [fast, reasoning] },
    getSystemPrompt: () => "",
    sessionManager: { getSessionName: () => "subagent-delegate-4163dd64-1" },
  };
  const router = new AutoModelRouter(pi, true);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.skipped, "subagent-session");
  assert.equal(result.changed, false);
  assert.equal(selected, 0);
});

test("selects available model and skips unchanged selection", async () => {
  let selected = 0;
  const fast = model("fast");
  const reasoning = model("reasoning", { reasoning: true, contextWindow: 200000 });
  const pi: any = { setModel: async () => { selected++; } };
  const ctx: any = {
    model: fast,
    modelRegistry: { getAvailable: () => [fast, reasoning] },
    getSystemPrompt: () => "",
  };
  const router = new AutoModelRouter(pi, true);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.model?.id, "reasoning");
  assert.equal(selected, 1);
  ctx.model = reasoning;
  const unchanged = await router.route("plan a safe migration", ctx);
  assert.equal(unchanged.changed, false);
  assert.equal(selected, 1);
});

const ctxWith = (models: any[]) =>
  ({ model: model("current"), modelRegistry: { getAvailable: () => models }, getSystemPrompt: () => "" }) as any;

const usageReport = (entries: Array<[string, number, { limitReached?: boolean; error?: string; windows?: any[] }?]>) => ({
  platforms: entries.map(([provider, usedPercent, extra]) => ({
    provider,
    platform: provider,
    limitReached: extra?.limitReached || undefined,
    windows: extra?.error ? [] : (extra?.windows ?? [{ label: "5-hour", usedPercent }]),
    error: extra?.error,
  })),
  unsupported: [],
});

const quotaRouter = (report: unknown, calls?: { n: number }, tierTable?: TierTable) =>
  new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, {
    tierTable,
    quotaSource: async () => {
      if (calls) calls.n++;
      return report as any;
    },
  });

// Same-provider Claude models pinned to one tier. Callers pass ids of equal
// generation, so the newest-version-per-tier policy keeps both for quota to decide.
const claudeTiers = (...ids: string[]): TierTable =>
  new Map(ids.map((id) => [`claude-bridge/${id}`, { tier: 3 as const, basis: "configured" as const }]));

test("excludes a provider whose fullest quota window is exhausted", async () => {
  const claude = model("fable", { provider: "claude-bridge", reasoning: true, contextWindow: 1000000 });
  const zai = model("glm", { provider: "zai", reasoning: true, contextWindow: 1000000 });
  // Without quota pressure the deterministic tiebreak favors claude-bridge.
  const plain = new AutoModelRouter({ setModel: async () => {} } as any, true);
  assert.equal((await plain.route("plan a safe migration", ctxWith([claude, zai]))).model?.provider, "claude-bridge");
  const result = await quotaRouter(usageReport([["claude-bridge", 100]])).route("plan a safe migration", ctxWith([claude, zai]));
  assert.equal(result.model?.provider, "zai");
  assert.match(result.reason, /quota: claude-bridge over quota \(5-hour 100% used\): excluded/);
});

test("a provider past the demote threshold loses score ties", async () => {
  const hot = model("a", { provider: "aaa-hot", reasoning: true, contextWindow: 200000 });
  const cool = model("z", { provider: "zzz-cool", reasoning: true, contextWindow: 200000 });
  const plain = new AutoModelRouter({ setModel: async () => {} } as any, true);
  assert.equal((await plain.route("plan a safe migration", ctxWith([hot, cool]))).model?.provider, "aaa-hot");
  const result = await quotaRouter(usageReport([["aaa-hot", 75]])).route("plan a safe migration", ctxWith([hot, cool]));
  assert.equal(result.model?.provider, "zzz-cool");
  assert.match(result.reason, /aaa-hot quota hot \(5-hour 75% used\): loses ties/);
});

test("over-quota models stay eligible when they alone satisfy the vision gate", async () => {
  const seer = model("seer", { provider: "claude-bridge", input: ["text", "image"] });
  const blind = model("blind", { provider: "zai" });
  const result = await quotaRouter(usageReport([["claude-bridge", 100]])).route("inspect this screenshot", ctxWith([seer, blind]), { hasImages: true });
  assert.equal(result.model?.provider, "claude-bridge");
  assert.match(result.reason, /kept, no alternative satisfies the hard requirement/);
});

test("a platform-reported limit excludes even below the percent threshold", async () => {
  const codex = model("astra", { provider: "openai-codex", reasoning: true, contextWindow: 272000 });
  const zai = model("glm", { provider: "zai", reasoning: true, contextWindow: 1000000 });
  const result = await quotaRouter(usageReport([["openai-codex", 40, { limitReached: true }]])).route("plan a safe migration", ctxWith([codex, zai]));
  assert.equal(result.model?.provider, "zai");
  assert.match(result.reason, /limit reached/);
});

test("scopeMatchesModel binds a platform scope name to catalog model ids", () => {
  assert.equal(scopeMatchesModel("Fable", "claude-fable-5-1"), true);
  assert.equal(scopeMatchesModel("Fable", "claude-fable-5"), true);
  assert.equal(scopeMatchesModel("Fable", "claude-opus-5-5"), false);
  assert.equal(scopeMatchesModel("Claude Sonnet 4.5", "claude-sonnet-4-5"), true);
  assert.equal(scopeMatchesModel("Claude Sonnet 4.5", "claude-opus-4-5"), false);
  // Purely numeric scopes would match every id; they bind nothing.
  assert.equal(scopeMatchesModel("5.5", "claude-fable-5-1"), false);
});

test("a hit per-model scoped limit excludes only the scoped model, not the provider's other models", async () => {
  const fable = model("claude-fable-5-1", { provider: "claude-bridge", reasoning: true, contextWindow: 1000000 });
  const opus = model("claude-opus-5-1", { provider: "claude-bridge", reasoning: true, contextWindow: 200000 });
  const claudeQuota = usageReport([[
    "claude-bridge", 17,
    { windows: [
      { label: "5-hour", usedPercent: 23 },
      { label: "weekly", usedPercent: 17 },
      { label: "weekly (Fable)", usedPercent: 95, scopeModel: "Fable" },
    ] },
  ]]);
  const table = claudeTiers(fable.id, opus.id);
  // Fable's 1M context wins outright without quota pressure.
  const plain = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, { tierTable: table });
  assert.equal((await plain.route("plan a safe migration", ctxWith([fable, opus]))).model?.id, "claude-fable-5-1");
  // The Fable-scoped bucket is hit, but the provider's unscoped windows (fullest 23%) are fine:
  // Fable is excluded and opus — same provider — stays eligible.
  const result = await quotaRouter(claudeQuota, undefined, table).route("plan a safe migration", ctxWith([fable, opus]));
  assert.equal(result.model?.id, "claude-opus-5-1");
  assert.match(result.reason, /weekly \(Fable\) 95% used: Fable-scoped models excluded/);
  assert.doesNotMatch(result.reason, /claude-bridge over quota/);
});

test("a hot per-model scoped limit demotes only the scoped model in score ties", async () => {
  const fable = model("claude-fable-5-1", { provider: "claude-bridge", reasoning: true, contextWindow: 200000 });
  const opus = model("claude-opus-5-1", { provider: "claude-bridge", reasoning: true, contextWindow: 200000 });
  const claudeQuota = usageReport([[
    "claude-bridge", 17,
    { windows: [
      { label: "5-hour", usedPercent: 23 },
      { label: "weekly", usedPercent: 17 },
      { label: "weekly (Fable)", usedPercent: 75, scopeModel: "Fable" },
    ] },
  ]]);
  const table = claudeTiers(fable.id, opus.id);
  // Equal models: without pressure the key tiebreak favors fable alphabetically.
  const plain = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, { tierTable: table });
  assert.equal((await plain.route("plan a safe migration", ctxWith([fable, opus]))).model?.id, "claude-fable-5-1");
  const result = await quotaRouter(claudeQuota, undefined, table).route("plan a safe migration", ctxWith([fable, opus]));
  assert.equal(result.model?.id, "claude-opus-5-1");
  assert.match(result.reason, /Fable-scoped models lose ties/);
  assert.doesNotMatch(result.reason, /claude-bridge quota hot/);
});

test("a hit Fable limit leaves other Claude models routable when tier policy already removed Fable", async () => {
  // Live shape: Fable is tier 5, so without a frontier request it never reaches the pool.
  // Its exhausted bucket must not turn into a provider-wide exclusion.
  const fable = model("claude-fable-5-1", { provider: "claude-bridge", reasoning: true, contextWindow: 1000000 });
  const opus = model("claude-opus-5-5", { provider: "claude-bridge", reasoning: true, contextWindow: 1000000 });
  const glm = model("glm-5.3", { provider: "zai", reasoning: true, contextWindow: 200000 });
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, {
    tierTable: tiers({ "claude-bridge/claude-fable-5-1": 5, "claude-bridge/claude-opus-5-5": 4, "zai/glm-5.3": 4 }),
    quotaSource: async () => usageReport([[
      "claude-bridge", 17,
      { windows: [
        { label: "5-hour", usedPercent: 23 },
        { label: "weekly", usedPercent: 17 },
        { label: "weekly (Fable)", usedPercent: 100, scopeModel: "Fable" },
      ] },
    ], ["zai", 5]]) as any,
  });
  const result = await router.route("plan a safe migration", ctxWith([fable, opus, glm]));
  assert.equal(result.model?.id, "claude-opus-5-5");
  assert.doesNotMatch(result.reason, /claude-bridge over quota/);
  assert.doesNotMatch(result.reason, /Fable-scoped models excluded/, "nothing to exclude: Fable was never in the pool");
});

test("a scoped limit whose name matches no catalog model falls back to provider-wide", async () => {
  const opus = model("claude-opus-5-5", { provider: "claude-bridge", reasoning: true, contextWindow: 200000 });
  const glm = model("glm", { provider: "zai", reasoning: true, contextWindow: 200000 });
  const unmatchable = usageReport([[
    "claude-bridge", 17,
    { windows: [
      { label: "5-hour", usedPercent: 23 },
      { label: "weekly", usedPercent: 17 },
      { label: "weekly (Zorblax)", usedPercent: 100, scopeModel: "Zorblax" },
    ] },
  ]]);
  const result = await quotaRouter(unmatchable).route("plan a safe migration", ctxWith([opus, glm]));
  assert.equal(result.model?.provider, "zai");
  assert.match(result.reason, /claude-bridge over quota \(weekly \(Zorblax\) 100% used\): excluded/);
});

test("the quota snapshot is cached across routes", async () => {
  const calls = { n: 0 };
  const router = quotaRouter(usageReport([]), calls);
  await router.route("plan a safe migration", ctxWith([model("m")]));
  await router.route("plan a safe migration", ctxWith([model("m")]));
  assert.equal(calls.n, 1);
});

test("a failing quota poll leaves routing untouched", async () => {
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, {
    quotaSource: async () => {
      throw new Error("boom");
    },
  });
  const result = await router.route("plan a safe migration", ctxWith([model("fast"), model("reasoning", { reasoning: true, contextWindow: 200000 })]));
  assert.equal(result.model?.id, "reasoning");
  assert.doesNotMatch(result.reason, /quota:/);
});

test("a platform whose usage read failed exerts no pressure", async () => {
  const claude = model("fable", { provider: "claude-bridge", reasoning: true, contextWindow: 1000000 });
  const zai = model("glm", { provider: "zai", reasoning: true, contextWindow: 1000000 });
  const result = await quotaRouter(usageReport([["claude-bridge", 0, { error: "HTTP 401" }]])).route("plan a safe migration", ctxWith([claude, zai]));
  assert.equal(result.model?.provider, "claude-bridge");
  assert.doesNotMatch(result.reason, /quota:/);
});

test("routes to openai-codex/gpt-6-astra when claude-bridge is over quota", async () => {
  // Mirrors the live pool: Claude's 5-hour window is exhausted, and astra
  // competes against glm-5.3-flash. Plain heuristic ranking prefers fable
  // (tiebreak), then glm (1M context) once Claude leaves — Jev fit scoring is
  // what puts astra ahead, and the excluded provider never reaches scoring.
  const fable = model("claude-fable-5-1", { provider: "claude-bridge", reasoning: true, contextWindow: 1000000, cost: { input: 10, output: 30 } });
  const astra = model("gpt-6-astra", { provider: "openai-codex", reasoning: true, contextWindow: 272000, cost: { input: 10, output: 50 } });
  const glm = model("glm-5.3-flash", { provider: "zai", reasoning: true, contextWindow: 1000000, cost: { input: 0.075, output: 0.25 } });
  const pi: any = { setModel: async () => {} };
  const ctx = ctxWith([fable, astra, glm]);

  const plain = new AutoModelRouter(pi, true);
  assert.equal((await plain.route("Use a frontier model. Plan the schema migration rollout", ctx)).model?.id, "claude-fable-5-1");

  const requests: any[] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      requests.push(req);
      if (req.questions.profile) {
        return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9, distribution: { reasoning: 0.9, balanced: 0.1 } } }, model: "jev-latest", elapsedMs: 1 };
      }
      return {
        answers: Object.fromEntries(Object.keys(req.questions).map((q, i) => [
          q,
          { type: "score", value: `${req.state.candidates[i].provider}/${req.state.candidates[i].model}` === "openai-codex/gpt-6-astra" ? 4 : 2, confidence: 0.9 },
        ])),
        model: "jev-latest", elapsedMs: 1,
      };
    },
  };
  const router = new AutoModelRouter(pi, true, jev, { quotaSource: async () => usageReport([["claude-bridge", 100]]) as any });
  const result = await router.route("Use a frontier model. Plan the schema migration rollout", ctx);
  assert.equal(result.model?.provider, "openai-codex");
  assert.equal(result.model?.id, "gpt-6-astra");
  assert.match(result.reason, /jev scoring/);
  assert.match(result.reason, /claude-bridge over quota \(5-hour 100% used\): excluded/);
  // The excluded provider's models are removed before Jev scores the pool.
  const scored = requests[1].state.candidates.map((c: any) => `${c.provider}/${c.model}`).sort();
  assert.deepEqual(scored, ["openai-codex/gpt-6-astra", "zai/glm-5.3-flash"]);
});

const tiers = (entries: Record<string, 1 | 2 | 3 | 4 | 5>): TierTable =>
  new Map(Object.entries(entries).map(([key, tier]) => [key, { tier, basis: "configured" as const }]));

test("quota headroom breaks ties toward the least-consumed subscription", async () => {
  const hot = model("m", { provider: "aaa-quota", reasoning: true, contextWindow: 200000 });
  const cool = model("m", { provider: "zzz-quota", reasoning: true, contextWindow: 200000 });
  // Without quota data the deterministic key tiebreak favors aaa-quota.
  const plain = new AutoModelRouter({ setModel: async () => {} } as any, true);
  assert.equal((await plain.route("plan a safe migration", ctxWith([hot, cool]))).model?.provider, "aaa-quota");
  // 60% is below the demote threshold, so this is the headroom tiebreak, not demotion.
  const result = await quotaRouter(usageReport([["aaa-quota", 60], ["zzz-quota", 10]])).route("plan a safe migration", ctxWith([hot, cool]));
  assert.equal(result.model?.provider, "zzz-quota");
  assert.match(result.reason, /headroom tiebreak: zzz-quota at 10% over aaa-quota at 60%/);
});

test("providers without quota data lose ties to known headroom", async () => {
  const unknown = model("m", { provider: "aaa-unknown", reasoning: true, contextWindow: 200000 });
  const known = model("m", { provider: "zzz-known", reasoning: true, contextWindow: 200000 });
  const result = await quotaRouter(usageReport([["zzz-known", 10]])).route("plan a safe migration", ctxWith([unknown, known]));
  assert.equal(result.model?.provider, "zzz-known", "known headroom beats unknown despite the key order");
});

test("quota headroom breaks Jev score ties", async () => {
  const codex = model("m", { provider: "openai-codex", reasoning: true, contextWindow: 200000 });
  const kimi = model("m", { provider: "kimi-coding", reasoning: true, contextWindow: 200000 });
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => req.questions.profile
      ? { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9, distribution: { reasoning: 0.9, balanced: 0.1 } } }, model: "jev-latest", elapsedMs: 1 }
      : { answers: Object.fromEntries(Object.keys(req.questions).map((q) => [q, { type: "score", value: 3, confidence: 0.8 }])), model: "jev-latest", elapsedMs: 1 },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev, {
    quotaSource: async () => usageReport([["openai-codex", 55], ["kimi-coding", 5]]) as any,
  });
  const result = await router.route("plan a safe migration", ctxWith([codex, kimi]));
  assert.equal(result.model?.provider, "kimi-coding");
  assert.match(result.reason, /headroom tiebreak: kimi-coding at 5% over openai-codex at 55%/);
});

test("tier flips the heuristic pick among structurally identical models", async () => {
  const economy = model("econ", { reasoning: true, contextWindow: 272000 });
  const flagship = model("flag", { reasoning: true, contextWindow: 272000 });
  const pi: any = { setModel: async () => {} };
  const ctx = ctxWith([economy, flagship]);
  // Without tiers the deterministic key tiebreak picks "econ".
  const plain = new AutoModelRouter(pi, true);
  assert.equal((await plain.route("Use a frontier model. Plan a safe migration", ctx)).model?.id, "econ");
  const router = new AutoModelRouter(pi, true, undefined, { tierTable: tiers({ "test/econ": 1, "test/flag": 5 }) });
  const result = await router.route("Use a frontier model. Plan a safe migration", ctx);
  assert.equal(result.model?.id, "flag");
  assert.match(result.reason, /heuristic scoring; quality 5\/5 configured/);
});

test("fast profile keeps cost dominant and ignores tier", async () => {
  const cheap = model("cheap", { cost: { input: 0.1, output: 0.1 } });
  const dear = model("dear", { cost: { input: 10, output: 10 } });
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, {
    tierTable: tiers({ "test/dear": 5, "test/cheap": 1 }),
  });
  const result = await router.route("hi", ctxWith([cheap, dear]));
  assert.equal(result.model?.id, "cheap");
  assert.match(result.reason, /heuristic scoring; quality 1\/5 configured/);
});

test("jev scoring state carries quality tiers, basis, and the scale guidance", async () => {
  const cheap = model("cheap", { reasoning: true, contextWindow: 200000 });
  const deep = model("deep", { reasoning: true, contextWindow: 200000 });
  const requests: any[] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      requests.push(req);
      if (req.questions.profile) {
        return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9, distribution: { reasoning: 0.9, balanced: 0.1 } } }, model: "jev-latest", elapsedMs: 1 };
      }
      return {
        answers: Object.fromEntries(Object.keys(req.questions).map((q, i) => [
          q, { type: "score", value: req.state.candidates[i].model === "deep" ? 4 : 2, confidence: 0.9 },
        ])),
        model: "jev-latest", elapsedMs: 1,
      };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev, { tierTable: tiers({ "test/deep": 5 }) });
  const result = await router.route("Use a frontier model. Plan a safe migration", ctxWith([cheap, deep]));
  assert.equal(result.model?.id, "deep");
  assert.match(result.reason, /jev scoring; quality 5\/5 configured/);
  const scoring = requests[1];
  const byId = Object.fromEntries(scoring.state.candidates.map((c: any) => [c.model, c]));
  assert.equal(byId.deep.quality_tier, 5);
  assert.equal(byId.deep.quality_tier_basis, "configured");
  // cheap shares the provider's two-model price tie and lands on the higher tier.
  assert.equal(byId.cheap.quality_tier, 4);
  assert.equal(byId.cheap.quality_tier_basis, "price-inferred");
  assert.match(scoring.questions.fit_0.instructions, /scale 1 \(economy\) to 5 \(flagship\)/);
  assert.match(scoring.state.task.classified_need.guidance, /quality_tier/);
});

test("tiers come from the full registry, never the scoped pool", async () => {
  const luna = model("luna", { provider: "codex", cost: { input: 0.1, output: 0.5 } });
  const astra = model("astra", { provider: "codex", cost: { input: 10, output: 50 } });
  const other = model("other", { provider: "zai", reasoning: true });
  const requests: any[] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      requests.push(req);
      if (req.questions.profile) {
        return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9 } }, model: "jev-latest", elapsedMs: 1 };
      }
      return { answers: Object.fromEntries(Object.keys(req.questions).map((q) => [q, { type: "score", value: 3, confidence: 0.9 }])), model: "jev-latest", elapsedMs: 1 };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  // luna is not a candidate here, but the Codex ladder must still rank astra
  // above it — computed from the registry, not the two-model scoped pool.
  await router.route("plan a safe migration", {
    ...ctxWith([luna, astra, other]),
    scopedModels: [astra, other].map((m) => ({ model: m })),
  });
  const candidates = requests[1].state.candidates;
  assert.equal(candidates.some((c: any) => c.model === "luna"), false);
  assert.equal(candidates.find((c: any) => c.model === "astra").quality_tier, 4, "two-model ladder: astra is the greater");
});

test("a malformed overlay warns once and routing falls back to price inference", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jev-tiers-")), "bad.json");
  fs.writeFileSync(file, "{ not json");
  const statuses: string[] = [];
  const ctx: any = {
    ...ctxWith([model("a", { cost: { input: 1, output: 1 } }), model("b", { cost: { input: 9, output: 9 } })]),
    ui: { setStatus: (_key: string, text: string) => statuses.push(text) },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, { tierOverlayPath: file });
  const table = router.tiersFor(ctx);
  router.tiersFor(ctx);
  assert.equal(statuses.length, 1);
  assert.match(statuses[0], /tier overlay invalid/);
  assert.equal(table.get("test/a")?.tier, 2, "price ladder still applies");
  assert.equal(table.get("test/b")?.tier, 4);
});

test("a missing overlay file is silent and yields price-inferred tiers", async () => {
  const statuses: string[] = [];
  const ctx: any = {
    ...ctxWith([model("a", { cost: { input: 1, output: 1 } }), model("b", { cost: { input: 9, output: 9 } })]),
    ui: { setStatus: (_key: string, text: string) => statuses.push(text) },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, { tierOverlayPath: "/nonexistent/jev-model-tiers.json" });
  const table = router.tiersFor(ctx);
  assert.equal(statuses.length, 0);
  assert.equal(table.get("test/b")?.basis, "price-inferred");
});

test("overlay file path comes from PI_JEV_MODEL_TIERS when set", () => {
  const parsed = parseTierOverlay(JSON.stringify({ tiers: { "openai-codex/gpt-6-astra": "flagship" } }));
  assert.ok("tiers" in parsed);
  assert.deepEqual(parsed.tiers.get("openai-codex/gpt-6-astra"), { tier: 5, basis: "configured" });
});

test("blocks quota model for future fallback", () => {
  const current = model("quota-model");
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true);
  assert.equal(router.recordProviderResponse(429, current), "rate-limit");
});

test("parses duration strings for quota windows", () => {
  assert.equal(parseDurationMs("45s"), 45_000);
  assert.equal(parseDurationMs("30m"), 1_800_000);
  assert.equal(parseDurationMs("5h"), 18_000_000);
  assert.equal(parseDurationMs("7d"), 604_800_000);
  assert.equal(parseDurationMs("5"), undefined);
  assert.equal(parseDurationMs("hours"), undefined);
  assert.equal(parseDurationMs(undefined), undefined);
});

test("quota windows come from env overrides, provider defaults, then the generic window", () => {
  assert.equal(quotaWindowFor("openai-codex"), 5 * 60 * 60 * 1000);
  assert.equal(quotaWindowFor("totally-unknown"), DEFAULT_QUOTA_WINDOW_MS);
  const env = { PI_JEV_QUOTA_WINDOW: "45m", PI_JEV_QUOTA_WINDOW_OPENAI_CODEX: "2h" };
  assert.equal(quotaWindowFor("openai-codex", env), 2 * 60 * 60 * 1000);
  assert.equal(quotaWindowFor("claude-bridge", env), 45 * 60 * 1000);
});

test("parses provider-reported reset times", () => {
  const now = Date.parse("2026-03-02T10:00:00Z");
  assert.equal(parseResetHeader("30", now), now + 30_000);
  assert.equal(parseResetHeader("1780000000", now), 1_780_000_000_000);
  assert.equal(parseResetHeader("1780000000000", now), 1_780_000_000_000);
  assert.equal(parseResetHeader("2026-03-02T11:00:00Z", now), now + 3_600_000);
  assert.equal(parseResetHeader("Mon, 02 Mar 2026 11:00:00 GMT", now), now + 3_600_000);
  assert.equal(parseResetHeader("soon", now), undefined);
  assert.equal(parseResetHeader(undefined, now), undefined);
});

test("usage limits back off until the reported reset or the next quota window", () => {
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true);
  const before = Date.now();

  // A provider-reported reset wins: Retry-After of 30 seconds.
  const codex = model("codex", { provider: "openai-codex" });
  assert.equal(router.recordProviderResponse(429, codex, { "Retry-After": "30" }), "rate-limit");
  const reported = router.blockedUntil(codex)!;
  assert.ok(reported >= before + 29_000 && reported <= before + 31_500, `reported reset ${reported}`);

  // No reset header: the provider's default window, openai-codex = 5 hours.
  const codexQuiet = model("codex-quiet", { provider: "openai-codex" });
  assert.equal(router.recordProviderResponse(402, codexQuiet), "quota");
  const windowed = router.blockedUntil(codexQuiet)!;
  assert.ok(windowed >= before + 5 * 3_600_000 - 1_000, `window backoff ${windowed}`);

  // An absurd reset is capped so a model cannot be parked for good.
  const absurd = model("absurd");
  router.recordProviderResponse(429, absurd, { "x-ratelimit-reset": String(before + 30 * 24 * 3_600_000) });
  const capped = router.blockedUntil(absurd)!;
  assert.ok(capped <= before + 7 * 24 * 3_600_000 + 1_000, `capped backoff ${capped}`);

  // Non-usage failures keep the short backoff.
  const flaky = model("flaky");
  router.recordProviderResponse(503, flaky);
  const short = router.blockedUntil(flaky)!;
  assert.ok(short >= before + 59_000 && short <= before + 61_500, `short backoff ${short}`);

  // A model that is not blocked reports no reset time.
  assert.equal(router.blockedUntil(model("never-hit")), undefined);
});

test("scores candidates with jev when configured", async () => {
  const weak = model("cheap", { reasoning: true, input: ["text", "image"], contextWindow: 1000000 });
  const strong = model("deep", { reasoning: true, contextWindow: 200000 });
  const pi: any = { setModel: async () => {} };
  const ctx: any = {
    model: model("other"),
    modelRegistry: { getAvailable: () => [weak, strong] },
    getSystemPrompt: () => "",
  };
  const requests: any[] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      requests.push(req);
      if (req.questions.profile) {
        return {
          answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9, distribution: { reasoning: 0.92, "long-context": 0.05, balanced: 0.03 } } },
          model: "jev-latest", elapsedMs: 1,
        };
      }
      // Heuristic would prefer `cheap` (1M context + image) for reasoning; Jev prefers `deep`.
      return {
        answers: Object.fromEntries(Object.keys(req.questions).map((q) => [
          q, { type: "score", value: req.state.candidates[q === "fit_0" ? 0 : 1].model === "deep" ? 4 : 1, confidence: 0.9 },
        ])),
        model: "jev-latest", elapsedMs: 1,
      };
    },
  };
  const router = new AutoModelRouter(pi, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.model?.id, "deep");
  assert.match(result.reason, /Jev classified as reasoning/);
  assert.match(result.reason, /jev scoring/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].questions.profile.type, "choice");
  assert.deepEqual(requests[0].questions.profile.criteria, {
    fast: "A short, simple request where low latency and low cost matter more than deep reasoning.",
    balanced: "General assistance with no specialized capability clearly dominating.",
    reasoning: "A request needing multi-step reasoning, careful analysis, planning, debugging, or trade-off evaluation.",
    "long-context": "A request needing many files or a large body of material held in context at once.",
    vision: "A request involving image input or understanding visual content.",
  });
  assert.equal(requests[1].state.task.classified_need.profile, "reasoning");
  assert.equal(requests[1].state.task.classified_need.secondary_profile, undefined, "a confident single profile is not combined");
  assert.equal(result.secondaryProfile, undefined);
});

test("falls back to heuristic scoring when jev fails", async () => {
  const weak = model("cheap", { reasoning: true, input: ["text", "image"], contextWindow: 1000000 });
  const strong = model("deep", { reasoning: true, contextWindow: 200000 });
  const pi: any = { setModel: async () => {} };
  const ctx: any = {
    model: model("other"),
    modelRegistry: { getAvailable: () => [weak, strong] },
    getSystemPrompt: () => "",
  };
  let calls = 0;
  const jev: any = { isConfigured: () => true, evaluate: async () => { calls++; throw new Error("boom"); } };
  const router = new AutoModelRouter(pi, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.model?.id, "cheap");
  assert.match(result.reason, /heuristic scoring/);
  assert.equal(calls, 1, "does not retry Jev scoring after classification fails");
});

test("falls back to local classification when Jev classification is malformed", async () => {
  const cheap = model("cheap", { reasoning: true, contextWindow: 1000000 });
  const deep = model("deep", { reasoning: true, contextWindow: 200000 });
  const ctx: any = {
    model: model("other"), modelRegistry: { getAvailable: () => [cheap, deep] }, getSystemPrompt: () => "",
  };
  let calls = 0;
  const jev: any = {
    isConfigured: () => true,
    evaluate: async () => { calls++; return { answers: { profile: { type: "score", value: 4 } } }; },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.profile, "long-context");
  assert.equal(result.model?.id, "cheap");
  assert.match(result.reason, /heuristic scoring/);
  assert.equal(calls, 1);
});

test("falls back to heuristic scoring when a jev answer is malformed", async () => {
  const a = model("a", { reasoning: true, contextWindow: 1000000 });
  const b = model("b", { reasoning: true, contextWindow: 200000 });
  const pi: any = { setModel: async () => {} };
  const ctx: any = {
    model: model("other"),
    modelRegistry: { getAvailable: () => [a, b] },
    getSystemPrompt: () => "",
  };
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => req.questions.profile
      ? { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9 } }, model: "jev-latest", elapsedMs: 1 }
      : { answers: {}, model: "jev-latest", elapsedMs: 1 },
  };
  const router = new AutoModelRouter(pi, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.model?.id, "a");
  assert.match(result.reason, /heuristic scoring/);
});

test("never routes image requests to text-only models under jev scoring", async () => {
  const textOnly = model("textonly", { reasoning: true, contextWindow: 1000000 });
  const visual = model("visual", { reasoning: true, input: ["text", "image"], contextWindow: 200000 });
  const pi: any = { setModel: async () => {} };
  const ctx: any = {
    model: model("other"),
    modelRegistry: { getAvailable: () => [textOnly, visual] },
    getSystemPrompt: () => "",
  };
  const requests: any[] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      requests.push(req);
      if (req.questions.profile) {
        return { answers: { profile: { type: "choice", value: "vision", confidence: 0.9 } }, model: "jev-latest", elapsedMs: 1 };
      }
      return {
        answers: Object.fromEntries(Object.keys(req.questions).map((q) => [q, { type: "score", value: 1, confidence: 0.9 }])),
        model: "jev-latest", elapsedMs: 1,
      };
    },
  };
  const router = new AutoModelRouter(pi, true, jev);
  const result = await router.route("inspect this screenshot", ctx, { hasImages: true });
  assert.equal(result.profile, "vision");
  assert.equal(result.model?.id, "visual");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].state.task.has_images, true);
  assert.equal(requests[1].state.candidates.length, 1);
});

test("routes a confidently classified balanced request", async () => {
  const a = model("a", { reasoning: true });
  const b = model("b");
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [a, b] }, getSystemPrompt: () => "" };
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => req.questions.profile
      ? { answers: { profile: { type: "choice", value: "balanced", confidence: 0.6 } }, model: "jev-latest", elapsedMs: 1 }
      : { answers: { fit_0: { type: "score", value: 1, confidence: 0.8 }, fit_1: { type: "score", value: 3, confidence: 0.8 } }, model: "jev-latest", elapsedMs: 1 },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("tell me something about octopuses", ctx);
  assert.equal(result.profile, "balanced");
  assert.equal(result.model?.id, "b");
  assert.match(result.reason, /jev scoring/);
});

test("combines the top two profiles when neither reaches 0.60 alone but together they do", async () => {
  const deep = model("deep", { reasoning: true, contextWindow: 200000 });
  const wide = model("wide", { contextWindow: 1000000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [deep, wide] }, getSystemPrompt: () => "" };
  const requests: any[] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      requests.push(req);
      if (req.questions.profile) {
        return {
          answers: { profile: { type: "choice", value: "reasoning", confidence: 0.44, distribution: { reasoning: 0.59, "long-context": 0.37, balanced: 0.04, fast: 0, vision: 0 } } },
          model: "jev-latest", elapsedMs: 1,
        };
      }
      return {
        answers: { fit_0: { type: "score", value: 2, confidence: 0.8 }, fit_1: { type: "score", value: 3, confidence: 0.8 } },
        model: "jev-latest", elapsedMs: 1,
      };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("perform a full security review of this repo", ctx);
  assert.equal(result.profile, "reasoning");
  assert.equal(result.secondaryProfile, "long-context");
  assert.equal(result.model?.id, "wide");
  assert.match(result.reason, /reasoning \+ long-context \(combined probability 0\.96\)/);
  assert.equal(requests.length, 2);
  const need = requests[1].state.task.classified_need;
  assert.equal(need.profile, "reasoning");
  assert.equal(need.secondary_profile, "long-context");
  assert.match(need.guidance, /multi-step reasoning/);
  assert.match(need.secondary_guidance, /large context window/);
  assert.match(requests[1].questions.fit_0.instructions, /secondary_profile/);
});

test("routes the top profile alone when its probability reaches 0.60 even if the Choice confidence is low", async () => {
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [model("a"), model("b")] }, getSystemPrompt: () => "" };
  const requests: any[] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      requests.push(req);
      if (req.questions.profile) {
        // Five options: probability 0.60 on one gives a Choice confidence of only 0.50.
        return {
          answers: { profile: { type: "choice", value: "reasoning", confidence: 0.5, distribution: { reasoning: 0.6, "long-context": 0.3, balanced: 0.1 } } },
          model: "jev-latest", elapsedMs: 1,
        };
      }
      return { answers: { fit_0: { type: "score", value: 3, confidence: 0.8 }, fit_1: { type: "score", value: 1, confidence: 0.8 } }, model: "jev-latest", elapsedMs: 1 };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.profile, "reasoning");
  assert.equal(result.secondaryProfile, undefined, "top profile at 0.60 routes alone, not combined");
  assert.equal(result.model?.id, "a");
  assert.equal(requests[1].state.task.classified_need.secondary_profile, undefined);
});

test("skips when neither the top profile nor the top two reach 0.60", async () => {
  const ctx: any = { model: model("current"), modelRegistry: { getAvailable: () => [model("candidate")] }, getSystemPrompt: () => "" };
  let calls = 0;
  const jev: any = {
    isConfigured: () => true,
    evaluate: async () => {
      calls++;
      return {
        answers: { profile: { type: "choice", value: "reasoning", confidence: 0.2, distribution: { reasoning: 0.35, "long-context": 0.2, balanced: 0.2, fast: 0.15, vision: 0.1 } } },
        model: "jev-latest", elapsedMs: 1,
      };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("do the thing", ctx);
  assert.equal(result.skipped, "low-confidence");
  assert.equal(result.secondaryProfile, undefined);
  assert.match(result.reason, /probability 0\.35, top two 0\.55/);
  assert.equal(calls, 1);
});

test("heuristic fallback ranks against both profiles of a split need", async () => {
  // Reasoning alone: deep 31.3 vs wide 5. Long-context alone: deep 15.8 vs wide 50. Combined: deep 47.1 vs wide 55.
  const deep = model("deep", { reasoning: true, contextWindow: 128000 });
  const wide = model("wide", { contextWindow: 1000000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [deep, wide] }, getSystemPrompt: () => "" };
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      if (req.questions.profile) {
        return {
          answers: { profile: { type: "choice", value: "reasoning", confidence: 0.44, distribution: { reasoning: 0.59, "long-context": 0.37, balanced: 0.04 } } },
          model: "jev-latest", elapsedMs: 1,
        };
      }
      throw new Error("scoring unavailable");
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("perform a full security review of this repo", ctx);
  assert.equal(result.secondaryProfile, "long-context");
  assert.equal(result.model?.id, "wide");
  assert.match(result.reason, /heuristic scoring/);
});

test("skips a low-confidence Jev classification without scoring candidates", async () => {
  const ctx: any = { model: model("current"), modelRegistry: { getAvailable: () => [model("candidate")] }, getSystemPrompt: () => "" };
  let calls = 0;
  const jev: any = {
    isConfigured: () => true,
    evaluate: async () => {
      calls++;
      return { answers: { profile: { type: "choice", value: "balanced", confidence: 0.59 } }, model: "jev-latest", elapsedMs: 1 };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("tell me something about octopuses", ctx);
  assert.equal(result.profile, "balanced");
  assert.equal(result.skipped, "low-confidence");
  assert.equal(calls, 1);
});

test("falls back when the selected label is not the distribution's top probability", async () => {
  // value:"fast" against balanced-on-top must not route fast+balanced together.
  const cheap = model("cheap", { reasoning: true, contextWindow: 1000000 });
  const deep = model("deep", { reasoning: true, contextWindow: 200000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [cheap, deep] }, getSystemPrompt: () => "" };
  let calls = 0;
  const jev: any = {
    isConfigured: () => true,
    evaluate: async () => {
      calls++;
      return { answers: { profile: { type: "choice", value: "fast", confidence: 0.9, distribution: { fast: 0.1, balanced: 0.9 } } }, model: "jev-latest", elapsedMs: 1 };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.profile, "long-context", "falls back to the local classification");
  assert.equal(result.secondaryProfile, undefined, "an inconsistent answer never splits the need");
  assert.equal(result.model?.id, "cheap");
  assert.match(result.reason, /heuristic scoring/);
  assert.equal(calls, 1);
});

test("falls back when a distribution probability is out of range", async () => {
  const cheap = model("cheap", { reasoning: true, contextWindow: 1000000 });
  const deep = model("deep", { reasoning: true, contextWindow: 200000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [cheap, deep] }, getSystemPrompt: () => "" };
  let calls = 0;
  const jev: any = {
    isConfigured: () => true,
    evaluate: async () => {
      calls++;
      return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9, distribution: { reasoning: 0.9, balanced: 1.4 } } }, model: "jev-latest", elapsedMs: 1 };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.profile, "long-context");
  assert.equal(result.model?.id, "cheap");
  assert.match(result.reason, /heuristic scoring/);
  assert.equal(calls, 1);
});

test("splits the need when the top two combined probability is exactly 0.60", async () => {
  const deep = model("deep", { reasoning: true, contextWindow: 200000 });
  const wide = model("wide", { contextWindow: 1000000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [deep, wide] }, getSystemPrompt: () => "" };
  const requests: any[] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      requests.push(req);
      if (req.questions.profile) {
        return {
          answers: { profile: { type: "choice", value: "reasoning", confidence: 0.42, distribution: { reasoning: 0.41, "long-context": 0.19, balanced: 0.18, fast: 0.12, vision: 0.1 } } },
          model: "jev-latest", elapsedMs: 1,
        };
      }
      return { answers: { fit_0: { type: "score", value: 2, confidence: 0.8 }, fit_1: { type: "score", value: 3, confidence: 0.8 } }, model: "jev-latest", elapsedMs: 1 };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("perform a full security review of this repo", ctx);
  assert.equal(result.profile, "reasoning");
  assert.equal(result.secondaryProfile, "long-context");
  assert.match(result.reason, /combined probability 0\.60/);
  assert.equal(requests.length, 2, "scoring runs for a split need");
  assert.equal(requests[1].state.task.classified_need.secondary_profile, "long-context");
});

test("skips routing when the top two combined are just below 0.60", async () => {
  const ctx: any = { model: model("current"), modelRegistry: { getAvailable: () => [model("candidate")] }, getSystemPrompt: () => "" };
  let calls = 0;
  const jev: any = {
    isConfigured: () => true,
    evaluate: async () => {
      calls++;
      return {
        answers: { profile: { type: "choice", value: "reasoning", confidence: 0.42, distribution: { reasoning: 0.4, "long-context": 0.19, balanced: 0.18, fast: 0.13, vision: 0.1 } } },
        model: "jev-latest", elapsedMs: 1,
      };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("do the thing", ctx);
  assert.equal(result.profile, "reasoning");
  assert.equal(result.secondaryProfile, undefined);
  assert.match(result.reason, /top two 0\.59/);
  assert.equal(result.skipped, "low-confidence", "combined 0.59 routes nothing");
  assert.equal(calls, 1, "no scoring without a split");
});

test("falls back when a distribution is present but empty", async () => {
  const cheap = model("cheap", { reasoning: true, contextWindow: 1000000 });
  const deep = model("deep", { reasoning: true, contextWindow: 200000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [cheap, deep] }, getSystemPrompt: () => "" };
  let calls = 0;
  const jev: any = {
    isConfigured: () => true,
    evaluate: async () => {
      calls++;
      return { answers: { profile: { type: "choice", value: "fast", confidence: 0.9, distribution: {} } }, model: "jev-latest", elapsedMs: 1 };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.profile, "long-context", "falls back to the local classification, not the unverified confidence");
  assert.equal(result.model?.id, "cheap");
  assert.match(result.reason, /heuristic scoring/);
  assert.equal(calls, 1);
});

test("falls back when a distribution has only unknown profiles", async () => {
  const cheap = model("cheap", { reasoning: true, contextWindow: 1000000 });
  const deep = model("deep", { reasoning: true, contextWindow: 200000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [cheap, deep] }, getSystemPrompt: () => "" };
  let calls = 0;
  const jev: any = {
    isConfigured: () => true,
    evaluate: async () => {
      calls++;
      return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9, distribution: { ultra: 0.9 } } }, model: "jev-latest", elapsedMs: 1 };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.profile, "long-context");
  assert.equal(result.model?.id, "cheap");
  assert.match(result.reason, /heuristic scoring/);
  assert.equal(calls, 1);
});

test("a tie between the selected profile and another keeps split routing alive regardless of key order", async () => {
  const deep = model("deep", { reasoning: true, contextWindow: 200000 });
  const wide = model("wide", { contextWindow: 1000000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [deep, wide] }, getSystemPrompt: () => "" };
  const run = async (distribution: Record<string, number>) => {
    const requests: any[] = [];
    const jev: any = {
      isConfigured: () => true,
      evaluate: async (req: any) => {
        requests.push(req);
        if (req.questions.profile) {
          return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.5, distribution } }, model: "jev-latest", elapsedMs: 1 };
        }
        return { answers: { fit_0: { type: "score", value: 2, confidence: 0.8 }, fit_1: { type: "score", value: 3, confidence: 0.8 } }, model: "jev-latest", elapsedMs: 1 };
      },
    };
    const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
    const result = await router.route("perform a full security review of this repo", ctx);
    return { result, requests };
  };
  const first = await run({ fast: 0.5, reasoning: 0.5 });
  const second = await run({ reasoning: 0.5, fast: 0.5 });
  for (const { result, requests } of [first, second]) {
    assert.equal(result.profile, "reasoning", "a tied selection is not rejected");
    assert.equal(result.secondaryProfile, "fast");
    assert.match(result.reason, /reasoning \+ fast \(combined probability 1\.00\)/);
    assert.equal(requests.length, 2, "scoring runs for a tied split");
  }
});

test("real JevClient normalization keeps missing score answers invalid", async () => {
  const a = model("a", { reasoning: true, contextWindow: 1000000 });
  const b = model("b", { reasoning: true, contextWindow: 200000 });
  const pi: any = { setModel: async () => {} };
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [a, b] }, getSystemPrompt: () => "" };
  const jev = new JevClient();
  jev.setApiKey("test-key");
  // Stub only the transport; request formatting and answer normalization run for real.
  (jev as any).client = {
    systemOne: async (req: any) => {
      if (req.questions.profile) {
        return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9, probabilities: { reasoning: 0.9, balanced: 0.1 } } }, model: "jev-latest" };
      }
      // Raw answers with no score field at all, as a misbehaving backend might return.
      return { answers: { fit_0: {}, fit_1: {} }, model: "jev-latest" };
    },
  };
  const scored = await jev.evaluate({ state: {}, questions: { fit_0: { type: "score", instructions: "fit", criteria: ["worst", "best"] }, fit_1: { type: "score", instructions: "fit", criteria: ["worst", "best"] } } });
  assert.equal(scored.answers.fit_0.value, undefined, "a missing score must not be normalized into 0");
  const router = new AutoModelRouter(pi, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.model?.id, "a", "falls back to heuristic scoring instead of picking fit_0 via a fake 0");
  assert.match(result.reason, /heuristic scoring/);
});

test("reports a failed switch when setModel returns false", async () => {
  const cheap = model("cheap", { reasoning: true });
  const strong = model("strong", { reasoning: true, contextWindow: 200000 });
  const pi: any = { setModel: async () => false };
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [cheap, strong] }, getSystemPrompt: () => "" };
  const router = new AutoModelRouter(pi, true);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.changed, false, "a false setModel result is not a successful switch");
  assert.equal(result.skipped, "error");
  assert.match(result.reason, /model switch failed: auth/);
  assert.equal(router.last, result, "the outcome is recorded on router.last");
  // The failed target is backed off, so the next prompt does not retry it.
  ctx.model = cheap;
  const next = await router.route("plan a safe migration", ctx);
  assert.equal(next.model?.id, "cheap");
  assert.equal(next.changed, false);
  assert.match(next.reason, /^large context task \(heuristic scoring; quality 4\/5 price-inferred\)/, "falls back to the remaining eligible model");
});

test("records every routing outcome on router.last", async () => {
  const pi: any = { setModel: async () => {} };
  const router = new AutoModelRouter(pi, false);
  const ctx: any = { model: model("a"), modelRegistry: { getAvailable: () => [model("a"), model("b", { reasoning: true, contextWindow: 200000 })] }, getSystemPrompt: () => "" };
  const disabled = await router.route("plan a safe migration", ctx);
  assert.equal(disabled.skipped, "disabled");
  assert.equal(router.last, disabled);

  router.setEnabled(true);
  const switched = await router.route("plan a safe migration", ctx);
  assert.equal(switched.changed, true, "switches to the better model once enabled");
  assert.equal(router.last, switched);

  const empty = await router.route("   ", ctx);
  assert.equal(empty.skipped, "low-confidence");
  assert.equal(router.last, empty);
});

test("aborts without switching models when the signal is already aborted", async () => {
  const ctx: any = { model: model("current"), modelRegistry: { getAvailable: () => [model("a", { reasoning: true, contextWindow: 200000 })] }, getSystemPrompt: () => "" };
  let switches = 0;
  const pi: any = { setModel: async () => { switches++; return true; } };
  const router = new AutoModelRouter(pi, true);
  const controller = new AbortController();
  controller.abort();
  const result = await router.route("plan a safe migration", ctx, { signal: controller.signal });
  assert.equal(result.changed, false);
  assert.equal(result.skipped, "error");
  assert.equal(switches, 0, "no model switch on an aborted turn");
});

test("describeRouteStatus explains unchanged and skipped outcomes", () => {
  assert.equal(describeRouteStatus({ changed: true, profile: "reasoning", model: model("deep"), reason: "" }), "jev: reasoning → deep");
  assert.equal(describeRouteStatus({ changed: false, profile: "balanced", model: model("same"), reason: "" }), "jev: balanced · same (current)");
  assert.equal(describeRouteStatus({ changed: false, profile: "reasoning", reason: "model selection skipped", skipped: "low-confidence" }), "jev: reasoning skipped: low-confidence");
  assert.equal(describeRouteStatus({ changed: false, profile: "reasoning", model: model("cur"), reason: "model switch failed: auth", skipped: "error" }), "jev: reasoning · cur (error)");
  assert.equal(describeRouteStatus({ changed: false, profile: "balanced", reason: "model selection skipped", skipped: "disabled" }), "jev: balanced skipped: disabled");
});

test("aborts a pending Jev evaluation mid-flight without switching models", async () => {
  const ctx: any = { model: model("current"), modelRegistry: { getAvailable: () => [model("a", { reasoning: true, contextWindow: 200000 })] }, getSystemPrompt: () => "" };
  let switches = 0;
  let evaluated = 0;
  const pi: any = { setModel: async () => { switches++; return true; } };
  const controller = new AbortController();
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (_req: any, signal: AbortSignal) => {
      evaluated++;
      // Pend exactly like an in-flight Jev request until the caller cancels it.
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Request was aborted")));
      });
    },
  };
  const router = new AutoModelRouter(pi, true, jev);
  const pending = router.route("plan a safe migration", ctx, { signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(evaluated, 1, "cancellation reaches the in-flight Jev request");
  assert.equal(result.changed, false);
  assert.equal(result.skipped, "error");
  assert.equal(switches, 0, "mid-flight cancellation never switches models");
  assert.equal(router.last, result);
});

test("heuristic-only routing abstains on unrecognized prompts by design", async () => {
  // "balanced 0.55" means "no distinguishing evidence": below the threshold the
  // router keeps the user's current model rather than switching on a guess.
  const ctx: any = { model: model("current"), modelRegistry: { getAvailable: () => [model("candidate")] }, getSystemPrompt: () => "" };
  let switches = 0;
  const router = new AutoModelRouter({ setModel: async () => { switches++; } } as any, true);
  const result = await router.route("tell me something about octopuses", ctx);
  assert.equal(result.profile, "balanced");
  assert.equal(result.skipped, "low-confidence");
  assert.equal(switches, 0, "no-evidence prompts never switch models");
});

test("generation tuples parse from model ids and sort newest first", () => {
  assert.deepEqual(generationOf("claude-fable-5-1"), [5, 1]);
  assert.deepEqual(generationOf("gpt-5.6-sol"), [5, 6]);
  assert.deepEqual(generationOf("k3-256k"), [3]);
  assert.deepEqual(generationOf("kimi-for-coding"), []);
  assert.ok(compareGeneration("claude-fable-5-1", "claude-fable-5") < 0, "5.1 is newer than 5");
  assert.ok(compareGeneration("gpt-6-sol", "gpt-5.5") < 0, "6 is newer than 5.5");
  assert.ok(compareGeneration("claude-opus-5", "claude-opus-4-8") < 0, "5 is newer than 4.8");
  assert.ok(compareGeneration("kimi-for-coding", "k3") > 0, "no version ranks below any version");
  assert.equal(compareGeneration("a-1", "b-1"), 0);
});

test("exact ties keep the current model instead of churning", async () => {
  const older = model("claude-fable-5", { reasoning: true, contextWindow: 1000000 });
  const newer = model("claude-fable-5-1", { reasoning: true, contextWindow: 1000000 });
  let switches = 0;
  const pi: any = { setModel: async () => { switches++; } };
  const ctx: any = { model: newer, modelRegistry: { getAvailable: () => [older, newer] }, getSystemPrompt: () => "" };
  const result = await new AutoModelRouter(pi, true).route("Use a frontier model. Plan a safe migration", ctx);
  assert.equal(result.model?.id, "claude-fable-5-1");
  assert.equal(result.changed, false);
  assert.equal(switches, 0, "alphabetical would have switched to the older model");
  // Stickiness applies only inside the tied group: a lower-scoring current model still loses.
  const weak = model("claude-haiku-4-5", { contextWindow: 200000 });
  ctx.model = weak;
  ctx.modelRegistry = { getAvailable: () => [older, newer, weak] };
  const moved = await new AutoModelRouter(pi, true).route("Use a frontier model. Plan a safe migration", ctx);
  assert.equal(moved.model?.id, "claude-fable-5-1");
  assert.equal(moved.changed, true);
});

test("exact ties prefer the newer generation when nothing is current", async () => {
  const older = model("gpt-5.5", { reasoning: true, contextWindow: 272000 });
  const newer = model("gpt-6-sol", { reasoning: true, contextWindow: 272000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [older, newer] }, getSystemPrompt: () => "" };
  const result = await new AutoModelRouter({ setModel: async () => {} } as any, true).route("plan a safe migration", ctx);
  assert.equal(result.model?.id, "gpt-6-sol", "alphabetical would have picked gpt-5.5");
});

test("quota headroom still outranks stickiness", async () => {
  const currentHot = model("m", { provider: "hot", reasoning: true, contextWindow: 200000 });
  const otherCool = model("m", { provider: "cool", reasoning: true, contextWindow: 200000 });
  const ctx: any = { model: currentHot, modelRegistry: { getAvailable: () => [currentHot, otherCool] }, getSystemPrompt: () => "" };
  const result = await quotaRouter(usageReport([["hot", 60], ["cool", 5]])).route("plan a safe migration", ctx);
  assert.equal(result.model?.provider, "cool", "a fuller subscription is left even when it is current");
  assert.equal(result.changed, true);
});

test("selection is independent of registry order for equal scores", async () => {
  const a = model("a", { reasoning: true, contextWindow: 200000 });
  const b = model("b", { reasoning: true, contextWindow: 200000 });
  const routeOnce = async (order: any[]) => {
    const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => order }, getSystemPrompt: () => "" };
    const jev: any = {
      isConfigured: () => true,
      evaluate: async (req: any) => req.questions.profile
        ? { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9 } }, model: "jev-latest", elapsedMs: 1 }
        // Exact ties on both score and confidence for every candidate.
        : { answers: Object.fromEntries(Object.keys(req.questions).map((q) => [q, { type: "score", value: 3, confidence: 0.8 }])), model: "jev-latest", elapsedMs: 1 },
    };
    const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
    return (await router.route("plan a safe migration", ctx)).model?.id;
  };
  const first = await routeOnce([a, b]);
  const second = await routeOnce([b, a]);
  assert.equal(first, second, "registry order must not decide exact ties");
  assert.equal(first, "a", "stable candidateKey tiebreak wins");
});

test("malformed score confidence degrades to zero instead of corrupting the comparator", async () => {
  const a = model("a", { reasoning: true, contextWindow: 200000 });
  const b = model("b", { reasoning: true, contextWindow: 1000000 });
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [a, b] }, getSystemPrompt: () => "" };
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => req.questions.profile
      ? { answers: { profile: { type: "choice", value: "long-context", confidence: 0.9 } }, model: "jev-latest", elapsedMs: 1 }
      // Equal scores; a carries a valid confidence while b's is NaN (degrades to 0), so a must win the tiebreak.
      : { answers: { fit_0: { type: "score", value: 3, confidence: 0.8 }, fit_1: { type: "score", value: 3, confidence: NaN } }, model: "jev-latest", elapsedMs: 1 },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev);
  const result = await router.route("review the entire codebase", ctx);
  assert.equal(result.model?.id, "a", "NaN confidences compare as zero, not as garbage");
});

test("expired backoff entries are pruned and their models become eligible again", async () => {
  const a = model("a");
  const ctx: any = { model: model("other"), modelRegistry: { getAvailable: () => [a] }, getSystemPrompt: () => "" };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true);
  (router as any).blocked.set("test/a", Date.now() - 1);
  const result = await router.route("hi, list the files in src", ctx);
  assert.equal(result.model?.id, "a", "an expired backoff no longer excludes the model");
  assert.equal((router as any).blocked.size, 0, "expired entries are pruned from the map");
});

test("frontier opt-in distinguishes routing requests from discussion, quotes, and negation", () => {
  for (const prompt of [
    "Use a frontier model for this review", "Please choose the frontier model",
    "Can you use a frontier model?", "Frontier model please",
    "Review this code. Switch to a frontier model", "Use a tier 5 model",
  ]) assert.equal(requestsFrontierModel(prompt), true, prompt);
  for (const prompt of [
    "Review this complex code", "What is a frontier model?", "Compare frontier models",
    "Don't use a frontier model", "Please do not use a frontier model",
    "Never use a frontier model", "Use a frontier model only if necessary",
    'Explain the phrase "Use a frontier model"', "`Use a frontier model`",
    "```text\nUse a frontier model\n```", "> Use a frontier model",
  ]) assert.equal(requestsFrontierModel(prompt), false, prompt);
});

test("tier policy keeps newest tier 4 per provider family, not the largest cross-provider version", () => {
  const ids = ["gpt-6-sol", "gpt-6.1-sol", "gpt-5.5", "claude-opus-5", "claude-opus-5-5"];
  const models = ids.map((id) => model(id, { provider: id.startsWith("gpt") ? "codex" : "claude" }));
  const table = tiers(Object.fromEntries(models.map((m) => [`${m.provider}/${m.id}`, 4])));
  // gpt-5.5 is the plain gpt family, not sol, so 6.1-sol does not supersede it.
  const expected = ["claude-opus-5-5", "gpt-5.5", "gpt-6.1-sol"];
  for (const pool of [models, [...models].reverse()]) {
    assert.deepEqual(applyModelTierPolicy(pool, table, false).map((m) => m.id).sort(), expected);
  }
});

test("model families strip version, dated alias, and size suffix", () => {
  assert.equal(familyOf("claude-opus-4-7"), "claude-opus");
  assert.equal(familyOf("claude-opus-4-5-20251101"), "claude-opus");
  assert.equal(familyOf("gpt-6.1-sol"), "gpt-sol");
  assert.equal(familyOf("gpt-5.5"), "gpt");
  assert.equal(familyOf("gpt-5.3-codex-spark"), "gpt-codex-spark");
  assert.equal(familyOf("glm-5.3-highspeed"), "glm-highspeed");
  assert.equal(familyOf("k3-256k"), "k");
  assert.equal(familyOf("kimi-for-coding"), "kimi-for-coding");
});

test("tier policy keeps newest version per provider family in every tier, never across tiers or families", () => {
  const ids = ["claude-sonnet-5", "claude-sonnet-5-5", "claude-opus-4-6", "claude-opus-4-7", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-fable-5", "claude-fable-5-1"];
  const models = ids.map((id) => model(id, { provider: "claude" }));
  const table = tiers({
    "claude/claude-fable-5": 5, "claude/claude-fable-5-1": 5,
    "claude/claude-sonnet-5": 3, "claude/claude-sonnet-5-5": 3, "claude/claude-opus-4-6": 3, "claude/claude-opus-4-7": 3,
    "claude/claude-sonnet-4-5": 2, "claude/claude-sonnet-4-6": 2,
  });
  // Tier 3 keeps the newest sonnet and the newest opus: sonnet 5.5 does not supersede opus 4.7.
  // Tier 2's sonnet 4.6 survives although sonnet 5.5 is newer, since tiers are separate lineups.
  const expected = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-sonnet-5-5"];
  assert.deepEqual(applyModelTierPolicy(models, table, false).map((m) => m.id).sort(), expected);
  // Frontier opt-in admits tier 5, which is superseded the same way.
  assert.deepEqual(applyModelTierPolicy(models, table, true).map((m) => m.id).sort(), ["claude-fable-5-1", ...expected].sort());
  // Same tier, different providers: each provider keeps its own newest.
  const glm = model("glm-4.7", { provider: "zai" });
  const mixed = applyModelTierPolicy([glm, ...models], tiers({ "zai/glm-4.7": 2, "claude/claude-sonnet-4-6": 2 }), false).map((m) => m.id);
  assert.ok(mixed.includes("glm-4.7") && mixed.includes("claude-sonnet-4-6"), "4.7 on zai is not superseded by 4.6 or newer on claude");
});

test("tier policy leaves unknown or equal versions available for scoring", () => {
  const models = [model("k3"), model("k3-256k"), model("unknown"), model("glm-5.3-flash"), model("glm-5.3-highspeed")];
  const table = tiers({ "test/k3": 4, "test/k3-256k": 4, "test/unknown": 4, "test/glm-5.3-flash": 2, "test/glm-5.3-highspeed": 2 });
  assert.deepEqual(applyModelTierPolicy(models, table, false), models);
  assert.deepEqual(generationOf("claude-opus-5-5-20260901"), [5, 5]);
  assert.deepEqual(generationOf("llama-3-70b"), [3]);
  assert.ok(compareGeneration("gpt-6.10-sol", "gpt-6.9-sol") < 0);
});

for (const mode of ["heuristic", "jev", "failed-jev"] as const) {
  test(`${mode}: tier 5 requires explicit frontier opt-in on each prompt`, async () => {
    const flagship = model("flag-9", { reasoning: true, contextWindow: 1000000 });
    const premium = model("premium-2", { reasoning: true, contextWindow: 200000 });
    const seen: string[][] = [];
    const jev: any = mode === "heuristic" ? undefined : {
      isConfigured: () => true,
      evaluate: async (req: any) => {
        if (mode === "failed-jev") throw new Error("offline");
        if (req.questions.profile) return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9 } } };
        seen.push(req.state.candidates.map((c: any) => c.model));
        return { answers: Object.fromEntries(req.state.candidates.map((c: any, i: number) => [
          `fit_${i}`, { type: "score", value: c.model === flagship.id ? 4 : 3, confidence: 0.9 },
        ])) };
      },
    };
    const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev, {
      tierTable: tiers({ "test/flag-9": 5, "test/premium-2": 4 }),
    });
    const ctx = ctxWith([flagship, premium]);
    assert.equal((await router.route("plan a complex review", ctx)).model?.id, premium.id);
    assert.equal((await router.route("Use a frontier model. Plan a complex review", ctx)).model?.id, flagship.id);
    ctx.model = flagship;
    assert.equal((await router.route("plan the next review", ctx)).model?.id, premium.id, "permission is not sticky");
    if (mode === "jev") assert.deepEqual(seen, [[premium.id], [flagship.id, premium.id], [premium.id]]);
  });

  test(`${mode}: newest tier 4 supersedes fit differences and current-model stickiness`, async () => {
    const old = model("gpt-6-sol", { reasoning: true, contextWindow: 1000000 });
    const latest = model("gpt-6.1-sol", { reasoning: true, contextWindow: 200000 });
    const scored: string[][] = [];
    const jev: any = mode === "heuristic" ? undefined : {
      isConfigured: () => true,
      evaluate: async (req: any) => {
        if (mode === "failed-jev") throw new Error("offline");
        if (req.questions.profile) return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9 } } };
        scored.push(req.state.candidates.map((c: any) => c.model));
        return { answers: { fit_0: { type: "score", value: 3, confidence: 0.9 } } };
      },
    };
    const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev, {
      tierTable: tiers({ "test/gpt-6-sol": 4, "test/gpt-6.1-sol": 4 }),
    });
    const ctx = { ...ctxWith([old, latest]), model: old };
    const result = await router.route("plan a review", ctx);
    assert.equal(result.model?.id, latest.id);
    assert.equal(result.changed, true);
    assert.match(result.reason, /newest eligible version per provider family in each tier/);
    if (mode === "jev") {
      assert.deepEqual(scored, [[latest.id]]);
      assert.match(result.reason, /jev scoring/);
    }
  });
}

test("frontier gate has no empty-pool or quota/vision exception", async () => {
  const flagship = model("flag", { provider: "frontier", input: ["text", "image"], reasoning: true });
  const premium = model("premium", { provider: "premium", reasoning: true });
  const table = tiers({ "frontier/flag": 5, "premium/premium": 4 });
  const selected: string[] = [];
  const router = new AutoModelRouter({ setModel: async (m: any) => { selected.push(m.id); } } as any, true, undefined, {
    tierTable: table, quotaSource: async () => usageReport([["premium", 100]]) as any,
  });
  const alone = await router.route("plan a review", ctxWith([flagship]));
  assert.equal(alone.skipped, "no-model");
  assert.equal(alone.model, undefined);
  const vision = await router.route("inspect this image", ctxWith([flagship, premium]), { hasImages: true });
  assert.equal(vision.skipped, "no-model");
  const quota = await router.route("plan a review", ctxWith([flagship, premium]));
  assert.equal(quota.model?.id, premium.id, "existing quota fallback cannot reintroduce frontier");
  assert.deepEqual(selected, [premium.id]);
});

test("low-confidence prompts leave a previously used frontier model when an alternative exists", async () => {
  const flagship = model("flag", { reasoning: true });
  const premium = model("premium", { reasoning: true });
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, {
    tierTable: tiers({ "test/flag": 5, "test/premium": 4 }),
  });
  const result = await router.route("continue", { ...ctxWith([flagship, premium]), model: flagship });
  assert.equal(result.model?.id, premium.id);
  assert.equal(result.changed, true);
});

test("newest tier 4 selection respects image compatibility, backoff, and scope", async () => {
  const old = model("opus-5", { input: ["text", "image"], reasoning: true });
  const latest = model("opus-5-5", { reasoning: true });
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, {
    tierTable: tiers({ "test/opus-5": 4, "test/opus-5-5": 4 }),
  });
  const ctx = ctxWith([old, latest]);
  assert.equal((await router.route("inspect image", ctx, { hasImages: true })).model?.id, old.id);
  assert.equal((await router.route("plan review", { ...ctx, scopedModels: [{ model: old }] })).model?.id, old.id);
  assert.equal((await router.route("plan review", ctx)).model?.id, latest.id);
  router.recordProviderResponse(429, latest);
  assert.equal((await router.route("plan review", ctx)).model?.id, old.id);
});

test("quota headroom still chooses between newest tier 4 representatives", async () => {
  const codex = model("gpt-6.1-sol", { provider: "codex", reasoning: true });
  const opus = model("opus-5-5", { provider: "claude", reasoning: true });
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, {
    tierTable: tiers({ "codex/gpt-6.1-sol": 4, "claude/opus-5-5": 4 }),
    quotaSource: async () => usageReport([["codex", 60], ["claude", 10]]) as any,
  });
  const result = await router.route("plan review", ctxWith([codex, opus]));
  assert.equal(result.model?.provider, "claude", "6.1 on one provider does not beat 5.5 on another");
});

test("a low-confidence continuation upgrades an obsolete lower-tier current model", async () => {
  const old = model("gpt-5.6-luna");
  const latest = model("gpt-6-luna");
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, {
    tierTable: tiers({ "test/gpt-5.6-luna": 1, "test/gpt-6-luna": 1 }),
  });
  const result = await router.route("continue", { ...ctxWith([old, latest]), model: old });
  assert.equal(result.model?.id, latest.id);
  assert.equal(result.changed, true);
});

test("a low-confidence continuation keeps a current model that is newest in its own family", async () => {
  const opus = model("claude-opus-4-7");
  const sonnet = model("claude-sonnet-5-5");
  let selected = 0;
  const router = new AutoModelRouter({ setModel: async () => { selected++; } } as any, true, undefined, {
    tierTable: tiers({ "test/claude-opus-4-7": 3, "test/claude-sonnet-5-5": 3 }),
  });
  const result = await router.route("continue", { ...ctxWith([opus, sonnet]), model: opus });
  assert.equal(result.skipped, "low-confidence");
  assert.equal(selected, 0);
});

test("a low-confidence continuation upgrades an obsolete tier 4 current model", async () => {
  const old = model("opus-5", { reasoning: true });
  const latest = model("opus-5-5", { reasoning: true });
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, undefined, {
    tierTable: tiers({ "test/opus-5": 4, "test/opus-5-5": 4 }),
  });
  const result = await router.route("continue", { ...ctxWith([old, latest]), model: old });
  assert.equal(result.model?.id, latest.id);
  assert.equal(result.changed, true);
});

test("malformed Jev fit scoring falls back inside the tier-filtered pool", async () => {
  const flagship = model("flag-9", { reasoning: true, contextWindow: 1000000 });
  const old = model("premium-1", { reasoning: true, contextWindow: 1000000 });
  const latest = model("premium-2", { reasoning: true, contextWindow: 200000 });
  const scored: string[][] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      if (req.questions.profile) return { answers: { profile: { type: "choice", value: "reasoning", confidence: 0.9 } } };
      scored.push(req.state.candidates.map((c: any) => c.model));
      return { answers: {} };
    },
  };
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true, jev, {
    tierTable: tiers({ "test/flag-9": 5, "test/premium-1": 4, "test/premium-2": 4 }),
  });
  const result = await router.route("plan review", ctxWith([flagship, old, latest]));
  assert.deepEqual(scored, [[latest.id]]);
  assert.equal(result.model?.id, latest.id);
  assert.match(result.reason, /heuristic scoring/);
});
