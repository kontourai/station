/**
 * The Station fence of one related pane occurrence
 * (docs/design/pane-relationships.md: target identity includes the Station).
 *
 * Pane state in this browser is origin-wide, so a pane opened while connected
 * to Station A is still placed — with A's Project slug and file path in its
 * own state — after the reader switches to Station B. The fence is what stops
 * B from reading that path: one record per occurrence, under the occurrence's
 * OWN key, written once when the occurrence is minted and removed only with
 * the occurrence. It is never rewritten, so it needs no shared
 * read-modify-write, and it does not depend on the relations side record:
 * losing, bounding or not understanding that record cannot make a fenced
 * occurrence readable on another Station.
 *
 * A reader treats the fence as its gate, before any identity or data read:
 * no fence is a pre-relationship (legacy) occurrence, an unreadable or newer
 * fence is closed, and a fenced occurrence is read only while the verified
 * Station is exactly the fenced one.
 */

const PANE_FENCE_PREFIX = 'station:pane-fence:v1';
const MAX_PANE_FENCE_BYTES = 1024;

export interface PaneFenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PaneFence =
  | { readonly status: 'none' }
  | { readonly status: 'fenced'; readonly stationId: string }
  /** Present but unreadable, or written by a newer build: closed. */
  | { readonly status: 'unknown' };

function fenceKey(instanceId: string): string {
  return `${PANE_FENCE_PREFIX}:${encodeURIComponent(instanceId)}`;
}

function isStationId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function readPaneFence(
  storage: PaneFenceStorage,
  instanceId: string,
): PaneFence {
  let raw: string | null;
  try {
    raw = storage.getItem(fenceKey(instanceId));
  } catch {
    // Unreadable storage cannot prove the occurrence is unfenced.
    return { status: 'unknown' };
  }
  if (raw === null) return { status: 'none' };
  if (raw.length > MAX_PANE_FENCE_BYTES) return { status: 'unknown' };
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { version?: unknown }).version === 1 &&
      isStationId((value as { stationId?: unknown }).stationId)
    )
      return {
        status: 'fenced',
        stationId: (value as { stationId: string }).stationId,
      };
  } catch {
    // Falls through: present but unreadable.
  }
  return { status: 'unknown' };
}

/**
 * Fence a NEW occurrence to `stationId`. Refused — `false`, nothing written —
 * when the occurrence already carries a fence (a fence is never rewritten) or
 * storage refuses the write; the caller then opens nothing.
 */
export function writePaneFence(
  storage: PaneFenceStorage,
  instanceId: string,
  stationId: string,
): boolean {
  if (!isStationId(stationId)) return false;
  try {
    if (storage.getItem(fenceKey(instanceId)) !== null) return false;
    storage.setItem(
      fenceKey(instanceId),
      JSON.stringify({ version: 1, stationId }),
    );
    return storage.getItem(fenceKey(instanceId)) !== null;
  } catch {
    return false;
  }
}

/** Remove an occurrence's fence; only the occurrence's own removal calls this. */
export function removePaneFence(
  storage: PaneFenceStorage,
  instanceId: string,
): void {
  try {
    storage.removeItem(fenceKey(instanceId));
  } catch {
    // Per-device storage is optional; an orphaned fence only closes a pane
    // that no longer exists.
  }
}

/**
 * Remove an occurrence's own record (its state, under `recordKey`), and its
 * fence only once that record is confirmed gone. A record whose removal
 * failed keeps its fence: unfenced, it would read as a legacy occurrence and
 * be admitted on any Station. True when the record is gone; the fence's own
 * removal stays best effort (an orphaned fence only closes a pane that no
 * longer exists).
 */
export function removeFencedRecord(
  storage: PaneFenceStorage,
  instanceId: string,
  recordKey: string,
): boolean {
  try {
    storage.removeItem(recordKey);
  } catch {
    // Whether it went is read below, not assumed from the throw.
  }
  let gone: boolean;
  try {
    gone = storage.getItem(recordKey) === null;
  } catch {
    gone = false;
  }
  if (gone) removePaneFence(storage, instanceId);
  return gone;
}

/**
 * Whether a reader may read a fenced occurrence now. `verifiedStationId` is
 * the verified authority observation's Station, or null while it is unknown.
 */
export type PaneFenceAdmission =
  | 'legacy'
  | 'admitted'
  | 'checking'
  | 'wrong-station'
  | 'unknown-fence';

export function paneFenceAdmission(
  fence: PaneFence,
  verifiedStationId: string | null,
): PaneFenceAdmission {
  if (fence.status === 'none') return 'legacy';
  if (fence.status === 'unknown') return 'unknown-fence';
  if (verifiedStationId === null) return 'checking';
  return verifiedStationId === fence.stationId ? 'admitted' : 'wrong-station';
}
