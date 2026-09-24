import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { classifyModelNeed } from "../src/model-router.js";

interface Fixture {
  id: string;
  prompt: string;
  hasImages?: boolean;
  contextChars?: number;
  expectProfile: string;
}

const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("./fixtures/model-routing.json", import.meta.url), "utf8"));

// The committed corpus is the contract for the local heuristic classifier.
// Recognizer changes must pass these cases and extend them — the corpus exists
// precisely so regex repairs are never tuned to a single live sample.
for (const f of fixtures) {
  test(`fixture: ${f.id}`, () => {
    const need = classifyModelNeed(f.prompt, f.contextChars ?? 0, f.hasImages ?? false);
    assert.equal(need.profile, f.expectProfile);
  });
}
