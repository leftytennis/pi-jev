import test from "node:test";
import assert from "node:assert/strict";
import { JevClient } from "../src/jev.js";

const OLD_ENV = { ...process.env };
test.afterEach(() => {
  process.env = { ...OLD_ENV };
});

function withFakeClient(requests: any[], answers: any) {
  process.env.TYPESAFE_API_KEY = "test-key";
  const jev = new JevClient();
  (jev as any).client = {
    systemOne: async (req: any) => {
      requests.push(req);
      return answers;
    },
  };
  (jev as any).clientKey = "test-key";
  return jev;
}

test("evaluate redacts state and question text at the egress boundary", async () => {
  const requests: any[] = [];
  const jev = withFakeClient(requests, { answers: {}, model: "j", elapsedMs: 1 });
  await jev.evaluate({
    state: { file: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----" },
    questions: {
      q: { type: "noul", instructions: "Review this diff: ghp_0123456789abcdefghijklmnopqrstuvwxyz leaked" },
    },
  });

  const sent = requests[0];
  assert.match(JSON.stringify(sent.state), /<REDACTED>/);
  assert.doesNotMatch(JSON.stringify(sent.state), /MIIabc/);
  assert.match(JSON.stringify(sent.questions), /<REDACTED>/);
  assert.doesNotMatch(JSON.stringify(sent.questions), /ghp_0123456789/);
});

test("noul answers carry confidence through to consumers", async () => {
  const requests: any[] = [];
  const jev = withFakeClient(requests, {
    answers: { gate_passed: { noul: 0.92, confidence: 0.87 } },
    model: "j", elapsedMs: 3,
  });
  const res = await jev.evaluate({ state: "x", questions: { gate_passed: { type: "noul", instructions: "pass?" } } });
  assert.equal(res.answers.gate_passed.value, 0.92);
  assert.equal(res.answers.gate_passed.confidence, 0.87, "gate results previously lost this field");
});

test("a rotated key rebuilds the client instead of being ignored", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  // A closed loopback port: the rebuilt real client fails locally, never reaching the TypeSafe API.
  process.env.PI_JEV_BASE_URL = "http://127.0.0.1:9";
  const jev = new JevClient();
  const fake = { systemOne: async () => ({ answers: {}, model: "j", elapsedMs: 1 }) };
  (jev as any).client = fake;
  (jev as any).clientKey = "test-key";
  // Rotate: the resolved key now differs from the stubbed client’s key, so
  // getClient discards the stub and builds a real client (which then rejects
  // on auth/network — the point is that the stale stub is not reused).
  process.env.TYPESAFE_API_KEY = "new-key";
  await assert.rejects(
    jev.evaluate({ state: "x", questions: { q: { type: "noul", instructions: "y" } } }),
    (err: any) => !/Missing TYPESAFE_API_KEY|Refusing PI_JEV_BASE_URL/.test(String(err?.message)),
    "fails in transport, not configuration"
  );
  assert.equal((jev as any).clientKey, "new-key", "client rebuilt when the resolved key changed");
  assert.notEqual((jev as any).client, fake, "the stale client was discarded");
});
