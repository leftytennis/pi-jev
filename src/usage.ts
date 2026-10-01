import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

/**
 * Per-platform quota usage for the providers authenticated in this Pi session.
 *
 * Every platform reports its own windows: Claude a 5-hour session window plus
 * weekly buckets (all models and per-model scopes — a scoped bucket binds only
 * the models inside its scope, never the provider as a whole), Codex the
 * windows its response describes (read from `limit_window_seconds`, never
 * assumed), Z.ai a 5-hour and a weekly credit window, Kimi a 5-hour window
 * plus monthly totals.
 * The endpoints are undocumented; each parser reads defensively and a failure
 * on one platform never hides the others. See docs/provider-usage-endpoints.md.
 */

export interface QuotaWindow {
  /** The window as the platform names it: "5-hour", "weekly", "monthly", "weekly (Fable)". */
  label: string;
  /** Share of the window consumed, 0–100. */
  usedPercent: number;
  resetsAt?: Date;
  /** The platform marks this window as the one currently binding. */
  binding?: boolean;
  /**
   * For model-scoped windows (Anthropic `weekly_scoped`): the platform's model
   * display name (e.g. "Fable"). Routing binds such a window only to catalog
   * models matching this scope; unscoped windows govern the whole provider.
   */
  scopeModel?: string;
}

export interface PlatformUsage {
  /** Pi provider id, e.g. "openai-codex". */
  provider: string;
  /** Platform name as people know it, e.g. "OpenAI Codex". */
  platform: string;
  plan?: string;
  windows: QuotaWindow[];
  /** The platform itself reports the limit reached (Codex: rate_limit.allowed === false). */
  limitReached?: boolean;
  /** Why no windows were read. The platform stays listed so the gap is visible. */
  error?: string;
}

export interface UsageReport {
  platforms: PlatformUsage[];
  /** Authenticated providers with no usage adapter. */
  unsupported: string[];
}

/** The registry surface this module reads; structural so tests can fake it. */
export interface UsageRegistry {
  getAvailable(): Array<{ provider: string; baseUrl?: string }>;
  getProviderAuthStatus(provider: string): { configured: boolean };
  getProviderAuth(provider: string): Promise<{ auth: { apiKey?: string; headers?: Record<string, string | null> } } | undefined>;
}

export interface ClaudeCodeCredential {
  accessToken: string;
  subscriptionType?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
}

export interface UsageDeps {
  registry: UsageRegistry;
  fetch?: typeof fetch;
  /** Reads Claude Code's OAuth credential. Defaults to the macOS keychain, then ~/.claude/.credentials.json. */
  readClaudeCodeCredential?: () => Promise<ClaudeCodeCredential | undefined>;
  now?: () => Date;
  signal?: AbortSignal;
  /** Per-platform request budget. */
  timeoutMs?: number;
}

type Parsed = { windows: QuotaWindow[]; plan?: string; limitReached?: boolean };

interface AdapterContext {
  registry: UsageRegistry;
  fetch: typeof fetch;
  readClaudeCodeCredential: () => Promise<ClaudeCodeCredential | undefined>;
  now: Date;
  signal: AbortSignal;
}

