/**
 * An ISO timestamp as epoch milliseconds, or `undefined` when it is absent or
 * unparseable. The one ISO-to-number seam for ordering and elapsed-time maths,
 * so a malformed stamp is treated the same on every surface.
 */
export function parseEpochMs(
  iso: string | null | undefined,
): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}
