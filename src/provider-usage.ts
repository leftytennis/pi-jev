import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export const PROVIDER_USAGE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_USAGE_RETRY_MS = 60 * 1000;
const PROVIDER_USAGE_TIMEOUT_MS = 10_000;

type ProviderUsageId = "claude-bridge" | "openai-codex" | "zai" | "kimi-coding";

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  resetsAt?: string;
  resetAfterSeconds?: number;
  active?: boolean;
}

export interface ProviderUsageSnapshot {
  provider: ProviderUsageId;
  fetchedAt: number;
  windows: UsageWindow[];
  plan?: string;
  modelAvailability?: Record<string, boolean>;
}

const PROVIDER_NAMES: Record<ProviderUsageId, string> = {
  "claude-bridge": "Anthropic",
  "openai-codex": "Codex",
  zai: "Z.ai",
  "kimi-coding": "Kimi",
};

/** Human-readable quota view; percentages remain percentages, not fractions. */
export function formatProviderUsage(snapshots: ProviderUsageSnapshot[], now = Date.now()): string {
  if (!snapshots.length) return "No provider usage snapshots available yet. Check provider credentials and try again.";
  return snapshots.map((snapshot) => {
    const ageMinutes = Math.max(0, Math.floor((now - snapshot.fetchedAt) / 60_000));
    const heading = `${PROVIDER_NAMES[snapshot.provider]}${snapshot.plan ? ` (${snapshot.plan})` : ""} · ${ageMinutes}m old`;
    const rows = snapshot.windows.map((window) => {
      const usage = window.used !== undefined && window.limit !== undefined
        ? `${window.used}/${window.limit}${window.usedPercent === undefined ? "" : ` (${window.usedPercent}% used)`}${window.remaining !== undefined ? ` · ${window.remaining} remaining` : ""}`
        : window.usedPercent !== undefined
          ? `${window.usedPercent}% used`
          : window.remaining !== undefined && window.limit !== undefined
            ? `${window.remaining}/${window.limit} remaining`
            : "usage unavailable";
      const active = window.active ? " · ACTIVE" : "";
      const reset = window.resetsAt ? ` · resets ${window.resetsAt}` : window.resetAfterSeconds !== undefined ? ` · resets in ${Math.ceil(window.resetAfterSeconds / 3600)}h` : "";
      return `  • ${window.label}: ${usage}${active}${reset}`;
    });
    for (const [model, available] of Object.entries(snapshot.modelAvailability ?? {})) {
      rows.push(`  • ${model}: ${available ? "available" : "unavailable"}`);
    }
    return [heading, ...rows].join("\n");
  }).join("\n");
}

export type Credentials = {
  claudeToken?: string;
  codexToken?: string;
  codexAccountId?: string;
  zaiKey?: string;
  kimiAccess?: string;
  kimiExpires?: number;
};

/** Returns a Kimi bearer token, or undefined to skip the Kimi poll. */
export type KimiAuthorization = (credentials: Credentials, now: number) => Promise<string | undefined>;

type JsonObject = Record<string, unknown>;
type Fetcher = typeof fetch;

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function field(source: unknown, key: string): unknown {
  return object(source)?.[key];
}

function nestedString(source: unknown, ...keys: string[]): string | undefined {
  let value: unknown = source;
  for (const key of keys) value = field(value, key);
  return string(value);
}

function readJsonFile(filePath: string): JsonObject | undefined {
  try {
    return object(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

function readCredentials(): Credentials {
  const home = os.homedir();
  const credentials: Credentials = {};
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
    });
    credentials.claudeToken = nestedString(JSON.parse(raw), "claudeAiOauth", "accessToken");
  } catch {
    const fallback = readJsonFile(path.join(home, ".claude", ".credentials.json"));
    credentials.claudeToken = nestedString(fallback, "claudeAiOauth", "accessToken");
  }

  const codex = readJsonFile(path.join(home, ".codex", "auth.json"));
  credentials.codexToken = nestedString(codex, "tokens", "access_token");
  credentials.codexAccountId = nestedString(codex, "tokens", "account_id");

  const authPath = path.join(home, ".pi", "agent", "auth.json");
  const auth = readJsonFile(authPath);
  credentials.zaiKey = process.env.ZAI_API_KEY || nestedString(auth, "zai", "key");
  credentials.kimiAccess = nestedString(auth, "kimi-coding", "access");
  credentials.kimiExpires = number(field(field(auth, "kimi-coding"), "expires"));
  return credentials;
}

