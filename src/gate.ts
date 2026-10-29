import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { JevClient } from "./jev.js";
import { isSecretPath } from "./redact.js";
import { MAX_STATE_CHARS } from "./limits.js";
import type { JevAnswerResult } from "./types.js";

/** git output buffer; well above the state limit so a large diff is measured, not lost. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** git's well-known empty tree, for diffing a repository with no commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The gate could not build the state it was asked to judge. Always exits 2,
 * even with --fail-open: that flag covers an unreachable judge, not a change
 * the judge never saw.
 */
export class GateStateError extends Error {}

export interface GateOptions {
  criteria: string;
  threshold?: number;
  state?: string | Record<string, unknown>;
  diff?: boolean;
  file?: string;
  json?: boolean;
  failOpen?: boolean;
  allowEmpty?: boolean;
  /** Largest state judged; anything bigger exits 2 rather than being truncated. */
  maxChars?: number;
  model?: string;
  help?: boolean;
}

export interface GateResult {
  passed: boolean;
  probability: number;
  confidence?: number;
  criteria: string;
  threshold: number;
  elapsedMs: number;
  answer?: JevAnswerResult;
  error?: string;
}

export function parseGateArgs(args: string[]): GateOptions {
  const options: GateOptions = {
    criteria: "",
    threshold: 0.7,
  };

  const valueFor = (flag: string, i: number): string => {
    const value = args[i];
    if (value === undefined) throw new Error(`Missing value for ${flag}.`);
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--criteria") {
      options.criteria = valueFor(arg, ++i);
    } else if (arg === "-p" || arg === "--min-prob" || arg === "--threshold") {
      const raw = valueFor(arg, ++i);
      const val = raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(val) || val < 0 || val > 1) throw new Error(`Invalid ${arg} "${raw}": expected a number between 0 and 1.`);
      options.threshold = val;
    } else if (arg === "--max-chars") {
      const raw = valueFor(arg, ++i);
      const val = Number(raw);
      if (!Number.isInteger(val) || val <= 0) throw new Error(`Invalid --max-chars "${raw}": expected a positive integer.`);
      options.maxChars = val;
    } else if (arg === "-d" || arg === "--diff") {
      options.diff = true;
    } else if (arg === "-f" || arg === "--file") {
      options.file = valueFor(arg, ++i);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-open") {
      options.failOpen = true;
    } else if (arg === "--allow-empty") {
      options.allowEmpty = true;
    } else if (arg === "-m" || arg === "--model") {
      options.model = valueFor(arg, ++i);
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.criteria) {
      options.criteria = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

export function printHelp(): void {
  console.log(`
Usage: jev-gate [options] [criteria]

Post-run gate check using TypeSafe Jev System One evaluation.
Exits with 0 if evaluation meets threshold, non-zero otherwise.

Options:
  -c, --criteria <text>      Acceptance criteria to check against output/diff
  -p, --threshold <num>      Minimum passing probability (default: 0.7)
  -d, --diff                 Use git diff (HEAD) plus untracked files as evaluation state
  -f, --file <path>          Read state from file
      --json                 Output result in JSON format
      --fail-open            Exit 0 even on API or config error
      --allow-empty          Judge an empty diff/stdin instead of exiting 2
      --max-chars <n>        Largest state to judge (default: 50000); larger exits 2
  -m, --model <model>        Override Jev model (default: jev-latest)
  -h, --help                 Show this help message

Examples:
  subagent gate: "npx pi-jev-gate -c 'Tests pass and no new any types' -d"
  pipeline gate: "git diff | npx pi-jev-gate -c 'All exports documented'"
`);
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER });
}

/**
 * Untracked, non-ignored files rendered as new-file text so the judge sees them.
 * Symlinks and secret-bearing paths are listed without their contents.
 * Returns null as soon as the text would pass `budget`, without reading the rest.
 */
