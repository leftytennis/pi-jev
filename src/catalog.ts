import type { Model } from "@earendil-works/pi-ai";
import { applyModelTierPolicy, supersedes } from "./model-router.js";
import type { TierOverlay } from "./tiers.js";

/**
 * Capability tier derived from registry metadata only — never from model or
 * provider names. Aligned with the router's profile vocabulary:
 * - "reasoning": the registry marks the model as a reasoning model.
 * - "fast": non-reasoning and cheap enough to treat as a low-latency workhorse.
 * - "balanced": everything else.
 */
export type ModelTier = "reasoning" | "balanced" | "fast";

/** Input cost (USD per MTok) at or below which a non-reasoning model counts as fast. */
export const FAST_INPUT_COST_CEILING = 1;

export function modelTier(model: Model<any>): ModelTier {
  if (model.reasoning) return "reasoning";
  const input = model.cost?.input;
  if (typeof input === "number" && Number.isFinite(input) && input <= FAST_INPUT_COST_CEILING) {
    return "fast";
  }
  return "balanced";
}

/**
 * Structural slices of session entries: the concrete SessionEntry union is not
 * exported from the package root, so the aggregation is typed against exactly
 * the fields it reads. Attribution mirrors Pi core's usage breakdown —
 * assistant messages by `provider/responseModel ?? model`, tool-result
 * summaries and compaction/branch summaries into one "tools/summaries" bucket.
 */
interface UsageSlice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

interface EntrySlice {
  type: string;
  message?: {
    role: string;
    provider?: string;
    model?: string;
    responseModel?: string;
    usage?: UsageSlice;
  };
  usage?: UsageSlice;
}

export const SUMMARY_BUCKET = "tools/summaries";

export interface SessionCostLine {
  /** `provider/modelId` for assistant usage, or SUMMARY_BUCKET. */
  key: string;
  cost: number;
  tokens: number;
}

export interface SessionCosts {
  lines: SessionCostLine[];
  totalCost: number;
  totalTokens: number;
}

/** Aggregate attributable session cost per model, highest cost first. */
export function sessionCosts(entries: readonly EntrySlice[]): SessionCosts {
  const byKey = new Map<string, { cost: number; tokens: number }>();
  for (const entry of entries) {
    let key: string | undefined;
    let usage: UsageSlice | undefined;
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
      usage = entry.message.usage;
    } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
      key = SUMMARY_BUCKET;
      usage = entry.message.usage;
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      key = SUMMARY_BUCKET;
      usage = entry.usage;
    }
    if (!key || !usage) continue;
    const totals = byKey.get(key) ?? { cost: 0, tokens: 0 };
    totals.cost += usage.cost?.total ?? 0;
    totals.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    byKey.set(key, totals);
  }
  const lines = Array.from(byKey, ([key, t]) => ({ key, ...t }))
    .filter((line) => line.cost > 0 || line.tokens > 0)
    .sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
  return {
    lines,
    totalCost: lines.reduce((sum, line) => sum + line.cost, 0),
    totalTokens: lines.reduce((sum, line) => sum + line.tokens, 0),
  };
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

function formatContextWindow(tokens: number | undefined): string {
  if (!tokens) return "ctx ?";
  return tokens >= 1000 ? `ctx ${Math.round(tokens / 1000)}k` : `ctx ${tokens}`;
}

function formatPricing(model: Model<any>): string {
  const input = model.cost?.input;
  const output = model.cost?.output;
  if (typeof input !== "number" && typeof output !== "number") return "cost ?";
  const fmt = (v: unknown) => (typeof v === "number" ? `$${v}` : "?");
  return `${fmt(input)}/${fmt(output)} per MTok`;
}

/** The registry surface the catalog reads; a structural type so tests can fake it. */
export interface CatalogRegistry {
  getAvailable(): Model<any>[];
  getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string };
  getProviderDisplayName(provider: string): string;
}

export interface CatalogContext {
  modelRegistry: CatalogRegistry;
  model?: Model<any>;
  sessionManager: { getEntries(): unknown[] };
}

type RoutingStatus =
  | { kind: "enabled" }
  | { kind: "frontier" }
  | { kind: "excluded" }
  | { kind: "suppressed"; by: string };

