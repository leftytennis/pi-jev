// Live smoke test for Jev classification and model scoring.
// Usage: node --import tsx scripts/smoke-model-router.ts [prompt ...]
//
// Two sections. The live section sends real prompts through Jev classification
// and scoring and asserts the category Jev picks. The boundary section injects
// classification distributions at the 0.60 edges (a live call cannot land on an
// exact boundary) and asserts the routing decision; routed cases still go
// through live Jev scoring so the split-need guidance is exercised for real.
import assert from "node:assert/strict";
import { AutoModelRouter, type ModelProfile } from "../src/model-router.js";
import { JevClient } from "../src/jev.js";

// Pool mirrors the user's authenticated lineup, with a text-only model for the image gate.
const model = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({
  id, provider, name: id, api: "test", baseUrl: "", reasoning: true,
  input: ["text", "image"], cost: { input: 1, output: 1 }, contextWindow: 272000, maxTokens: 131072, ...extra,
}) as any;

const pool = [
  model("openai-codex", "gpt-6-astra", { contextWindow: 272000, cost: { input: 10, output: 30 } }),
  model("claude-bridge", "claude-fable-5-1", { contextWindow: 1000000, cost: { input: 10, output: 30 } }),
  model("zai", "glm-5.3-flash", { contextWindow: 1000000, cost: { input: 0.075, output: 0.25 } }),
  model("kimi-coding", "k3", { contextWindow: 1048576, cost: { input: 3, output: 15 } }),
  model("kimi-coding", "k3-256k", { contextWindow: 262144, cost: { input: 0, output: 0 } }),
  model("openai", "gpt-4.1-nano", { reasoning: false, contextWindow: 1047576, cost: { input: 0.1, output: 0.4 } }),
  model("openai-codex", "gpt-5.3-codex-spark", { input: ["text"], contextWindow: 128000, cost: { input: 1.75, output: 7 } }),
];

const jev = new JevClient();
if (!jev.isConfigured()) { console.error("Jev not configured"); process.exit(1); }

type Injected = { value: ModelProfile; confidence: number; distribution?: Record<string, number> };
let injectedClassification: Injected | undefined;
let classificationAnswer: { value: unknown; confidence: number | undefined; distribution: unknown } | undefined;
let scoringRequests = 0;

const origEvaluate = jev.evaluate.bind(jev);
(jev as any).evaluate = async (req: any, signal?: AbortSignal) => {
  const isClassification = Boolean(req.questions.profile);
  if (isClassification && injectedClassification) {
    console.log(`  -- Jev classification (injected, no network) --`);
    console.log(`  profile=${injectedClassification.value} confidence=${injectedClassification.confidence}`);
    console.log(`  probabilities=${JSON.stringify(injectedClassification.distribution)}`);
    classificationAnswer = injectedClassification;
    return { answers: { profile: { type: "choice", ...injectedClassification } }, model: "injected", elapsedMs: 0 };
  }

  console.log(`  -- Jev ${isClassification ? "classification" : "model-fit scoring"} request --`);
  if (isClassification) {
    console.log(`  task signals: ${JSON.stringify(req.state.task)}`);
  } else {
    scoringRequests++;
    console.log(`  need: ${JSON.stringify(req.state.task.classified_need)}`);
    console.log(`  candidates: ${req.state.candidates.map((c: any) => `${c.provider}/${c.model}`).join(", ")}`);
  }

  const res = await origEvaluate(req, signal);
  if (isClassification) {
    const answer = res.answers.profile;
    classificationAnswer = { value: answer?.value, confidence: answer?.confidence, distribution: answer?.distribution };
    console.log(`  profile=${answer?.value} confidence=${answer?.confidence}`);
    console.log(`  probabilities=${JSON.stringify(answer?.distribution)}`);
  } else {
    for (const [id, answer] of Object.entries(res.answers) as [string, any][]) {
      const candidate = req.state.candidates[Number(id.slice("fit_".length))];
      console.log(`  ${candidate.provider}/${candidate.model}: score=${answer.value} confidence=${answer.confidence}`);
    }
  }
  console.log(`  usage=${JSON.stringify(res.usage)} elapsed=${res.elapsedMs}ms model=${res.model}`);
  return res;
};

let switched: string[] = [];
const pi: any = { setModel: async (m: any) => { switched.push(`${m.provider}/${m.id}`); } };
const ctx: any = {
  model: pool[2], // start on glm-5.3-flash
  modelRegistry: { getAvailable: () => pool },
  getSystemPrompt: () => "",
};
const router = new AutoModelRouter(pi, true, jev);

