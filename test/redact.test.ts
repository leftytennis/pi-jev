import test from "node:test";
import assert from "node:assert/strict";
import { capText, redactDeep, redactText, referencesSecretPath } from "../src/redact.js";

test("redactText strips recognized secret material", () => {
  const secret = [
    "awsKey = AKIAIOSFODNN7EXAMPLE",
    "github ghp_0123456789abcdefghijklmnopqrstuvwxyz token",
    "openai sk-proj-abcdefghijklmnopqrst",
    "Authorization: Bearer abcdef123456",
    "DB_PASSWORD: hunter22222",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  ].join("\n");
  const out = redactText(secret);
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(out, /ghp_0123456789/);
  assert.doesNotMatch(out, /sk-proj-/);
  assert.doesNotMatch(out, /Bearer abcdef123456/);
  assert.doesNotMatch(out, /hunter22222/);
  assert.doesNotMatch(out, /MIIabc/);
  assert.doesNotMatch(out, /eyJzdWIiOiIxMjM0NTY3ODkwIn0/);
  assert.match(out, /<REDACTED>/);
  assert.match(out, /awsKey = /, "the key name survives so the model retains context");
});

test("redactText leaves ordinary code untouched", () => {
  const code = "const threshold = 0.7;\nexport function cheaperFirst(a, b) { return a - b; }";
  assert.equal(redactText(code), code);
});

test("redactDeep redacts nested strings and preserves the value when clean", () => {
  const dirty = { a: "token=supersecret99", b: [{ c: "AKIAIOSFODNN7EXAMPLE" }], d: 4 };
  const out = redactDeep(dirty);
  assert.equal((out as any).a, "token=<REDACTED>", "the key name stays so the judge knows what was hidden");
  assert.equal((out as any).b[0].c, "<REDACTED>");
  assert.equal((out as any).d, 4);

  const clean = { a: "hello", b: [1, 2] };
  assert.equal(redactDeep(clean), clean, "clean values return the same reference");
});

test("capText truncates with a marker", () => {
  assert.equal(capText("short", 10), "short");
  const capped = capText("x".repeat(100), 10);
  assert.match(capped, /^x{10}… \[truncated 90 chars\]$/);
});

test("referencesSecretPath detects secret-bearing writes", () => {
  assert.equal(referencesSecretPath({ path: "/repo/.env" }), true);
  assert.equal(referencesSecretPath({ path: "/home/u/.ssh/id_rsa" }), true);
  assert.equal(referencesSecretPath({ file: "server.key" }), true);
  assert.equal(referencesSecretPath({ path: "/repo/src/index.ts" }), false);
  assert.equal(referencesSecretPath({ command: "ls .env" }), false, "only path-like fields count");
});

test("redactText catches credential names that embed the keyword, Stripe keys, and DSN passwords", () => {
  const samples = [
    "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    "aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    "STRIPE_SECRET_KEY=sk_live_51Habcdefghijklmnop",
    "charge with sk_live_51Habcdefghijklmnop now",
  ];
  for (const sample of samples) {
    const out = redactText(sample);
    assert.match(out, /<REDACTED>/, sample);
    assert.doesNotMatch(out, /wJalrXUtnFEMI|51Habcdefghijklmnop/, sample);
  }
  assert.equal(redactText("postgres://app:hunter2pass@db.internal:5432/main"), "postgres://app:<REDACTED>@db.internal:5432/main");
});

test("KEY=VALUE redaction hides literals but leaves code that reads secrets visible", () => {
  const code = [
    "user.password = req.body.password;",
    "const apiKey = process.env.OPENAI_API_KEY;",
    "const token = Math.random().toString(36);",
    "tokens = tokenize(source_code)",
    "accessKeyId: process.env.AWS_ACCESS_KEY_ID,",
    "return { token: jwtService.sign(payload) };",
    "self.password_hash = generate_password_hash(password)",
    "tokenizer=AutoTokenizer.from_pretrained(name)",
    "passwordField: string;",
  ];
  for (const line of code) assert.equal(redactText(line), line);
  assert.equal(redactText("const apiKey = 'hardcoded-value-123';"), "const apiKey = <REDACTED>;");
  assert.equal(redactText('{"password": "correct-horse-battery"}'), '{"password": <REDACTED>}');
});

test("redactDeep redacts secrets nested past the walk depth", () => {
  let value: any = { token: "ghp_0123456789abcdefghijklmnopqrstuvwxyz" };
  for (let i = 0; i < 12; i++) value = { nested: value };
  const out = JSON.stringify(redactDeep(value));
  assert.doesNotMatch(out, /ghp_0123456789/);
  assert.match(out, /<REDACTED>/);
});
