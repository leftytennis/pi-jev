import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerJevTools } from "../src/tools.js";
import { JevClient } from "../src/jev.js";
import { ToolRouter } from "../src/router.js";
import { SkillRouter } from "../src/skills.js";

test("jev_find_skill renders full command names and legacy bare names with one prefix", async () => {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
    getCommands: () => [
      { name: "skill:testing", source: "skill", description: "testing code" },
      { name: "bare", source: "skill", description: "testing legacy skills" },
    ],
  } as unknown as ExtensionAPI;
  const client = new JevClient();
  client.isConfigured = () => false;
  registerJevTools(pi, client, new ToolRouter(pi, client), new SkillRouter(pi, client));
  const tool = tools.get("jev_find_skill");
  assert.ok(tool);
  const result = await tool.execute("call-1", { query: "testing" }, undefined, undefined, {} as ExtensionToolContext);
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /\/skill:testing \(P=0.00\)/);
  assert.match(text, /\/skill:bare \(P=0.00\)/);
  assert.doesNotMatch(text, /\/skill:skill:/);
});