function describe(result: Awaited<ReturnType<AutoModelRouter["route"]>>): string {
  const profiles = result.secondaryProfile ? `${result.profile}+${result.secondaryProfile}` : result.profile;
  const target = result.model ? `${result.model.provider}/${result.model.id}` : "-";
  return `profile=${profiles} changed=${result.changed} model=${target} reason="${result.reason}"${result.skipped ? ` skipped=${result.skipped}` : ""}`;
}

// ---------------------------------------------------------------------------
// Live section: real prompts, real classification, real scoring.
// ---------------------------------------------------------------------------
type LiveCase = { prompt: string; expectedProfile?: ModelProfile; hasImages?: boolean };

/**
 * What the routing rule says the router should have done for a returned
 * distribution. Live probabilities drift run to run, so the live section
 * checks the decision against the rule rather than against a fixed branch.
 */
function expectedDecision(distribution: unknown, chosen: unknown): { secondary?: ModelProfile; skipped: boolean } | undefined {
  if (typeof distribution !== "object" || distribution === null || typeof chosen !== "string") return undefined;
  const entries = Object.entries(distribution as Record<string, number>).sort((a, b) => b[1] - a[1]);
  const p1 = entries.find(([profile]) => profile === chosen)?.[1];
  const runnerUp = entries.find(([profile]) => profile !== chosen);
  if (p1 === undefined || !runnerUp) return undefined;
  if (p1 >= 0.6) return { skipped: false };
  const combined = Number((p1 + runnerUp[1]).toFixed(6));
  if (combined >= 0.6) return { secondary: runnerUp[0] as ModelProfile, skipped: false };
  return { skipped: true };
}
const liveDefaults: LiveCase[] = [
  { prompt: "hi, list the files in src", expectedProfile: "fast" },
  { prompt: "analyze the security trade-offs of two cache designs", expectedProfile: "reasoning" },
  { prompt: "review this diff across the entire repo before the migration", expectedProfile: "long-context" },
  { prompt: "describe what is wrong in this screenshot", expectedProfile: "vision", hasImages: true },
  { prompt: "Give me a considered overview of the history and cultural impact of the bicycle.", expectedProfile: "balanced" },
  // Sits on the 0.60 margin between reasoning and long-context (0.59 to 0.61 for reasoning across
  // runs), so it exercises whichever branch Jev lands on: alone above 0.60, combined below it.
  { prompt: "perform a full security review of this repo", expectedProfile: "reasoning" },
];
const liveCases: LiveCase[] = process.argv.length > 2 ? process.argv.slice(2).map((prompt) => ({ prompt })) : liveDefaults;

console.log("=== Live classification ===");
for (const c of liveCases) {
  console.log(`\nPROMPT: "${c.prompt}"${c.hasImages ? " [+image]" : ""}`);
  switched = [];
  classificationAnswer = undefined;
  const result = await router.route(c.prompt, ctx, { hasImages: c.hasImages });
  assert.ok(classificationAnswer, "Jev must return a classification answer");
  if (c.expectedProfile) assert.equal(classificationAnswer.value, c.expectedProfile, "Jev classified the prompt into the expected category");
  const expected = expectedDecision(classificationAnswer.distribution, classificationAnswer.value);
  assert.ok(expected, "live classification must carry a usable distribution");
  assert.equal(result.secondaryProfile, expected.secondary, "secondary profile follows the top-two rule for the returned distribution");
  assert.equal(result.skipped === "low-confidence", expected.skipped, "skip decision follows the top-two rule for the returned distribution");
  console.log(`  RESULT: ${describe(result)}`);
  console.log(`  RULE: ${expected.skipped ? "skip (top two below 0.60)" : expected.secondary ? `combine with ${expected.secondary} (top alone below 0.60, pair at or above)` : "route alone (top at or above 0.60)"}`);
  if (switched.length) { console.log(`  setModel called: ${switched.join(", ")}`); ctx.model = result.model; }
}

