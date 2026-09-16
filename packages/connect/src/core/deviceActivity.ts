/**
 * Presentation helpers for the paired-device list.
 *
 * The host has always recorded when a device was paired and when its
 * credential was last used — `PairedDevice.issuedAt` and `.lastUsedAt` — but
 * the only surface that rendered devices showed neither, so "which of my
 * devices still has access, and when did it last talk to this Station?" was
 * unanswerable from the UI even though the answer was already on the wire.
 *
 * One caveat governs every label here: `lastUsedAt` is persisted at a bounded
 * cadence (`LAST_USED_WRITE_INTERVAL_MS` in the host's device-pairing
 * service, one minute), and it advances on *credential use*, not on
 * connection liveness. A device
 * holding an idle stream open makes no requests and so goes quiet in this data.
 * These labels therefore describe recent request activity, which is a weaker
 * claim than "connected right now" and is worded accordingly.
 */

import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  DEVICE_PAIRING_SCOPE,
  PAIRING_SCOPE_HOME_CONTROL,
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_PRESETS,
  PAIRING_SCOPES,
  type PairedDevice,
  parsePairingScope,
} from '@kontourai/station-contracts';

/**
 * How recent `lastUsedAt` must be to read as current activity: comfortably
 * wider than the host's minutely persistence cadence, and narrow enough that
 * "active" still means recent observed use.
 */
export const DEVICE_ACTIVE_WINDOW_MS = 2 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function scopeSetsMatch(scope: string, preset: readonly string[]): boolean {
  const parsed = parsePairingScope(scope);
  if (parsed === null || parsed.length !== preset.length) return false;
  const presetSet = new Set(preset);
  return parsed.every((token) => presetSet.has(token));
}

/**
 * Plain-English scope label (station#1098) — the wire value is a
 * space-delimited identifier list, not copy. A device paired before scoped
 * pairing shipped still carries the legacy marker until its next load
 * migrates it server-side; this reads it the same as the default grant
 * rather than showing the raw identifier.
 *
 * **Why the default grant is no longer labelled "Full access"**
 * (station#1398 slice 2, `docs/design/inference-fleet.md` §11 slice 2 point
 * 3): it used to be the entire vocabulary, so "Full access" was accurate by
 * construction. Once `inference:invoke` joined the vocabulary — deliberately
 * NOT joining the default grant — a legacy or unscoped device holding those
 * four tokens no longer holds everything, and a label that says otherwise
 * tells the owner their laptop can borrow this machine's GPU when it cannot.
 * The label must describe the tokens held, not the constant's old name, so
 * the four-token set now reads as what it grants and "Full access" is
 * reserved for a scope that genuinely carries every token. This is the label
 * surface for a security control; over-claiming here is the same class of
 * defect as under-enforcing.
 */
export function describeDeviceScope(scope: string): string {
  if (scope === DEVICE_PAIRING_SCOPE || scope === DEFAULT_GRANT_PAIRING_SCOPE) {
    return 'Standard + device management';
  }
  if (scopeSetsMatch(scope, PAIRING_SCOPES)) {
    return 'Full access';
  }
  if (scopeSetsMatch(scope, PAIRING_SCOPE_PRESETS['read-only'])) {
    return 'Read-only';
  }
  if (scopeSetsMatch(scope, PAIRING_SCOPE_PRESETS.standard)) {
    return 'Standard';
  }
  // station#1123 slice 1: the delegation preset (read + operate, no
  // terminal) is a distinct set from both 'standard' (adds terminal) and
  // 'read-only' (drops operate), so this never shadows either check above.
  if (scopeSetsMatch(scope, PAIRING_SCOPE_PRESETS.delegation)) {
    return 'Delegation';
  }
  // station#1398 slice 2: the fleet-inference preset. A single-token grant
  // that can ask this Station for model completions on its contributed
  // connections and read which models those are — and nothing else.
  if (scopeSetsMatch(scope, PAIRING_SCOPE_PRESETS.inference)) {
    return 'Fleet inference';
  }
  if (scopeSetsMatch(scope, PAIRING_SCOPE_PRESETS['home-transfer'])) {
    return 'Home transfer';
  }
  if (scope === PAIRING_SCOPE_HOME_CONTROL) return 'Home control';
  return parsePairingScope(scope) !== null ? 'Custom access' : scope;
}

/**
 * station#1123 slice 1: a device-list label distinguishing an ordinary
 * paired device from a delegation grant — same registry, same revoke
 * affordance, visibly different purpose.
 */
export function describeDeviceKind(kind: PairedDevice['kind']): string {
  return kind === 'delegation' ? 'Delegation' : 'Device';
}

/**
 * What a delegation-minted device can CURRENTLY do (station#3845).
 *
 * `kind` records why a credential was minted and never changes; scope
 * records what it may do and now does change (station#3816). So the row's
 * chip could outlive the capability it claimed: a delegation device
 * narrowed to Read-only still advertised "This peer may delegate work",
 * and an operator auditing the list read a capability that was gone.
 *
 * The chip therefore reports the LIVE answer, because that is what the
 * device list is for — but it keeps the provenance rather than vanishing,
 * since "this was paired to delegate and no longer can" is exactly the
 * state someone needs to see to decide whether to restore it or revoke it.
 * `null` for a device that was never minted for delegation.
 */
