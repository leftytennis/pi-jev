/**
 * Shared pre-send redaction for state leaving the machine toward the TypeSafe
 * API. Every outbound evaluation passes through `redactDeep` at the JevClient
 * boundary so no single feature has to remember to scrub its payload.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<REDACTED>"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<REDACTED>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<REDACTED>"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, "<REDACTED>"],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g, "<REDACTED>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<REDACTED>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "<REDACTED>"],
  [/(?:Authorization|Proxy-Authorization)\s*:\s*\S+/gi, "<REDACTED>"],
  // Credentials in connection strings: scheme://user:password@host keeps the user and host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+):[^\s@\/]+@/gi, "$1:<REDACTED>@"],
  // KEY=VALUE credentials; the name may embed the keyword (AWS_SECRET_ACCESS_KEY, "password": …).
  // Only literal values count: a quoted string, or a bare token not followed by `.`/`(`/`[`, so code
  // such as `password = req.body.password` or `token = jwt.sign(…)` stays readable to the judge.
  [/([\w-]*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?key|credential)[\w-]*["']?\s*[:=]\s*)(?:(["'])[^"'\s]{8,}\2|[A-Za-z0-9_+\/=~-]{8,}(?![\w.(\[]))/gi, "$1<REDACTED>"],
];

export const REDACTED_MARKER = "<REDACTED>";

/** Deeper values are serialized and redacted as text rather than walked. */
const MAX_DEPTH = 8;

/** Replace recognized secret material in a single string with a marker. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Deeply redact every string in a JSON-like value. Non-destructive: returns
 * the original reference when nothing changed, so callers can detect no-ops.
 * Past MAX_DEPTH the subtree is serialized and redacted as text, so nesting
 * cannot carry a secret past the boundary.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH && value && typeof value === "object") {
    const text = JSON.stringify(value);
    const redacted = redactText(text);
    return (redacted === text ? value : redacted) as unknown as T;
  }
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) {
    const out = value.map((item) => redactDeep(item, depth + 1));
    return (out.some((item, i) => item !== value[i]) ? out : value) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = redactDeep(item, depth + 1);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return (changed ? out : value) as unknown as T;
  }
  return value;
}

/** Truncate long text for transport, marking the cut. */
export function capText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`;
}

const SECRET_PATH = /(?:\.env|\.pem|id_rsa|id_ed25519|\.key\b|secret)/i;
const SECRET_PATH_ARG = new RegExp(`"(?:path|file|filepath|filename|cwd|to|from|destination|target)"\\s*:\\s*"[^"]*${SECRET_PATH.source}`, "i");

/** True when a file path names secret-bearing material (.env, keys, "secret"). */
export function isSecretPath(filePath: string): boolean {
  return SECRET_PATH.test(filePath);
}

/** True when a tool-call input references a secret-bearing path; such calls skip external evaluation entirely. */
export function referencesSecretPath(input: unknown): boolean {
  return SECRET_PATH_ARG.test(JSON.stringify(input ?? ""));
}
