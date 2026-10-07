import type { Model } from "@earendil-works/pi-ai";
import { applyModelTierPolicy, compareGeneration, supersedes } from "./model-router.js";
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

/** Pad every column but the last to its widest cell; columns empty in every row are dropped. */
function alignColumns(rows: string[][]): string[] {
  const width = Math.max(...rows.map((row) => row.length));
  const keep = Array.from({ length: width }, (_, col) => rows.slice(1).some((row) => (row[col] ?? "") !== ""));
  keep[0] = true;
  const kept = rows.map((row) => row.filter((_, col) => keep[col]));
  const widths = kept[0].map((_, col) => Math.max(...kept.map((row) => (row[col] ?? "").length)));
  return kept.map((row) => row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]))).join("  ").trimEnd());
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const GROUP_TITLES = {
  frontier: "Frontier only — used when a prompt asks for a frontier model",
  suppressed: "Suppressed — a newer version is used instead",
  excluded: "Excluded by the tier file",
} as const;

/**
 * Render the session's model catalog: authenticated providers and their
 * models in aligned columns, grouped by routing status when a tier policy is
 * supplied, with this session's attributable cost per model. Providers
 * without configured auth are counted, not listed.
 */
export function renderCatalog(ctx: CatalogContext, policy?: TierOverlay): string {
  const models = ctx.modelRegistry.getAvailable();
  const statuses = policy ? routingStatuses(models, policy) : undefined;
  const costs = sessionCosts(ctx.sessionManager.getEntries() as EntrySlice[]);
  const costByKey = new Map(costs.lines.map((line) => [line.key, line]));
  const matchedKeys = new Set<string>();
  const isCurrent = (model: Model<any>) => ctx.model?.provider === model.provider && ctx.model?.id === model.id;
  const qualityOf = (model: Model<any>) => policy?.tiers.get(modelKey(model));

  const byProvider = new Map<string, Model<any>[]>();
  for (const model of models) {
    const group = byProvider.get(model.provider) ?? [];
    group.push(model);
    byProvider.set(model.provider, group);
  }

  const shown: Model<any>[] = [];
  let unauthenticatedProviders = 0;
  let unauthenticatedModels = 0;
  let inferredQuality = false;
  const sections: string[][] = [];

  for (const [provider, group] of [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const status = ctx.modelRegistry.getProviderAuthStatus(provider);
    if (!status.configured) {
      unauthenticatedProviders += 1;
      unauthenticatedModels += group.length;
      continue;
    }
    shown.push(...group);

    const tableRow = (model: Model<any>): string[] => {
      const key = modelKey(model);
      const line = costByKey.get(key);
      if (line) matchedKeys.add(key);
      const quality = qualityOf(model);
      const inferred = quality?.basis === "price-inferred";
      if (inferred) inferredQuality = true;
      const session = line
        ? `${line.cost > 0 ? `${formatUsd(line.cost)} · ` : ""}${formatTokens(line.tokens)} tok`
        : "";
      return [
        `    ${model.id}`,
        quality && quality.basis !== "default" ? `${quality.tier}${inferred ? "*" : ""}` : "",
        modelTier(model),
        formatContextWindow(model.contextWindow),
        (model.input ?? ["text"]).join("+"),
        formatPricing(model),
        session,
        isCurrent(model) ? "← current" : "",
      ];
    };
    const byQuality = (a: Model<any>, b: Model<any>) =>
      (qualityOf(b)?.tier ?? 0) - (qualityOf(a)?.tier ?? 0) || a.id.localeCompare(b.id);
    const withStatus = (kind: RoutingStatus["kind"]) =>
      group.filter((model) => statuses?.get(modelKey(model))?.kind === kind).sort(byQuality);

    // Group titles sit between table rows, so tag them and align the rest together.
    const TITLE = "\u0000";
    const rows: string[][] = [["  MODEL", "QUALITY", "TYPE", "CONTEXT", "INPUT", "PRICE", "SESSION", ""]];
    if (!statuses) {
      rows.push(...[...group].sort((a, b) => a.id.localeCompare(b.id)).map(tableRow));
    } else {
      const eligible = withStatus("eligible");
      const frontier = withStatus("frontier");
      if (eligible.length) rows.push([TITLE + "  Eligible"], ...eligible.map(tableRow));
      if (frontier.length) rows.push([TITLE + `  ${GROUP_TITLES.frontier}`], ...frontier.map(tableRow));
    }
    const aligned = alignColumns(rows.map((row) => (row[0].startsWith(TITLE) ? [""] : row)));
    const lines = aligned.map((text, i) => (rows[i][0].startsWith(TITLE) ? rows[i][0].slice(1) : text));

    if (statuses) {
      const label = (model: Model<any>) => `${model.id}${isCurrent(model) ? " (current)" : ""}`;
      // One line per replacement: the older versions it stands in for, newest first.
      const replaced = new Map<string, { by: Model<any>; older: Model<any>[] }>();
      for (const model of group) {
        const routing = statuses.get(modelKey(model));
        if (routing?.kind !== "suppressed") continue;
        const entry = replaced.get(routing.by.id) ?? { by: routing.by, older: [] };
        entry.older.push(model);
        replaced.set(routing.by.id, entry);
      }
      if (replaced.size) {
        lines.push(`  ${GROUP_TITLES.suppressed}`);
        for (const { by, older } of [...replaced.values()].sort((a, b) => a.by.id.localeCompare(b.by.id))) {
          older.sort((a, b) => compareGeneration(a.id, b.id));
          lines.push(`    ${older.map(label).join(", ")} → ${by.id}`);
        }
      }
      const excluded = withStatus("excluded");
      if (excluded.length) lines.push(`  ${GROUP_TITLES.excluded}`, `    ${excluded.map(label).join(", ")}`);
    }

    const auth = status.label ?? status.source ?? "configured";
    sections.push([`${ctx.modelRegistry.getProviderDisplayName(provider)} (auth: ${auth})`, ...lines]);
  }

  const header = [`Model catalog — ${plural(sections.length, "provider")}, ${plural(shown.length, "model")}`];
  if (statuses) {
    const counts = { eligible: 0, frontier: 0, suppressed: 0, excluded: 0 };
    for (const model of shown) {
      const routing = statuses.get(modelKey(model));
      if (routing) counts[routing.kind] += 1;
    }
    header.push(`Routing: ${counts.eligible} eligible · ${counts.frontier} frontier only · ${counts.suppressed} suppressed · ${counts.excluded} excluded`);
    header.push(`Quality runs 1–5 and ranks models for routing${inferredQuality ? "; * means inferred from price, not set in the tier file" : ""}.`);
  }
  header.push("Price is $ per million tokens, input / output.");

  const out: string[] = [...header, "", ...sections.flatMap((section) => [...section, ""])];
  out.push(`Session cost: ${formatUsd(costs.totalCost)} (${formatTokens(costs.totalTokens)} tokens)`);
  for (const line of costs.lines.filter((line) => !matchedKeys.has(line.key))) {
    out.push(`  • ${line.key}: ${formatUsd(line.cost)} (${formatTokens(line.tokens)} tok)`);
  }
  if (unauthenticatedProviders > 0) {
    out.push(`Not shown: ${unauthenticatedModels} model(s) from ${unauthenticatedProviders} provider(s) without configured auth.`);
  }
  return out.join("\n");
}
