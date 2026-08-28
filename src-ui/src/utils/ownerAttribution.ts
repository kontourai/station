/**
 * Owner-attribution contract for message-row annotation (archive#1424).
 *
 * The row identifies the Station that produced it, not the single local
 * operator. The shape is deliberately versionless from the chip's point of
 * view: `id` is a stable reference a consumer could key off, `label` is what
 * renders. Consumers of `OwnerAttribution`/`OwnerChip` only ever read
 * `label`, so #1392 can restore attested human attribution by changing this
 * producer without changing the chip's consumers.
 */
export interface OwnerAttribution {
  /** Stable identity reference for the Station that produced the row. */
  id: string;
  /** Human-readable Station label to render in the row chip. */
  label: string;
}

/**
 * Builds the row attribution from the device's active saved Station first,
 * then the Station build identity. The OS alias is intentionally not an
 * input: it identifies the local account, not which Station produced a row.
 */
export function ownerAttributionFromStation(
  savedStation:
    | { id: string; name: string; injected?: boolean }
    | null
    | undefined,
  stationIdentity: string | null | undefined,
): OwnerAttribution | null {
  if (savedStation && !savedStation.injected) {
    const savedName = savedStation.name.trim();
    if (savedName) return { id: savedStation.id, label: savedName };
  }

  const identity = stationIdentity?.trim();
  return identity ? { id: `station:${identity}`, label: identity } : null;
}

/** The accountable human belongs in expanded provenance, never the row chip. */
export function accountableHumanFromUser(
  user: { name?: string } | null | undefined,
): string | null {
  return user?.name?.trim() || null;
}
