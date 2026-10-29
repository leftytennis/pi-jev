/**
 * Map a spawnSync result to a process exit code. The gate is fail-closed:
 * a child killed by a signal (OOM, CI timeout) or a spawn failure has
 * `status: null` and must NOT exit 0 — that would silently pass the gate.
 * Only the runner's own explicit --fail-open path may report success on error.
 *
 * @param {{ status: number | null, error?: Error }} result
 * @returns {number}
 */
export function exitCodeFor(result) {
  if (result.error) return 2;
  return result.status ?? 2;
}
