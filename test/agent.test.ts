import test from "node:test";
import assert from "node:assert/strict";
import { executeJevAgentTask, JevAgentHandler } from "../src/agent.js";
import { JevClient } from "../src/jev.js";

test("executeJevAgentTask runs noul check for simple prompt", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async (req) => {
    assert.ok(req.questions["judgment"]);
    assert.equal(req.questions["judgment"].type, "noul");
    return {
      answers: {
        judgment: {
          type: "noul",
          value: 0.88,
        },
      },
      model: "jev-latest",
      elapsedMs: 30,
    };
  };

  const res = await executeJevAgentTask(
    { task: "Is this pull request safe to deploy?", state: "git diff content" },
    mockClient
  );
  assert.equal(res.success, true);
  assert.equal(res.primaryValue, 0.88);
});

test("executeJevAgentTask runs choice check when specified", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async (req) => {
    assert.equal(req.questions["judgment"].type, "choice");
    return {
      answers: {
        judgment: {
          type: "choice",
          value: "bugfix",
        },
      },
      model: "jev-latest",
      elapsedMs: 25,
    };
  };

  const res = await executeJevAgentTask(
    {
      type: "choice",
      instructions: "Classify issue type",
      criteria: { bugfix: "Bug report", feature: "New feature request" },
      state: "Fix null pointer in auth handler",
    },
    mockClient
  );
  assert.equal(res.success, true);
  assert.equal(res.primaryValue, "bugfix");
});

test("JevAgentHandler intercepts RPC for agent 'jev'", async () => {
  const listeners: Record<string, Function[]> = {};
  const emitted: Record<string, any[]> = {};

  const mockPi: any = {
    events: {
      on: (event: string, fn: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
        return () => {};
      },
      emit: (event: string, payload: any) => {
        emitted[event] = emitted[event] || [];
        emitted[event].push(payload);
      },
    },
  };

  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async () => ({
    answers: {
      judgment: {
        type: "choice",
        value: "approved",
      },
    },
    model: "jev-latest",
    elapsedMs: 20,
  });

  const handler = new JevAgentHandler(mockPi, mockClient);
  handler.install();

  const rpcHandler = listeners["subagents:rpc:v1:request"]?.[0];
  assert.ok(rpcHandler);

  await rpcHandler({
    version: 1,
    requestId: "req-123",
    params: {
      agent: "jev",
      type: "choice",
      criteria: { approved: "Pass", rejected: "Fail" },
      task: "Review changes",
    },
  });

  const reply = emitted["subagents:rpc:v1:reply:req-123"]?.[0];
  assert.ok(reply);
  assert.equal(reply.success, true);
  assert.equal(reply.data.result.primaryValue, "approved");
});

test("agent tasks enforce the shared 24-question cost cap instead of forwarding verbatim", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  let evaluated = 0;
  mockClient.evaluate = async () => { evaluated++; return { answers: {}, model: "jev-latest", elapsedMs: 1 }; };

  const questions: Record<string, any> = {};
  for (let i = 0; i < 25; i++) questions[`q_${i}`] = { type: "noul", instructions: `check ${i}` };
  await assert.rejects(
    executeJevAgentTask({ questions, state: "x" }, mockClient),
    /max 24/,
    "the RPC path must hold the same line as the jev_evaluate tool"
  );
  assert.equal(evaluated, 0, "no paid request leaves the machine for an over-cap task");

  // Exactly 24 stays allowed: the cap matches jev_evaluate, not a tighter bound.
  delete questions.q_24;
  const ok = await executeJevAgentTask({ questions, state: "x" }, mockClient);
  assert.equal(ok.success, true);
  assert.equal(evaluated, 1);
});

test("agent tasks reject an oversized questions payload rather than truncating judgments", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async () => { throw new Error("must not be reached"); };
  const questions = { q: { type: "noul" as const, instructions: "x".repeat(60_000) } };
  await assert.rejects(executeJevAgentTask({ questions, state: "s" }, mockClient), /50000 characters/);
});

test("agent task state is capped at the jev-gate bound with a visible truncation marker", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  let seenState: any;
  mockClient.evaluate = async (req) => { seenState = req.state; return { answers: {}, model: "jev-latest", elapsedMs: 1 }; };

  await executeJevAgentTask({ task: "judge", state: "y".repeat(80_000) }, mockClient);
  assert.ok(typeof seenState === "string" && seenState.length < 60_000, "oversized string state is capped");
  assert.match(seenState, /truncated 30000 chars/);

  // A small object keeps its structure; an oversized one is serialized and capped.
  await executeJevAgentTask({ task: "judge", state: { small: true } }, mockClient);
  assert.deepEqual(seenState, { small: true });
  await executeJevAgentTask({ task: "judge", state: { blob: "z".repeat(80_000) } }, mockClient);
  assert.ok(typeof seenState === "string" && seenState.includes("truncated"), "oversized object state is serialized and capped");
});

test("the RPC handler passes a bounded AbortSignal so evaluations cannot run unbounded", async () => {
  const listeners: Record<string, Function[]> = {};
  const emitted: Record<string, any[]> = {};
  const mockPi: any = {
    events: {
      on: (event: string, fn: Function) => { (listeners[event] ||= []).push(fn); return () => {}; },
      emit: (event: string, payload: any) => { (emitted[event] ||= []).push(payload); },
    },
  };
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  let seenSignal: AbortSignal | undefined;
  mockClient.evaluate = async (_req, signal) => { seenSignal = signal; return { answers: { judgment: { type: "noul", value: 0.5 } }, model: "jev-latest", elapsedMs: 1 }; };

  new JevAgentHandler(mockPi, mockClient).install();
  await listeners["subagents:rpc:v1:request"][0]({ version: 1, requestId: "req-sig", params: { agent: "jev", task: "check" } });
  assert.ok(seenSignal instanceof AbortSignal, "RPC evaluations carry a timeout signal");
  assert.equal(emitted["subagents:rpc:v1:reply:req-sig"][0].success, true);

  // An over-cap RPC request surfaces as a failed reply, not a thrown handler.
  const big: Record<string, any> = {};
  for (let i = 0; i < 30; i++) big[`q_${i}`] = { type: "noul", instructions: "c" };
  await listeners["subagents:rpc:v1:request"][0]({ version: 1, requestId: "req-cap", params: { agent: "jev", questions: big } });
  const reply = emitted["subagents:rpc:v1:reply:req-cap"][0];
  assert.equal(reply.success, false);
  assert.match(reply.error.message, /max 24/);
});
