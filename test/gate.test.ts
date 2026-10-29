import test from "node:test";
import assert from "node:assert/strict";
import { parseGateArgs, resolveGateState, evaluateGate, GateStateError } from "../src/gate.js";
import { JevClient } from "../src/jev.js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("parseGateArgs parses flags and criteria correctly", () => {
  const args = ["--criteria", "All tests pass", "-p", "0.85", "--diff", "--json", "--fail-open"];
  const opts = parseGateArgs(args);
  assert.equal(opts.criteria, "All tests pass");
  assert.equal(opts.threshold, 0.85);
  assert.equal(opts.diff, true);
  assert.equal(opts.json, true);
  assert.equal(opts.failOpen, true);
});

test("parseGateArgs handles positional criteria", () => {
  const args = ["Code is clean and modular", "-p", "0.9"];
  const opts = parseGateArgs(args);
  assert.equal(opts.criteria, "Code is clean and modular");
  assert.equal(opts.threshold, 0.9);
});

test("resolveGateState returns provided state string or diff fallback", () => {
  const state = resolveGateState({ criteria: "test", state: "function foo() { return 42; }" });
  assert.equal(state, "function foo() { return 42; }");
});

test("evaluateGate fails open when unconfigured if failOpen is true", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => false;

  const result = await evaluateGate(
    { criteria: "Must not break build", failOpen: true },
    mockClient
  );
  assert.equal(result.passed, true);
  assert.equal(result.probability, 1.0);
});

test("evaluateGate evaluates gate condition with JevClient", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async () => ({
    answers: {
      gate_passed: {
        type: "noul",
        value: 0.92,
        confidence: 0.95,
      },
    },
    model: "jev-latest",
    elapsedMs: 45,
  });

  const passResult = await evaluateGate(
    { criteria: "Clean TypeScript with no any", threshold: 0.8, state: "const x: number = 1;" },
    mockClient
  );
  assert.equal(passResult.passed, true);
  assert.equal(passResult.probability, 0.92);

  const failResult = await evaluateGate(
    { criteria: "Clean TypeScript with no any", threshold: 0.95, state: "const x: number = 1;" },
    mockClient
  );
  assert.equal(failResult.passed, false);
});

test("parseGateArgs rejects unknown flags, stray arguments, and out-of-range thresholds", () => {
  assert.throws(() => parseGateArgs(["-c", "x", "--threshhold", "0.95"]), /Unknown option: --threshhold/);
  assert.throws(() => parseGateArgs(["first", "second"]), /Unexpected argument/);
  assert.throws(() => parseGateArgs(["-c", "x", "-p", "-1"]), /between 0 and 1/);
  assert.throws(() => parseGateArgs(["-c", "x", "-p", "abc"]), /between 0 and 1/);
  assert.throws(() => parseGateArgs(["-c"]), /Missing value for -c/);
  assert.equal(parseGateArgs(["-c", "x", "--help"]).help, true, "help is reported, not acted on, by the parser");
});