async function fetchJson(fetcher: Fetcher, url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(PROVIDER_USAGE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`provider usage HTTP ${response.status}`);
  return await response.json();
}

function asWindow(id: string, label: string, row: unknown, options: {
  percentKey?: string; usedKey?: string; limitKey?: string; remainingKey?: string; resetKey?: string; activeKey?: string;
} = {}): UsageWindow | undefined {
  const data = object(row);
  if (!data) return undefined;
  const usedPercent = number(data[options.percentKey ?? "utilization"]);
  const used = number(data[options.usedKey ?? "currentValue"]);
  const limit = number(data[options.limitKey ?? "usage"]);
  const remaining = number(data[options.remainingKey ?? "remaining"]);
  const resetsAt = string(data[options.resetKey ?? "resets_at"]);
  const activeValue = data[options.activeKey ?? "is_active"];
  const active = typeof activeValue === "boolean" ? activeValue : undefined;
  if (usedPercent === undefined && used === undefined && limit === undefined && remaining === undefined && resetsAt === undefined) return undefined;
  return { id, label, ...(usedPercent === undefined ? {} : { usedPercent }), ...(used === undefined ? {} : { used }), ...(limit === undefined ? {} : { limit }), ...(remaining === undefined ? {} : { remaining }), ...(resetsAt === undefined ? {} : { resetsAt }), ...(active === undefined ? {} : { active }) };
}

function anthropicSnapshot(body: unknown, fetchedAt: number): ProviderUsageSnapshot | undefined {
  const data = object(body);
  if (!data) return undefined;
  const windows: UsageWindow[] = [];
  const limits = data.limits;
  if (Array.isArray(limits)) {
    for (const [index, value] of limits.entries()) {
      const row = object(value);
      if (!row) continue;
      const kind = string(row.kind) ?? `limit-${index}`;
      const scope = nestedString(row, "scope", "model", "display_name");
      const window = asWindow(`${kind}:${scope ?? index}`, scope ? `${kind} (${scope})` : kind, row, {
        percentKey: "percent", resetKey: "resets_at", activeKey: "is_active",
      });
      if (window) windows.push(window);
    }
  }
  if (!windows.length) {
    const fiveHour = asWindow("session", "5-hour session", data.five_hour, { percentKey: "utilization", resetKey: "resets_at" });
    const weekly = asWindow("weekly-all", "weekly (all models)", data.seven_day, { percentKey: "utilization", resetKey: "resets_at" });
    if (fiveHour) windows.push(fiveHour);
    if (weekly) windows.push(weekly);
  }
  return windows.length ? { provider: "claude-bridge", fetchedAt, windows } : undefined;
}

function codexSnapshot(body: unknown, fetchedAt: number): ProviderUsageSnapshot | undefined {
  const data = object(body);
  const rateLimit = object(data?.rate_limit);
  if (!data || !rateLimit) return undefined;
  const windows: UsageWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const row = object(rateLimit[key]);
    if (!row) continue;
    const seconds = number(row.limit_window_seconds);
    const label = seconds === undefined ? key.replace("_", " ") : seconds % 604800 === 0 ? `${seconds / 604800}-week window` : seconds % 86400 === 0 ? `${seconds / 86400}-day window` : `${seconds / 3600}-hour window`;
    const window = asWindow(key, label, row, { percentKey: "used_percent", resetKey: "reset_at" });
    if (window) {
      const resetAfterSeconds = number(row.reset_after_seconds);
      windows.push({ ...window, ...(resetAfterSeconds === undefined ? {} : { resetAfterSeconds }) });
    }
  }
  const availability: Record<string, boolean> = {};
  const models = object(data.model_usage);
  for (const [id, value] of Object.entries(models ?? {})) {
    const available = field(value, "available");
    if (typeof available === "boolean") availability[id] = available;
  }
  if (!windows.length && Object.keys(availability).length === 0) return undefined;
  return { provider: "openai-codex", fetchedAt, windows, ...(string(data.plan_type) ? { plan: string(data.plan_type) } : {}), ...(Object.keys(availability).length ? { modelAvailability: availability } : {}) };
}

