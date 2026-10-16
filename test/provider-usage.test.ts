import test from "node:test";
import assert from "node:assert/strict";
import { ProviderUsagePoller, PROVIDER_USAGE_TTL_MS, formatProviderUsage } from "../src/provider-usage.js";

const timestamp = 1_800_000_000_000;

function fixtures(url: string): unknown {
  if (url.includes("anthropic.com")) return {
    five_hour: { utilization: 42, resets_at: "2027-01-15T12:00:00Z" },
    seven_day: { utilization: 12, resets_at: "2027-01-20T00:00:00Z" },
    limits: [
      { kind: "session", percent: 42, resets_at: "2027-01-15T12:00:00Z", is_active: true },
      { kind: "weekly_scoped", percent: 12, resets_at: "2027-01-20T00:00:00Z", scope: { model: { display_name: "Fable" } }, is_active: false },
    ],
  };
  if (url.includes("chatgpt.com")) return {
    plan_type: "pro",
    rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_after_seconds: 100, reset_at: "2027-01-20T00:00:00Z" }, secondary_window: null },
    model_usage: { "gpt-6-astra": { available: true } },
  };
  if (url.includes("api.z.ai")) return {
    data: { level: "pro", limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 6, currentValue: 720, usage: 12000, remaining: 11280, nextResetTime: timestamp + 1000 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 2, currentValue: 1200, usage: 60000, remaining: 58800, nextResetTime: timestamp + 2000 },
    ] },
  };
  return {
    usages: {
      limit_5h: { used_ratio: 0, reset_time: "2027-01-15T12:00:00Z" },
      limit_month_total: { used_ratio: 0.055, reset_time: "2027-02-01T00:00:00Z" },
      limit_month_code: { used_ratio: 0, reset_time: "2027-02-01T00:00:00Z" },
    },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "100", resetTime: "2027-01-15T12:00:00Z" } }],
  };
}

test("polls and normalizes provider-specific quota windows", async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    return Response.json(fixtures(url));
  };
  const poller = new ProviderUsagePoller(fetcher, () => ({
    claudeToken: "claude-test", codexToken: "codex-test", codexAccountId: "account-test",
    zaiKey: "zai-test", kimiAccess: "kimi-test",
  }), () => timestamp);

  await poller.refreshIfStale();
  const snapshots = poller.getSnapshots();
  assert.equal(requested.length, 4);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.provider).sort(), ["claude-bridge", "kimi-coding", "openai-codex", "zai"]);
  const claude = snapshots.find((snapshot) => snapshot.provider === "claude-bridge")!;
  assert.equal(claude.windows.find((window) => window.id.startsWith("session"))?.usedPercent, 42);
  assert.equal(claude.windows.find((window) => window.id.startsWith("weekly_scoped"))?.label, "weekly_scoped (Fable)");
  const codex = snapshots.find((snapshot) => snapshot.provider === "openai-codex")!;
  assert.equal(codex.windows[0]?.label, "1-week window");
  assert.equal(codex.windows[0]?.resetAfterSeconds, 100);
  assert.equal(codex.modelAvailability?.["gpt-6-astra"], true);
  const zai = snapshots.find((snapshot) => snapshot.provider === "zai")!;
  assert.equal(zai.windows[0]?.used, 720);
  assert.equal(zai.windows[0]?.limit, 12000);
  const kimi = snapshots.find((snapshot) => snapshot.provider === "kimi-coding")!;
  assert.equal(kimi.windows.find((window) => window.id === "limit_month_total")?.usedPercent, 5.5);
  assert.match(formatProviderUsage(snapshots, timestamp), /5-hour credits: 720\/12000/);
});

test("cached snapshots are reused until the five-minute TTL expires", async () => {
  let now = timestamp;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({ usages: { limit_5h: { used_ratio: 0.2, reset_time: "2027-01-15T12:00:00Z" } } });
  };
  const poller = new ProviderUsagePoller(fetcher, () => ({ kimiAccess: "kimi-test" }), () => now);
  await poller.refreshIfStale();
  assert.equal(calls, 1, "providers without credentials are skipped");
  now += PROVIDER_USAGE_TTL_MS - 1;
  await poller.refreshIfStale();
  assert.equal(calls, 1, "fresh snapshot is served from cache");
  now += 1;
  await poller.refreshIfStale();
  assert.equal(calls, 2, "expired snapshot is refreshed");
});

test("provider failures retain the last successful snapshot", async () => {
  let fail = false;
  const fetcher: typeof fetch = async () => {
    if (fail) throw new Error("offline");
    return Response.json({ usages: { limit_month_total: { used_ratio: 0.1, reset_time: "2027-02-01T00:00:00Z" } } });
  };
  let now = timestamp;
  const poller = new ProviderUsagePoller(fetcher, () => ({ kimiAccess: "kimi-test" }), () => now);
  await poller.refreshIfStale();
  const first = poller.getSnapshots()[0];
  assert.ok(first);
  fail = true;
  now += PROVIDER_USAGE_TTL_MS;
  await poller.refreshIfStale();
  assert.deepEqual(poller.getSnapshots()[0], first);
});

test("an expired stored Kimi token skips the poll instead of refreshing", async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    requested.push(String(input));
    return Response.json(fixtures(String(input)));
  };
  const poller = new ProviderUsagePoller(fetcher, () => ({ kimiAccess: "kimi-test", kimiExpires: timestamp }), () => timestamp);
  await poller.refreshIfStale();
  assert.deepEqual(requested, []);
  assert.deepEqual(poller.getSnapshots(), []);
});

test("a Kimi 401 never triggers a token refresh", async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response("unauthorized", { status: 401 });
  };
  const poller = new ProviderUsagePoller(fetcher, () => ({ kimiAccess: "kimi-test", kimiExpires: timestamp + 1 }), () => timestamp);
  await poller.refreshIfStale();
  assert.deepEqual(requested, ["https://api.kimi.com/coding/v1/usages"]);
  assert.deepEqual(poller.getSnapshots(), []);
});

test("a host-supplied Kimi resolver provides the bearer token", async () => {
  const authorizations: (string | null)[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    return Response.json(fixtures(String(input)));
  };
  const poller = new ProviderUsagePoller(fetcher, () => ({ kimiAccess: "stale", kimiExpires: timestamp - 1 }), () => timestamp, async () => "from-pi");
  await poller.refreshIfStale();
  assert.deepEqual(authorizations, ["Bearer from-pi"]);
  assert.equal(poller.getSnapshots()[0]?.provider, "kimi-coding");
});
