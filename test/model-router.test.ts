import test from "node:test";
import assert from "node:assert/strict";
import { classifyModelError, classifyModelNeed, AutoModelRouter } from "../src/model-router.js";

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

test("blocks quota model for future fallback", () => {
  const current = model("quota-model");
  const router = new AutoModelRouter({ setModel: async () => {} } as any, true);
  assert.equal(router.recordProviderResponse(429, current), "rate-limit");
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
  const asked: string[] = [];
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      asked.push(...Object.keys(req.questions));
      // Heuristic would prefer `cheap` (1M context + image) for reasoning; Jev prefers `deep`.
      const values = req.state.candidates.map((c: any) => (c.model === "deep" ? 4 : 1));
      return {
        answers: Object.fromEntries(Object.keys(req.questions).map((q, i) => [q, { type: "score", value: values[i], confidence: 0.9 }])),
        model: "jev-latest",
        elapsedMs: 1,
      };
    },
  };
  const router = new AutoModelRouter(pi, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.model?.id, "deep");
  assert.match(result.reason, /jev scoring/);
  assert.equal(asked.length, 2);
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
  const jev: any = { isConfigured: () => true, evaluate: async () => { throw new Error("boom"); } };
  const router = new AutoModelRouter(pi, true, jev);
  const result = await router.route("plan a safe migration", ctx);
  assert.equal(result.model?.id, "cheap");
  assert.match(result.reason, /heuristic scoring/);
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
  const jev: any = { isConfigured: () => true, evaluate: async () => ({ answers: {}, model: "jev-latest", elapsedMs: 1 }) };
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
  let questionCount = 0;
  const jev: any = {
    isConfigured: () => true,
    evaluate: async (req: any) => {
      questionCount = Object.keys(req.questions).length;
      return {
        answers: Object.fromEntries(Object.keys(req.questions).map((q) => [q, { type: "score", value: 1, confidence: 0.9 }])),
        model: "jev-latest",
        elapsedMs: 1,
      };
    },
  };
  const router = new AutoModelRouter(pi, true, jev);
  const result = await router.route("inspect this screenshot", ctx, { hasImages: true });
  assert.equal(result.profile, "vision");
  assert.equal(result.model?.id, "visual");
  assert.equal(questionCount, 1);
});
