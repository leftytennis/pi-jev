// Live smoke test for /jev usage. Builds Pi's real ModelRuntime and ModelRegistry
// (the same registry the command receives as ctx.modelRegistry, including OAuth
// refresh for short-lived tokens such as Kimi's), reads every platform, and prints
// the rendered report. Tokens are never printed.
// Usage: node --import tsx scripts/smoke-usage.ts
//
// claude-bridge is registered by the pi-claude-bridge extension inside a session,
// so it is added here by hand; its credential comes from Claude Code's keychain.
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { collectPlatformUsage, renderUsage, type UsageRegistry } from "../src/usage.js";

const runtime = await ModelRuntime.create();
const real = new ModelRegistry(runtime);
const available = await runtime.getAvailable();
const registry: UsageRegistry = {
  getAvailable: () => [...available, { provider: "claude-bridge", baseUrl: "" }],
  getProviderAuthStatus: (provider) => (provider === "claude-bridge" ? { configured: true } : real.getProviderAuthStatus(provider)),
  getProviderAuth: (provider) => real.getProviderAuth(provider),
};

const report = await collectPlatformUsage({ registry });
console.log(renderUsage(report));
process.exit(0);
