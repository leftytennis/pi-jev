import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitCodeFor } from "../bin/exit-code.js";

test("jev-gate wrapper fails closed on abnormal child termination", () => {
  assert.equal(exitCodeFor({ status: 0 }), 0, "genuine pass exits 0");
  assert.equal(exitCodeFor({ status: 1 }), 1, "gate failure exits 1");
  assert.equal(exitCodeFor({ status: 2 }), 2, "runner error exits 2");
  assert.equal(exitCodeFor({ status: null }), 2, "signal kill / OOM must NOT exit 0");
  assert.equal(exitCodeFor({ status: null, error: new Error("spawn ENOENT") }), 2, "spawn failure exits 2");
});

test("--fail-open never passes a gate whose state could not be built", () => {
  const run = (args: string[], input: string) =>
    spawnSync(process.execPath, [fileURLToPath(new URL("../bin/jev-gate.js", import.meta.url)), ...args], {
      input,
      encoding: "utf8",
      // Configured but unreachable: state errors happen before any request.
      env: { ...process.env, TYPESAFE_API_KEY: "test-key", PI_JEV_BASE_URL: "http://127.0.0.1:9" },
    });
  assert.equal(run(["-c", "x", "--fail-open"], "").status, 2, "empty stdin");
  assert.equal(run(["-c", "x", "--fail-open", "--max-chars", "10"], "x".repeat(50)).status, 2, "oversized stdin");
  assert.equal(run(["-c", "x", "--fail-open", "-f", "/nonexistent/file"], "").status, 2, "unreadable file");
});

test("--fail-open never passes a gate run with empty criteria", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/jev-gate.js", import.meta.url)), "-c", "", "--fail-open"], {
    input: "some state",
    encoding: "utf8",
    env: { ...process.env, TYPESAFE_API_KEY: "test-key", PI_JEV_BASE_URL: "http://127.0.0.1:9" },
  });
  assert.equal(result.status, 2);
});
