import test from "node:test";
import assert from "node:assert/strict";
import {
  bindingWindow,
  codexAccountId,
  collectPlatformUsage,
  formatPercent,
  formatRelative,
  hottestPercent,
  parseAnthropicUsage,
  parseCodexUsage,
  parseKimiUsage,
  parseZaiUsage,
  renderUsage,
  SUPPORTED_PLATFORMS,
  type UsageRegistry,
} from "../src/usage.js";

const NOW = new Date("2026-09-29T12:00:00Z");

// Fixtures mirror the shapes recorded live in docs/provider-usage-endpoints.md.

test("parseAnthropicUsage prefers limits[] and marks the active scoped bucket as binding", () => {
  const parsed = parseAnthropicUsage({
    five_hour: { utilization: 23, resets_at: "2026-09-29T14:00:00Z" },
    seven_day: { utilization: 17, resets_at: "2026-10-01T09:00:00Z" },
    seven_day_opus: null,
    limits: [
      { kind: "weekly_scoped", percent: 25, resets_at: "2026-10-02T00:00:00Z", scope: { model: { display_name: "Fable" } }, is_active: true },
      { kind: "weekly_all", percent: 17, resets_at: "2026-10-01T09:00:00Z" },
      { kind: "session", percent: 23, resets_at: "2026-09-29T14:00:00Z" },
    ],
  });
  assert.deepEqual(
    parsed.windows.map((w) => [w.label, w.usedPercent, w.binding]),
    [
      ["5-hour", 23, undefined],
      ["weekly", 17, undefined],
      ["weekly (Fable)", 25, true],
    ]
  );
  assert.equal(parsed.windows[0].resetsAt?.toISOString(), "2026-09-29T14:00:00.000Z");
  // The scoped bucket keeps its model scope as structured data for per-model routing.
  assert.deepEqual(
    parsed.windows.map((w) => w.scopeModel),
    [undefined, undefined, "Fable"]
  );
});

test("parseAnthropicUsage falls back to the legacy flat keys when limits[] is absent", () => {
  const parsed = parseAnthropicUsage({
    five_hour: { utilization: 40, resets_at: "2026-09-29T14:00:00Z" },
    seven_day: { utilization: 60, resets_at: "2026-10-01T09:00:00Z" },
  });
  assert.deepEqual(parsed.windows.map((w) => [w.label, w.usedPercent]), [["5-hour", 40], ["weekly", 60]]);
});

test("parseCodexUsage names windows from limit_window_seconds, never by position", () => {
  const parsed = parseCodexUsage(
    {
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 96, limit_window_seconds: 604800, reset_after_seconds: 140400, reset_at: 1790985600 },
        secondary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_after_seconds: 3600 },
      },
    },
    NOW
  );
  assert.equal(parsed.plan, "pro");
  assert.deepEqual(parsed.windows.map((w) => [w.label, w.usedPercent]), [["5-hour", 12.5], ["weekly", 96]]);
  // Epoch seconds are accepted for reset_at; reset_after_seconds is used when reset_at is missing.
  assert.equal(parsed.windows[1].resetsAt?.toISOString(), "2026-10-03T00:00:00.000Z");
  assert.equal(parsed.windows[0].resetsAt?.toISOString(), "2026-09-29T13:00:00.000Z");
});

test("parseCodexUsage surfaces a platform-reported limit", () => {
  const limited = parseCodexUsage(
    { plan_type: "pro", rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 40, limit_window_seconds: 604800 } } },
    NOW
  );
  assert.equal(limited.limitReached, true);
  const fine = parseCodexUsage(
    { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 40, limit_window_seconds: 604800 } } },
    NOW
  );
  assert.equal(fine.limitReached, undefined);
});

test("bindingWindow picks the fullest window, preferring the flagged one on ties", () => {
  const platform = (windows: any[], extra: Record<string, unknown> = {}) => ({ provider: "p", platform: "P", windows, ...extra });
  assert.equal(bindingWindow(platform([])), undefined);
  assert.equal(bindingWindow(platform([], { error: "HTTP 401" })), undefined);
  // A flagged scoped weekly bucket does not excuse a 5-hour window sitting at 100%.
  const fullest = bindingWindow(platform([
    { label: "weekly (Fable)", usedPercent: 57, binding: true },
    { label: "5-hour", usedPercent: 100 },
  ]));
  assert.equal(fullest?.label, "5-hour");
  const flagged = bindingWindow(platform([
    { label: "5-hour", usedPercent: 57 },
    { label: "weekly (Fable)", usedPercent: 57, binding: true },
  ]));
  assert.equal(flagged?.label, "weekly (Fable)");
});

