# Provider Usage/Quota Endpoints

**Status:** research findings, proven live on 2026-09-24 (UTC).
**Purpose:** ground the quota-aware model-routing design (poller, usage snapshot, demotion thresholds) in verified, per-provider mechanisms. The four read adapters and parsers are implemented in `src/usage.ts`, surfaced by `/jev usage`, and consumed by auto-model routing (`src/model-router.ts`): a provider past 90% of its fullest window — or reporting its limit reached — is excluded unless no other candidate satisfies a hard requirement, and past 70% its models lose score ties. Model-scoped windows (Anthropic `weekly_scoped`) apply those thresholds only to the models in their scope.

All four providers in the pi-jev model pool expose (or are believed to expose) programmatic usage APIs. Two are undocumented internal endpoints; treat every schema as drift-prone and every call as advisory telemetry.

---

## Summary matrix

| Provider | Endpoint | Auth | Proven | Windows reported | Local credential source |
|---|---|---|---|---|---|
| Anthropic (`claude-bridge`) | `GET https://api.anthropic.com/api/oauth/usage` | Claude Code OAuth Bearer + `anthropic-beta: oauth-2025-04-20` | ✅ HTTP 200 | 5-hour, weekly (all-models), per-model weekly scopes | macOS keychain item `Claude Code-credentials` (fallback `~/.claude/.credentials.json`) |
| Codex (`openai-codex`) | `GET https://chatgpt.com/backend-api/wham/usage` | ChatGPT OAuth Bearer + `ChatGPT-Account-Id` | ✅ HTTP 200 | Primary window (role varies — read `limit_window_seconds`), credits, per-model availability | `~/.codex/auth.json` → `tokens.access_token`, `tokens.account_id` |
| Z.ai (`zai`) | `GET https://api.z.ai/api/monitor/usage/quota/limit` | API key Bearer | ✅ HTTP 200 | 5-hour (credits), weekly (credits), plan level | `~/.pi/agent/auth.json` → `zai.key` (also `ZAI_API_KEY` env) |
| Kimi (`kimi-coding`) | `GET https://api.kimi.com/coding/v1/usages` | **OAuth Bearer only** (Coding Plan `kimi login`; API keys rejected) | ✅ HTTP 200 (after refresh) | 5-hour rolling, monthly total, monthly code, burst rate limit | `~/.pi/agent/auth.json` → `kimi-coding.access` (+ `refresh`) |

China region note: Z.ai has a second host, `open.bigmodel.cn`, with the same path.

---

## Anthropic (Claude Code)

### Call

```bash
TOKEN=<claudeAiOauth.accessToken>
curl https://api.anthropic.com/api/oauth/usage \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20"
```

### Credential location

macOS keychain generic-password service `Claude Code-credentials`, JSON shape — **camelCase**:

```json
{ "claudeAiOauth": { "accessToken": "…", "refreshToken": "…", "expiresAt": 1790231205041,
  "scopes": [...], "subscriptionType": "max", "rateLimitTier": "default_claude_max_5x" } }
```

> ⚠️ Some community reference code uses snake_case (`access_token`) — that fails here.

### Response schema (observed 2026-09-24)

- `five_hour.utilization` (percent), `five_hour.resets_at` (ISO 8601)
- `seven_day.utilization`, `seven_day.resets_at`
- `limits[]` — **the authoritative list**, superseding the legacy flat keys (`seven_day_sonnet`, `seven_day_opus`, … which are now `null`):
  - `{ kind: "session", percent, resets_at }`
  - `{ kind: "weekly_all", percent, resets_at }`
  - `{ kind: "weekly_scoped", percent, resets_at, scope: { model: { display_name } }, is_active }` — per-model weekly buckets (e.g. a Fable-scoped weekly limit); **`is_active: true` marks the currently binding limit**
- `extra_usage` — credit overflow config (`is_enabled`, `disabled_reason`)

### Observed status at documentation time

5-hour **23%** · weekly-all **17%** · **Fable-scoped weekly 25%, active** · extra-usage credits disabled (`out_of_credits`).

### Caveats

- Undocumented; no support guarantee. Anthropic already migrated per-model quotas from `seven_day_*` keys into `limits[]` once — parse defensively, prefer `limits[]`.
- Legacy plan accounts may still report weekly in the old keys.

---

## Codex / ChatGPT (`openai-codex`)

### Call

```bash
ACCESS=<tokens.access_token>; ACCOUNT=<tokens.account_id>
curl "https://chatgpt.com/backend-api/wham/usage" \
  -H "Authorization: Bearer $ACCESS" \
  -H "ChatGPT-Account-Id: $ACCOUNT" \
  -H "Accept: application/json"
```