export function describeDelegationStanding(
  device: Pick<PairedDevice, 'kind' | 'scope'>,
): { label: string; title: string } | null {
  if (device.kind !== 'delegation') return null;
  // Delegating work is `orchestration:operate`; the delegation preset is
  // exactly read+operate, so operate is the token that makes the claim true.
  const mayDelegate = (parsePairingScope(device.scope) ?? []).includes(
    PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  );
  return mayDelegate
    ? {
        label: 'Delegation',
        title: 'This peer may delegate work to this Station — see Devices',
      }
    : {
        label: 'Paired for delegation',
        title:
          'This peer was paired to delegate work, but its access no longer allows it — see Devices',
      };
}

/**
 * station#1878 slice 1: how this device's pairing request reached the host
 * and, for a tailnet request, who asked — the same provenance the operator's
 * approval decision already saw, now visible on the device row instead of
 * discarded after approval. `null` for a device paired before this field
 * existed (no such key in its persisted record): rendered as nothing rather
 * than a guess.
 */
export function describeDeviceProvenance(device: PairedDevice): string | null {
  if (device.source === undefined) return null;
  if (device.source === 'tailnet') {
    const who = device.requester?.displayName ?? device.requester?.login;
    return who ? `Tailnet · ${who}` : 'Tailnet';
  }
  if (device.source === 'same-origin') return 'Same-origin';
  return 'Pairing code';
}

/** Bounded revocation provenance, never a guessed actor for upgraded records. */
export function describeDeviceRevocation(device: PairedDevice): string | null {
  if (device.revokedAt === null) return null;
  if (device.revocation.state === 'unobserved-before-revocation-provenance') {
    return 'Revocation provenance unavailable';
  }
  if (device.revocation.state === 'recorded') {
    return device.revocation.actor === 'operator-credential'
      ? 'Revoked by the Station operator · Owner request'
      : 'Replaced by the same client instance';
  }
  return null;
}

/**
 * "just now" / "8 minutes ago" / "3 days ago", falling back to a plain date
 * once the elapsed time stops being easier to read than the date itself.
 *
 * A timestamp in the future is clamped to the present rather than rendered as
 * a negative age: hosts and clients keep their own clocks, and a few seconds of
 * skew should not produce "in 4 seconds".
 */
export function formatElapsed(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (elapsed < 7 * DAY_MS) {
    const days = Math.floor(elapsed / DAY_MS);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return new Date(timestamp).toLocaleDateString();
}

export interface DeviceActivity {
  /** Recent request activity — not a liveness check. See the module docblock. */
  recentlyActive: boolean;
  /** "Active recently", "Last used 8 minutes ago", "Never used". */
  lastUsedLabel: string;
  /** "Issued 3 days ago", when the registry recorded an issue timestamp. */
  pairedLabel: string;
  /** "Revoked 2 hours ago", or null while the device still has access. */
  revokedLabel: string | null;
}

export function describeDeviceActivity(
  device: PairedDevice,
  now: number,
): DeviceActivity {
  const recentlyActive =
    device.revokedAt === null &&
    device.lastUsedAt != null &&
    now - device.lastUsedAt < DEVICE_ACTIVE_WINDOW_MS;

  return {
    recentlyActive,
    lastUsedLabel:
      device.activityTracking === 'unobserved-before-activity-tracking'
        ? 'Activity before tracking is unavailable'
        : device.lastUsedAt == null
          ? 'Never used'
          : recentlyActive
            ? 'Active recently'
            : `Last used ${formatElapsed(device.lastUsedAt, now)}`,
    pairedLabel:
      device.issuedAt === undefined
        ? `Paired ${formatElapsed(device.createdAt, now)}`
        : `Issued ${formatElapsed(device.issuedAt, now)}`,
    revokedLabel:
      device.revokedAt === null
        ? null
        : `Revoked ${formatElapsed(device.revokedAt, now)}`,
  };
}

/**
 * Splits the registry into the two groups that answer different questions —
 * "who can reach this Station right now?" and "what did I already turn off?" —
 * because a revoked device rendered inline with active ones reads as a device
 * that still has access. Each group leads with its most recent activity.
 */
export function partitionPairedDevices(devices: readonly PairedDevice[]): {
  active: PairedDevice[];
  revoked: PairedDevice[];
} {
  const active: PairedDevice[] = [];
  const revoked: PairedDevice[] = [];
  for (const device of devices) {
    (device.revokedAt === null ? active : revoked).push(device);
  }
  active.sort(
    (a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt),
  );
  revoked.sort((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0));
  return { active, revoked };
}

/**
 * Why a revoke did not take effect. Revocation is the control a user reaches
 * for when they think access is compromised, so a failure has to say so — the
 * previous implementation ignored the response entirely and a rejected revoke
 * was indistinguishable from a successful one.
 */
export function deviceRevokeError(status: number): string {
  if (status === 401) {
    return 'This connection no longer has owner access. Reconnect it, then try again.';
  }
  if (status === 403) {
    return 'This Station does not allow device changes from the current app address.';
  }
  if (status === 404) {
    return 'That device is no longer in this Station’s list.';
  }
  return `This Station could not revoke that device (HTTP ${status}).`;
}
