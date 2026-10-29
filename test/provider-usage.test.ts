import test from "node:test";
import assert from "node:assert/strict";
import { ProviderUsagePoller, PROVIDER_USAGE_TTL_MS, formatProviderUsage } from "../src/provider-usage.js";
import type { UsageDeps, UsageRegistry } from "../src/usage.js";

function kimiDeps(responses: Array<number | object>) {
  const requests: Array<{ url: string; auth: string | null }> = [];
  const authLookups: string[] = [];
  const registry: UsageRegistry = {
    getAvailable: () => [{ provider: "kimi-coding" }, { provider: "zai" }],
    getProviderAuthStatus: (provider) => ({ configured: provider === "kimi-coding" }),
    getProviderAuth: async (provider) => {
      authLookups.push(provider);
      return { auth: { apiKey: "resolved-by-pi" } };
    },
  };
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    const next = responses.shift() ?? 500;
    return typeof next === "number"
      ? new Response("{}", { status: next })
      : new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const deps = (): UsageDeps => ({ registry, fetch: fetcher, readClaudeCodeCredential: async () => undefined });
  return { deps, requests, authLookups };
}

const KIMI_BODY = { usages: { limit_5h: { used_ratio: 0.25, reset_time: "2026-10-01T00:00:00Z" } } };

test("the poller uses Pi's resolved credentials and only polls configured providers", async () => {
  const { deps, requests, authLookups } = kimiDeps([KIMI_BODY]);
  const poller = new ProviderUsagePoller(deps);
  await poller.refreshIfStale();
  assert.deepEqual(authLookups, ["kimi-coding"], "unconfigured zai is never looked up");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/api\.kimi\.com\//);
  assert.equal(requests[0].auth, "Bearer resolved-by-pi");
  assert.equal(poller.getReport()?.report.platforms[0].provider, "kimi-coding");
});

test("the poller respects its TTL and keeps the last good report when a poll fails", async () => {
  let now = 1_000_000;
  const { deps, requests } = kimiDeps([KIMI_BODY, 500]);
  const poller = new ProviderUsagePoller(deps, () => now);
  await poller.refreshIfStale();
  await poller.refreshIfStale();
  assert.equal(requests.length, 1, "fresh report is not refetched");

  now += PROVIDER_USAGE_TTL_MS;
  await poller.refreshIfStale();
  assert.equal(requests.length, 2);
  const platform = poller.getReport()!.report.platforms[0];
  assert.equal(platform.error, undefined, "a failed poll does not replace good data");
  assert.ok(platform.windows.length > 0);
});

test("formatProviderUsage reports age and handles an empty cache", () => {
  assert.match(formatProviderUsage(undefined), /No provider usage snapshots/);
  const text = formatProviderUsage({ report: { platforms: [], unsupported: [] }, fetchedAt: 0 }, 5 * 60_000);
  assert.match(text, /5m old/);
});