test("parseCodexUsage tolerates a null secondary window", () => {
  const parsed = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 }, secondary_window: null } }, NOW);
  assert.deepEqual(parsed.windows.map((w) => w.label), ["weekly"]);
});

test("codexAccountId reads the ChatGPT account id from the token claim", () => {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })).toString("base64url");
  assert.equal(codexAccountId(`h.${payload}.s`), "acct_123");
  assert.equal(codexAccountId("not-a-jwt"), undefined);
  assert.equal(codexAccountId(`h.${Buffer.from("{}").toString("base64url")}.s`), undefined);
});

test("parseZaiUsage computes percent from the credit cap and decodes the window units", () => {
  const parsed = parseZaiUsage({
    code: 200,
    data: {
      level: "pro",
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 53, remaining: 11946, percentage: 1, nextResetTime: 1790704171097 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 5976, remaining: 54023, percentage: 9, nextResetTime: 1790896010984 },
      ],
    },
  });
  assert.equal(parsed.plan, "pro");
  assert.deepEqual(parsed.windows.map((w) => [w.label, Math.round(w.usedPercent * 100) / 100]), [["5-hour", 0.44], ["weekly", 9.96]]);
  assert.equal(parsed.windows[0].resetsAt?.getTime(), 1790704171097);
});

test("parseZaiUsage keeps unknown encodings visible instead of guessing", () => {
  const parsed = parseZaiUsage({ data: { limits: [{ type: "TIME_LIMIT", unit: 9, number: 2, percentage: 50 }] } });
  assert.deepEqual(parsed.windows.map((w) => [w.label, w.usedPercent]), [["every 2 (unit 9) (time)", 50]]);
});

test("parseKimiUsage converts used_ratio and ignores the burst limits[] rows", () => {
  const parsed = parseKimiUsage({
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "100" } }],
    usages: {
      limit_month_code: { used_ratio: 0, reset_time: "2026-10-01T00:00:00Z" },
      limit_5h: { used_ratio: 0.031, reset_time: "2026-09-29T15:00:00Z" },
      limit_month_total: { used_ratio: 0.0546, reset_time: "2026-10-01T00:00:00Z" },
    },
  });
  assert.deepEqual(
    parsed.windows.map((w) => [w.label, Math.round(w.usedPercent * 100) / 100]),
    [["5-hour", 3.1], ["monthly", 5.46], ["monthly (code)", 0]]
  );
});

test("formatting helpers", () => {
  assert.equal(formatPercent(23), "23%");
  assert.equal(formatPercent(9.96), "10%");
  assert.equal(formatPercent(12.54), "12.5%");
  assert.equal(formatRelative(new Date(NOW.getTime() + 25 * 60_000), NOW), "in 25m");
  assert.equal(formatRelative(new Date(NOW.getTime() + (2 * 60 + 10) * 60_000), NOW), "in 2h 10m");
  assert.equal(formatRelative(new Date(NOW.getTime() + 39 * 3600_000), NOW), "in 1d 15h");
  assert.equal(formatRelative(new Date(NOW.getTime() - 1), NOW), "now");
});

test("renderUsage lists each platform with its own windows, flags, plan, errors, and unsupported providers", () => {
  const report = {
    platforms: [
      {
        provider: "claude-bridge",
        platform: "Anthropic Claude",
        plan: "max",
        windows: [
          { label: "5-hour", usedPercent: 23, resetsAt: new Date(NOW.getTime() + 2 * 3600_000) },
          { label: "weekly (Fable)", usedPercent: 25, binding: true },
        ],
      },
      { provider: "openai-codex", platform: "OpenAI Codex", plan: "pro", windows: [{ label: "weekly", usedPercent: 96 }] },
      { provider: "kimi-coding", platform: "Kimi Code", windows: [], error: "HTTP 401" },
    ],
    unsupported: ["openai"],
  };
  const text = renderUsage(report, NOW);
  assert.equal(
    text,
    [
      "Platform usage — 3 platform(s):",
      "",
      "Anthropic Claude (claude-bridge) · plan: max",
      "  • 5-hour: 23% used · resets in 2h 0m",
      "  • weekly (Fable): 25% used  ← binding",
      "",
      "OpenAI Codex (openai-codex) · plan: pro",
      "  • weekly: 96% used  ← near limit",
      "",
      "Kimi Code (kimi-coding)",
      "  • unavailable: HTTP 401",
      "",
      "No usage adapter for: openai.",
    ].join("\n")
  );
  assert.equal(hottestPercent(report), 96);
});