function zaiWindowLabel(unit: unknown, count: unknown): string {
  if (unit === 3 && count === 5) return "5-hour credits";
  if (unit === 6 && count === 1) return "weekly credits";
  if (typeof count === "number") return `${count} ${unit === 3 ? "hours" : unit === 6 ? "days" : "units"}`;
  return "provider quota";
}

function zaiSnapshot(body: unknown, fetchedAt: number): ProviderUsageSnapshot | undefined {
  const data = object(field(body, "data"));
  if (!data) return undefined;
  const windows: UsageWindow[] = [];
  if (Array.isArray(data.limits)) {
    for (const [index, value] of data.limits.entries()) {
      const label = zaiWindowLabel(field(value, "unit"), field(value, "number"));
      const window = asWindow(`quota-${index}`, label, value, { percentKey: "percentage", usedKey: "currentValue", limitKey: "usage", resetKey: "nextResetTime" });
      if (window) {
        if (window.resetsAt && /^\d+$/.test(window.resetsAt)) window.resetsAt = new Date(Number(window.resetsAt)).toISOString();
        const row = object(value);
        if (row && typeof row.nextResetTime === "number" && Number.isFinite(row.nextResetTime)) window.resetsAt = new Date(row.nextResetTime).toISOString();
        windows.push(window);
      }
    }
  }
  return windows.length ? { provider: "zai", fetchedAt, windows, ...(string(data.level) ? { plan: string(data.level) } : {}) } : undefined;
}

