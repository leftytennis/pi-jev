import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIER, TIER_ALIASES, inferTiers, parseTierOverlay, readTierOverlay, tierKey } from "../src/tiers.js";

const m = (provider: string, id: string, input?: number, output?: number) => ({
  provider,
  id,
  cost: input === undefined ? undefined : { input, output },
});

test("tierKey matches the router's candidateKey shape", () => {
  assert.equal(tierKey("openai-codex", "gpt-6-astra"), "openai-codex/gpt-6-astra");
});

test("parseTierOverlay accepts numeric tiers and named aliases", () => {
  const result = parseTierOverlay(JSON.stringify({
    comment: "my lineup",
    tiers: { "openai-codex/gpt-6-astra": 5, "openai-codex/gpt-6-luna": "economy", "zai/glm-5.3": "FLAGSHIP" },
  }));
  assert.ok("tiers" in result);
  assert.deepEqual(result.tiers.get("openai-codex/gpt-6-astra"), { tier: 5, basis: "configured" });
  assert.deepEqual(result.tiers.get("openai-codex/gpt-6-luna"), { tier: TIER_ALIASES.economy, basis: "configured" });
  assert.deepEqual(result.tiers.get("zai/glm-5.3"), { tier: 5, basis: "configured" });
});

test("parseTierOverlay tolerates unknown model keys", () => {
  const result = parseTierOverlay(JSON.stringify({ tiers: { "gone/model-9": 4 } }));
  assert.ok("tiers" in result);
  assert.deepEqual(result.tiers.get("gone/model-9"), { tier: 4, basis: "configured" });
});

test("parseTierOverlay rejects the whole file on any malformed entry", () => {
  for (const raw of [
    "not json",
    JSON.stringify([1, 2]),
    JSON.stringify({ tiers: {}, extra: 1 }),
    JSON.stringify({ comment: 42, tiers: {} }),
    JSON.stringify({ tiers: "nope" }),
    JSON.stringify({ tiers: { "a/b": 0 } }),
    JSON.stringify({ tiers: { "a/b": 6 } }),
    JSON.stringify({ tiers: { "a/b": 2.5 } }),
    JSON.stringify({ tiers: { "a/b": "great" } }),
  ]) {
    const result = parseTierOverlay(raw);
    assert.ok("error" in result, `expected rejection for ${raw}`);
  }
});

test("readTierOverlay distinguishes missing, malformed, and valid files", () => {
  assert.deepEqual(readTierOverlay("/nonexistent/jev-model-tiers.json"), { missing: true });
});

test("inferTiers: a single priced model is neutral price-inferred, zero-priced is default", () => {
  const priced = inferTiers([m("solo", "a", 5, 20)]);
  assert.deepEqual(priced.get("solo/a"), { tier: DEFAULT_TIER, basis: "price-inferred" });
  const free = inferTiers([m("solo", "a", 0, 0)]);
  assert.deepEqual(free.get("solo/a"), { tier: DEFAULT_TIER, basis: "default" });
  const noCost = inferTiers([m("solo", "a")]);
  assert.deepEqual(noCost.get("solo/a"), { tier: DEFAULT_TIER, basis: "default" });
});

test("inferTiers: a two-model ladder reads as lesser/greater, not budget/flagship", () => {
  const table = inferTiers([m("p", "cheap", 1, 5), m("p", "dear", 10, 50)]);
  assert.deepEqual(table.get("p/cheap"), { tier: 2, basis: "price-inferred" });
  assert.deepEqual(table.get("p/dear"), { tier: 4, basis: "price-inferred" });
});

