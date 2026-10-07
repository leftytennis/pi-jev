// Show the routing precedence table: for every authenticated model, the value
// each precedence stage would use right now, sorted the way routeOnce sorts.
// Stages: 1 capability score (per profile; reasoning and fast shown),
// 2 quota demotion, 3 Jev confidence (exists only during live Jev scoring,
// not shown), 4 quota headroom (live), 5 current/provider/generation/key.
// Tier-policy and quota exclusions are listed separately at the end.
// Usage: node --import tsx scripts/show-routing.ts [--frontier]
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { attributeScopes, AutoModelRouter, applyModelTierPolicy, compareGeneration, heuristicScore, pressureForModel, pressureFromReport, QUOTA_DEMOTE_PERCENT, QUOTA_EXCLUDE_PERCENT } from "../src/model-router.js";
import { collectPlatformUsage } from "../src/usage.js";
import { tierKey, type QualityTier } from "../src/tiers.js";

const runtime = await ModelRuntime.create();
const real = new ModelRegistry(runtime);
const available = await runtime.getAvailable();
const claudeBridge = runtime
  .getModels("anthropic")
  .filter((m) => !/-20\d{6}$/.test(m.id))
  .map((m) => ({ ...m, provider: "claude-bridge" as const, cost: { input: 0, output: 0 } }));
const models = [...available, ...claudeBridge];

const registry: any = {
  getAvailable: () => models,
  getProviderAuthStatus: (p: string) => (p === "claude-bridge" ? { configured: true } : real.getProviderAuthStatus(p)),
  getProviderAuth: (p: string) => real.getProviderAuth(p),
};

// The router computes tiers itself; an enabled-but-never-routed instance gives
// us the same table via its public tiersFor.
const router = new AutoModelRouter({ setModel: async () => {} } as any, true);
const tiers = router.tiersFor({ modelRegistry: registry });
const tierOf = (m: any): QualityTier => tiers.get(tierKey(m.provider, m.id))?.tier ?? 3;
const basisOf = (m: any): string => tiers.get(tierKey(m.provider, m.id))?.basis ?? "default";

const report = await collectPlatformUsage({ registry });
const snapshot = attributeScopes(pressureFromReport(report), models);

type Row = { model: any; quota: string; headroom: number; demoted: boolean };
const rows: Row[] = models.map((model) => {
  const p = pressureForModel(snapshot, model);
  const excluded = p ? p.limitReached || p.usedPercent >= QUOTA_EXCLUDE_PERCENT : false;
  const demoted = !excluded && p ? p.usedPercent >= QUOTA_DEMOTE_PERCENT : false;
  const quota = excluded
    ? `EXCLUDED (${p!.limitReached ? "limit reached" : `${p!.windowLabel} ${Math.round(p!.usedPercent)}%`})`
    : demoted
      ? `demoted (${p!.windowLabel} ${Math.round(p!.usedPercent)}%)`
      : p ? "ok" : "no data";
  return { model, quota, headroom: p?.usedPercent ?? Number.MAX_SAFE_INTEGER, demoted };
});

const allowFrontier = process.argv.includes("--frontier");
const admittedKeys = new Set(applyModelTierPolicy(models, tiers, allowFrontier).map((m) => tierKey(m.provider, m.id)));
const policyLabel = (r: Row): string => admittedKeys.has(tierKey(r.model.provider, r.model.id))
  ? "" : tierOf(r.model) === 5 && !allowFrontier ? "reserved for explicit frontier request" : `superseded tier ${tierOf(r.model)} version`;

const render = (profile: "reasoning" | "fast") => {
  const score = (m: any) => heuristicScore(m, profile, false, tierOf(m));
  const eligible = rows.filter((r) => !policyLabel(r) && !r.quota.startsWith("EXCLUDED"));
  const excluded = rows.filter((r) => policyLabel(r) || r.quota.startsWith("EXCLUDED"));
  const cmp = (a: Row, b: Row) =>
    score(b.model) - score(a.model) ||
    Number(a.demoted) - Number(b.demoted) ||
    (a.headroom === b.headroom ? 0 : a.headroom < b.headroom ? -1 : 1) ||
    a.model.provider.localeCompare(b.model.provider) ||
    compareGeneration(a.model.id, b.model.id) ||
    tierKey(a.model.provider, a.model.id).localeCompare(tierKey(b.model.provider, b.model.id));
  eligible.sort(cmp);
  excluded.sort(cmp);
  console.log(`\n== ${profile} need — precedence: score → demotion → headroom → current → provider → generation → key (Jev confidence slots between demotion and headroom when Jev runs; no current model in this view) ==`);
  console.log(`Tier policy: frontier ${allowFrontier ? "enabled" : "disabled"}; newest eligible version per provider family`);
  console.log(`${"  #"}  ${"model (key)"}  ${"score"}  ${"tier"}  ${"quota"}  headroom`);
  eligible.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(3)}  ${tierKey(r.model.provider, r.model.id).padEnd(34)} ${score(r.model).toFixed(1).padStart(6)}  ${`${tierOf(r.model)}/5 ${basisOf(r.model)}`.padEnd(19)} ${r.quota.padEnd(30)} ${r.headroom === Number.MAX_SAFE_INTEGER ? "—" : `${Math.round(r.headroom)}%`}`
    );
  });
  for (const r of excluded) {
    console.log(`  ✗  ${tierKey(r.model.provider, r.model.id).padEnd(34)} ${score(r.model).toFixed(1).padStart(6)}  ${`${tierOf(r.model)}/5 ${basisOf(r.model)}`.padEnd(19)} ${policyLabel(r) || r.quota}`);
  }
};

render("reasoning");
render("fast");
process.exit(0);