function modelKey(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

/** Apply the same model policy as routing and explain why each model survives or not. */
function routingStatuses(models: Model<any>[], policy: TierOverlay | undefined): Map<string, RoutingStatus> {
  const statuses = new Map<string, RoutingStatus>();
  if (!policy) return statuses;

  const ordinary = applyModelTierPolicy(models, policy.tiers, false, policy.exclude);
  const frontier = applyModelTierPolicy(models, policy.tiers, true, policy.exclude);
  const ordinaryKeys = new Set(ordinary.map(modelKey));
  const frontierKeys = new Set(frontier.map(modelKey));

  for (const model of models) {
    const key = modelKey(model);
    if (policy.exclude.has(key)) {
      statuses.set(key, { kind: "excluded" });
    } else if (ordinaryKeys.has(key)) {
      statuses.set(key, { kind: "enabled" });
    } else if (frontierKeys.has(key)) {
      statuses.set(key, { kind: "frontier" });
    } else {
      const replacement = ordinary.find((candidate) => supersedes(candidate, model))
        ?? frontier.find((candidate) => supersedes(candidate, model));
      statuses.set(key, replacement ? { kind: "suppressed", by: replacement.id } : { kind: "enabled" });
    }
  }
  return statuses;
}

function routingLabel(status: RoutingStatus): string {
  switch (status.kind) {
    case "enabled": return "enabled";
    case "frontier": return "frontier only";
    case "excluded": return "excluded";
    case "suppressed": return `suppressed by ${status.by}`;
  }
}

/**
 * Render the session's model catalog: authenticated providers and their
 * models with tier, routing eligibility, capability metadata, and this
 * session's attributable cost per model. Providers without configured auth
 * are counted, not listed.
 */
export function renderCatalog(ctx: CatalogContext, policy?: TierOverlay): string {
  const models = ctx.modelRegistry.getAvailable();
  const statuses = routingStatuses(models, policy);
  const costs = sessionCosts(ctx.sessionManager.getEntries() as EntrySlice[]);
  const costByKey = new Map(costs.lines.map((line) => [line.key, line]));
  const matchedKeys = new Set<string>();

  const byProvider = new Map<string, Model<any>[]>();
  for (const model of models) {
    const group = byProvider.get(model.provider) ?? [];
    group.push(model);
    byProvider.set(model.provider, group);
  }

  const authenticated: string[] = [];
  let unauthenticatedProviders = 0;
  let unauthenticatedModels = 0;
  const sections: string[] = [];

  for (const [provider, group] of [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const status = ctx.modelRegistry.getProviderAuthStatus(provider);
    if (!status.configured) {
      unauthenticatedProviders += 1;
      unauthenticatedModels += group.length;
      continue;
    }
    authenticated.push(provider);
    const auth = status.label ?? status.source ?? "configured";
    const rows = [...group]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((model) => {
        const key = `${model.provider}/${model.id}`;
        const line = costByKey.get(key);
        if (line) matchedKeys.add(key);
        const parts = [
          `tier: ${modelTier(model)}`,
          formatContextWindow(model.contextWindow),
          (model.input ?? ["text"]).join("+"),
          formatPricing(model),
        ];
        // The quality axis is omitted when nothing is known, not rendered as noise.
        const quality = policy?.tiers.get(key);
        if (quality && quality.basis !== "default") parts.push(`quality: ${quality.tier}/5 (${quality.basis})`);
        const routing = statuses.get(key);
        if (routing) parts.push(`routing: ${routingLabel(routing)}`);
        if (line) parts.push(`session: ${formatUsd(line.cost)} (${formatTokens(line.tokens)} tok)`);
        const current = ctx.model?.provider === model.provider && ctx.model?.id === model.id;
        return `  • ${model.id} — ${parts.join(" · ")}${current ? "  ← current" : ""}`;
      });
    sections.push(`${ctx.modelRegistry.getProviderDisplayName(provider)} (auth: ${auth}):\n${rows.join("\n")}`);
  }

  const shownModels = [...byProvider.entries()]
    .filter(([provider]) => ctx.modelRegistry.getProviderAuthStatus(provider).configured)
    .flatMap(([, group]) => group);
  const statusCounts = { enabled: 0, frontier: 0, suppressed: 0, excluded: 0 };
  for (const model of shownModels) {
    const status = statuses.get(modelKey(model));
    if (status) statusCounts[status.kind] += 1;
  }
  const policySummary = policy
    ? ` ${statusCounts.enabled} enabled · ${statusCounts.frontier} frontier-only · ${statusCounts.suppressed} suppressed · ${statusCounts.excluded} excluded`
    : "";
  const header = `Model catalog — ${authenticated.length} authenticated provider(s), ${shownModels.length} model(s):${policySummary}`;
  const out: string[] = [header, "", ...sections.flatMap((s) => [s, ""])];

  const unmatched = costs.lines.filter((line) => !matchedKeys.has(line.key));
  const footer: string[] = [
    `Session cost: ${formatUsd(costs.totalCost)} (${formatTokens(costs.totalTokens)} tokens)`,
  ];
  for (const line of unmatched) {
    footer.push(`  • ${line.key}: ${formatUsd(line.cost)} (${formatTokens(line.tokens)} tok)`);
  }
  if (unauthenticatedProviders > 0) {
    footer.push(
      `Not shown: ${unauthenticatedModels} model(s) from ${unauthenticatedProviders} provider(s) without configured auth.`
    );
  }
  out.push(...footer);
  return out.join("\n");
}
