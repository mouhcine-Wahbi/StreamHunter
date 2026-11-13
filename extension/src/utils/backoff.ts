/**
 * Exponential backoff: base * 2^(failures-1), capped. failures <= 0 → 0.
 * Jitter is optional so tests can be deterministic.
 */
export function backoffDelayMs(
  failures: number,
  { baseMs = 60_000, maxMs = 15 * 60_000, jitter = 0 }: { baseMs?: number; maxMs?: number; jitter?: number } = {},
): number {
  if (failures <= 0) return 0;
  const raw = Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 30));
  if (!jitter) return raw;
  const spread = raw * jitter;
  return Math.max(0, Math.round(raw - spread + Math.random() * spread * 2));
}
