import { collectPlatformUsage, renderUsage, type UsageDeps, type UsageReport } from "./usage.js";

export const PROVIDER_USAGE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_USAGE_RETRY_MS = 60 * 1000;

/**
 * Background cache over `collectPlatformUsage`. Credentials come only from
 * the deps the host supplies (Pi's model registry and the shared Claude Code
 * reader in usage.ts), so the poller reads no auth files of its own and only
 * polls providers Pi has configured.
 */
export class ProviderUsagePoller {
  private report?: UsageReport;
  private fetchedAt?: number;
  private lastAttempt?: number;
  private inFlight?: Promise<void>;
  private pollingInterval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: () => UsageDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start a five-minute polling loop; repeated starts are harmless. */
  public startPolling(): void {
    if (this.pollingInterval) return;
    void this.refreshIfStale();
    this.pollingInterval = setInterval(() => { void this.refreshIfStale(); }, PROVIDER_USAGE_TTL_MS);
    this.pollingInterval.unref?.();
  }

  public stopPolling(): void {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    this.pollingInterval = undefined;
  }

  /** The most recent report and when it was fetched, if any poll has completed. */
  public getReport(): { report: UsageReport; fetchedAt: number } | undefined {
    return this.report && this.fetchedAt !== undefined ? { report: this.report, fetchedAt: this.fetchedAt } : undefined;
  }

  /** Polls when the report is stale or missing, at most once per minute after a failure. */
  public async refreshIfStale(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (!force) {
      if (this.fetchedAt !== undefined && now - this.fetchedAt < PROVIDER_USAGE_TTL_MS) return;
      if (this.lastAttempt !== undefined && now - this.lastAttempt < PROVIDER_USAGE_RETRY_MS) return;
    }
    this.lastAttempt = now;
    this.inFlight = this.poll().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async poll(): Promise<void> {
    try {
      const report = await collectPlatformUsage(this.deps());
      // Keep the last good report for platforms that failed this round.
      const previous = new Map(this.report?.platforms.filter((p) => !p.error).map((p) => [p.provider, p]));
      report.platforms = report.platforms.map((p) => (p.error && previous.get(p.provider)) || p);
      this.report = report;
      this.fetchedAt = this.now();
    } catch {
      // Usage APIs are advisory; keep the last good report.
    }
  }
}

/** Human-readable view of the latest poll, with its age. */
export function formatProviderUsage(latest: { report: UsageReport; fetchedAt: number } | undefined, now = Date.now()): string {
  if (!latest) return "No provider usage snapshots available yet. Check provider credentials and try again.";
  const ageMinutes = Math.max(0, Math.floor((now - latest.fetchedAt) / 60_000));
  return `${renderUsage(latest.report, new Date(now))}\n(${ageMinutes}m old)`;
}