function kimiSnapshot(body: unknown, fetchedAt: number): ProviderUsageSnapshot | undefined {
  const data = object(body);
  const usages = object(data?.usages);
  if (!data || !usages) return undefined;
  const labels: Record<string, string> = { limit_5h: "5-hour rolling", limit_week: "weekly", limit_month_total: "monthly total", limit_month_code: "monthly code" };
  const windows: UsageWindow[] = [];
  for (const [id, label] of Object.entries(labels)) {
    const row = object(usages[id]);
    if (!row) continue;
    const ratio = number(row.used_ratio);
    const window = asWindow(id, label, { ...row, utilization: ratio === undefined ? undefined : ratio * 100 }, { percentKey: "utilization", resetKey: "reset_time" });
    if (window) windows.push(window);
  }
  if (Array.isArray(data.limits)) {
    for (const [index, value] of data.limits.entries()) {
      const window = object(value);
      const details = object(window?.detail);
      if (!window || !details) continue;
      const period = object(window.window);
      const duration = number(period?.duration);
      const unit = string(period?.timeUnit)?.replace("TIME_UNIT_", "").toLowerCase();
      const label = duration !== undefined && unit ? `burst (${duration} ${unit.toLowerCase()})` : "burst";
      const limit = Number(string(details.limit));
      const remaining = Number(string(details.remaining));
      const resetsAt = string(details.resetTime);
      windows.push({ id: `burst-${index}`, label, ...(Number.isFinite(limit) ? { limit } : {}), ...(Number.isFinite(remaining) ? { remaining } : {}), ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  return windows.length ? { provider: "kimi-coding", fetchedAt, windows } : undefined;
}

/**
 * Pi core owns Kimi OAuth: it refreshes under the auth.json lock and Kimi rotates
 * refresh tokens, so the poller must never refresh on its own. Without a resolver
 * from the host, use the stored access token only while it is unexpired.
 */
const storedKimiAuthorization: KimiAuthorization = async (credentials, now) => {
  if (credentials.kimiExpires !== undefined && now >= credentials.kimiExpires) return undefined;
  return credentials.kimiAccess;
};

export class ProviderUsagePoller {
  private snapshots = new Map<ProviderUsageId, ProviderUsageSnapshot>();
  private lastAttempt = new Map<ProviderUsageId, number>();
  private inFlight?: Promise<void>;
  private pollingInterval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly credentialReader: () => Credentials = readCredentials,
    private readonly now: () => number = Date.now,
    private readonly kimiAuthorization: KimiAuthorization = storedKimiAuthorization,
  ) {}

  /** Start a five-minute polling loop; repeated starts are harmless. */
  public startPolling(): void {
    if (this.pollingInterval) return;
    void this.refreshIfStale();
    this.pollingInterval = setInterval(() => { void this.refreshIfStale(); }, PROVIDER_USAGE_TTL_MS);
    this.pollingInterval.unref?.();
  }

  /** Returns the most recent successful snapshots; failed polls retain old data. */
  public getSnapshots(): ProviderUsageSnapshot[] {
    return [...this.snapshots.values()].map((snapshot) => ({
      ...snapshot,
      windows: snapshot.windows.map((window) => ({ ...window })),
      ...(snapshot.modelAvailability ? { modelAvailability: { ...snapshot.modelAvailability } } : {}),
    }));
  }

  /** Polls stale/missing providers, at most once per minute after a failure. */
  public async refreshIfStale(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    const providers: ProviderUsageId[] = ["claude-bridge", "openai-codex", "zai", "kimi-coding"];
    const due = providers.filter((provider) => {
      const previous = this.snapshots.get(provider);
      if (!force && previous && now - previous.fetchedAt < PROVIDER_USAGE_TTL_MS) return false;
      const attempted = this.lastAttempt.get(provider);
      return force || attempted === undefined || now - attempted >= PROVIDER_USAGE_RETRY_MS;
    });
    if (!due.length) return;
    this.inFlight = this.pollProviders(due, now).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async pollProviders(providers: ProviderUsageId[], fetchedAt: number): Promise<void> {
    let credentials: Credentials;
    try {
      credentials = this.credentialReader();
    } catch {
      return;
    }
    await Promise.all(providers.map(async (provider) => {
      this.lastAttempt.set(provider, this.now());
      try {
        const snapshot = await this.fetchProvider(provider, credentials, fetchedAt);
        if (snapshot) this.snapshots.set(provider, snapshot);
      } catch {
        // Usage APIs are advisory and undocumented; keep the last good snapshot.
      }
    }));
  }

  private async fetchProvider(provider: ProviderUsageId, credentials: Credentials, fetchedAt: number): Promise<ProviderUsageSnapshot | undefined> {
    if (provider === "claude-bridge") {
      if (!credentials.claudeToken) return undefined;
      const body = await fetchJson(this.fetcher, "https://api.anthropic.com/api/oauth/usage", {
        Authorization: `Bearer ${credentials.claudeToken}`, "anthropic-beta": "oauth-2025-04-20",
      });
      return anthropicSnapshot(body, fetchedAt);
    }
    if (provider === "openai-codex") {
      if (!credentials.codexToken || !credentials.codexAccountId) return undefined;
      const body = await fetchJson(this.fetcher, "https://chatgpt.com/backend-api/wham/usage", {
        Authorization: `Bearer ${credentials.codexToken}`, "ChatGPT-Account-Id": credentials.codexAccountId, Accept: "application/json",
      });
      return codexSnapshot(body, fetchedAt);
    }
    if (provider === "zai") {
      if (!credentials.zaiKey) return undefined;
      const body = await fetchJson(this.fetcher, "https://api.z.ai/api/monitor/usage/quota/limit", {
        Authorization: `Bearer ${credentials.zaiKey}`, Accept: "application/json",
      });
      return zaiSnapshot(body, fetchedAt);
    }
    const access = await this.kimiAuthorization(credentials, this.now());
    if (!access) return undefined;
    const body = await fetchJson(this.fetcher, "https://api.kimi.com/coding/v1/usages", { Authorization: `Bearer ${access}` });
    return kimiSnapshot(body, fetchedAt);
  }
}
