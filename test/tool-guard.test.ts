import test from "node:test";
import assert from "node:assert/strict";
import { ToolGuard } from "../src/tool-guard.js";
import { JevClient } from "../src/jev.js";

test("ToolGuard skips when disabled or unconfigured", async () => {
  const mockPi: any = { on: () => {} };
  const jevClient = new JevClient();
  const guard = new ToolGuard(mockPi, jevClient, false);

  const res = await guard.checkToolCall("bash", { command: "ls -la" });
  assert.equal(res.valid, true);
  assert.equal(res.blocked, undefined);
});

test("ToolGuard evaluates tool calls and flags hallucinations", async () => {
  const mockPi: any = { on: () => {} };
  const mockJev: any = {
    isConfigured: () => true,
    evaluate: async () => ({
      answers: {
        is_hallucinated: { type: "noul", value: 0.95 },
      },
      model: "jev-latest",
      elapsedMs: 15,
    }),
  };

  const guard = new ToolGuard(mockPi, mockJev, true);
  const res = await guard.checkToolCall("read", { path: "/non/existent/hallucinated/file.xyz" });

  assert.equal(res.valid, false);
  assert.equal(res.blocked, true);
  assert.match(res.reason ?? "", /hallucinated parameters/);
});

test("ToolGuard bounds both evaluations to 3s, disables retries and fails open on abort", async (t) => {
  for (const operation of ["call", "error"]) {
    for (const source of ["timeout", "caller", "already-aborted"]) {
      await t.test(`${operation}: ${source}`, async (t) => {
        const timeout = new AbortController();
        const caller = new AbortController();
        const reason = new DOMException("test abort", source === "timeout" ? "TimeoutError" : "AbortError");
        const delays: number[] = [];
        t.mock.method(AbortSignal, "timeout", (delay: number) => { delays.push(delay); return timeout.signal; });
        if (source === "already-aborted") caller.abort(reason);
        const client = new JevClient();
        client.isConfigured = () => true;
        let calls = 0;
        client.evaluate = async (_request, signal, options) => {
          calls++;
          assert.deepEqual(options, { retry: { maxRetries: 0 } });
          assert.ok(signal);
          if (source !== "timeout") assert.notEqual(signal, caller.signal);
          if (signal.aborted) throw signal.reason;
          return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        };
        const pi: any = { on: () => {} };
        const guard = new ToolGuard(pi, client, true);
        const signal = source === "timeout" ? undefined : caller.signal;
        const pending = operation === "call"
          ? guard.checkToolCall("read", { path: "file.ts" }, undefined, signal)
          : guard.enhanceErrorResult("read", { path: "file.ts" }, [], undefined, signal);
        if (source === "timeout") timeout.abort(reason);
        else caller.abort(reason);
        const result = await pending;
        if (operation === "call") {
          assert.ok(result && typeof result === "object");
          assert.equal(result.valid, true);
          assert.equal(result.blocked, undefined);
        } else assert.equal(result, null);
        assert.deepEqual(delays, [3_000]);
        assert.equal(calls, 1);
      });
    }
  }
});

test("ToolGuard enhances error results with guidance", async () => {
  const mockPi: any = { on: () => {} };
  const mockJev: any = {
    isConfigured: () => true,
    evaluate: async () => ({
      answers: {
        error_category: { type: "choice", value: "missing_file" },
      },
      model: "jev-latest",
      elapsedMs: 12,
    }),
  };

  const guard = new ToolGuard(mockPi, mockJev, true);
  const hint = await guard.enhanceErrorResult(
    "read",
    { path: "fake.ts" },
    [{ type: "text", text: "ENOENT: no such file or directory" }]
  );

  assert.match(hint ?? "", /Path not found/);
});
