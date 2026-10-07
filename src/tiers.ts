import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Quality tiers for model routing: the capability axis the registry metadata
 * lacks. Structure (reasoning flag, modalities, context window) and cost say
 * nothing about where a model stands in its vendor's lineup, so without tiers
 * the cheapest structurally identical model always wins routing. Tiers come
 * from the explicit overlay file when configured (`~/.pi/agent/jev-model-tiers.json`
 * or PI_JEV_MODEL_TIERS), otherwise from the provider's price ladder: vendor
 * pricing is tier positioning.
 */

export type QualityTier = 1 | 2 | 3 | 4 | 5;
export type TierBasis = "configured" | "price-inferred" | "default";

export interface TierAssignment {
  tier: QualityTier;
  basis: TierBasis;
}

/** Keyed by `${provider}/${modelId}`, same as the router's candidateKey. */
export type TierTable = Map<string, TierAssignment>;

/** Named aliases accepted at the file boundary; internally tiers are numeric. */
export const TIER_ALIASES: Record<string, QualityTier> = {
  budget: 1,
  economy: 2,
  standard: 3,
  premium: 4,
  flagship: 5,
};

/** Neutral tier when nothing is known about a model. */
export const DEFAULT_TIER: QualityTier = 3;

export function tierKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** A model's `provider/id` key, the shape tier tables, exclusions, and backoffs are keyed by. */
export function modelKey(model: { provider: string; id: string }): string {
  return tierKey(model.provider, model.id);
}

/** A model's quality tier, or DEFAULT_TIER when the table has no entry for it. */
export function tierFor(tiers: TierTable, model: { provider: string; id: string }): QualityTier {
  return tiers.get(modelKey(model))?.tier ?? DEFAULT_TIER;
}

export function defaultTierOverlayPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "jev-model-tiers.json");
}

export interface TierOverlay {
  tiers: TierTable;
  exclude: Set<string>;
}

/**
 * Parse overlay JSON. Strict by design: any malformed entry rejects the whole
 * file, because a half-parsed overlay would silently mix configured and
 * inferred bases. Unknown model keys are tolerated and inert — renamed or
 * removed models must not break the file. Pure; the caller surfaces errors.
 */
export function parseTierOverlay(raw: string): TierOverlay | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    return { error: `invalid JSON: ${err?.message ?? err}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "top level must be an object" };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "comment" && key !== "tiers" && key !== "exclude") return { error: `unknown top-level key "${key}"` };
  }
  const obj = parsed as { comment?: unknown; tiers?: unknown; exclude?: unknown };
  if (obj.comment !== undefined && typeof obj.comment !== "string") {
    return { error: `"comment" must be a string` };
  }
  if (typeof obj.tiers !== "object" || obj.tiers === null || Array.isArray(obj.tiers)) {
    return { error: `"tiers" must be an object` };
  }
  const tiers: TierTable = new Map();
  for (const [key, value] of Object.entries(obj.tiers)) {
    let tier: QualityTier | undefined;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5) {
      tier = value as QualityTier;
    } else if (typeof value === "string") {
      tier = TIER_ALIASES[value.toLowerCase()];
    }
    if (tier === undefined) {
      return { error: `invalid tier for "${key}": expected an integer 1-5 or one of ${Object.keys(TIER_ALIASES).join("/")}, got ${JSON.stringify(value)}` };
    }
    tiers.set(key, { tier, basis: "configured" });
  }
  const exclude = new Set<string>();
  if (obj.exclude !== undefined) {
    if (!Array.isArray(obj.exclude)) {
      return { error: `"exclude" must be an array of strings` };
    }
    for (const item of obj.exclude) {
      if (typeof item !== "string") {
        return { error: `"exclude" entries must be strings in the form "provider/model-id"` };
      }
      exclude.add(item);
    }
  }
  return { tiers, exclude };
}

export type TierOverlayRead = TierOverlay | { error: string } | { missing: true };

/** Read the overlay file. A missing file is not an error. */
export function readTierOverlay(filePath: string): TierOverlayRead {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { missing: true };
    return { error: `cannot read ${filePath}: ${err?.message ?? err}` };
  }
  return parseTierOverlay(raw);
}

/** The minimal model shape the price ladder reads. */
interface PricedModel {
  provider: string;
  id: string;
  cost?: { input?: number; output?: number };
}

function priceOf(model: PricedModel): { input: number; output: number } {
  return { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 };
}

/**
 * Price-rank prior: rank each provider's lineup by price and map the rank
 * onto the 1-5 tier scale. Per-provider ranking sidesteps cross-vendor price
 * normalization. Overlay entries always win, with basis "configured".
 */
export function inferTiers(models: readonly PricedModel[], overlay: TierTable = new Map()): TierTable {
  const byProvider = new Map<string, PricedModel[]>();
  for (const model of models) {
    const group = byProvider.get(model.provider) ?? [];
    group.push(model);
    byProvider.set(model.provider, group);
  }

  const table: TierTable = new Map();
  for (const group of byProvider.values()) {
    const sorted = [...group].sort(
      (a, b) =>
        priceOf(a).input - priceOf(b).input ||
        priceOf(a).output - priceOf(b).output ||
        tierKey(a.provider, a.id).localeCompare(tierKey(b.provider, b.id))
    );
    const n = sorted.length;

    // A provider whose models are all zero-priced (flat-rate subscription)
    // has no ladder to read.
    if (sorted.every((m) => priceOf(m).input === 0 && priceOf(m).output === 0)) {
      for (const m of sorted) table.set(tierKey(m.provider, m.id), { tier: DEFAULT_TIER, basis: "default" });
      continue;
    }

    const tierAt = (idx: number): QualityTier => {
      if (n === 1) return DEFAULT_TIER; // neutral: a single model is no ladder
      if (n === 2) return ([2, 4] as const)[idx] as QualityTier; // lesser/greater, not budget/flagship
      return (1 + Math.floor((4 * idx) / (n - 1))) as QualityTier;
    };

    // Price-tied models share the higher tier of the tie span.
    let runStart = 0;
    for (let i = 1; i <= n; i++) {
      const tied =
        i < n &&
        priceOf(sorted[i]).input === priceOf(sorted[runStart]).input &&
        priceOf(sorted[i]).output === priceOf(sorted[runStart]).output;
      if (tied) continue;
      const shared = tierAt(i - 1);
      const basis: TierBasis = n === 1 && priceOf(sorted[runStart]).input === 0 && priceOf(sorted[runStart]).output === 0 ? "default" : "price-inferred";
      for (let j = runStart; j < i; j++) {
        table.set(tierKey(sorted[j].provider, sorted[j].id), { tier: shared, basis });
      }
      runStart = i;
    }
  }

  for (const [key, assignment] of overlay) table.set(key, assignment);
  return table;
}
