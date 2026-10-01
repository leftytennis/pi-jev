// Show the full quality-tier table by provider and model, exactly as routing
// computes it: the explicit overlay (~/.pi/agent/jev-model-tiers.json or
// PI_JEV_MODEL_TIERS) wins per model; the provider price ladder fills the rest.
// claude-bridge is extension-registered, so its lineup is approximated from
// pi-ai's built-in anthropic models (same lineup the bridge proxies).
// Usage: node --import tsx scripts/show-tiers.ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaultTierOverlayPath, inferTiers, readTierOverlay, tierKey, type TierTable } from "../src/tiers.js";

const runtime = await ModelRuntime.create();
const available = await runtime.getAvailable();

// claude-bridge lineup via the anthropic builtin it proxies, matching the
// bridge's buildModels: dated aliases (-20YYMMDD) are never registered, and
// every model is zero-priced because it is a subscription bridge — so without
// an overlay, all claude-bridge models flatten to the default tier.
const claudeBridge = runtime
  .getModels("anthropic")
  .filter((m) => !/-20\d{6}$/.test(m.id))
  .map((m) => ({ ...m, provider: "claude-bridge" as const, cost: { input: 0, output: 0 } }));

const overlayPath = process.env.PI_JEV_MODEL_TIERS ?? defaultTierOverlayPath();
const read = readTierOverlay(overlayPath);
console.log(`overlay: ${"tiers" in read ? `${overlayPath} (${read.tiers.size} entr${read.tiers.size === 1 ? "y" : "ies"})` : "missing" in read ? "none (all price-inferred)" : `INVALID: ${(read as any).error}`}`);

const tiers: TierTable = inferTiers([...available, ...claudeBridge], "tiers" in read ? read.tiers : new Map());

const byProvider = new Map<string, typeof available>();
for (const m of [...available, ...claudeBridge]) {
  const g = byProvider.get(m.provider) ?? [];
  g.push(m as any);
  byProvider.set(m.provider, g as any);
}

for (const provider of [...byProvider.keys()].sort()) {
  const models = [...byProvider.get(provider)!].sort(
    (a, b) => (tiers.get(tierKey(provider, b.id))?.tier ?? 0) - (tiers.get(tierKey(provider, a.id))?.tier ?? 0)
      || (b.cost?.input ?? 0) - (a.cost?.input ?? 0)
  );
  console.log(`\n${provider}:`);
  for (const m of models) {
    const t = tiers.get(tierKey(provider, m.id));
    const price = m.cost ? (m.cost.input === 0 && m.cost.output === 0 ? "$0 (subscription)" : `$${m.cost.input}/$${m.cost.output}`) : "no price";
    console.log(`  ${m.id.padEnd(28)} ${price.padEnd(14)} tier ${t?.tier ?? "?"}/5 (${t?.basis ?? "unknown"})`);
  }
}
process.exit(0);
