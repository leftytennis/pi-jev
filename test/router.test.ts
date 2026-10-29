import test from "node:test";
import assert from "node:assert/strict";
import { ToolRouter } from "../src/router.js";
import { JEV_THRESHOLD } from "../src/skills.js";
import { JevClient } from "../src/jev.js";

test("ToolRouter shortlists inactive tools correctly using local keywords", () => {
  const mockTools = [
    { name: "read", description: "Read files from disk" },
    { name: "bash", description: "Execute shell commands" },
    { name: "docker_logs", description: "View container docker logs and inspect status" },
    { name: "git_push", description: "Push commits to remote git repository" },
  ];

  let activeTools = ["read", "bash"];

  const mockPi: any = {
    getAllTools: () => mockTools,
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  };

  const jevClient = new JevClient();
  const router = new ToolRouter(mockPi, jevClient);

  const candidates = router.shortlist("docker container logs");
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].name, "docker_logs");
});

test("ToolRouter findAndActivate fallback when unconfigured does not activate unjudged tools", async () => {
  const mockTools = [
    { name: "read", description: "Read files" },
    { name: "sqlite_query", description: "Query sqlite database" },
    { name: "postgres_query", description: "Query postgres database" },
  ];

  let activeTools = ["read"];

  const mockPi: any = {
    getAllTools: () => mockTools,
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  };

  // Stub unconfigured client: local runs may have a real API key or secret file.
  const jevClient = { isConfigured: () => false } as unknown as JevClient;
  const router = new ToolRouter(mockPi, jevClient);

  const result = await router.findAndActivate("run SQL query against sqlite");
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.activated, []);
  assert.equal(result.probabilities["sqlite_query"], 0);
  assert.deepEqual(activeTools, ["read"]); // preserves existing without expanding
});

test("ToolRouter never offers its own jev tools as candidates", async () => {
  // Regression: after /jev disable, routing used to re-activate jev_find_skill/jev_evaluate.
  const mockTools = [
    { name: "read", description: "Read files" },
    { name: "jev_find_tools", description: "Find and activate tools" },
    { name: "jev_find_skill", description: "Find matching skills" },
    { name: "jev_evaluate", description: "Typed evaluations" },
    { name: "sqlite_query", description: "Query sqlite" },
  ];
  let activeTools = ["read"];

  const mockPi: any = {
    getAllTools: () => mockTools,
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  };

  const jevClient = { isConfigured: () => false } as unknown as JevClient;
  const router = new ToolRouter(mockPi, jevClient);

  const candidates = router.shortlist("evaluate skills and find tools").map((c) => c.name);
  assert.ok(!candidates.includes("jev_find_tools"));
  assert.ok(!candidates.includes("jev_find_skill"));
  assert.ok(!candidates.includes("jev_evaluate"));

  const result = await router.findAndActivate("evaluate skills and find tools");
  assert.deepEqual(result.activated, []);
});

test("ToolRouter accepts a probability exactly at the shared threshold and rejects below it", async () => {
  const withProbability = (value: number | undefined) => {
    const jevClient = {
      isConfigured: () => value !== undefined,
      evaluate: async () => ({
        answers: value === undefined ? {} : { sqlite_query: { type: "noul", value } },
        model: "m",
        elapsedMs: 1,
      }),
    } as unknown as JevClient;
    const pi: any = {
      getAllTools: () => [{ name: "sqlite_query", description: "Query sqlite", annotations: { readOnlyHint: true } }],
      getActiveTools: () => [],
      setActiveTools: () => {},
    };
    return new ToolRouter(pi, jevClient);
  };

  const atCutoff = await withProbability(JEV_THRESHOLD).findAndActivate("query sqlite");
  assert.deepEqual(atCutoff.activated, ["sqlite_query"]);
  assert.equal(atCutoff.fallbackUsed, false);

  const belowCutoff = await withProbability(JEV_THRESHOLD - 0.01).findAndActivate("query sqlite");
  assert.deepEqual(belowCutoff.activated, []);
});

test("JevClient handles unconfigured state safely without throwing in check", () => {
  const client = new JevClient();
  assert.equal(typeof client.isConfigured(), "boolean");
});