function untrackedFilesText(budget: number): string | null {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const names = git(["ls-files", "--others", "--exclude-standard", "-z", "--full-name", ":/"]).split("\0").filter(Boolean);
  const parts: string[] = [];
  let total = 0;
  for (const name of names) {
    const full = path.join(root, name);
    let body: string;
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) body = `(symlink to ${fs.readlinkSync(full)}, not followed)`;
      else if (!stat.isFile()) body = "(not a regular file)";
      else if (isSecretPath(name)) {
        // Withholding it would let a change hide behind a secret-looking name; sending it could leak a secret.
        throw new GateStateError(`Untracked file ${name} looks secret-bearing, so it was not sent. Ignore it in .gitignore, or rename it, before gating.`);
      }
      else if (total + stat.size > budget) return null;
      else {
        const buf = fs.readFileSync(full);
        body = buf.includes(0) ? "(binary file)" : buf.toString("utf8");
      }
    } catch (e: any) {
      if (e instanceof GateStateError) throw e;
      body = `(unreadable: ${e.message})`;
    }
    const part = `New untracked file: ${name}\n${body}`;
    parts.push(part);
    total += part.length;
    if (total > budget) return null;
  }
  return parts.join("\n\n");
}

function hasHead(): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function oversized(source: string, options: GateOptions): GateStateError {
  // Judging a truncated change would let whatever is past the cut through unseen.
  return new GateStateError(`The ${source} is over ${options.maxChars ?? MAX_STATE_CHARS} characters; nothing was judged. Narrow the input or raise --max-chars.`);
}

function requireContent(text: string, source: string, options: GateOptions): string {
  if (text.length > (options.maxChars ?? MAX_STATE_CHARS)) throw oversized(source, options);
  if (text.trim()) return text;
  if (options.allowEmpty) return `(empty ${source})`;
  throw new GateStateError(`Empty ${source}: nothing to judge. Pass --allow-empty to evaluate it anyway.`);
}

export function resolveGateState(options: GateOptions): string {
  if (options.state) {
    return typeof options.state === "string" ? options.state : JSON.stringify(options.state, null, 2);
  }

  if (options.diff) {
    let text: string;
    let untracked: string | null;
    try {
      // Without a first commit, diff the working tree against the empty tree so
      // a staged-then-edited file is judged as it is on disk.
      const tracked = git(["diff", hasHead() ? "HEAD" : EMPTY_TREE, "--"]);
      const budget = (options.maxChars ?? MAX_STATE_CHARS) - tracked.length;
      untracked = budget >= 0 ? untrackedFilesText(budget) : null;
      text = [tracked, untracked ?? ""].filter((part) => part.trim()).join("\n");
    } catch (e: any) {
      // A failed diff must fail the gate, not be judged as if the error text
      // were the change under review.
      if (e instanceof GateStateError) throw e;
      throw new GateStateError(`Git diff failed: ${e.message}`);
    }
    if (untracked === null) throw oversized("git diff", options);
    return requireContent(text, "git diff", options);
  }

  if (options.file) {
    let text: string;
    try {
      text = fs.readFileSync(options.file, "utf8");
    } catch (e: any) {
      throw new GateStateError(`Failed to read file ${options.file}: ${e.message}`);
    }
    return requireContent(text, `file ${options.file}`, options);
  }

  if (!process.stdin.isTTY) {
    let text: string;
    try {
      text = fs.readFileSync(0, "utf8");
    } catch (e: any) {
      throw new GateStateError(`Failed to read stdin: ${e.message}`);
    }
    return requireContent(text, "stdin", options);
  }

  throw new GateStateError("No state provided. Use --diff, --file <path>, or pipe input on stdin.");
}

export async function evaluateGate(options: GateOptions, jevClient?: JevClient): Promise<GateResult> {
  const client = jevClient ?? new JevClient();
  const threshold = options.threshold ?? 0.7;

  if (!options.criteria.trim()) {
    throw new GateStateError("Missing criteria for gate check. Provide --criteria <text>.");
  }

  if (!client.isConfigured()) {
    if (options.failOpen) {
      return {
        passed: true,
        probability: 1.0,
        criteria: options.criteria,
        threshold,
        elapsedMs: 0,
        error: "Jev unconfigured (fail-open enabled)",
      };
    }
    throw new Error("TypeSafe Jev unconfigured. Set TYPESAFE_API_KEY or PI_JEV_BASE_URL.");
  }

  const stateText = resolveGateState(options);

  const response = await client.evaluate({
    state: stateText,
    model: options.model,
    questions: {
      gate_passed: {
        type: "noul",
        instructions: `Does the provided code/output satisfy this acceptance criteria: "${options.criteria}"?`,
      },
    },
  });

  const answer = response.answers["gate_passed"];
  const probability = typeof answer?.value === "number" ? answer.value : Number(answer?.value ?? 0);
  const passed = probability >= threshold;

  return {
    passed,
    probability,
    confidence: answer?.confidence,
    criteria: options.criteria,
    threshold,
    elapsedMs: response.elapsedMs,
    answer,
  };
}
