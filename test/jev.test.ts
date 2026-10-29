import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JevClient, assertSafeBaseURL, resolveApiKeySource, resolveBaseURL } from "../src/jev.js";

const ENV_KEYS = ["HOME", "TYPESAFE_API_KEY", "PI_JEV_API_KEY", "PI_JEV_BASE_URL", "TYPESAFE_BASE_URL"];
const OLD_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const OLD_FETCH = globalThis.fetch;
const request = { state: "state", questions: { pick: { type: "noul" as const, instructions: "pick?" } } };
let home: string;
let requests: Array<{ url: string; init?: RequestInit }>;

test.beforeEach(() => {
  for (const key of ENV_KEYS.slice(1)) delete process.env[key];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-key-test-"));
  process.env.HOME = home;
  requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ model: "jev-test", usage: { input_tokens: 3, output_tokens: 4 }, answers: { pick: { noul: 0.9 } } });
  };
});

test.afterEach(() => {
  for (const [key, value] of Object.entries(OLD_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = OLD_FETCH;
  fs.rmSync(home, { recursive: true, force: true });
});

function secretFile(mode = 0o600): string {
  const file = path.join(home, ".pi", "agent", "secrets", "typesafe_api_key");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "file-key");
  fs.chmodSync(file, mode);
  return file;
}

function authorization(index = requests.length - 1): string | null {
  return new Headers(requests[index].init?.headers).get("Authorization");
}

test("resolveBaseURL prefers PI_JEV_BASE_URL over TYPESAFE_BASE_URL", () => {
  process.env.TYPESAFE_BASE_URL = "http://typesafe.local";
  process.env.PI_JEV_BASE_URL = "http://pi-jev.local";
  assert.equal(resolveBaseURL(), "http://pi-jev.local");
});

test("custom endpoint configures JevClient without sending a production key", async () => {
  process.env.TYPESAFE_API_KEY = "production-key";
  secretFile();
  process.env.PI_JEV_BASE_URL = "http://localhost:8000";
  const client = new JevClient();
  client.setApiKey("session-key");

  assert.equal(client.isConfigured(), true);
  assert.equal(client.getBaseURL(), "http://localhost:8000");
  assert.equal(client.getKeyOrigin(), null);
  assert.equal(resolveApiKeySource(), null);
  await client.evaluate(request);
  assert.equal(authorization()?.trim(), "Bearer");
  assert.equal(requests[0].url, "http://localhost:8000/v1/systemone");
});

test("custom endpoints use only PI_JEV_API_KEY for either base URL variable", async () => {
  for (const variable of ["PI_JEV_BASE_URL", "TYPESAFE_BASE_URL"]) {
    process.env[variable] = "https://jev.example.test";
    process.env.TYPESAFE_API_KEY = "production-key";
    process.env.PI_JEV_API_KEY = " custom-key ";
    secretFile(0o644);
    const client = new JevClient();
    client.setApiKey("session-key");
    assert.equal(client.getKeyOrigin(), "$PI_JEV_API_KEY");
    assert.equal(client.getKeyWarning(), null);
    await client.evaluate(request);
    assert.equal(authorization(), "Bearer custom-key");
    delete process.env[variable];
  }
});

test("an empty custom key stays empty even when a secrets-file key exists", async () => {
  process.env.PI_JEV_BASE_URL = "http://localhost:8000";
  process.env.PI_JEV_API_KEY = "  ";
  secretFile();
  await new JevClient().evaluate(request);
  assert.equal(authorization()?.trim(), "Bearer");
});

test("default TypeSafe origin, including paths and the default port, keeps the production key", async () => {
  process.env.TYPESAFE_API_KEY = "production-key";
  process.env.PI_JEV_API_KEY = "custom-key";
  for (const endpoint of [undefined, "https://api.typesafe.ai", "https://api.typesafe.ai:443/proxy"]) {
    if (endpoint) process.env.PI_JEV_BASE_URL = endpoint;
    else delete process.env.PI_JEV_BASE_URL;
    const client = new JevClient();
    assert.equal(client.getKeyOrigin(), "$TYPESAFE_API_KEY");
    await client.evaluate(request);
    assert.equal(authorization(), "Bearer production-key");
  }
});

test("a different port or lookalike host is a custom origin", async () => {
  process.env.TYPESAFE_API_KEY = "production-key";
  for (const endpoint of ["https://api.typesafe.ai:444", "https://api.typesafe.ai.example.test"]) {
    process.env.PI_JEV_BASE_URL = endpoint;
    await new JevClient().evaluate(request);
    assert.equal(authorization()?.trim(), "Bearer");
  }
});

test("endpoint changes rebuild the client and keep credentials scoped to the origin", async () => {
  process.env.TYPESAFE_API_KEY = "production-key";
  // Equal key values still require rebuilding for a different endpoint.
  process.env.PI_JEV_API_KEY = "production-key";
  const client = new JevClient();
  await client.evaluate(request);
  process.env.PI_JEV_BASE_URL = "https://jev.example.test";
  await client.evaluate(request);
  delete process.env.PI_JEV_API_KEY;
  await client.evaluate(request);
  assert.equal(authorization()?.trim(), "Bearer");
  delete process.env.PI_JEV_BASE_URL;
  await client.evaluate(request);
  assert.equal(authorization(), "Bearer production-key");
  assert.deepEqual(requests.map((r) => r.url), [
    "https://api.typesafe.ai/v1/systemone", "https://jev.example.test/v1/systemone",
    "https://jev.example.test/v1/systemone", "https://api.typesafe.ai/v1/systemone",
  ]);
});

test("unsafe base URLs still fail before transport", async () => {
  for (const endpoint of ["http://jev.example.test", "ftp://localhost", "not a URL"]) {
    process.env.PI_JEV_BASE_URL = endpoint;
    await assert.rejects(new JevClient().evaluate(request), /Refusing PI_JEV_BASE_URL|Invalid PI_JEV_BASE_URL/);
  }
  for (const endpoint of [null, "https://jev.example.test", "http://localhost:8000", "http://127.0.0.1", "http://[::1]"]) {
    assert.doesNotThrow(() => assertSafeBaseURL(endpoint));
  }
  assert.equal(requests.length, 0);
});

test("JevClient stats sum SDK snake_case token usage", async () => {
  const client = new JevClient();
  client.setApiKey("test-key");
  await client.evaluate(request);
  assert.equal(client.stats.requestsCount, 1);
  assert.equal(client.stats.totalTokens, 7);
});

test("JevClient reports env key origin instead of in-session", () => {
  process.env.TYPESAFE_API_KEY = "env-key";
  assert.equal(new JevClient().getKeyOrigin(), "$TYPESAFE_API_KEY");
});

test("JevClient reports explicit runtime key as in-session", () => {
  const client = new JevClient();
  client.setApiKey("runtime-key");
  assert.equal(client.getKeyOrigin(), "set in-session");
});

test("JevClient lets non-empty runtime key override env key", async () => {
  process.env.TYPESAFE_API_KEY = "env-key";
  const client = new JevClient();
  client.setApiKey(" runtime-key ");
  assert.equal(client.getKeyOrigin(), "set in-session");
  await client.evaluate(request);
  assert.equal(authorization(), "Bearer runtime-key");
});

test("JevClient ignores empty runtime key and keeps env key", async () => {
  process.env.TYPESAFE_API_KEY = "env-key";
  const client = new JevClient();
  client.setApiKey("  ");
  assert.equal(client.getKeyOrigin(), "$TYPESAFE_API_KEY");
  await client.evaluate(request);
  assert.equal(authorization(), "Bearer env-key");
});

test("key-file permission warnings do not refuse the key", async () => {
  for (const mode of [0o640, 0o604, 0o644]) {
    secretFile(mode);
    assert.match(resolveApiKeySource()?.warning ?? "", /group or others; run chmod 600/);
    const client = new JevClient();
    assert.equal(client.isConfigured(), true);
    assert.equal(client.getKeyOrigin(), "~/.pi/agent/secrets/typesafe_api_key");
    assert.match(client.getKeyWarning() ?? "", /chmod 600/);
    await client.evaluate(request);
    assert.equal(authorization(), "Bearer file-key");
  }
  secretFile(0o600);
  assert.equal(new JevClient().getKeyWarning(), null);
});

test("an environment key takes precedence over key-file warnings", () => {
  secretFile(0o644);
  process.env.TYPESAFE_API_KEY = "env-key";
  assert.equal(new JevClient().getKeyWarning(), null);
});

test("evaluate redacts state and question text at the egress boundary", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  await new JevClient().evaluate({
    state: { file: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----" },
    questions: {
      q: { type: "noul", instructions: "Review this diff: ghp_0123456789abcdefghijklmnopqrstuvwxyz leaked" },
    },
  });
  const sent = String(requests[0].init?.body);
  assert.match(sent, /<REDACTED>/);
  assert.doesNotMatch(sent, /MIIabc|ghp_0123456789/);
});

test("noul answers carry confidence through to consumers", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  globalThis.fetch = async () => Response.json({ answers: { pick: { noul: 0.92, confidence: 0.87 } }, model: "j" });
  const res = await new JevClient().evaluate(request);
  assert.equal(res.answers.pick.value, 0.92);
  assert.equal(res.answers.pick.confidence, 0.87);
});

test("a rotated key rebuilds the client instead of being ignored", async () => {
  process.env.PI_JEV_BASE_URL = "http://localhost:8000";
  process.env.PI_JEV_API_KEY = "test-key";
  const client = new JevClient();
  await client.evaluate(request);
  assert.equal(authorization(), "Bearer test-key");
  process.env.PI_JEV_API_KEY = "new-key";
  await client.evaluate(request);
  assert.equal(authorization(), "Bearer new-key");
});

test("evaluate forwards per-call retry options to the SDK", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return Response.json({ error: "unavailable" }, { status: 503 });
  };
  await assert.rejects(new JevClient().evaluate(request, undefined, { retry: { maxRetries: 0 } }), /unavailable/);
  assert.equal(attempts, 1);
});


test("malformed noul answers stay absent instead of becoming negative judgments", async () => {
  process.env.TYPESAFE_API_KEY = "test-key";
  for (const answer of [null, {}, { noul: null }, { noul: "0.9" }, { noul: -1 }, { noul: 2 }]) {
    globalThis.fetch = async () => Response.json({ answers: { pick: answer }, model: "test" });
    const result = await new JevClient().evaluate(request);
    assert.equal(result.answers.pick, undefined, JSON.stringify(answer));
  }
});