// ---------------------------------------------------------------------------
// Boundary section: injected distributions at the 0.60 edges.
// ---------------------------------------------------------------------------
type BoundaryCase = {
  name: string;
  injected: Injected;
  expect: { profile: ModelProfile; secondary?: ModelProfile; routed: boolean; scoringCalls: number };
};
// Every distribution below sums to 1 and the runner-up is the highest probability
// other than the chosen profile, which is how the router picks the secondary.
const boundaryCases: BoundaryCase[] = [
  {
    name: "top profile exactly 0.60 routes alone (Choice confidence is only 0.50)",
    injected: { value: "reasoning", confidence: 0.5, distribution: { reasoning: 0.6, "long-context": 0.3, balanced: 0.1, fast: 0, vision: 0 } },
    expect: { profile: "reasoning", routed: true, scoringCalls: 1 },
  },
  {
    name: "top 0.59 alone falls short; with runner-up 0.15 the pair reaches 0.74 and combines",
    injected: { value: "reasoning", confidence: 0.49, distribution: { reasoning: 0.59, "long-context": 0.15, balanced: 0.12, fast: 0.08, vision: 0.06 } },
    expect: { profile: "reasoning", secondary: "long-context", routed: true, scoringCalls: 1 },
  },
  {
    name: "top 0.45 + runner-up 0.15 = 0.60 exactly combines",
    injected: { value: "reasoning", confidence: 0.31, distribution: { reasoning: 0.45, "long-context": 0.15, balanced: 0.14, fast: 0.13, vision: 0.13 } },
    expect: { profile: "reasoning", secondary: "long-context", routed: true, scoringCalls: 1 },
  },
  {
    name: "top 0.45 + runner-up 0.14 = 0.59 is skipped without a scoring call",
    injected: { value: "reasoning", confidence: 0.31, distribution: { reasoning: 0.45, "long-context": 0.14, balanced: 0.14, fast: 0.14, vision: 0.13 } },
    expect: { profile: "reasoning", routed: false, scoringCalls: 0 },
  },
  {
    name: "even 0.30/0.30 split between two profiles reaches 0.60 and combines",
    injected: { value: "reasoning", confidence: 0.13, distribution: { reasoning: 0.3, "long-context": 0.3, balanced: 0.2, fast: 0.1, vision: 0.1 } },
    expect: { profile: "reasoning", secondary: "long-context", routed: true, scoringCalls: 1 },
  },
  {
    name: "diffuse five-way split with top two at 0.55 is skipped",
    injected: { value: "reasoning", confidence: 0.2, distribution: { reasoning: 0.35, "long-context": 0.2, balanced: 0.2, fast: 0.15, vision: 0.1 } },
    expect: { profile: "reasoning", routed: false, scoringCalls: 0 },
  },
  {
    name: "no distribution: Choice confidence 0.70 routes alone",
    injected: { value: "long-context", confidence: 0.7 },
    expect: { profile: "long-context", routed: true, scoringCalls: 1 },
  },
  {
    name: "no distribution: Choice confidence 0.59 is skipped",
    injected: { value: "long-context", confidence: 0.59 },
    expect: { profile: "long-context", routed: false, scoringCalls: 0 },
  },
  {
    name: "vision top 0.45 + long-context 0.30 combines; image gate still excludes text-only models",
    injected: { value: "vision", confidence: 0.3, distribution: { vision: 0.45, "long-context": 0.3, reasoning: 0.2, balanced: 0.05, fast: 0 } },
    expect: { profile: "vision", secondary: "long-context", routed: true, scoringCalls: 1 },
  },
];

console.log("\n=== Boundary cases (injected classification, live scoring when routed) ===");
for (const c of boundaryCases) {
  console.log(`\nCASE: ${c.name}`);
  injectedClassification = c.injected;
  scoringRequests = 0;
  switched = [];
  const hasImages = c.injected.value === "vision";
  const result = await router.route("boundary case prompt", ctx, { hasImages });
  console.log(`  RESULT: ${describe(result)}`);

  assert.equal(result.profile, c.expect.profile, "primary profile");
  assert.equal(result.secondaryProfile, c.expect.secondary, "secondary profile");
  assert.equal(scoringRequests, c.expect.scoringCalls, "number of live scoring calls");
  if (c.expect.routed) {
    assert.equal(result.skipped, undefined, "routed cases are not skipped");
    assert.ok(result.model, "routed cases select a model");
    if (hasImages) assert.ok(result.model.input?.includes("image"), "image gate holds under a split need");
  } else {
    assert.equal(result.skipped, "low-confidence", "sub-threshold cases are skipped as low-confidence");
    assert.equal(switched.length, 0, "skipped cases never switch models");
  }
  if (switched.length) { console.log(`  setModel called: ${switched.join(", ")}`); ctx.model = result.model; }
}
injectedClassification = undefined;

console.log(`\nPASS: ${liveCases.length} live prompt(s) and ${boundaryCases.length} boundary case(s).`);
