# pi-jev

Semantic tool routing and typed decisions for the [Pi coding agent](https://pi.dev) powered by [TypeSafe](https://typesafe.ai) Jev (System One).

## Features

- **Semantic Tool Router (`jev_find_tools`)**: Automatically searches registered inactive tools and additively activates only the tools needed for the user's specific prompt or workflow.
- **Skill Discovery (`jev_find_skill`)**: Semantically matches and suggests the most relevant specialized agent skills (`SKILL.md`) for any task without cluttering prompt context.
- **Typed Judgments (`jev_evaluate`)**: Run fast, calibrated System One decisions directly from the agent using Choice, Noul (yes/no probability), and Score primitives.
- **Custom Jev Endpoint**: `PI_JEV_BASE_URL` / `TYPESAFE_BASE_URL` points the TypeSafe client at Jev-compatible local servers or proxies such as Laya `laya-serve`.
- **Dynamic Evaluations (`/jev test <prompt>`)**: The active model designs the Jev question schema for a free-form prompt, then Jev evaluates it.
- **Automatic Mode (opt-in)**: `--jev-auto` / `PI_JEV_AUTO=1` / `/jev auto on` routes tools and suggests skills before every prompt. Off by default.
- **Automatic Model Mode (opt-in)**: `--jev-auto-model` / `PI_JEV_AUTO_MODEL=1` / `/jev auto-model on` selects fast, balanced, reasoning, long-context, vision, or URL-capable models per prompt; image and URL inputs only ever go to models that accept them. When a TypeSafe API key is configured, Jev System One scores each candidate model's fit for the classified need; otherwise a local heuristic ranks candidates. Each route also reads the platforms' quota windows (the `/jev usage` data, cached for five minutes): a provider whose fullest window is at 90% — or whose platform reports the limit reached — is excluded unless no other candidate satisfies a hard requirement such as image input, providers at 70% or more lose score ties, and otherwise-equal candidates break toward the subscription whose fullest window has the most headroom, spreading load across plans before thresholds trip. A model-scoped window, such as Claude's per-model weekly Fable limit, applies those thresholds only to the models it covers: a hit Fable limit sets Fable aside while Opus and Sonnet stay routable on the same subscription. Ties among the candidates admitted by the tier policy keep the current model to avoid churn, then use provider key and numeric generation for deterministic ordering. Provider errors still back a model off until its reported reset. Off by default.
- **Quality Tiers**: routing scores capability and cost as separate axes, so the cheapest structurally identical model no longer wins by default. Pin tiers in `~/.pi/agent/jev-model-tiers.json` (or `PI_JEV_MODEL_TIERS`): `{"tiers": {"openai-codex/gpt-6-astra": 5, "openai-codex/gpt-6-luna": "economy"}}` — integers 1–5 or `budget`/`economy`/`standard`/`premium`/`flagship`. Models without an entry inherit their rank in their provider's price ladder. Prices are used only as vendor capability positioning — all supported platforms here are flat-rate subscriptions, so routing never optimizes for dollars, only for capability fit and quota-window headroom. `fast` tasks still prefer cheap models; reasoning, long-context, and vision prefer higher tiers. `/jev catalog` shows each model's tier and whether it was configured or price-inferred.
- **Tier routing policy**: tier 5 is eligible only when the current prompt explicitly requests it, for example `Use a frontier model. Review this code.` Mentions, quoted examples, and negated requests do not opt in. This permission is separate from the task profile and does not persist to later prompts. Within each tier, only the highest numeric version of each provider's model family reaches scoring, so at tier 4 `claude-opus-5-5` supersedes `claude-opus-5` and `gpt-6.1-sol` supersedes `gpt-6-sol`, at tier 3 `claude-sonnet-5-5` supersedes `claude-sonnet-5`, and at tier 1 `gpt-6-luna` supersedes `gpt-5.6-luna`, even if the older model is current. A family is the model id without its version (`claude-opus`, `gpt-sol`, `glm-highspeed`). Versions are not compared across tiers, providers, or families, so `claude-sonnet-5-5` does not supersede `claude-opus-4-7` in the same tier. Scope, image compatibility, and backoff apply first, allowing an older compatible version when the latest is unavailable. Equal-version variants and unversioned IDs remain eligible for fit scoring. No eligible candidate produces a visible `no-model` result, never an automatic tier-5 fallback. As with other routing failures, this does not cancel the turn or change Pi's manually selected model. The policy applies only when automatic model routing is enabled; subagent launch contracts remain untouched.
- **Tool Call Guard (opt-in)**: `--jev-tool-guard` / `PI_JEV_TOOL_GUARD=1` / `/jev tool-guard on` intercepts tool calls with Jev to detect hallucinations and enhance failed results. Off by default.
- **Jev Compaction (opt-in)**: `--jev-compact` / `PI_JEV_COMPACT=1` / `/jev compact on` uses Jev to retain important tool history during `/compact`, while Pi's normal compaction remains the safe fallback.
- **Agent Orchestration & Typed Agent**: `/jev agents <task>` dispatches `pi-subagents` orchestration; register `agent: "jev"` in workflows for instant sub-second typed judgments without LLM overhead.
- **Post-Run Gate Check (`jev-gate` CLI)**: Fast binary for subagent `gate` parameters (`npx pi-jev-gate -c "criteria"`). Checks git diff / output and exits 0 on pass or 1 on fail.
- **On-Demand & Safe**: Runs when called. No unsolicited per-turn API token costs. Fails closed safely: if Jev is unreachable or unconfigured, tool routing does not blindly activate unjudged tools and reports zero confidence on keyword fallbacks.
- **Cost Clarity**: Tool routing (`jev_find_tools`, `/jev auto`), skill discovery (`jev_find_skill`), evaluations (`jev_evaluate`), Jev subagents (`agent: "jev"`), and gate checks (`pi-jev-gate`) consume a Jev System One request. `/jev auto-model` spends up to two Jev evaluations per routed prompt when a key is configured — one to classify the need and one to score candidates; SDK retries may add HTTP attempts within the routing timeout — and it falls back to the local heuristic on any Jev failure or without a key (attempts already made may still have been consumed).

## Installation

```bash
pi install npm:pi-jev
```

Or install directly from GitHub:

```bash
pi install git:github.com/TheoOliveira/pi-jev
```

## Setup

Set your TypeSafe API key via environment variable:

```bash
export TYPESAFE_API_KEY=ts_...
```

For Jev-compatible local servers or proxies, point `pi-jev` at a custom endpoint:

```bash
export PI_JEV_BASE_URL=http://localhost:8000
# TYPESAFE_BASE_URL also works, but PI_JEV_BASE_URL wins.
```

Custom endpoints may omit `TYPESAFE_API_KEY`; `pi-jev` sends an empty key in that case for unauthenticated local servers such as Laya's `laya-serve`.

Or store your TypeSafe key in Pi's secret store file:

```bash
mkdir -p ~/.pi/agent/secrets
echo "ts_..." > ~/.pi/agent/secrets/typesafe_api_key
```

Then check status inside Pi:

```text
/jev status
```

## Automatic Mode

Opt in to run one Jev routing pass before each agent turn (automatic mode costs one Jev request per prompt):

```bash
pi --jev-auto            # per-run CLI flag
export PI_JEV_AUTO=1     # persistent via environment
```

Toggle at runtime with `/jev auto on` or `/jev auto off` (no argument flips it). Automatic mode:

- activates inactive tools whose usefulness probability clears `JEV_THRESHOLD` (0.65);
- injects matching skill recommendations into the turn;
- skips slash commands, empty prompts, and prompts while Jev is unconfigured or already evaluating;
- never throws — a Jev failure leaves the turn untouched.

`JEV_THRESHOLD` (in `src/skills.ts`) is the one act/reject cutoff: raise it for precision, lower it for recall. Every path — router, tools, `/jev skills`, auto mode — reads that same constant.

### Jev Gate CLI (`pi-jev-gate` / `jev-gate`)

Use `pi-jev-gate` as a post-run gate check for subagents or CI/CD pipelines. Evaluates git diff, file, or stdin against natural language criteria using Jev System One probability.

- Exits `0` if evaluation probability meets threshold ($\ge 0.70$ by default).
- Exits `1` if rejected.
- Exits `2` on error (or `0` with `--fail-open`).

#### Subagent `gate` Example
Set a child subagent's `gate` parameter to run `pi-jev-gate` immediately upon completion:

```json
{
  "agent": "worker",
  "task": "Refactor auth middleware to use jose",
  "gate": "npx pi-jev-gate -c 'Middleware strictly refactored without breaking exports and no new any types' -d -p 0.8"
}
```

#### Pipeline / CLI Examples
```bash
# Check git diff against acceptance criteria
npx pi-jev-gate -c "All exported functions have TypeScript type annotations" --diff

# Check piped test/linter output
npm test 2>&1 | npx pi-jev-gate -c "Zero test failures and no unhandled promise rejections"

# JSON output with custom threshold
npx pi-jev-gate -c "Documentation updated" -f ./README.md -p 0.85 --json
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

Execution is asynchronous; completion is reported back into the session. Automatic dispatch is opt-in via `--jev-agents` / `PI_JEV_AGENTS=1` or `/jev auto-agents on`.

### Jev Compaction

`/jev compact on` enables Jev-guided compaction. Tool-history entries are evaluated for retention; important paths, errors, constraints, and results stay in the custom summary. User and assistant intent is not rewritten. The feature preserves Pi's `firstKeptEntryId` boundary and falls back to Pi's built-in summary when Jev is unconfigured, fails, or returns unusable data. It does not silently truncate context.

### Automatic Model Mode

Auto-model uses task signals, attached images, and context size to classify the need, then chooses the best available model. With a configured TypeSafe key, each candidate is scored by one batched Jev System One evaluation — a Score judgment per model against the classified need and its capability metadata (reasoning flag, context window, modalities, input cost), capped at 24 candidates with a 10s timeout; larger pools are prefiltered with the deterministic score, and any Jev failure or malformed answer falls back to it. Image requests never route to text-only models. It respects `ctx.scopedModels`, skips low-confidence general prompts, and preserves the current model when no compatible option exists. Models that hit usage limits are temporarily avoided until the quota window restarts: the provider's reported reset (Retry-After or ratelimit reset headers) is honoured when present, otherwise a full window is assumed — 5 hours for the openai-codex, claude-bridge, anthropic and openai providers, 1 hour for others, configurable with `PI_JEV_QUOTA_WINDOW` and `PI_JEV_QUOTA_WINDOW_<PROVIDER>` (e.g. `PI_JEV_QUOTA_WINDOW_OPENAI_CODEX=2h`). Timeout, context-limit, and unavailable errors use a short 60-second backoff instead, capped at 7 days; fallback is bounded and never loops. Provider failures do not silently truncate user context.

## Commands

- `/jev status` — Shows Jev configuration, endpoint, API key origin, auto-mode state, session request count, total tokens, and available tool counts.
- `/jev catalog` — Lists the authenticated providers and models available in this session, each with a capability tier (fast / balanced / reasoning, from registry metadata only), context window, modalities, list pricing, quality tier (configured or price-inferred), and this session's attributable cost per model. Also `/jev models`.
- `/jev usage` — Reads each authenticated platform's own quota windows and shows how much of each is used: Claude (5-hour, weekly, per-model weekly), OpenAI Codex (whatever windows the account reports, typically 5-hour and weekly), Z.ai (5-hour and weekly credits), Kimi Code (5-hour and monthly). Also `/jev quota`. Windows at 90% or more are flagged and the notice becomes a warning. Endpoints and credential sources are documented in `docs/provider-usage-endpoints.md`.
- `/jev help` — Lists available subcommands.
- `/jev skills [query]` — Discover and rank matching skills in the workspace using Jev.
- `/jev test [prompt]` — With no prompt, runs the fixed connectivity smoke test. With a prompt, the active model designs the Jev questions for that prompt and Jev evaluates them. Also accepts `/jev eval` and `/jev evaluate`.
- `/jev enable` — Enables Jev tools in the active session.
- `/jev disable` — Disables Jev tools for the active session.
- `/jev auto [on|off]` — Turns automatic per-prompt tool/skill routing on or off (no argument flips it).
- `/jev auto-model [on|off]` — Turns automatic model selection on or off (no argument flips it).
- `/jev tool-guard [on|off]` — Turns tool call anti-hallucination validation and error guidance on or off.
- `/jev compact [on|off]` — Turns Jev-guided compaction on or off. Run `/compact` after enabling.
- `/jev agents <task>` — Dispatches the task to `pi-subagents`, which selects and coordinates available agents.
- `/jev auto-agents [on|off]` — Enables automatic orchestration for complex architecture, refactoring, security, repository-wide, and migration prompts.

## Tools Provided

### 1. `jev_find_tools`
Used by the model to find capabilities that aren't currently loaded into the prompt prefix.

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
