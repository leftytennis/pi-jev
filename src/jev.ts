import { TypeSafeClient, choice, noul, score, type RequestOptions } from "@typesafe-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { redactDeep, redactText } from "./redact.js";
import type {
  JevEvaluationRequest,
  JevEvaluationResponse,
  JevAnswerResult,
  JevSessionStats,
  QuestionConfig,
} from "./types.js";

export type ApiKeySource = "env" | "file";
type ActiveApiKey = { key: string; origin: string; warning?: string };
const TYPESAFE_ORIGIN = "https://api.typesafe.ai";

export function resolveBaseURL(): string | null {
  return process.env.PI_JEV_BASE_URL?.trim() || process.env.TYPESAFE_BASE_URL?.trim() || null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The API key and every payload travel to the base URL, so a custom endpoint
 * must use https unless it is on this machine.
 */
export function assertSafeBaseURL(baseURL: string | null): void {
  if (!baseURL) return;
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error(`Invalid PI_JEV_BASE_URL: ${baseURL}`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new Error(`Refusing PI_JEV_BASE_URL ${url.origin}: use https, or http only on localhost.`);
}

function isCustomEndpoint(baseURL: string | null): boolean {
  if (!baseURL) return false;
  try {
    return new URL(baseURL).origin !== TYPESAFE_ORIGIN;
  } catch {
    return true;
  }
}

/** Resolve the API key together with where it came from, for status reporting. */
export function resolveApiKeySource(baseURL = resolveBaseURL()): (ActiveApiKey & { source: ApiKeySource }) | null {
  if (isCustomEndpoint(baseURL)) {
    const key = process.env.PI_JEV_API_KEY?.trim();
    return key ? { key, source: "env", origin: "$PI_JEV_API_KEY" } : null;
  }
  const envKey = process.env.TYPESAFE_API_KEY?.trim();
  if (envKey) return { key: envKey, source: "env", origin: "$TYPESAFE_API_KEY" };

  const defaultSecretPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "secrets",
    "typesafe_api_key"
  );
  if (fs.existsSync(defaultSecretPath)) {
    try {
      const content = fs.readFileSync(defaultSecretPath, "utf8").trim();
      if (content) {
        const origin = "~/.pi/agent/secrets/typesafe_api_key";
        const warning = fs.statSync(defaultSecretPath).mode & 0o077
          ? `${origin} is accessible to group or others; run chmod 600 ${origin}.`
          : undefined;
        return { key: content, source: "file", origin, warning };
      }
    } catch {
      // Ignore read errors
    }
  }

  return null;
}

export class JevClient {
  private client: TypeSafeClient | null = null;
  private clientKey: string | null = null;
  private clientBaseURL: string | null = null;
  private apiKey: string | null = null;
  private apiKeySetInSession = false;
  private configuredCache?: { value: boolean; until: number };
  public stats: JevSessionStats = {
    requestsCount: 0,
    totalTokens: 0,
  };

  public isConfigured(): boolean {
    // resolveApiKeySource performs filesystem reads; cache briefly so per-prompt
    // callers do not hammer the disk. setApiKey invalidates immediately.
    const now = Date.now();
    if (this.configuredCache && this.configuredCache.until > now) return this.configuredCache.value;
    const value = Boolean(this.getActiveApiKey() || this.getBaseURL());
    this.configuredCache = { value, until: now + 5_000 };
    return value;
  }

  private getActiveApiKey(): ActiveApiKey | null {
    const baseURL = this.getBaseURL();
    const sessionKey = this.apiKey?.trim();
    if (!isCustomEndpoint(baseURL) && this.apiKeySetInSession && sessionKey) {
      return { key: sessionKey, origin: "set in-session" };
    }
    return resolveApiKeySource(baseURL);
  }

  /** Human-readable description of where the API key came from, or null when unconfigured. */
  public getKeyOrigin(): string | null {
    return this.getActiveApiKey()?.origin ?? null;
  }

  public getKeyWarning(): string | null {
    return this.getActiveApiKey()?.warning ?? null;
  }

  public getBaseURL(): string | null {
    return resolveBaseURL();
  }

  public setApiKey(key: string): void {
    this.apiKey = key;
    this.apiKeySetInSession = true;
    this.client = null;
    this.clientKey = null;
    this.configuredCache = undefined;
  }

  private getClient(): TypeSafeClient {
    const key = this.getActiveApiKey()?.key ?? null;
    const baseURL = this.getBaseURL();
    if (!key && !baseURL) {
      throw new Error("Missing TYPESAFE_API_KEY. Set it in environment, ~/.pi/agent/secrets/typesafe_api_key, or set PI_JEV_BASE_URL for a compatible local endpoint.");
    }
    // Endpoint changes must not reuse a client holding another origin's key.
    if (!this.client || this.clientKey !== key || this.clientBaseURL !== baseURL) {
      assertSafeBaseURL(baseURL);
      this.client = new TypeSafeClient({ apiKey: key ?? "", ...(baseURL ? { baseURL } : {}) });
      this.clientKey = key;
      this.clientBaseURL = baseURL;
    }
    return this.client;
  }

  public async evaluate(
    request: JevEvaluationRequest,
    signal?: AbortSignal,
    options?: Pick<RequestOptions, "retry">
  ): Promise<JevEvaluationResponse> {
    const startTime = Date.now();
    const client = this.getClient();

    const formattedQuestions: Record<string, any> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      // Instructions and criteria embed untrusted state (paths, entry text,
      // prompts) — redact them at the same boundary as the state payload.
      if (q.type === "choice") {
        formattedQuestions[id] = choice(redactText(q.instructions), redactDeep(q.criteria));
      } else if (q.type === "noul") {
        formattedQuestions[id] = noul(redactText(q.instructions));
      } else if (q.type === "score") {
        formattedQuestions[id] = score(redactText(q.instructions), redactDeep(q.criteria) as any);
      }
    }

    // Single egress boundary: every feature's state passes through redaction
    // before leaving the machine.
    const statePayload: any = redactDeep(
      typeof request.state === "string" ? { text: request.state } : request.state
    );

    try {
      const response: any = await client.systemOne({
        state: statePayload,
        questions: formattedQuestions,
        model: request.model,
      }, { ...options, signal });

      const elapsedMs = Date.now() - startTime;
      this.stats.requestsCount += 1;
      const usage = response.usage;
      this.stats.totalTokens += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
      this.stats.lastElapsedMs = elapsedMs;

      const answers: Record<string, JevAnswerResult> = {};
      for (const [id, rawAns] of Object.entries(response.answers || {})) {
        const qConfig = request.questions[id];
        if (!qConfig) continue;

        if (qConfig.type === "choice") {
          const c = (rawAns as any).choice ?? (rawAns as any).value;
          answers[id] = {
            type: "choice",
            value: c,
            confidence: (rawAns as any).confidence,
            distribution: (rawAns as any).probabilities ?? (rawAns as any).distribution,
            raw: rawAns,
          };
        } else if (qConfig.type === "noul") {
          const prob = (rawAns as any).noul ?? (rawAns as any).probability ?? (rawAns as any).value ?? 0;
          answers[id] = {
            type: "noul",
            value: prob,
            confidence: (rawAns as any).confidence,
            raw: rawAns,
          };
        } else if (qConfig.type === "score") {
          // No `?? 0` fallback: a missing score must stay missing so consumers
          // reject it as malformed instead of reading "worst fit" into silence.
          const s = (rawAns as any).score ?? (rawAns as any).value;
          answers[id] = {
            type: "score",
            value: s,
            confidence: (rawAns as any).confidence,
            raw: rawAns,
          };
        }
      }

      return {
        answers,
        model: response.model || "jev-latest",
        usage: response.usage,
        elapsedMs,
      };
    } catch (err: any) {
      this.stats.lastError = err?.message || String(err);
      throw err;
    }
  }
}
