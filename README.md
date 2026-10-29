# pi-jev

Semantic tool routing and typed decisions for the [Pi coding agent](https://pi.dev) powered by [TypeSafe](https://typesafe.ai) Jev (System One).

This fork uses the npm package name `@leftytennis/pi-jev`. The upstream project is [TheoOliveira/pi-jev](https://github.com/TheoOliveira/pi-jev); its unscoped npm package is separate.

## Features

- **Semantic Tool Router (`jev_find_tools`)**: Automatically searches registered inactive tools and additively activates only the tools needed for the user's specific prompt or workflow. Read-only tools activate directly; tools that can write, execute, or reach the network need your confirmation.
- **Skill Discovery (`jev_find_skill`)**: Semantically matches and suggests the most relevant specialized agent skills (`SKILL.md`) for any task without cluttering prompt context. Scope-aware matching avoids false positives from coincidental topic overlap.
- **Typed Judgments (`jev_evaluate`)**: Run fast, calibrated System One decisions directly from the agent using Choice, Noul (yes/no probability), and Score primitives.
- **Custom Jev Endpoint**: `PI_JEV_BASE_URL` / `TYPESAFE_BASE_URL` points the TypeSafe client at Jev-compatible local servers or proxies such as Laya `laya-serve`.
- **Dynamic Evaluations (`/jev test <prompt>`)**: The active model designs the Jev question schema for a free-form prompt, then Jev evaluates it.
- **Automatic Mode (opt-in)**: `--jev-auto` / `PI_JEV_AUTO=1` / `/jev auto on` routes tools and suggests skills before every prompt. Off by default.
- **Automatic Model Mode (opt-in)**: `--jev-auto-model` / `PI_JEV_AUTO_MODEL=1` / `/jev auto-model on` selects fast, balanced, reasoning, long-context, vision, or URL-capable models per prompt; image and URL inputs only ever go to models that accept them. When a TypeSafe API key is configured, Jev System One scores each candidate model's fit for the classified need; otherwise a local heuristic ranks candidates. Each route also reads the platforms' quota windows (the `/jev usage` data, cached for five minutes): a provider whose fullest window is at 90% — or whose platform reports the limit reached — is excluded unless no other candidate satisfies a hard requirement such as image input, providers at 70% or more lose score ties, and otherwise-equal candidates break toward the subscription whose fullest window has the most headroom, spreading load across plans before thresholds trip. A model-scoped window, such as Claude's per-model weekly Fable limit, applies those thresholds only to the models it covers: a hit Fable limit sets Fable aside while Opus and Sonnet stay routable on the same subscription. Ties among the candidates admitted by the tier policy keep the current model to avoid churn, then use provider key and numeric generation for deterministic ordering. Provider errors still back a model off until its reported reset. Off by default.
- **Quality Tiers**: routing scores capability and cost as separate axes, so the cheapest structurally identical model no longer wins by default. Pin tiers in `~/.pi/agent/jev-model-tiers.json` (or `PI_JEV_MODEL_TIERS`): `{"tiers": {"openai-codex/gpt-6-astra": 5, "openai-codex/gpt-6-luna": "economy"}}` — integers 1–5 or `budget`/`economy`/`standard`/`premium`/`flagship`. An optional `"exclude": ["provider/model-id", ...]` list removes models from routing entirely, for example ones your plan does not include. Models without an entry inherit their rank in their provider's price ladder. Prices are used only as vendor capability positioning — all supported platforms here are flat-rate subscriptions, so routing never optimizes for dollars, only for capability fit and quota-window headroom. `fast` tasks still prefer cheap models; reasoning, long-context, and vision prefer higher tiers. `/jev catalog` shows each model's tier and whether it was configured or price-inferred.
- **Tier routing policy**: tier 5 is eligible only when the current prompt explicitly requests it, for example `Use a frontier model. Review this code.` Mentions, quoted examples, and negated requests do not opt in. Only the first 4,000 characters of the prompt are checked for this request. This permission is separate from the task profile and does not persist to later prompts. Only the highest numeric version of each provider's model family reaches scoring, whatever tier each version sits in, so `claude-opus-5-5` supersedes `claude-opus-4-7` and `gpt-6.1-sol` supersedes `gpt-5.6-sol`, even if the older model is current. A family is the model id without its version (`claude-opus`, `gpt-sol`, `glm-highspeed`). Versions are not compared across providers or families, so `claude-sonnet-5-5` does not supersede `claude-opus-4-7`. Scope, image compatibility, backoff, the overlay's `exclude` list, and the frontier gate apply first, so an older version stays eligible when the latest is unavailable, excluded, or tier 5 without a frontier request. Equal-version variants and unversioned IDs remain eligible for fit scoring. No eligible candidate produces a visible `no-model` result, never an automatic tier-5 fallback. As with other routing failures, this does not cancel the turn or change Pi's manually selected model. The policy applies only when automatic model routing is enabled; subagent launch contracts remain untouched.
- **Reasoning-Level Mode (opt-in)**: `--jev-thinking` / `PI_JEV_THINKING=1` / `/jev thinking on` sets the reasoning level per prompt (escalates for planning, debugging, and review; de-escalates for short mechanical tasks) without changing the model, so the prompt cache identity stays fixed. Off by default.
- **Tool Call Guard (opt-in)**: `--jev-tool-guard` / `PI_JEV_TOOL_GUARD=1` / `/jev tool-guard on` intercepts tool calls with Jev to detect hallucinations and enhance failed results. This is an anti-hallucination aid, not a security control: it fails open on errors or a 3-second timeout, with no retries. Off by default.
- **Jev Compaction (opt-in)**: `--jev-compact` / `PI_JEV_COMPACT=1` / `/jev compact on` uses Jev to retain important tool history during `/compact`, while Pi's normal compaction remains the safe fallback.
- **Agent Orchestration & Typed Agent**: `/jev agents <task>` dispatches `pi-subagents` orchestration; register `agent: "jev"` in workflows for instant sub-second typed judgments without LLM overhead.
- **Post-Run Gate Check (`jev-gate` CLI)**: Fast binary for subagent `gate` parameters (`npx --package=@leftytennis/pi-jev pi-jev-gate -c "criteria"`). Checks git diff / output and exits 0 on pass or 1 on fail.
- **On-Demand & Safe**: Runs when called. No unsolicited per-turn API token costs. Fails closed safely: if Jev is unreachable or unconfigured, tool routing does not blindly activate unjudged tools and reports zero confidence on keyword fallbacks.
- **Cost Clarity**: Tool routing (`jev_find_tools`, `/jev auto`), skill discovery (`jev_find_skill`), evaluations (`jev_evaluate`), Jev subagents (`agent: "jev"`), and gate checks (`pi-jev-gate`) consume a Jev System One request. `/jev auto-model` spends up to two Jev evaluations per routed prompt when a key is configured — one to classify the need and one to score candidates; SDK retries may add HTTP attempts within the routing timeout — and it falls back to the local heuristic on any Jev failure or without a key (attempts already made may still have been consumed). `/jev thinking` and topology fallback classify locally without spending Jev requests.

## Installation

```bash
pi install npm:@leftytennis/pi-jev
```

Or install directly from GitHub:

```bash
pi install git:github.com/leftytennis/pi-jev
```

## Setup

Set your TypeSafe API key via environment variable:

```bash
export TYPESAFE_API_KEY=ts_...
```

Or store your TypeSafe key in Pi's secret store file:

```bash
install -d -m 700 ~/.pi/agent/secrets
# Paste the key at the prompt; it stays out of shell history and the file is owner-only.
(umask 077; read -rs KEY && printf %s "$KEY" > ~/.pi/agent/secrets/typesafe_api_key)
```

For the default TypeSafe origin, an explicit non-empty runtime key set in-session takes precedence and reports origin as `set in-session`, while empty session values fall back to the environment key. The secrets file is used when neither is set. If the file has any group or other permissions (`mode & 0o077`), `/jev status` warns to run `chmod 600`; the key remains usable.

Then check status inside Pi:

```text
/jev status
```

### Custom Jev Endpoint

For Jev-compatible local servers or proxies, point `pi-jev` at a custom endpoint:

```bash
export PI_JEV_BASE_URL=http://localhost:8000
# TYPESAFE_BASE_URL also works, but PI_JEV_BASE_URL wins.
# Only if the custom server requires authentication:
export PI_JEV_API_KEY=custom-server-key
```

Any origin other than `https://api.typesafe.ai` uses only `PI_JEV_API_KEY`, never `TYPESAFE_API_KEY`, the TypeSafe secrets-file key, or an in-session TypeSafe key. Without `PI_JEV_API_KEY`, the client sends an empty key for unauthenticated local servers such as Laya's `laya-serve`. `/jev status` shows `$PI_JEV_API_KEY` or reports that the custom endpoint has no key. Changing the endpoint rebuilds the client so credentials stay scoped to the selected origin.

A custom endpoint must use `https://`, or `http://` on `localhost`/`127.0.0.1`/`[::1]`; other plain-HTTP hosts are refused. A URL on the default TypeSafe origin still uses the TypeSafe key sources above.

### Data sent to the TypeSafe API

All Jev features send evaluation state to the TypeSafe API you configure with
the key above. Per feature, when enabled:

| Feature | Payload |
|---|---|
| `jev auto` / `jev_find_tools` / `jev_find_skill` | your prompt (≤ 4,000 chars) + tool/skill names and descriptions |
| `jev auto-model` | your prompt (≤ 4,000 chars) + per-model capability metadata (reasoning, context window, input modalities, input cost, serving-tier grade) |
| `jev tool-guard` | every tool call's name and serialized arguments (≤ 4 KB; calls touching `.env`, key, or secret paths are skipped entirely) and failed tools' error output (≤ 4 KB) |
| `jev compact` | the messages being compacted: your messages whole (≤ 50,000 chars in total), plus at most 24 other entries, 2,000 chars each |
| `jev-gate` CLI | `git diff` output plus untracked files, a file, or piped state (≤ 50,000 chars unless `--max-chars` raises it) |

Recognized secret material (PEM blocks, `AKIA…`/`ghp_…`/`sk-…`-style tokens,
JWTs, `Authorization:` headers, `KEY=VALUE` credentials) is replaced with
`<REDACTED>` before anything leaves the machine (`src/redact.ts`). Redaction is
best-effort pattern matching — treat every enabled feature as sending session
derived content to a third party, and keep the flags off when working with
material that must not leave your machine.

## Automatic Mode

Opt in to run one Jev routing pass before each agent turn (automatic mode costs one Jev request per prompt):

```bash
pi --jev-auto            # per-run CLI flag
export PI_JEV_AUTO=1     # persistent via environment
```

Toggle at runtime with `/jev auto on` or `/jev auto off` (no argument flips it). Automatic mode:

- activates inactive tools whose usefulness probability clears `JEV_THRESHOLD` (0.65), asking first for any tool that is not read-only;
- injects matching skill recommendations into the turn;
- skips slash commands, empty prompts, and prompts while Jev is unconfigured or already evaluating;
- never throws — a Jev failure leaves the turn untouched.

`JEV_THRESHOLD` (in `src/skills.ts`) is the one act/reject cutoff: raise it for precision, lower it for recall. Every path — router, tools, `/jev skills`, auto mode — reads that same constant.

### Jev Gate CLI (`pi-jev-gate` / `jev-gate`)

Use `pi-jev-gate` as a post-run gate check for subagents or CI/CD pipelines. Evaluates git diff, file, or stdin against natural language criteria using Jev System One probability.

- Exits `0` if evaluation probability meets threshold ($\ge 0.70$ by default).
- Exits `1` if rejected.
- Exits `2` on error (or `0` with `--fail-open`), including when the runner is killed or fails to start, on unknown options, and on empty or oversized state. State over 50,000 characters is never truncated and judged; raise the limit with `--max-chars`. `--diff` covers tracked changes and untracked files (symlinks are listed without being followed; an untracked secret-named file such as `.env` exits `2` without being sent); pass `--allow-empty` to judge an empty diff or stdin instead of exiting `2`. `--fail-open` only covers an unreachable or unconfigured judge: missing criteria and state errors still exit `2`.

#### Subagent `gate` Example
Set a child subagent's `gate` parameter to run `pi-jev-gate` immediately upon completion:

```json
{
  "agent": "worker",
  "task": "Refactor auth middleware to use jose",
  "gate": "npx --package=@leftytennis/pi-jev pi-jev-gate -c 'Middleware strictly refactored without breaking exports and no new any types' -d -p 0.8"
}
```

#### Pipeline / CLI Examples
```bash
# Check git diff against acceptance criteria
npx --package=@leftytennis/pi-jev pi-jev-gate -c "All exported functions have TypeScript type annotations" --diff

# Check piped test/linter output
npm test 2>&1 | npx --package=@leftytennis/pi-jev pi-jev-gate -c "Zero test failures and no unhandled promise rejections"

# JSON output with custom threshold
npx --package=@leftytennis/pi-jev pi-jev-gate -c "Documentation updated" -f ./README.md -p 0.85 --json
```

### Typed Jev Subagent (`agent: "jev"`)

Register fast System One evaluations directly in `pi-subagents` workflows without spawning heavy LLM processes.

#### Workflow Example
```javascript
export const meta = { name: "triage_workflow", description: "Classify and route tasks" };

// 1. Instant typed classification with Jev
const triage = await agent("Classify incoming issue", {
  agent: "jev",
  type: "choice",
  criteria: {
    bug: "Bug or regression in existing behavior",
    feature: "New capability request",
    docs: "Documentation or comment update"
  },
  state: args.issueBody
});

// 2. Route dynamically based on System One verdict
if (triage.primaryValue === "bug") {
  await agent("Fix reported bug and add test", { agent: "worker", task: args.issueBody });
}
```

### Agent Orchestration

`/jev agents <task>` uses Jev System One to analyze task requirements and construct specialized multi-agent workflow scripts executed via `pi-subagents`:
- **Implementation tasks**: Staged `scout` (code context) $\rightarrow$ `worker` (changes) $\rightarrow$ `reviewer` (standards & tests).
- **Research tasks**: Parallel `scout` + `researcher` $\rightarrow$ `worker` synthesis.
- **Review / Security tasks**: Parallel `reviewer` + `evidence-auditor`.
- **General tasks**: `worker` $\rightarrow$ `reviewer`.

Execution is asynchronous; completion is reported back into the session. Automatic dispatch is opt-in via `--jev-agents` / `PI_JEV_AGENTS=1` or `/jev auto-agents on`. Keyword matching ignores Pi-expanded `<skill name="…" location="…">` blocks and checks only your typed text, including arguments after a skill invocation. Each automatic workflow requires your confirmation before classification or dispatch; declining or running without a UI skips it. Agents may edit files, and the main turn still runs. Explicit `/jev agents <task>` dispatches without that additional confirmation.

### Jev Compaction

`/jev compact on` enables Jev-guided compaction. It works on exactly the messages Pi is about to compact: every message you typed is kept verbatim, and Jev decides which assistant, tool, and `!command` entries to retain, so important paths, errors, and results stay in the custom summary. The previous compaction summary is carried forward. The feature preserves Pi's `firstKeptEntryId` boundary and falls back to Pi's built-in summary when Jev is unconfigured, fails, leaves any entry unjudged, or the window holds more than 24 other entries or over 50,000 characters of your messages. `<summary>` tags in retained text are neutralized so it cannot escape Pi's wrapper. Retained `!command` output is labeled `[Command output]:` and custom messages `[Custom message]:`, not `[User]:`; typed user messages keep their user label.

### Automatic Model Mode

Auto-model uses task signals, attached images, and context size to classify the need, then chooses the best available model. With a configured TypeSafe key, each candidate is scored by one batched Jev System One evaluation — a Score judgment per model against the classified need and its capability metadata (reasoning flag, context window, modalities, input cost), capped at 24 candidates with a 10s timeout; larger pools are prefiltered with the deterministic score, and any Jev failure or malformed answer falls back to it. Image requests never route to text-only models. It respects `ctx.scopedModels`, skips low-confidence general prompts, and preserves the current model when no compatible option exists. Even on a low-confidence prompt it moves off a current model that is backed off, excluded by the tier file, superseded by a newer version in its family, or tier 5 without a frontier request. Models that hit usage limits are temporarily avoided until the quota window restarts: the provider's reported reset (Retry-After or ratelimit reset headers) is honoured when present, otherwise a full window is assumed — 5 hours for the openai-codex, claude-bridge, anthropic and openai providers, 1 hour for others, configurable with `PI_JEV_QUOTA_WINDOW` and `PI_JEV_QUOTA_WINDOW_<PROVIDER>` (e.g. `PI_JEV_QUOTA_WINDOW_OPENAI_CODEX=2h`). Timeout, context-limit, and unavailable errors use a short 60-second backoff instead. A model the subscription plan does not include (for example Z.ai's "plan does not yet include access" 429) is backed off for 7 days, the cap on any backoff; backoffs live in memory, so in practice that is the rest of the session. Providers whose SDK throws on an error status never reach Pi's `after_provider_response` hook, so the failed turn is also read at `agent_end`: the model named on the failed message is backed off and, with auto-model on, the session switches models before Pi's automatic retry, so the retry runs on the new model. Fallback is bounded and never loops. Provider failures do not silently truncate user context.

### Reasoning-Level Mode

`/jev thinking on` (or `--jev-thinking` / `PI_JEV_THINKING=1`) provides per-prompt reasoning effort control without changing the active model:

- Dynamically escalates reasoning level (`high` / `xhigh`) for planning, debugging, security, and architectural review tasks.
- De-escalates to `minimal` for short mechanical edits and quick queries.
- Because the model does not change, prompt cache identity remains intact.
- Preserves native Pi behavior by skipping budget-based Anthropic models where `budget_tokens` alters cache identity.

## Commands

- `/jev status` — Shows Jev configuration, endpoint, API key origin and permission warnings, the tool guard's fail-open limits, auto-mode state, session request count, total tokens, and available tool counts.
- `/jev catalog` — Lists the models the tier policy lets auto-model route to, grouped by quality tier from 5 (flagship, frontier requests only) down to 1 (budget), with provider, type, context window, input modalities, price, and session usage in aligned columns. Models routing will not use follow: suppressed versions, one line per newer replacement, then models excluded by the tier file. The header totals each status and names each authenticated provider. The catalog shows the tier policy only: per-prompt filters (scoped models, current backoffs, image or URL requirements) can narrow a given route further. Also `/jev models`.
- `/jev usage` — Reads each authenticated platform's own quota windows and shows how much of each is used: Claude (5-hour, weekly, per-model weekly), OpenAI Codex (whatever windows the account reports, typically 5-hour and weekly), Z.ai (5-hour and weekly credits), Kimi Code (5-hour and monthly). Also `/jev quota`. Windows at 90% or more are flagged and the notice becomes a warning. Endpoints and credential sources are documented in `docs/provider-usage-endpoints.md`.
- `/jev help` — Lists available subcommands.
- `/jev skills [query]` — Discover and rank matching skills in the workspace using Jev.
- `/jev test [prompt]` — With no prompt, runs the fixed connectivity smoke test. With a prompt, the active model designs the Jev questions for that prompt and Jev evaluates them. Also accepts `/jev eval` and `/jev evaluate`.
- `/jev enable` — Enables Jev tools in the active session.
- `/jev disable` — Disables Jev tools for the active session.
- `/jev auto [on|off]` — Turns automatic per-prompt tool/skill routing on or off (no argument flips it).
- `/jev auto-model [on|off]` — Turns automatic model selection on or off (no argument flips it).
- `/jev thinking [on|off]` — Turns per-prompt reasoning-level control on or off (no argument flips it). The model is never changed, so the prompt cache stays valid. Budget-based Anthropic thinking is skipped because Pi derives `budget_tokens` from the level there.
- `/jev tool-guard [on|off]` — Turns tool call anti-hallucination validation and error guidance on or off.
- `/jev compact [on|off]` — Turns Jev-guided compaction on or off. Run `/compact` after enabling.
- `/jev agents <task>` — Dispatches the task to `pi-subagents`, which selects and coordinates available agents.
- `/jev auto-agents [on|off]` — Enables automatic orchestration for complex architecture, refactoring, security, repository-wide, and migration prompts.

## Tools Provided

### 1. `jev_find_tools`
Used by the model to find capabilities that aren't currently loaded into the prompt prefix.

Read-only tools (`read`, `grep`, `find`, `ls`, and tools annotated `readOnlyHint`) activate directly. Anything else — `bash`, `edit`, `write`, MCP tools without a read-only hint or that also declare `destructiveHint` or `openWorldHint` — needs your confirmation, and stays off in sessions without a UI. A tool you decline is not offered again in that session. A model-supplied `threshold` can raise the cutoff but never lower it below `JEV_THRESHOLD`. `/jev auto` follows the same rules. Tools removed with `--tools` or `--exclude-tools` are never reachable.

```json
{
  "query": "inspect SQLite database schemas and run queries"
}
```

### 2. `jev_find_skill`
Used by the agent to find relevant specialized workflows and instructions for complex tasks.

```json
{
  "query": "build accessible modal component in React"
}
```

### 3. `jev_evaluate`
Used for structured decisions, classifications, triage, and scoring.

```json
{
  "state": { "diff": "..." },
  "questions": {
    "is_breaking": {
      "type": "noul",
      "instructions": "Does this change introduce any breaking API changes?"
    }
  }
}
```

## Development & Testing

```bash
npm install
npm run typecheck
npm test
```

## License

MIT © Theophilo Damiao