test("renderUsage with nothing to show", () => {
  assert.equal(renderUsage({ platforms: [], unsupported: [] }, NOW), "Platform usage: no authenticated provider has a usage adapter.");
});

function fakeRegistry(configured: string[], tokens: Record<string, string>): UsageRegistry {
  const all = ["claude-bridge", "openai-codex", "zai", "kimi-coding", "openai"];
  return {
    getAvailable: () => all.map((provider) => ({ provider, baseUrl: provider === "zai" ? "https://open.bigmodel.cn/api/coding/paas/v4" : "" })),
    getProviderAuthStatus: (provider) => ({ configured: configured.includes(provider) }),
    // Pi hands Kimi's token back as an Authorization header, the others as apiKey.
    getProviderAuth: async (provider) =>
      !tokens[provider]
        ? undefined
        : provider === "kimi-coding"
          ? { auth: { headers: { Authorization: `Bearer ${tokens[provider]}` } } }
          : { auth: { apiKey: tokens[provider] } },
  };
}

test("collectPlatformUsage queries only authenticated adapters, with the right headers, and isolates failures", async () => {
  const codexToken = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } })).toString("base64url")}.s`;
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = String(input);
    requests.push({ url, headers: { ...init.headers } });
    const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });
    if (url.startsWith("https://api.anthropic.com/")) return json({ limits: [{ kind: "session", percent: 23 }] });
    if (url.startsWith("https://chatgpt.com/")) return json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 96, limit_window_seconds: 604800 } } });
    if (url.startsWith("https://open.bigmodel.cn/")) return json({}, false, 401);
    if (url.startsWith("https://api.kimi.com/")) return json({ usages: { limit_5h: { used_ratio: 0.5 } } });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;

  const report = await collectPlatformUsage({
    registry: fakeRegistry(["claude-bridge", "openai-codex", "zai", "kimi-coding", "openai"], { "openai-codex": codexToken, zai: "zk", "kimi-coding": "kt" }),
    fetch: fetchImpl,
    readClaudeCodeCredential: async () => ({ accessToken: "ct", subscriptionType: "max", expiresAt: NOW.getTime() + 60_000 }),
    now: () => NOW,
  });

  assert.deepEqual(report.unsupported, ["openai"]);
  assert.deepEqual(
    report.platforms.map((p) => [p.provider, p.plan, p.error, p.windows.map((w) => `${w.label}=${w.usedPercent}`)]),
    [
      ["claude-bridge", "max", undefined, ["5-hour=23"]],
      ["kimi-coding", undefined, undefined, ["5-hour=50"]],
      ["openai-codex", "pro", undefined, ["weekly=96"]],
      ["zai", undefined, "HTTP 401", []],
    ]
  );

  const byUrl = Object.fromEntries(requests.map((r) => [new URL(r.url).host, r.headers]));
  assert.equal(byUrl["api.anthropic.com"]["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(byUrl["api.anthropic.com"].Authorization, "Bearer ct");
  assert.equal(byUrl["chatgpt.com"]["ChatGPT-Account-Id"], "acct_9");
  assert.equal(byUrl["chatgpt.com"].Authorization, `Bearer ${codexToken}`);
  // The Z.ai host follows the provider's configured baseUrl (China region here).
  assert.equal(requests.find((r) => r.url.includes("bigmodel"))?.url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  assert.equal(byUrl["api.kimi.com"].Authorization, "Bearer kt");
});

test("collectPlatformUsage reports missing or expired credentials per platform without a request", async () => {
  let calls = 0;
  const report = await collectPlatformUsage({
    registry: fakeRegistry(["claude-bridge", "openai-codex"], {}),
    fetch: (async () => {
      calls += 1;
      throw new Error("must not be called");
    }) as unknown as typeof fetch,
    readClaudeCodeCredential: async () => ({ accessToken: "stale", expiresAt: NOW.getTime() - 1 }),
    now: () => NOW,
  });
  assert.equal(calls, 0);
  assert.deepEqual(
    report.platforms.map((p) => [p.provider, p.error]),
    [
      ["claude-bridge", "Claude Code token expired; run Claude Code once to refresh it"],
      ["openai-codex", "no credential from Pi"],
    ]
  );
});

test("collectPlatformUsage times out a hung platform and still returns the others", async () => {
  const report = await collectPlatformUsage({
    registry: fakeRegistry(["zai", "kimi-coding"], { zai: "zk", "kimi-coding": "kt" }),
    fetch: (async (input: any, init: any) => {
      if (String(input).includes("kimi")) return { ok: true, status: 200, json: async () => ({ usages: { limit_5h: { used_ratio: 0.1 } } }) };
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    }) as unknown as typeof fetch,
    timeoutMs: 20,
    now: () => NOW,
  });
  assert.deepEqual(
    report.platforms.map((p) => [p.provider, p.error ?? p.windows.length]),
    [
      ["kimi-coding", 1],
      ["zai", "timed out after 20ms"],
    ]
  );
});

test("/jev usage command renders the per-platform report", async () => {
  const { registerJevCommands } = await import("../src/commands.js");
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi: any = { registerCommand: (_n: string, o: any) => (handler = o.handler), getActiveTools: () => [], getAllTools: () => [], setActiveTools() {} };
  registerJevCommands(pi, { isConfigured: () => false, stats: {} } as any, {} as any, {} as any, { enabled: false, setEnabled() {} } as any);
  const calls: Array<{ message: string; level?: string }> = [];
  const ctx: any = {
    ui: { notify: (message: string, level?: string) => calls.push({ message, level }) },
    modelRegistry: fakeRegistry(["kimi-coding"], { "kimi-coding": "kt" }),
    signal: undefined,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ usages: { limit_5h: { used_ratio: 0.95 } } }) })) as unknown as typeof fetch;
  try {
    await handler!("usage", ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls[0].level, "info");
  assert.equal(calls[1].level, "warning");
  assert.equal(calls[1].message, "Platform usage — 1 platform(s):\n\nKimi Code (kimi-coding)\n  • 5-hour: 95% used  ← near limit");
});

test("SUPPORTED_PLATFORMS names the four adapters", () => {
  assert.deepEqual([...SUPPORTED_PLATFORMS].sort(), ["claude-bridge", "kimi-coding", "openai-codex", "zai"]);
});

test("platform errors never echo response bodies or dependency messages that may carry credentials", async () => {
  const SENTINEL = "FAKE_SENTINEL_TOKEN";
  const cases: Array<[string, typeof fetch, string]> = [
    ["non-JSON body", (async () => new Response(SENTINEL, { status: 200 })) as unknown as typeof fetch, "response was not valid JSON"],
    ["network failure", (async () => { throw new TypeError(`fetch failed for ${SENTINEL}`); }) as unknown as typeof fetch, "network error"],
    ["dependency error", (async () => { throw new Error(`upstream said ${SENTINEL}`); }) as unknown as typeof fetch, "unexpected error"],
  ];
  for (const [name, fetchImpl, expected] of cases) {
    const report = await collectPlatformUsage({ registry: fakeRegistry(["zai"], { zai: SENTINEL }), fetch: fetchImpl, now: () => NOW });
    assert.equal(report.platforms[0].error, expected, name);
    assert.ok(!renderUsage(report, NOW).includes(SENTINEL), `${name}: rendered usage leaks the credential`);
  }
});

test("collectPlatformUsage bounds credential lookup, not just the request", async () => {
  const registry: UsageRegistry = {
    ...fakeRegistry(["zai"], {}),
    getProviderAuth: () => new Promise(() => {}),
  };
  const started = Date.now();
  const report = await collectPlatformUsage({
    registry,
    fetch: (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch,
    timeoutMs: 20,
    now: () => NOW,
  });
  assert.ok(Date.now() - started < 1_000, "a never-settling getProviderAuth must not outlive the timeout");
  assert.deepEqual(report.platforms.map((p) => [p.provider, p.error]), [["zai", "timed out after 20ms"]]);
});

test("a caller's cancellation reason is never shown as the platform error", async () => {
  const controller = new AbortController();
  controller.abort(new Error("internal detail FAKE_SENTINEL_TOKEN"));
  const report = await collectPlatformUsage({ registry: fakeRegistry(["zai"], { zai: "zk" }), signal: controller.signal, now: () => NOW });
  assert.equal(report.platforms[0].error, "cancelled");
});