function withTempRepo(fn: (dir: string) => void, { commit = true } = {}): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-gate-"));
  const prev = process.cwd();
  try {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    run("init", "-q");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "test");
    fs.writeFileSync(path.join(dir, "tracked.txt"), "original\n");
    if (commit) {
      run("add", "tracked.txt");
      run("commit", "-qm", "init");
    }
    process.chdir(dir);
    fn(dir);
  } finally {
    process.chdir(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("--diff includes untracked files instead of reporting no changes", () => {
  withTempRepo((dir) => {
    fs.writeFileSync(path.join(dir, "new-module.ts"), "export const evil = () => {};\n");
    const state = resolveGateState({ criteria: "x", diff: true });
    assert.match(state, /New untracked file: new-module\.ts/);
    assert.match(state, /export const evil/);
  });
});

test("state over the limit exits 2 instead of judging a truncated prefix", () => {
  withTempRepo((dir) => {
    fs.writeFileSync(path.join(dir, "tracked.txt"), "changed line\n".repeat(120_000));
    assert.throws(() => resolveGateState({ criteria: "x", diff: true }), (e: unknown) => e instanceof GateStateError && /over 50000 characters/.test(e.message));
    const state = resolveGateState({ criteria: "x", diff: true, maxChars: 2_000_000 });
    assert.match(state, /^diff --git/, "a raised limit judges the whole >1 MB diff, no ENOBUFS");
  });
});

test("an untracked file past the limit cannot hide behind a large tracked diff", () => {
  withTempRepo((dir) => {
    fs.writeFileSync(path.join(dir, "tracked.txt"), "pad\n".repeat(12_000));
    fs.writeFileSync(path.join(dir, "evil.js"), "x".repeat(5_000));
    assert.throws(() => resolveGateState({ criteria: "x", diff: true }), /over 50000 characters/);
  });
});

test("untracked symlinks are listed without being followed", () => {
  withTempRepo((dir) => {
    const outside = path.join(os.tmpdir(), `jev-gate-outside-${process.pid}`);
    fs.writeFileSync(outside, "outside-the-repo\n");
    try {
      fs.symlinkSync(outside, path.join(dir, "link.txt"));
      const state = resolveGateState({ criteria: "x", diff: true });
      assert.match(state, /link\.txt\n\(symlink to .*, not followed\)/);
      assert.doesNotMatch(state, /outside-the-repo/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

test("an untracked secret-named file fails the gate without being sent", () => {
  withTempRepo((dir) => {
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=abc\n");
    assert.throws(() => resolveGateState({ criteria: "x", diff: true }), (e: unknown) => e instanceof GateStateError && /\.env looks secret-bearing/.test(e.message));
  });
});

test("missing criteria is a state error, so --fail-open cannot pass it", async () => {
  const client = new JevClient();
  client.isConfigured = () => true;
  await assert.rejects(evaluateGate({ criteria: "  ", state: "x" }, client), (e: unknown) => e instanceof GateStateError);
});

test("--diff before the first commit judges files as they are on disk", () => {
  withTempRepo((dir) => {
    fs.writeFileSync(path.join(dir, "tracked.txt"), "safe()\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "tracked.txt"), "evil()\n");
    const state = resolveGateState({ criteria: "x", diff: true });
    assert.match(state, /evil\(\)/);
    assert.doesNotMatch(state, /safe\(\)/);
  }, { commit: false });
});

test("an empty threshold value is rejected, not read as 0", () => {
  assert.throws(() => parseGateArgs(["-c", "x", "-p", ""]), /between 0 and 1/);
  assert.throws(() => parseGateArgs(["-c", "x", "--max-chars", "0"]), /positive integer/);
  assert.equal(parseGateArgs(["-c", "x", "--max-chars", "100"]).maxChars, 100);
});

test("--diff works in a repository without commits", () => {
  withTempRepo((dir) => {
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    const state = resolveGateState({ criteria: "x", diff: true });
    assert.match(state, /original/);
  }, { commit: false });
});

test("an empty diff fails the gate unless --allow-empty is passed", () => {
  withTempRepo(() => {
    assert.throws(() => resolveGateState({ criteria: "x", diff: true }), /Empty git diff/);
    assert.equal(resolveGateState({ criteria: "x", diff: true, allowEmpty: true }), "(empty git diff)");
  });
});


test("a zero threshold cannot pass an absent or malformed judgment", async () => {
  const client = new JevClient();
  client.isConfigured = () => true;
  for (const value of [undefined, "0.9", NaN, -1, 2]) {
    client.evaluate = async (): Promise<import("../src/types.js").JevEvaluationResponse> => ({ answers: value === undefined ? {} : { gate_passed: { type: "noul", value } }, model: "test", elapsedMs: 0 });
    const result = await evaluateGate({ criteria: "x", state: "x", threshold: 0, failOpen: true }, client);
    assert.equal(result.passed, false, String(value));
  }
});
