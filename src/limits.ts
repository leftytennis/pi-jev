import { capText } from "./redact.js";

/** Largest state, in characters, sent for one Jev judgment. */
export const MAX_STATE_CHARS = 50_000;
/** Most questions one model-initiated evaluation may ask. */
export const MAX_QUESTIONS = 24;
/** Prompt characters sent for routing decisions. */
export const MAX_TASK_CHARS = 4_000;

/** Bound untrusted state to MAX_STATE_CHARS, preserving object shape when it already fits. */
export function capState(state: string | Record<string, unknown>): string | Record<string, unknown> {
  if (typeof state === "string") return capText(state, MAX_STATE_CHARS);
  const serialized = JSON.stringify(state);
  return serialized.length <= MAX_STATE_CHARS ? state : capText(serialized, MAX_STATE_CHARS);
}
