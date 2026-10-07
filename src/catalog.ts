import type { Model } from "@earendil-works/pi-ai";
import { applyModelTierPolicy, compareGeneration, supersedes } from "./model-router.js";
import { DEFAULT_TIER, TIER_ALIASES, type QualityTier, type TierOverlay } from "./tiers.js";

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
  if (!tokens) return "?";
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function formatPricing(model: Model<any>): string {
  const input = model.cost?.input;
  const output = model.cost?.output;
  if (typeof input !== "number" && typeof output !== "number") return "?";
  // Subscription-bridged models are zero-priced; one "$0" reads better than "$0 / $0".
  if (input === 0 && output === 0) return "$0";
  const fmt = (v: unknown) => (typeof v === "number" ? `$${v}` : "?");
  return `${fmt(input)} / ${fmt(output)}`;
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
  | { kind: "eligible" }
  | { kind: "frontier" }
  | { kind: "excluded" }
  | { kind: "suppressed"; by: Model<any> };

function modelKey(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

/** Apply the same model policy as routing and explain why each model survives or not. */
function routingStatuses(models: Model<any>[], policy: TierOverlay): Map<string, RoutingStatus> {
  const ordinary = applyModelTierPolicy(models, policy.tiers, false, policy.exclude);
  const frontier = applyModelTierPolicy(models, policy.tiers, true, policy.exclude);
  const ordinaryKeys = new Set(ordinary.map(modelKey));
  const frontierKeys = new Set(frontier.map(modelKey));

  const statuses = new Map<string, RoutingStatus>();
  for (const model of models) {
    const key = modelKey(model);
    if (policy.exclude.has(key)) {
      statuses.set(key, { kind: "excluded" });
    } else if (ordinaryKeys.has(key)) {
      statuses.set(key, { kind: "eligible" });
    } else if (frontierKeys.has(key)) {
      statuses.set(key, { kind: "frontier" });
    } else {
      const replacement = ordinary.find((candidate) => supersedes(candidate, model))
        ?? frontier.find((candidate) => supersedes(candidate, model));
      statuses.set(key, replacement ? { kind: "suppressed", by: replacement } : { kind: "eligible" });
    }
  }
  return statuses;
}

/**
 * Pad every column but the last to its widest cell. With a header row,
 * columns empty in every body row are dropped.
 */
function alignColumns(rows: string[][], hasHeader: boolean): string[] {
  if (!rows.length) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const body = hasHeader ? rows.slice(1) : rows;
  const keep = Array.from({ length: width }, (_, col) => col === 0 || body.some((row) => (row[col] ?? "") !== ""));
  const kept = rows.map((row) => row.filter((_, col) => keep[col]));
  const widths = kept[0].map((_, col) => Math.max(...kept.map((row) => (row[col] ?? "").length)));
  return kept.map((row) => row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]))).join("  ").trimEnd());
}

/** A rendered line: plain text (titles, blank lines) or table cells aligned with the other cell rows. */
type Line = string | string[];

