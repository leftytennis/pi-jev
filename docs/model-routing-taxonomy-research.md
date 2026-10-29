# Model-routing prompt taxonomies: what the industry classifies on

**Status:** research findings, sourced 2026-09-25 (UTC) from provider documentation, open-source agent code, and peer-reviewed routing literature.
**Purpose:** evaluate whether `AutoModelRouter`'s five profiles — `fast`, `balanced`, `reasoning`, `long-context`, `vision` — match industry practice, and what changes are worth considering. Nothing here is committed to the implementation.

## Summary matrix

| System | Routing basis | Categories exposed | Source |
| --- | --- | --- | --- |
| OpenRouter Auto Router | ~30 fine-grained task types + market spend-share ranking + cost-tier bands + capability/modality filters | `code:debugging`, `agent:multi_step_planning`, `qa_knowledge`, `math`, `customer_support`, `research_report`, … | [Auto Router docs](https://openrouter.ai/docs/guides/routing/routers/auto-router) |
| Gemini CLI (google-gemini) | Complexity classification, small local classifier | binary `SIMPLE` (Flash) / `COMPLEX` (Pro) with rubric; alt. numerical 1–100 complexity score | [classifierStrategy.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/routing/strategies/classifierStrategy.ts), [numericalClassifierStrategy.ts](https://github.com/google-gemini/gemini-cli/blob/f8541cf7/packages/core/src/routing/strategies/numericalClassifierStrategy.ts) |
| Azure Foundry Model Router | Trained ML: prompt intent + difficulty → per-model performance prediction | none user-facing; routing *modes* Balanced/Cost/Quality as policy axis | [model-router-how-it-works](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-router-how-it-works) |
| Amazon Bedrock Intelligent Prompt Routing | Per-request response-quality prediction within a model family | none | [prompt-routing docs](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html) |
| RouteLLM (LMSYS, ICLR 2025) | Learned router from human preference data | binary stronger/weaker, tunable threshold | [arXiv 2406.18665](https://arxiv.org/abs/2406.18665) |
| FrugalGPT (Stanford) | Cascade: cheap first, escalate on quality failure | none (ordering, not classification) | [arXiv 2305.05176](https://arxiv.org/abs/2305.05176) |
| Martian | Trained ML predicting per-prompt, per-model performance | none | [patent](https://patents.us/US12314825), [solutions page](https://www.withmartian.com/solutions/routing-for-ai-agents) |
| NotDiamond | Multi-signal classifier (complexity, capability, cost, latency); custom routers cluster queries on eval data | per-customer clusters | [key concepts](https://docs.notdiamond.ai/docs/key-concepts) |
| **pi-jev AutoModelRouter** | Jev Choice over 5 profiles → Jev fit-scoring per candidate → tier + deterministic cost/grade preference | `fast`, `balanced`, `reasoning`, `long-context`, `vision` | `src/model-router.ts` |

## What the sources establish

**No canonical category list exists.** Production routers cluster into three patterns:

1. **Capability/modality gates as filters, not classifications.** OpenRouter's router honors "output-modality requirements" and tool support as filters before ranking; its `openrouter/free` router "smartly filters for features needed by your request such as image understanding, tool calling, structured outputs". pi-jev's image hard-gate and 120k-context override are exactly this pattern.
2. **A single difficulty/intensity axis as the classification target.** Gemini CLI is binary (with a 1–100 numerical variant); RouteLLM is binary strong/weak with a tunable threshold; Azure estimates "what the prompt is asking for and how challenging it is" with no user-facing categories at all. pi-jev's `fast/balanced/reasoning` is a three-point version of this axis, with `balanced` doubling as the below-threshold abstain ("no dominant need" at 0.55 < 0.60 threshold keeps the current model — the same abstention idea as RouteLLM's tunable threshold).
3. **Learned per-query performance prediction with no human taxonomy.** Martian, Azure, Bedrock, NotDiamond-custom. The most fine-grained human taxonomy found is OpenRouter's ~30 task types, and even there the categories feed a market-spend *ranking*, not a rule — and the router "degrades gracefully to a default model set" when classification is unavailable, mirroring pi-jev's fallback-to-current behavior.

**Session stickiness is an industry-standard complement.** OpenRouter: "it remembers the model a conversation landed on and prefers it on later turns… while that model is still one of the top candidates". Azure's session affinity: "on a later request with the same ID, it attempts the associated model first when it remains eligible", explicitly for "behavioral continuity and the opportunity for prompt-cache reuse", with 30-minute expiry. pi-jev currently reroutes every prompt with no current-model bias.

**A policy/cost-aggressiveness knob is common and orthogonal to classification.** Azure exposes Balanced/Cost/Quality modes; OpenRouter exposes cost tiers `low`…`max` ("a tier is a band, not a ceiling"). pi-jev's equivalent (routing-confidence threshold, grade preference within tier) exists but is not user-exposed.

**Task-type granularity beyond difficulty is mostly a provider-scale phenomenon.** OpenRouter's ~30 types (coding, agentic planning, math, customer support, research) are workable because their ranking signal is aggregate spend per type across millions of users. An individual agent has no such signal. Gemini CLI — the closest analog to pi (an interactive coding agent) — deliberately chose a two-way complexity split with a tiny local classifier, not task types.

## Assessment of pi-jev's five profiles

The set is sound and well-aligned: one three-point intensity axis (`fast`/`balanced`/`reasoning`) plus two capability dimensions (`vision`, `long-context`) that the implementation already treats partly as gates (image input hard-gates the pool; >120k context chars force long-context). Nothing in the sources suggests a different five, and the sources actively support the design choices:

- Difficulty triad ≈ Gemini SIMPLE/COMPLEX with an explicit middle; abstain-below-threshold ≈ RouteLLM threshold tuning.
- Gates for modality/size ≈ OpenRouter capability filters.
- Split needs (primary + secondary profile on combined probability) have no direct analog found, but generalize the binary-with-uncertainty case sensibly.

## Suggested changes (ranked)

1. **Keep the taxonomy as is.** No evidence for adding categories like coding, agentic, or math: in an interactive coding agent those are ambient, not discriminating — which is presumably why Gemini CLI ignores them too. Audio/structured-output become relevant only as gates if those input/output types ever appear in pi.
2. **Add session stickiness within the chosen tier.** Prefer the session's current model whenever it lands inside the winning tier, rather than only when it is the tier's cost winner. Matches OpenRouter and Azure practice; the payoff is prompt-cache continuity (cacheRead already dominates `cheaperFirst` ties) and behavioral consistency mid-session. Small, local change in `pickFromTopTier`'s `withinTier` preference.
3. **Consider exposing the aggressiveness knob.** A `/jev auto-model cost|balanced|quality`-style setting would mirror Azure's modes and OpenRouter's cost tiers, mapping naturally onto the existing confidence threshold and within-tier cost-vs-grade preference. Optional; current defaults are reasonable.
4. **Restructure the docs (not the code) around "one axis + two gates."** The profile list reads as five peers, but the design is a difficulty axis with capability overrides. Making that explicit would keep future contributors from "adding a category" when what they want is a gate.
5. **Long-term only: outcome learning.** RouteLLM's preference-data training and OpenRouter's market signal are the mature versions of learning routing from feedback. pi-jev already learns *failures* (backoff); learning *outcomes* (was the cheap tier's answer accepted?) would be the next maturity step, at substantially larger scope.

Verification limits: Gemini CLI and Azure details come from public source/docs as of 2026-09-25; OpenRouter's ~30 task-type list is documented but the full enumeration is not published (examples are). No source was found that publishes a category set claiming to be standard; the absence of a canonical list is itself the finding.
