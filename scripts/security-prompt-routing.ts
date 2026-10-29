// Routes a corpus of real-world security-audit prompts through the local
// classifier and the live Jev model router, then reports both verdicts side by
// side. Companion to smoke-model-router.ts: that script asserts routing rules
// on a handful of prompts, this one measures behavior across a whole corpus.
//
// Usage: node --import tsx scripts/security-prompt-routing.ts [corpus.json]
import * as fs from "node:fs";
import * as path from "node:path";
import { AutoModelRouter, classifyModelNeed, type ModelProfile } from "../src/model-router.js";
import { JevClient } from "../src/jev.js";

const corpusPath = process.argv[2] ?? path.join(import.meta.dirname, "security-audit-prompts.json");
const corpus: { prompts: { id: string; source: string; text: string; hasImages?: boolean }[] } =
  JSON.parse(fs.readFileSync(corpusPath, "utf8"));

// Same pool as smoke-model-router.ts so results are comparable across scripts.
const model = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({
  id, provider, name: id, api: "test", baseUrl: "", reasoning: true,
  input: ["text", "image"], cost: { input: 1, output: 1 }, contextWindow: 272000, maxTokens: 131072, ...extra,
}) as any;

const pool = [
  model("openai-codex", "gpt-6-astra", { contextWindow: 272000, cost: { input: 10, output: 30 } }),
  model("openai-codex", "gpt-6.1-sol", { contextWindow: 272000, cost: { input: 2, output: 10 } }),
  model("claude-bridge", "claude-fable-5-1", { contextWindow: 1000000, cost: { input: 10, output: 30 } }),
  model("zai", "glm-5.3-flash", { contextWindow: 1000000, cost: { input: 0.075, output: 0.25 } }),
  model("kimi-coding", "k3", { contextWindow: 1048576, cost: { input: 3, output: 15 } }),
  model("kimi-coding", "k3-256k", { contextWindow: 262144, cost: { input: 0, output: 0 } }),
  model("openai", "gpt-4.1-nano", { reasoning: false, contextWindow: 1047576, cost: { input: 0.1, output: 0.4 } }),
  model("openai-codex", "gpt-5.3-codex-spark", { input: ["text"], contextWindow: 128000, cost: { input: 1.75, output: 7 } }),
];
const baseline = pool[2]; // every prompt starts from glm-5.3-flash so runs are independent

const jev = new JevClient();
if (!jev.isConfigured()) { console.error("Jev not configured"); process.exit(1); }

type Classification = { value: unknown; confidence: number | undefined; distribution: Record<string, number> | undefined };
let classification: Classification | undefined;
let scoringCalls = 0;
let jevCalls = 0;

const failures: { id: string; phase: string; error: string }[] = [];
let currentId = "";

const origEvaluate = jev.evaluate.bind(jev);
(jev as any).evaluate = async (req: any, signal?: AbortSignal) => {
  jevCalls++;
  const isClassification = Boolean(req.questions.profile);
  if (!isClassification) scoringCalls++;
  try {
    const res = await origEvaluate(req, signal);
    if (isClassification) {
      const answer = res.answers.profile;
      classification = { value: answer?.value, confidence: answer?.confidence, distribution: answer?.distribution };
    }
    return res;
  } catch (error: any) {
    failures.push({ id: currentId, phase: isClassification ? "classification" : "scoring", error: String(error?.message ?? error).slice(0, 160) });
    throw error;
  }
};

const router = new AutoModelRouter({ setModel: async () => true } as any, true, jev);