### Credential location

`~/.codex/auth.json` → `tokens.access_token`, `tokens.account_id`.

### Response schema (observed 2026-09-24)

- `plan_type` (e.g. `"pro"`), `rate_limit.allowed`, `rate_limit.limit_reached`
- `rate_limit.primary_window`: `{ used_percent, limit_window_seconds, reset_after_seconds, reset_at }`
  - ⚠️ **Window roles vary**: at documentation time `primary_window` was the **weekly** window (`limit_window_seconds: 604800`) and `secondary_window` was `null`. Always read `limit_window_seconds` (and/or `reset_after_seconds`) — never assume primary = 5-hour.
- `model_usage` — per-model availability (e.g. `gpt-6-astra.available`)
- `credits` (balance, `has_credits`), `rate_limit_reset_credits.available_count`
- `spend_control`, `code_review_rate_limit`, `additional_rate_limits` (may be null)

### Observed status at documentation time

**Weekly primary window 96% used** (resets in ~39 h) — near-exhausted; 5-hour window absent from the response.

### Alternates

- Legacy response headers on Codex traffic: `x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-at`, `x-codex-secondary-*` — not emitted by newer transports, and `codex exec` mode emits no rate-limit data at all.
- `codex app-server` JSON-RPC: `account/rateLimits/read` → `resetsAt`, `windowDurationMins`, `credits.balance`, `planType`.

---

## Z.ai / GLM (`zai`)

### Call

```bash
KEY=<zai.key or $ZAI_API_KEY>
curl "https://api.z.ai/api/monitor/usage/quota/limit" \
  -H "Authorization: Bearer $KEY" \
  -H "Accept: application/json"
# China region: https://open.bigmodel.cn/api/monitor/usage/quota/limit
```

### Response schema (observed 2026-09-24)

`data.limits[]` rows encode the window as `unit`/`number` (unit 3 = hour, number 5 = five of them; unit 6 = day, number 1 = seven → week):

| type | unit/number | meaning | observed |
|---|---|---|---|
| `CREDIT_LIMIT` | 3 / 5 | 5-hour credit window | 472/12,000 used → **3%**, `nextResetTime` ms epoch |
| `CREDIT_LIMIT` | 6 / 1 | weekly credit window | 13,224/60,000 → **22%** |

`data.level` = plan tier (`"pro"`). `TIME_LIMIT` rows map to monthly limits on some accounts.

### Caveats

- Endpoint is undocumented in Z.ai's public reference (used internally by the subscription UI); community-verified across several tools.

---

## Kimi Coding Plan (`kimi-coding`)

### Auth model — the part that bites

- Coding Plan auth is **OAuth only** (`kimi login` → JWT access + refresh tokens). API keys work for the chat endpoints but are **rejected by the usage endpoint** (401 "API Key … invalid or may have expired").
- **Access tokens expire every ~15 minutes.** Any poller must **refresh-then-poll** (or refresh on 401) and persist rotated tokens.

### Refresh flow (verified working)

```bash
curl -X POST "https://auth.kimi.com/api/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=17e5f671-d194-4dfb-9706-5516cb48c098" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=$REFRESH"
# 200 → { access_token, refresh_token, expires_in (900), scope, token_type }
```

- Source of truth: MoonshotAI/kimi-code `packages/oauth/src/oauth.ts` (`{oauthHost}/api/oauth/token`).
- No `/.well-known/` discovery document is served — the host/path above is hard-coded in the CLI.
- **Persist the rotated tokens** immediately after refresh (the refresh token may rotate). On 2026-09-24 pi's stored token was found expired; it was refreshed and written back to `~/.pi/agent/auth.json` (backup created).

### Usage call

```bash
curl "https://api.kimi.com/coding/v1/usages" -H "Authorization: Bearer $ACCESS"
```

### Response schema (observed 2026-09-24)

```json
{
  "limits": [ { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
                "detail": { "limit": "100", "remaining": "100", "resetTime": "…" } } ],
  "usages": {
    "limit_5h":             { "used_ratio": 0,     "reset_time": "…" },
    "limit_month_total":    { "used_ratio": 0.0546, "reset_time": "…" },
    "limit_month_code":     { "used_ratio": 0,      "reset_time": "…" }
  }
}
```

### Plan-shape difference (matters)

- **New Kimi Code plans have no weekly quota** — windows are 5-hour rolling + monthly totals (`limit_month_total` / `limit_month_code`). Legacy plans still report weekly. The poller should treat the presence/absence of keys as the plan shape, not hard-code it.
- A burst row (100 requests / 5 min) also appears under `limits[]`.