interface PlatformAdapter {
  platform: string;
  read(ctx: AdapterContext): Promise<Parsed>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Parsing helpers

function clampPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

/** Accepts ISO strings, epoch seconds, and epoch milliseconds. */
function toDate(value: unknown): Date | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === "string" && value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

/** Order windows short to long so every platform reads the same way. */
function windowRank(label: string): number {
  if (/^5-hour/.test(label)) return 0;
  if (/hour/.test(label)) return 1;
  if (/^daily/.test(label)) return 2;
  if (/^weekly/.test(label)) return 3;
  if (/^monthly/.test(label)) return 4;
  return 5;
}

function sortWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((a, b) => windowRank(a.label) - windowRank(b.label) || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Anthropic (Claude Code OAuth) — GET https://api.anthropic.com/api/oauth/usage

const ANTHROPIC_KINDS: Record<string, string> = {
  session: "5-hour",
  weekly_all: "weekly",
};

export function parseAnthropicUsage(body: any): Parsed {
  const windows: QuotaWindow[] = [];
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  for (const limit of limits) {
    const usedPercent = clampPercent(limit?.percent);
    if (usedPercent === undefined) continue;
    let label = ANTHROPIC_KINDS[limit.kind];
    const scopeModel = limit.kind === "weekly_scoped" ? limit?.scope?.model?.display_name : undefined;
    if (!label && limit.kind === "weekly_scoped") {
      label = typeof scopeModel === "string" && scopeModel ? `weekly (${scopeModel})` : "weekly (scoped)";
    }
    windows.push({
      label: label ?? String(limit.kind ?? "unknown"),
      usedPercent,
      resetsAt: toDate(limit.resets_at),
      binding: limit.is_active === true ? true : undefined,
      scopeModel: typeof scopeModel === "string" && scopeModel ? scopeModel : undefined,
    });
  }
  if (windows.length === 0) {
    // Legacy accounts still report the flat keys instead of `limits[]`.
    for (const [key, label] of [["five_hour", "5-hour"], ["seven_day", "weekly"]] as const) {
      const usedPercent = clampPercent(body?.[key]?.utilization);
      if (usedPercent === undefined) continue;
      windows.push({ label, usedPercent, resetsAt: toDate(body[key].resets_at) });
    }
  }
  return { windows: sortWindows(windows) };
}

// ---------------------------------------------------------------------------
// OpenAI Codex (ChatGPT OAuth) — GET https://chatgpt.com/backend-api/wham/usage

function labelForSeconds(seconds: unknown, fallback: string): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds === 5 * 3600) return "5-hour";
  if (seconds === 86_400) return "daily";
  if (seconds === 7 * 86_400) return "weekly";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return `${Math.round(seconds / 60)}-minute`;
}

export function parseCodexUsage(body: any, now: Date): Parsed {
  const windows: QuotaWindow[] = [];
  const rateLimit = body?.rate_limit ?? {};
  for (const [key, fallback] of [["primary_window", "primary window"], ["secondary_window", "secondary window"]] as const) {
    const window = rateLimit[key];
    const usedPercent = clampPercent(window?.used_percent);
    if (usedPercent === undefined) continue;
    const resetsAt =
      toDate(window.reset_at) ??
      (typeof window.reset_after_seconds === "number" ? new Date(now.getTime() + window.reset_after_seconds * 1000) : undefined);
    windows.push({ label: labelForSeconds(window.limit_window_seconds, fallback), usedPercent, resetsAt });
  }
  const plan = typeof body?.plan_type === "string" ? body.plan_type : undefined;
  const limitReached = rateLimit?.limit_reached === true || rateLimit?.allowed === false;
  return { windows: sortWindows(windows), plan, limitReached: limitReached || undefined };
}

/**
 * The platform window that most constrains routing right now: the fullest
 * window, with the platform-flagged binding window preferred when it is at
 * least as full. A scoped weekly bucket marked `binding` does not excuse a
 * 5-hour window sitting at 100%. Platforms that failed to read have no
 * constraining window.
 */
export function bindingWindow(platform: PlatformUsage): QuotaWindow | undefined {
  if (platform.error || platform.windows.length === 0) return undefined;
  const flagged = platform.windows.find((w) => w.binding);
  const fullest = platform.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
  return flagged && flagged.usedPercent >= fullest.usedPercent ? flagged : fullest;
}

/** The ChatGPT account id lives in the access token's OpenAI auth claim. */
export function codexAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Z.ai / GLM — GET {origin}/api/monitor/usage/quota/limit

function zaiLabel(row: any): string {
  const unit = row?.unit;
  const count = row?.number;
  // Observed encodings: unit 3 counts hours (number 5 → the 5-hour window);
  // unit 6 with number 1 is the weekly credit window.
  let base: string;
  if (unit === 3 && typeof count === "number") base = `${count}-hour`;
  else if (unit === 6 && count === 1) base = "weekly";
  else base = `every ${count ?? "?"} (unit ${unit ?? "?"})`;
  return row?.type === "TIME_LIMIT" ? `${base} (time)` : base;
}

export function parseZaiUsage(body: any): Parsed {
  const rows = Array.isArray(body?.data?.limits) ? body.data.limits : [];
  const windows: QuotaWindow[] = [];
  for (const row of rows) {
    const cap = row?.usage;
    const used = row?.currentValue;
    const usedPercent =
      typeof cap === "number" && cap > 0 && typeof used === "number"
        ? clampPercent((used / cap) * 100)
        : clampPercent(row?.percentage);
    if (usedPercent === undefined) continue;
    windows.push({ label: zaiLabel(row), usedPercent, resetsAt: toDate(row?.nextResetTime) });
  }
  const plan = typeof body?.data?.level === "string" ? body.data.level : undefined;
  return { windows: sortWindows(windows), plan };
}