test("inferTiers: the 8-model Codex lineup maps to the worked ladder", () => {
  const table = inferTiers([
    m("openai-codex", "gpt-6-astra", 10, 50),
    m("openai-codex", "gpt-6-sol", 2, 10),
    m("openai-codex", "gpt-6-luna", 0.1, 0.5),
    m("openai-codex", "gpt-5.6-terra", 2, 12),
    m("openai-codex", "gpt-5.6-sol", 4, 20),
    m("openai-codex", "gpt-5.6-luna", 0.2, 1.2),
    m("openai-codex", "gpt-5.5", 5, 30),
    m("openai-codex", "gpt-5.3-codex-spark", 1.75, 14),
  ]);
  const tierOf = (id: string) => table.get(`openai-codex/${id}`)?.tier;
  assert.equal(tierOf("gpt-6-luna"), 1);
  assert.equal(tierOf("gpt-5.6-luna"), 1);
  assert.equal(tierOf("gpt-5.3-codex-spark"), 2);
  assert.equal(tierOf("gpt-6-sol"), 2);
  assert.equal(tierOf("gpt-5.6-terra"), 3);
  assert.equal(tierOf("gpt-5.6-sol"), 3);
  assert.equal(tierOf("gpt-5.5"), 4);
  assert.equal(tierOf("gpt-6-astra"), 5);
});

test("inferTiers: price-tied models share the higher tier of the tie span", () => {
  const table = inferTiers([m("p", "a", 1, 1), m("p", "b", 5, 5), m("p", "c", 5, 5)]);
  assert.equal(table.get("p/a")?.tier, 1);
  assert.equal(table.get("p/b")?.tier, 5);
  assert.equal(table.get("p/c")?.tier, 5);
});

test("inferTiers: an all-zero-price provider has no ladder", () => {
  const table = inferTiers([m("flat", "a", 0, 0), m("flat", "b", 0, 0), m("flat", "c", 0, 0)]);
  for (const id of ["a", "b", "c"]) assert.deepEqual(table.get(`flat/${id}`), { tier: DEFAULT_TIER, basis: "default" });
});

test("inferTiers: cache pricing does not participate in the ladder", () => {
  const table = inferTiers([
    m("p", "a", 1, 5),
    m("p", "b", 10, 50),
  ]);
  assert.equal(table.get("p/a")?.tier, 2);
  assert.equal(table.get("p/b")?.tier, 4);
});

test("inferTiers: overlay entries win with basis configured", () => {
  const overlay = new Map([["p/cheapest", { tier: 5 as const, basis: "configured" as const }]]);
  const table = inferTiers([m("p", "cheapest", 1, 1), m("p", "dearest", 100, 100)], overlay);
  assert.deepEqual(table.get("p/cheapest"), { tier: 5, basis: "configured" });
  assert.deepEqual(table.get("p/dearest"), { tier: 4, basis: "price-inferred" });
});

test("inferTiers: ladders are per-provider and never cross-normalized", () => {
  const table = inferTiers([
    m("cheap-vendor", "flagship", 0.5, 2),
    m("dear-vendor", "budget", 20, 80),
  ]);
  // Each provider is its own lineup of one: both neutral, regardless of price gap.
  assert.equal(table.get("cheap-vendor/flagship")?.tier, DEFAULT_TIER);
  assert.equal(table.get("dear-vendor/budget")?.tier, DEFAULT_TIER);
});

test("parseTierOverlay parses the exclude array", () => {
  const result = parseTierOverlay(JSON.stringify({
    comment: "exclude test",
    exclude: ["openai-codex/gpt-6-sol", "zai/glm-5.3-highspeed"],
    tiers: { "openai-codex/gpt-6-astra": 5 },
  }));
  assert.ok("tiers" in result);
  assert.ok(result.exclude.has("openai-codex/gpt-6-sol"));
  assert.ok(result.exclude.has("zai/glm-5.3-highspeed"));
  assert.equal(result.exclude.size, 2);
});

test("parseTierOverlay rejects malformed exclude entries", () => {
  for (const raw of [
    JSON.stringify({ tiers: {}, exclude: "not an array" }),
    JSON.stringify({ tiers: {}, exclude: [1, 2] }),
    JSON.stringify({ tiers: {}, exclude: ["valid", 123] }),
  ]) {
    const result = parseTierOverlay(raw);
    assert.ok("error" in result, `expected rejection for ${raw}`);
  }
});

test("parseTierOverlay omits exclude when not present", () => {
  const result = parseTierOverlay(JSON.stringify({ tiers: {} }));
  assert.ok("tiers" in result);
  assert.equal(result.exclude.size, 0);
});