/** Top two entries of a distribution, highest probability first. */
function topTwo(distribution: Record<string, number> | undefined): { profile: string; p: number }[] {
  if (!distribution) return [];
  return Object.entries(distribution)
    .map(([profile, p]) => ({ profile, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 2);
}

type Row = {
  id: string;
  chars: number;
  local: string;
  localConfidence: number;
  jev: string;
  jevDetail: string;
  decision: string;
  routed: string;
  tierSize: number;
  costSwap: boolean;
};

const rows: Row[] = [];
console.log(`Routing ${corpus.prompts.length} prompts from ${path.basename(corpusPath)} through the classifier and model router...\n`);

for (const entry of corpus.prompts) {
  classification = undefined;
  scoringCalls = 0;
  currentId = entry.id;
  const ctx: any = {
    model: baseline,
    modelRegistry: { getAvailable: () => pool },
    getSystemPrompt: () => "",
  };
  const localNeed = classifyModelNeed(entry.text, 0, Boolean(entry.hasImages));
  const result = await router.route(entry.text, ctx, { hasImages: entry.hasImages });

  const ranked = topTwo(classification?.distribution);
  const jevProfile = classification ? String(classification.value) : "(skipped)";
  const jevDetail = ranked.length
    ? ranked.map((r) => `${r.profile} ${r.p.toFixed(2)}`).join(" / ")
    : classification
      ? `confidence ${classification.confidence ?? "?"}, no distribution`
      : "local only";
  const decision = result.skipped
    ? `skip (${result.skipped})`
    : result.secondaryProfile
      ? `combine ${result.profile}+${result.secondaryProfile}`
      : `alone ${result.profile}`;

  rows.push({
    id: entry.id,
    chars: entry.text.length,
    local: localNeed.profile,
    localConfidence: localNeed.confidence,
    jev: jevProfile,
    jevDetail,
    decision,
    routed: result.model ? `${result.model.provider}/${result.model.id}` : "(unchanged)",
    tierSize: result.tier?.length ?? 0,
    costSwap: /over best-overall/.test(result.reason),
  });
  process.stdout.write(".");
}
console.log("\n");

const widths = {
  id: Math.max(...rows.map((r) => r.id.length), 2),
  local: Math.max(...rows.map((r) => r.local.length), 5),
  jev: Math.max(...rows.map((r) => r.jevDetail.length), 18),
  decision: Math.max(...rows.map((r) => r.decision.length), 8),
  routed: Math.max(...rows.map((r) => r.routed.length), 7),
};
const pad = (text: string, width: number) => text.padEnd(width);
console.log(
  `${pad("#", 3)} ${pad("prompt", widths.id)}  ${pad("chars", 5)}  ${pad("local", widths.local)}  ` +
  `${pad("jev top two", widths.jev)}  ${pad("decision", widths.decision)}  ${pad("routed to", widths.routed)}  tier`
);
console.log("-".repeat(3 + widths.id + widths.local + widths.jev + widths.decision + widths.routed + 30));
rows.forEach((row, index) => {
  console.log(
    `${pad(String(index + 1), 3)} ${pad(row.id, widths.id)}  ${pad(String(row.chars), 5)}  ` +
    `${pad(row.local, widths.local)}  ${pad(row.jevDetail, widths.jev)}  ${pad(row.decision, widths.decision)}  ` +
    `${pad(row.routed, widths.routed)}  ${row.tierSize}${row.costSwap ? " (cost swap)" : ""}`
  );
});

const tally = (values: string[]) =>
  [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => `${value} ${count}`)
    .join(", ");

const agreed = rows.filter((row) => row.local === row.jev).length;
const routedRows = rows.filter((row) => !row.decision.startsWith("skip"));
console.log(`\nPrompts:            ${rows.length}`);
console.log(`Jev primary:        ${tally(rows.map((r) => r.jev))}`);
console.log(`Local classifier:   ${tally(rows.map((r) => r.local))}`);
console.log(`Agreement:          ${agreed}/${rows.length} (${Math.round((agreed / rows.length) * 100)}%)`);
console.log(`Decisions:          ${tally(rows.map((r) => (r.decision.startsWith("combine") ? "combined" : r.decision.startsWith("skip") ? "skipped" : "alone")))}`);
console.log(`Routed to:          ${tally(routedRows.map((r) => r.routed))}`);
console.log(`Cost swaps in tier: ${rows.filter((r) => r.costSwap).length}`);
console.log(`Jev calls:          ${jevCalls}`);
if (failures.length) {
  console.log(`\nJev call failures (router fell back to the local classifier / heuristic scoring):`);
  for (const failure of failures) console.log(`  ${failure.id} [${failure.phase}]: ${failure.error}`);
}