// ---------------------------------------------------------------------------
// Kimi Code (Coding Plan OAuth) — GET https://api.kimi.com/coding/v1/usages

const KIMI_LABELS: Record<string, string> = {
  limit_5h: "5-hour",
  limit_day: "daily",
  limit_week: "weekly",
  limit_month_total: "monthly",
  limit_month_code: "monthly (code)",
};

export function parseKimiUsage(body: any): Parsed {
  const usages = body?.usages && typeof body.usages === "object" ? body.usages : {};
  const windows: QuotaWindow[] = [];
  for (const [key, usage] of Object.entries<any>(usages)) {
    const ratio = usage?.used_ratio;
    if (typeof ratio !== "number") continue;
    const usedPercent = clampPercent(ratio * 100);
    if (usedPercent === undefined) continue;
    windows.push({ label: KIMI_LABELS[key] ?? key.replace(/^limit_/, ""), usedPercent, resetsAt: toDate(usage.reset_time) });
  }
  return { windows: sortWindows(windows) };
}

// ---------------------------------------------------------------------------
// Credentials and transport

const execFileAsync = promisify(execFile);

async function readKeychainCredential(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readCredentialsFile(): Promise<string | undefined> {
  try {
    return (await fs.readFile(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Claude Code's OAuth credential: keychain first, then the credentials file. Never logged. */
export async function readClaudeCodeCredential(): Promise<ClaudeCodeCredential | undefined> {
  const raw = (await readKeychainCredential()) ?? (await readCredentialsFile());
  if (!raw) return undefined;
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return undefined;
    return {
      accessToken: oauth.accessToken,
      subscriptionType: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Fetch JSON; errors carry the HTTP status only, never headers or tokens. */
async function getJson(ctx: AdapterContext, url: string, headers: Record<string, string>): Promise<any> {
  const response = await ctx.fetch(url, { headers: { Accept: "application/json", ...headers }, signal: ctx.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Pi resolves some OAuth providers (Kimi) into an Authorization header rather than apiKey. */
function bearerFromHeaders(headers: Record<string, string | null> | undefined): string | undefined {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== "authorization" || typeof value !== "string") continue;
    const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
    if (match) return match[1];
  }
  return undefined;
}

async function bearerFor(ctx: AdapterContext, provider: string): Promise<string> {
  const resolved = (await ctx.registry.getProviderAuth(provider))?.auth;
  const token = resolved?.apiKey || bearerFromHeaders(resolved?.headers);
  if (!token) throw new Error("no credential from Pi");
  return token;
}

function zaiOrigin(registry: UsageRegistry): string {
  const baseUrl = registry.getAvailable().find((m) => m.provider === "zai")?.baseUrl;
  try {
    if (baseUrl) return new URL(baseUrl).origin;
  } catch {
    // fall through to the default host
  }
  return "https://api.z.ai";
}

// ---------------------------------------------------------------------------
// Adapters, keyed by Pi provider id

const ADAPTERS: Record<string, PlatformAdapter> = {
  "claude-bridge": {
    platform: "Anthropic Claude",
    async read(ctx) {
      const credential = await ctx.readClaudeCodeCredential();
      if (!credential) throw new Error("no Claude Code credential (keychain or ~/.claude/.credentials.json)");
      if (credential.expiresAt !== undefined && credential.expiresAt <= ctx.now.getTime()) {
        throw new Error("Claude Code token expired; run Claude Code once to refresh it");
      }
      const body = await getJson(ctx, "https://api.anthropic.com/api/oauth/usage", {
        Authorization: `Bearer ${credential.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      });
      return { ...parseAnthropicUsage(body), plan: credential.subscriptionType };
    },
  },
  "openai-codex": {
    platform: "OpenAI Codex",
    async read(ctx) {
      const token = await bearerFor(ctx, "openai-codex");
      const accountId = codexAccountId(token);
      if (!accountId) throw new Error("no ChatGPT account id in the Codex token");
      const body = await getJson(ctx, "https://chatgpt.com/backend-api/wham/usage", {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": accountId,
      });
      return parseCodexUsage(body, ctx.now);
    },
  },
  zai: {
    platform: "Z.ai GLM",
    async read(ctx) {
      const token = await bearerFor(ctx, "zai");
      const body = await getJson(ctx, `${zaiOrigin(ctx.registry)}/api/monitor/usage/quota/limit`, {
        Authorization: `Bearer ${token}`,
      });
      return parseZaiUsage(body);
    },
  },
  "kimi-coding": {
    platform: "Kimi Code",
    async read(ctx) {
      // Coding Plan tokens expire every ~15 minutes; Pi refreshes on getProviderAuth.
      const token = await bearerFor(ctx, "kimi-coding");
      const body = await getJson(ctx, "https://api.kimi.com/coding/v1/usages", { Authorization: `Bearer ${token}` });
      return parseKimiUsage(body);
    },
  },
};

export const SUPPORTED_PLATFORMS: readonly string[] = Object.keys(ADAPTERS);

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/**
 * Read usage from every authenticated provider that has an adapter. Platforms
 * are queried concurrently; one failure is reported on that platform only.
 */
export async function collectPlatformUsage(deps: UsageDeps): Promise<UsageReport> {
  const providers = [...new Set(deps.registry.getAvailable().map((m) => m.provider))].sort();
  const configured = providers.filter((p) => deps.registry.getProviderAuthStatus(p).configured);
  const supported = configured.filter((p) => p in ADAPTERS);
  const unsupported = configured.filter((p) => !(p in ADAPTERS));
  const now = deps.now?.() ?? new Date();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const platforms = await Promise.all(
    supported.map(async (provider): Promise<PlatformUsage> => {
      const adapter = ADAPTERS[provider];
      const guard = withTimeout(deps.signal, timeoutMs);
      try {
        const parsed = await adapter.read({
          registry: deps.registry,
          fetch: deps.fetch ?? fetch,
          readClaudeCodeCredential: deps.readClaudeCodeCredential ?? readClaudeCodeCredential,
          now,
          signal: guard.signal,
        });
        return { provider, platform: adapter.platform, ...parsed };
      } catch (err) {
        const reason = guard.signal.aborted && guard.signal.reason instanceof Error ? guard.signal.reason.message : describeError(err);
        return { provider, platform: adapter.platform, windows: [], error: reason };
      } finally {
        guard.clear();
      }
    })
  );

  return { platforms, unsupported };
}

// ---------------------------------------------------------------------------
// Rendering

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

export function formatRelative(target: Date, now: Date): string {
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return "now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

/** Threshold at or above which a window is called out and the notice is a warning. */
export const HOT_PERCENT = 90;

export function hottestPercent(report: UsageReport): number {
  return report.platforms.reduce((max, p) => p.windows.reduce((m, w) => Math.max(m, w.usedPercent), max), 0);
}

export function renderUsage(report: UsageReport, now: Date = new Date()): string {
  const out: string[] = [];
  if (report.platforms.length === 0) {
    out.push("Platform usage: no authenticated provider has a usage adapter.");
  } else {
    out.push(`Platform usage — ${report.platforms.length} platform(s):`, "");
    for (const platform of report.platforms) {
      const plan = platform.plan ? ` · plan: ${platform.plan}` : "";
      out.push(`${platform.platform} (${platform.provider})${plan}`);
      if (platform.error) {
        out.push(`  • unavailable: ${platform.error}`);
      } else if (platform.windows.length === 0) {
        out.push("  • no quota windows reported");
      }
      for (const window of platform.windows) {
        const parts = [`${window.label}: ${formatPercent(window.usedPercent)} used`];
        if (window.resetsAt) parts.push(`resets ${formatRelative(window.resetsAt, now)}`);
        const flags = [window.binding ? "binding" : "", window.usedPercent >= HOT_PERCENT ? "near limit" : ""].filter(Boolean);
        out.push(`  • ${parts.join(" · ")}${flags.length ? `  ← ${flags.join(", ")}` : ""}`);
      }
      out.push("");
    }
    out.pop();
  }
  if (report.unsupported.length > 0) {
    out.push("", `No usage adapter for: ${report.unsupported.join(", ")}.`);
  }
  return out.join("\n");
}