function routerWith(tools: any[], score: number, active: string[] = []) {
  let current = [...active];
  const jevClient = {
    isConfigured: () => true,
    evaluate: async (request: any) => ({
      answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: "noul", value: score }])),
      model: "m",
      elapsedMs: 1,
    }),
  } as unknown as JevClient;
  const pi: any = {
    getAllTools: () => tools,
    getActiveTools: () => current,
    setActiveTools: (names: string[]) => { current = names; },
  };
  return { router: new ToolRouter(pi, jevClient), active: () => current };
}

const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"].map((name) => ({ name, description: name }));

test("a model-supplied threshold below the default cannot activate low-scoring tools", async () => {
  const { router, active } = routerWith(BUILTINS, 0.01, ["read", "grep", "find", "ls"]);
  const result = await router.findAndActivate("run shell bash write edit file", 0);
  assert.deepEqual(result.activated, []);
  assert.deepEqual(active(), ["read", "grep", "find", "ls"]);
});

test("write/exec tools need user confirmation and stay off without a UI", async () => {
  const { router, active } = routerWith(BUILTINS, 0.99, ["read"]);
  const headless = await router.findAndActivate("run shell bash write edit file", JEV_THRESHOLD, undefined, { hasUI: false } as any);
  assert.deepEqual(headless.activated.sort(), ["find", "grep", "ls"], "only read-only built-ins come back");
  assert.deepEqual(headless.declined.sort(), ["bash", "edit", "powershell", "write"]);
  assert.ok(!active().includes("bash"));

  const prompts: string[] = [];
  const refused = await router.findAndActivate("run bash", JEV_THRESHOLD, undefined, {
    hasUI: true,
    ui: { confirm: async (_title: string, message: string) => { prompts.push(message); return false; } },
  } as any);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /bash/);
  assert.deepEqual(refused.activated, []);
  assert.ok(!active().includes("bash"));

  const again = await router.findAndActivate("run bash", JEV_THRESHOLD, undefined, {
    hasUI: true,
    ui: { confirm: async () => { prompts.push("asked again"); return true; } },
  } as any);
  assert.equal(prompts.length, 1, "a refused tool is not asked about again this session");
  assert.ok(again.declined.includes("bash"));

  const fresh = routerWith(BUILTINS, 0.99, ["read"]);
  const approved = await fresh.router.findAndActivate("run bash", JEV_THRESHOLD, undefined, {
    hasUI: true,
    ui: { confirm: async () => true },
  } as any);
  assert.ok(approved.activated.includes("bash"));
  assert.ok(fresh.active().includes("bash"));
});

test("a readOnlyHint paired with destructiveHint or openWorldHint still needs confirmation", async () => {
  const { router } = routerWith([
    { name: "purge_cache", description: "purge cache", annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "fetch_url", description: "fetch cache url", annotations: { readOnlyHint: true, openWorldHint: true } },
  ], 0.99);
  const result = await router.findAndActivate("purge fetch cache url", JEV_THRESHOLD);
  assert.deepEqual(result.activated, []);
  assert.deepEqual(result.declined.sort(), ["fetch_url", "purge_cache"]);
});

test("routing keeps the task in state, not in each question", async () => {
  const requests: any[] = [];
  const jevClient = {
    isConfigured: () => true,
    evaluate: async (request: any) => { requests.push(request); return { answers: {}, model: "m", elapsedMs: 1 }; },
  } as unknown as JevClient;
  const pi: any = { getAllTools: () => BUILTINS, getActiveTools: () => [], setActiveTools: () => {} };
  const prompt = "run the bash tool " + "x".repeat(10_000);
  await new ToolRouter(pi, jevClient).findAndActivate(prompt);
  const [request] = requests;
  for (const q of Object.values<any>(request.questions)) assert.doesNotMatch(q.instructions, /xxxx/);
  assert.ok(request.state.task.length < 4_100, "task text is capped");
});

test("tools annotated readOnlyHint activate without confirmation", async () => {
  const { router } = routerWith([
    { name: "docs_search", description: "search docs", annotations: { readOnlyHint: true } },
    { name: "deploy", description: "deploy docs", annotations: { readOnlyHint: false } },
  ], 0.99);
  const result = await router.findAndActivate("search docs deploy", JEV_THRESHOLD);
  assert.deepEqual(result.activated, ["docs_search"]);
  assert.deepEqual(result.declined, ["deploy"]);
});
