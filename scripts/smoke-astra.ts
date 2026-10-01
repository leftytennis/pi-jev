// Live demonstration: with Claude's quota state read from Anthropic's own
// endpoint, does auto-model routing consider openai-codex/gpt-6-astra, and
// what does it pick? Uses Pi's real ModelRuntime/ModelRegistry, the real
// quota adapters, and real Jev calls (one classification + one scoring batch).
// setModel is faked — nothing is switched. Usage: node --import tsx scripts/smoke-astra.ts
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AutoModelRouter } from "../src/model-router.js";
import { JevClient } from "../src/jev.js";
import { collectPlatformUsage, renderUsage } from "../src/usage.js";

const runtime = await ModelRuntime.create();
const real = new ModelRegistry(runtime);
const available = await runtime.getAvailable();

// claude-bridge is registered by its extension inside a session; add the two
// heaviest hitters by hand so quota exclusion is visible here.
const claude = ["claude-fable-5-1", "claude-opus-5-5"].map((id) => ({
  id, provider: "claude-bridge", name: id, api: "test", baseUrl: "", reasoning: true,
  input: ["text", "image"], cost: { input: 0, output: 0 }, contextWindow: 1000000, maxTokens: 128000,
})) as any[];
const registry: any = {
  getAvailable: () => [...available, ...claude],
  getProviderAuthStatus: (p: string) => (p === "claude-bridge" ? { configured: true } : real.getProviderAuthStatus(p)),
  getProviderAuth: (p: string) => real.getProviderAuth(p),
};

const astra = available.find((m) => m.provider === "openai-codex" && m.id === "gpt-6-astra");
console.log(`astra in available pool: ${astra ? "yes" : "NO"}${astra ? ` (reasoning=${astra.reasoning}, ctx=${astra.contextWindow}, input=${astra.input?.join("+")})` : ""}`);
console.log(`pool size: ${available.length + claude.length} models (${claude.length} claude-bridge fakes included)`);

console.log("\n-- live quota snapshot --");
console.log(renderUsage(await collectPlatformUsage({ registry })));

const jev = new JevClient();
console.log(`\njev configured: ${jev.isConfigured()}`);
const pi: any = { setModel: async (m: any) => console.log(`setModel → ${m.provider}/${m.id}`) };
const ctx: any = {
  model: available.find((m) => m.provider === "zai") ?? available[0],
  modelRegistry: registry,
  getSystemPrompt: () => "",
};
const router = new AutoModelRouter(pi, true, jev);
const prompt = "Use a frontier model. Plan the schema migration rollout and compare rollback strategies";
console.log(`\n-- routing: "${prompt}" --`);
const result = await router.route(prompt, ctx);
console.log(`picked: ${result.model ? `${result.model.provider}/${result.model.id}` : "(none)"} (changed=${result.changed})`);
console.log(`reason: ${result.reason}`);

// Scoped pool: when the user scopes candidates to Codex models (a real router
// feature via ctx.scopedModels), astra is the flagship and should win.
const scoped = available.filter((m) => m.provider === "openai-codex");
console.log(`\n-- routing with pool scoped to ${scoped.length} openai-codex model(s) --`);
const scopedCtx: any = { ...ctx, scopedModels: scoped.map((model) => ({ model })) };
const scopedResult = await router.route(prompt, scopedCtx);
console.log(`picked: ${scopedResult.model ? `${scopedResult.model.provider}/${scopedResult.model.id}` : "(none)"} (changed=${scopedResult.changed})`);
console.log(`reason: ${scopedResult.reason}`);

// Tier-aware routing: with an explicit overlay the flagship should win the
// reasoning route even though budget models share its structural metadata.
const { parseTierOverlay } = await import("../src/tiers.js");
const overlay = parseTierOverlay(JSON.stringify({
  comment: "demo overlay: codex lineup per vendor positioning",
  tiers: {
    "openai-codex/gpt-6-astra": "flagship",
    "openai-codex/gpt-6-sol": "premium",
    "openai-codex/gpt-6-luna": "economy",
    "openai-codex/gpt-5.6-luna": "economy",
    "kimi-coding/k3": "premium",
    "zai/glm-5.3": "premium",
  },
}));
if (!("tiers" in overlay)) throw new Error("overlay failed to parse");
const tiered = new AutoModelRouter(pi, true, jev, { tierTable: overlay.tiers });
console.log(`\n-- tier-aware routing (overlay: astra=flagship, sol/k3/glm-5.3=premium, lunas=economy) --`);
const tieredResult = await tiered.route(prompt, ctx);
console.log(`picked: ${tieredResult.model ? `${tieredResult.model.provider}/${tieredResult.model.id}` : "(none)"} (changed=${tieredResult.changed})`);
console.log(`reason: ${tieredResult.reason}`);
const tieredScoped = await tiered.route(prompt, { ...ctx, scopedModels: scoped.map((model) => ({ model })) });
console.log(`scoped picked: ${tieredScoped.model ? `${tieredScoped.model.provider}/${tieredScoped.model.id}` : "(none)"}`);
console.log(`reason: ${tieredScoped.reason}`);
process.exit(0);
