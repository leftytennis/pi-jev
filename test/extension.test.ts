import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/index.js";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
const ISOLATED_ENV = ["HOME", "TYPESAFE_API_KEY", "PI_JEV_BASE_URL", "TYPESAFE_BASE_URL"];

// Loads the real extension against a fake host: flags come from getFlag, the
// pi-subagents RPC is answered in-process, and Jev stays unconfigured (empty
// HOME, no key or endpoint) so nothing reaches the network.
function loadExtension(t: test.TestContext, flags: Record<string, boolean>, overrides: Record<string, unknown> = {}) {
  const saved = Object.fromEntries(ISOLATED_ENV.map((k) => [k, process.env[k]]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-ext-home-"));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  for (const k of ISOLATED_ENV.slice(1)) delete process.env[k];

  const hooks = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
  const listeners = new Map<string, (payload: any) => void>();
  const dispatched: any[] = [];
  const host: Record<string, unknown> = {
    registerFlag: () => {},
    getFlag: (name: string) => flags[name] ?? false,
    on: (event: string, handler: any) => { hooks.set(event, handler); },
    getAllTools: () => [],
    getActiveTools: () => [],
    events: {
      on: (name: string, fn: (payload: any) => void) => { listeners.set(name, fn); return () => listeners.delete(name); },
      emit: (name: string, payload: any) => {
        if (name !== RPC_REQUEST) return;
        dispatched.push(payload);
        listeners.get(`${RPC_REPLY}${payload.requestId}`)?.({ success: true, data: { runId: "run-1" } });
      },
    },
    ...overrides,
  };
  const pi = new Proxy(host, { get: (target, key: string) => (key in target ? target[key] : () => undefined) });
  extension(pi as any);
  const ctx = { ui: { setStatus: () => {}, notify: () => {} }, signal: undefined };
  return { start: (prompt: string) => hooks.get("before_agent_start")!({ prompt }, ctx), hooks, dispatched };
}

test("agent orchestration dispatches without auto mode", async (t) => {
  const ext = loadExtension(t, { "jev-agents": true, "jev-auto": false });
  await ext.start("do an architecture review of the router");
  assert.equal(ext.dispatched.length, 1);
  assert.equal(ext.dispatched[0].method, "spawn");
});

test("agent orchestration stays off when its flag is off", async (t) => {
  const ext = loadExtension(t, { "jev-agents": false, "jev-auto": false });
  await ext.start("do an architecture review of the router");
  assert.equal(ext.dispatched.length, 0);
});

const zaiModel = (id: string, extra: Record<string, unknown> = {}) => ({
  id, provider: "zai", name: id, api: "openai-completions", baseUrl: "", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0 }, contextWindow: 1_000_000, maxTokens: 131072, ...extra,
});

// SDK-backed providers throw on error statuses before after_provider_response
// fires, so the failed assistant message is the router's only signal.
test("a plan-entitlement failure moves the run to another model before Pi retries", async (t) => {
  const highspeed = zaiModel("glm-5.3-highspeed");
  const flash = zaiModel("glm-5.3-flash", { input: ["text", "image"], cost: { input: 0.075, output: 0.25 } });
  const selected: string[] = [];
  const ext = loadExtension(t, { "jev-auto-model": true }, {
    setModel: async (m: any) => { selected.push(m.id); ctx.model = m; return true; },
  });
  const statuses: string[] = [];
  const ctx: any = {
    model: highspeed,
    modelRegistry: { getAvailable: () => [highspeed, flash], getProviderAuthStatus: () => ({ configured: false }) },
    getSystemPrompt: () => "",
    ui: { setStatus: (_key: string, text: string) => statuses.push(text), notify: () => {} },
  };

  // An unrecognized prompt abstains and stays on the current model.
  await ext.hooks.get("before_agent_start")!({ prompt: "show me the model tier catalog" }, ctx);
  assert.deepEqual(selected, []);

  const failed = {
    role: "assistant", provider: "zai", model: "glm-5.3-highspeed", content: [], stopReason: "error",
    errorMessage: '429: {"code":"1311","message":"Your current subscription plan does not yet include access to GLM-5.3-Highspeed"}',
  };
  await ext.hooks.get("agent_end")!({ type: "agent_end", messages: [failed] }, ctx);
  assert.deepEqual(selected, ["glm-5.3-flash"]);
  assert.match(statuses.at(-1)!, /access → glm-5\.3-flash/);

  // The next prompt never routes back to the model the plan excludes.
  ctx.model = flash;
  await ext.hooks.get("before_agent_start")!({ prompt: "plan a safe migration" }, ctx);
  assert.deepEqual(selected, ["glm-5.3-flash"]);
});

// Pi retries on whichever model is current, so by agent_end the session may
// already sit on a different model than the one that failed.
test("a failed turn backs off the model named on the message, not the current one", async (t) => {
  const highspeed = zaiModel("glm-5.3-highspeed");
  const flash = zaiModel("glm-5.3-flash", { cost: { input: 0.075, output: 0.25 } });
  const selected: string[] = [];
  const ext = loadExtension(t, { "jev-auto-model": true }, { setModel: async (m: any) => { selected.push(m.id); ctx.model = m; return true; } });
  const ctx: any = {
    model: flash,
    modelRegistry: { getAvailable: () => [highspeed, flash], getProviderAuthStatus: () => ({ configured: false }) },
    getSystemPrompt: () => "",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await ext.hooks.get("before_agent_start")!({ prompt: "show me the model tier catalog" }, ctx);
  const failed = {
    role: "assistant", provider: "zai", model: "glm-5.3-highspeed", content: [], stopReason: "error",
    errorMessage: '429: {"code":"1311","message":"Your current subscription plan does not yet include access to GLM-5.3-Highspeed"}',
  };
  await ext.hooks.get("agent_end")!({ type: "agent_end", messages: [failed] }, ctx);
  assert.deepEqual(selected, [], "flash was not blamed for highspeed's failure");

  ctx.model = highspeed;
  await ext.hooks.get("before_agent_start")!({ prompt: "show me the model tier catalog" }, ctx);
  assert.deepEqual(selected, ["glm-5.3-flash"], "highspeed is backed off");
});

test("with auto-model off a failed turn is recorded but neither switches nor claims a fallback", async (t) => {
  const highspeed = zaiModel("glm-5.3-highspeed");
  const flash = zaiModel("glm-5.3-flash", { cost: { input: 0.075, output: 0.25 } });
  const selected: string[] = [];
  const ext = loadExtension(t, { "jev-auto-model": false }, { setModel: async (m: any) => { selected.push(m.id); return true; } });
  const statuses: string[] = [];
  const ctx: any = {
    model: highspeed,
    modelRegistry: { getAvailable: () => [highspeed, flash], getProviderAuthStatus: () => ({ configured: false }) },
    getSystemPrompt: () => "",
    ui: { setStatus: (_key: string, text: string) => statuses.push(text), notify: () => {} },
  };
  const failed = {
    role: "assistant", provider: "zai", model: "glm-5.3-highspeed", content: [], stopReason: "error",
    errorMessage: '429: {"code":"1311","message":"Your current subscription plan does not yet include access to GLM-5.3-Highspeed"}',
  };
  await ext.hooks.get("agent_end")!({ type: "agent_end", messages: [failed] }, ctx);
  assert.deepEqual(selected, []);
  assert.deepEqual(statuses.filter((s) => /fallback|access/.test(s)), []);
});

test("successful and aborted runs leave routing alone", async (t) => {
  const highspeed = zaiModel("glm-5.3-highspeed");
  const flash = zaiModel("glm-5.3-flash", { cost: { input: 0.075, output: 0.25 } });
  const selected: string[] = [];
  const ext = loadExtension(t, { "jev-auto-model": true }, { setModel: async (m: any) => { selected.push(m.id); return true; } });
  const ctx: any = {
    model: highspeed,
    modelRegistry: { getAvailable: () => [highspeed, flash], getProviderAuthStatus: () => ({ configured: false }) },
    getSystemPrompt: () => "",
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await ext.hooks.get("before_agent_start")!({ prompt: "show me the model tier catalog" }, ctx);
  for (const stopReason of ["stop", "aborted"]) {
    await ext.hooks.get("agent_end")!({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason }] }, ctx);
  }
  assert.deepEqual(selected, []);
});
