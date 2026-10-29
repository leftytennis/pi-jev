import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JevClient } from "./jev.js";
import { JEV_TOOL_NAMES, isJevTool } from "./types.js";
import { JEV_THRESHOLD } from "./skills.js";
import { MAX_TASK_CHARS } from "./limits.js";

export interface ToolMetadata {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

export interface RouterResult {
  query: string;
  candidates: string[];
  activated: string[];
  /** Passed Jev's threshold but were not activated (needs confirmation, refused or no UI). */
  declined: string[];
  probabilities: Record<string, number>;
  fallbackUsed: boolean;
  elapsedMs: number;
}

/** Pi built-ins that only read; they carry no annotations, so name them here. */
const READ_ONLY_BUILTINS = new Set(["read", "grep", "find", "ls"]);

/** The tool-usefulness question; the task itself travels once, in state.task. */
export function toolApplicabilityQuestion(name: string, description?: string): { type: "noul"; instructions: string } {
  return {
    type: "noul",
    instructions: `Does the tool '${name}' (${description || "no description"}) directly help accomplish \`task\`?`,
  };
}

/** Bound the task text sent for routing; the shortlist still sees the whole prompt. */
export function routingTask(text: string): string {
  return text.length > MAX_TASK_CHARS ? `${text.slice(0, MAX_TASK_CHARS)}\n[truncated]` : text;
}

/** Clamp a caller-supplied threshold so the model cannot lower the bar below the default. */
export function clampThreshold(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : JEV_THRESHOLD;
  return Math.min(1, Math.max(JEV_THRESHOLD, n));
}

export class ToolRouter {
  private pi: ExtensionAPI;
  private jevClient: JevClient;
  private managedTools = new Set<string>();
  /** Tools the user refused this session; not asked about again. */
  private refused = new Set<string>();

  constructor(pi: ExtensionAPI, jevClient: JevClient) {
    this.pi = pi;
    this.jevClient = jevClient;
  }

  public getAvailableTools(): ToolMetadata[] {
    const all = this.pi.getAllTools();
    return all.map((t: any) => ({
      name: t.name,
      description: t.description,
      promptSnippet: t.promptSnippet,
      promptGuidelines: t.promptGuidelines,
    }));
  }

  public shortlist(query: string, limit = 8): ToolMetadata[] {
    const active = new Set(this.pi.getActiveTools());
    const all = this.getAvailableTools();

    const inactive = all.filter((t) => !active.has(t.name) && !isJevTool(t.name));
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

    if (terms.length === 0) {
      return inactive.slice(0, limit);
    }

    const scored = inactive.map((tool) => {
      const text = `${tool.name} ${tool.description || ""} ${tool.promptSnippet || ""}`.toLowerCase();
      let matchCount = 0;
      for (const term of terms) {
        if (text.includes(term)) matchCount += 1;
      }
      return { tool, score: matchCount };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.tool);
  }

  /**
   * True when a tool only reads local state: a known read-only built-in, or
   * annotated readOnlyHint without destructiveHint or openWorldHint. Hints are
   * unverified, so a tool claiming any risky hint needs confirmation.
   */
  public isReadOnly(name: string): boolean {
    if (READ_ONLY_BUILTINS.has(name)) return true;
    const hints = this.pi.getAllTools().find((t) => t.name === name)?.annotations;
    return hints?.readOnlyHint === true && hints.destructiveHint !== true && hints.openWorldHint !== true;
  }

  /**
   * Add tools to the active set. Jev routing runs on text the model and its
   * inputs control, so anything that can write, execute, or reach the network
   * needs the user's confirmation; without a UI to ask, it stays off.
   * Returns the tools actually activated.
   */
  public async activateTools(tools: string[], ctx?: ExtensionContext, signal?: AbortSignal): Promise<string[]> {
    const approved: string[] = [];
    const needsConfirm: string[] = [];
    for (const name of new Set(tools)) {
      if (this.isReadOnly(name)) approved.push(name);
      else if (!this.refused.has(name)) needsConfirm.push(name);
    }
    if (needsConfirm.length > 0 && ctx?.hasUI) {
      const ok = await ctx.ui.confirm(
        "Activate tools?",
        `Jev tool routing wants to enable: ${needsConfirm.join(", ")}. These tools can change files, run commands, or reach the network.`,
        { signal }
      );
      if (ok) approved.push(...needsConfirm);
      else for (const name of needsConfirm) this.refused.add(name);
    }
    if (approved.length === 0) return [];
    const currentActive = this.pi.getActiveTools();
    this.pi.setActiveTools(Array.from(new Set([...currentActive, ...approved])));
    return approved;
  }

  public async findAndActivate(
    query: string,
    threshold = JEV_THRESHOLD,
    signal?: AbortSignal,
    ctx?: ExtensionContext
  ): Promise<RouterResult> {
    threshold = clampThreshold(threshold);
    const startTime = Date.now();
    const candidates = this.shortlist(query, 10);
    const candidateNames = candidates.map((c) => c.name);

    if (candidates.length === 0) {
      return {
        query,
        candidates: [],
        activated: [],
        declined: [],
        probabilities: {},
        fallbackUsed: false,
        elapsedMs: Date.now() - startTime,
      };
    }

    const probabilities: Record<string, number> = {};
    const passed: string[] = [];
    let fallbackUsed = false;

    if (this.jevClient.isConfigured()) {
      try {
        const questions: Record<string, any> = {};
        for (const c of candidates) {
          questions[c.name] = toolApplicabilityQuestion(c.name, c.description);
        }

        const res = await this.jevClient.evaluate(
          {
            state: { task: routingTask(query), tools: candidates },
            questions,
          },
          signal
        );

        for (const [toolName, ans] of Object.entries(res.answers)) {
          const prob = typeof ans.value === "number" ? ans.value : 0;
          probabilities[toolName] = prob;
          if (prob >= threshold && candidateNames.includes(toolName)) {
            passed.push(toolName);
          }
        }
      } catch (err) {
        fallbackUsed = true;
      }
    } else {
      fallbackUsed = true;
    }

    if (fallbackUsed) {
      // Fallback does not activate tools or claim certainty without Jev judgment
      for (const c of candidates) {
        probabilities[c.name] = 0;
      }
    }

    const activated = await this.activateTools(passed, ctx, signal);
    const declined = passed.filter((name) => !activated.includes(name));

    return {
      query,
      candidates: candidateNames,
      activated,
      declined,
      probabilities,
      fallbackUsed,
      elapsedMs: Date.now() - startTime,
    };
  }
}