function layout(lines: Line[], hasHeader: boolean): string[] {
  const aligned = alignColumns(lines.filter((line): line is string[] => Array.isArray(line)), hasHeader);
  let next = 0;
  return lines.map((line) => (Array.isArray(line) ? aligned[next++] : line));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const TIER_NAMES = Object.fromEntries(Object.entries(TIER_ALIASES).map(([name, tier]) => [tier, name])) as Record<QualityTier, string>;
const TIERS_HIGH_TO_LOW: QualityTier[] = [5, 4, 3, 2, 1];

interface ProviderGroup {
  provider: string;
  name: string;
  auth: string;
  models: Model<any>[];
}

/**
 * Render the session's model catalog for authenticated providers, with this
 * session's attributable cost per model. With a tier policy, models from
 * every provider are grouped by quality tier, highest first, and the models
 * routing will not use are listed after them: suppressed versions as one line
 * per replacement, then exclusions. Without a policy there is no tier to
 * group by, so each provider gets its own table. Providers without configured
 * auth are counted, not listed.
 */
export function renderCatalog(ctx: CatalogContext, policy?: TierOverlay): string {
  const models = ctx.modelRegistry.getAvailable();
  const costs = sessionCosts(ctx.sessionManager.getEntries() as EntrySlice[]);
  const costByKey = new Map(costs.lines.map((line) => [line.key, line]));
  const matchedKeys = new Set<string>();
  const isCurrent = (model: Model<any>) => ctx.model?.provider === model.provider && ctx.model?.id === model.id;

  const grouped = new Map<string, Model<any>[]>();
  for (const model of models) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
  const providers: ProviderGroup[] = [];
  let unauthenticatedProviders = 0;
  let unauthenticatedModels = 0;
  for (const [provider, group] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const status = ctx.modelRegistry.getProviderAuthStatus(provider);
    if (!status.configured) {
      unauthenticatedProviders += 1;
      unauthenticatedModels += group.length;
      continue;
    }
    const auth = status.label ?? status.source ?? "configured";
    providers.push({ provider, name: ctx.modelRegistry.getProviderDisplayName(provider), auth, models: group });
  }
  const shown = providers.flatMap((group) => group.models);

  const detailCells = (model: Model<any>): string[] => {
    const key = modelKey(model);
    const line = costByKey.get(key);
    if (line) matchedKeys.add(key);
    return [
      modelTier(model),
      formatContextWindow(model.contextWindow),
      (model.input ?? ["text"]).join("+"),
      formatPricing(model),
      line ? `${line.cost > 0 ? `${formatUsd(line.cost)} · ` : ""}${formatTokens(line.tokens)} tok` : "",
      isCurrent(model) ? "← current" : "",
    ];
  };
  const DETAIL_HEADERS = ["TYPE", "CONTEXT", "INPUT", "PRICE", "SESSION", ""];

  const header = [`Model catalog — ${plural(providers.length, "provider")}, ${plural(shown.length, "model")}`];
  let body: string[];

  if (!policy) {
    body = providers.flatMap((group, i) => [
      ...(i > 0 ? [""] : []),
      `${group.name} (auth: ${group.auth})`,
      ...layout([
        ["  MODEL", ...DETAIL_HEADERS],
        ...[...group.models].sort((a, b) => a.id.localeCompare(b.id)).map((model) => [`    ${model.id}`, ...detailCells(model)]),
      ], true),
    ]);
  } else {
    const statuses = routingStatuses(models, policy);
    const kindOf = (model: Model<any>) => statuses.get(modelKey(model))?.kind;
    const providerName = new Map(providers.map((group) => [group.provider, group.name]));
    const nameOf = (model: Model<any>) => providerName.get(model.provider) ?? model.provider;
    const tierOf = (model: Model<any>) => policy.tiers.get(modelKey(model))?.tier ?? DEFAULT_TIER;
    const byProviderThenId = (a: Model<any>, b: Model<any>) => nameOf(a).localeCompare(nameOf(b)) || a.id.localeCompare(b.id);
    const label = (model: Model<any>) => `${model.id}${isCurrent(model) ? " (current)" : ""}`;

    let inferredShown = false;
    let defaultShown = false;
    const modelCell = (model: Model<any>) => {
      const basis = policy.tiers.get(modelKey(model))?.basis ?? "default";
      if (basis === "price-inferred") inferredShown = true;
      if (basis === "default") defaultShown = true;
      return `  ${model.id}${basis === "price-inferred" ? " *" : basis === "default" ? " ?" : ""}`;
    };

    const routable = shown.filter((model) => kindOf(model) === "eligible" || kindOf(model) === "frontier");
    const table: Line[] = [["  MODEL", "PROVIDER", ...DETAIL_HEADERS]];
    for (const tier of TIERS_HIGH_TO_LOW) {
      const inTier = routable.filter((model) => tierOf(model) === tier).sort(byProviderThenId);
      if (!inTier.length) continue;
      if (table.length > 1) table.push("");
      table.push(`Tier ${tier} · ${TIER_NAMES[tier]}${tier === 5 ? " — frontier only, used when a prompt asks for a frontier model" : ""}`);
      table.push(...inTier.map((model) => [modelCell(model), nameOf(model), ...detailCells(model)]));
    }
    body = table.length > 1 ? layout(table, true) : [];

    // The models routing will not use, one line per replacement or per provider.
    const replaced = new Map<string, { by: Model<any>; older: Model<any>[] }>();
    for (const model of shown) {
      const routing = statuses.get(modelKey(model));
      if (routing?.kind !== "suppressed") continue;
      const entry = replaced.get(modelKey(routing.by)) ?? { by: routing.by, older: [] };
      entry.older.push(model);
      replaced.set(modelKey(routing.by), entry);
    }
    const unused: Line[] = [];
    if (replaced.size) {
      unused.push("", "Suppressed — a newer version is used instead");
      const entries = [...replaced.values()].sort((a, b) => tierOf(b.by) - tierOf(a.by) || byProviderThenId(a.by, b.by));
      for (const { by, older } of entries) {
        older.sort((a, b) => compareGeneration(a.id, b.id));
        unused.push([`  ${nameOf(by)}`, `${older.map(label).join(", ")} → ${by.id}`]);
      }
    }
    const excluded = providers
      .map((group) => ({ group, models: group.models.filter((model) => kindOf(model) === "excluded").sort((a, b) => a.id.localeCompare(b.id)) }))
      .filter(({ models: list }) => list.length);
    if (excluded.length) {
      unused.push("", "Excluded by the tier file");
      for (const { group, models: list } of excluded) unused.push([`  ${group.name}`, list.map(label).join(", ")]);
    }
    body.push(...layout(unused, false));
    if (body[0] === "") body.shift();

    const counts = { eligible: 0, frontier: 0, suppressed: 0, excluded: 0 };
    for (const model of shown) {
      const kind = kindOf(model);
      if (kind) counts[kind] += 1;
    }
    header[0] += `: ${counts.eligible} eligible · ${counts.frontier} frontier only · ${counts.suppressed} suppressed · ${counts.excluded} excluded`;
    header.push(`Providers: ${providers.map((group) => `${group.name} (auth: ${group.auth})`).join(" · ")}`);
    header.push([
      "Tiers rank quality from 1 (budget) to 5 (flagship).",
      ...(inferredShown ? ["* tier inferred from price, not set in the tier file."] : []),
      ...(defaultShown ? [`? no tier set and no price to infer from; treated as ${DEFAULT_TIER}.`] : []),
    ].join(" "));
  }
  header.push("Price is $ per million tokens, input / output.");

  const out = [...header, "", ...body, ...(body.length ? [""] : [])];
  out.push(`Session cost: ${formatUsd(costs.totalCost)} (${formatTokens(costs.totalTokens)} tokens)`);
  for (const line of costs.lines.filter((line) => !matchedKeys.has(line.key))) {
    out.push(`  • ${line.key}: ${formatUsd(line.cost)} (${formatTokens(line.tokens)} tok)`);
  }
  if (unauthenticatedProviders > 0) {
    out.push(`Not shown: ${unauthenticatedModels} model(s) from ${unauthenticatedProviders} provider(s) without configured auth.`);
  }
  return out.join("\n");
}