---

## Available-models listing (companion capability)

Verified live 2026-09-24 — same credentials as the usage endpoints. Useful for validating the configured pool, discovering newly released models, and refreshing capability metadata (`context_length`, modality flags) that feeds Jev scoring.

| Provider | Endpoint | Auth | Result |
|---|---|---|---|
| Anthropic | `GET https://api.anthropic.com/v1/models` (+ `anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20`) | Claude Code OAuth Bearer | ✅ 12 models (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`, …) |
| Z.ai | `GET https://api.z.ai/api/paas/v4/models` (Bearer API key) | `zai.key` | ✅ 11 models (`glm-5.3-flash`, `glm-5.3-flashx`, `glm-5.3`, …) |
| Kimi | `GET https://api.kimi.com/coding/v1/models` | Coding Plan OAuth Bearer (fresh token) | ✅ 4 models with `context_length` + capability flags |
| Codex | none found | — | ❌ `wham/models` / `codex/models` → HTTP 400; availability surfaces via `wham/usage` `model_usage`, the CLI `/model`, or `app-server` JSON-RPC |

Kimi live catalog (note `context_length` and modality flags — directly consumable as scoring metadata):

| id | display name | context | capabilities |
|---|---|---|---|
| `kimi-for-coding` | K2.8 Preview | 1,048,576 | reasoning, image-in, video-in, dynamic tools |
| `kimi-for-coding-highspeed` | K2.7 Code Highspeed | 262,144 | reasoning, image-in, video-in |
| `k3` | K3 | 1,048,576 | reasoning, image-in, video-in, dynamic tools |
| `k3-256k` | K3-256k | 262,144 | reasoning, image-in, dynamic tools |

### Drift observed against the local registry

- Z.ai's live catalog includes `glm-5.3-flashx`, absent from `models-store.json`.
- Kimi's `kimi-for-coding` is now **K2.8 Preview** (1M context, video-in) — newer metadata than the local store carries.
- Conclusion: a periodic models probe can validate that enabled models still exist upstream, discover new releases, and refresh the capability metadata Jev scores against (addressing the "scoring evidence" weakness flagged in the design consultation).

---

## Implications for the quota-aware routing design

1. **Poller**: one adapter per provider, ~5-minute cache TTL, every failure swallowed → snapshot marked stale (the reactive 429 backoff in `recordProviderResponse` remains the safety net).
2. **Kimi adapter is refresh-then-poll** (15-minute token TTL); persist rotations to `~/.pi/agent/auth.json` (with backup) so pi's own provider usage stays consistent.
3. **Codex adapter reads `limit_window_seconds`** to identify which window a block describes; do not assume 5h/weekly positions.
4. **Anthropic parser prefers `limits[]`** and surfaces `is_active` scoped limits (per-model weekly buckets), keeping `scope.model.display_name` as `QuotaWindow.scopeModel`. A scoped bucket binds only its own models: routing matches the display name's tokens against catalog model ids ("Fable" ⊆ `claude-fable-5-1`), so a hit Fable limit excludes Fable while Opus and Sonnet keep routing on the provider's unscoped windows. A scope that matches no model in the provider's catalog is applied provider-wide, since it cannot be attributed; a scope whose models the tier policy already removed (Fable, tier 5, without a frontier request) affects nothing else.
5. **Thresholds (implemented in `src/model-router.ts`)**: ≥70% of the fullest unscoped window → the provider's models lose score ties (a scoped window demotes or excludes only its scope's models); ≥90% or a platform-reported limit → excluded unless no other candidate satisfies a hard requirement (e.g. the vision gate); equal-score ties below that break toward the binding window with the most headroom (load spreading across subscriptions). The snapshot is advisory — never a hard guarantee of provider-side quota state; the reactive 429 backoff remains the safety net.
6. **Credential hygiene**: tokens live in the keychain / auth files; extraction and calls must run in non-echoing subshells; never print or log credential material.

## Provenance

- Live verification: 2026-09-24 — all four calls executed from this machine with locally stored credentials (results captured in session history; Anthropic 23%/17%/25%-Fable-active, Codex week 96%, Z.ai 3%/22%, Kimi 0%/5.5%/0%).
- Community corroboration: MoonshotAI/kimi-code source (OAuth + usage paths), anthropics/claude-code issues #34199/#34497/#30764/#86297 (no official CLI/JSON), openai/codex issues #14728/#15281/#20310/#24080 (header/exec gaps), community tools (usagebar, CodexBar, zai-quota, zquota, OpenTokenUsage, shunt, loopflow).
