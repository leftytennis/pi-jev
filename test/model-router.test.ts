import test from "node:test";
import assert from "node:assert/strict";
import { classifyModelError, classifyModelNeed, AutoModelRouter } from "../src/model-router.js";
import { JevClient } from "../src/jev.js";

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
