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
function loadExtension(t: test.TestContext, flags: Record<string, boolean>) {
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
  };
  const pi = new Proxy(host, { get: (target, key: string) => (key in target ? target[key] : () => undefined) });
  extension(pi as any);
  const ctx = { ui: { setStatus: () => {}, notify: () => {} }, signal: undefined };
  return { start: (prompt: string) => hooks.get("before_agent_start")!({ prompt }, ctx), dispatched };
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
