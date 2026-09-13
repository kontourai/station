// Runtime parsers for the two update-identity responses (update-ux PR2).
//
// Contract types come from the published contracts package; the status shape
// itself is the SDK's `CoreUpdateStatus` (type-only import, mirroring
// `core-update-restart-expectation.ts`). Parsing rules:
//
// - Required facts (the identity triple, `updateAvailable`, supplied
//   behind/ahead counts) are REJECTED when malformed — a half-valid update
//   check must not read as a valid one.
// - Newer optional diagnostics are normalized, never trusted: an invalid
//   identity or presentation becomes unavailable (null/omitted), and an
//   unknown provenance code stays unknown (null) — it must not collapse into
//   'missing', which would state a specific reason nobody computed.
// - Omitted diagnostics (older servers) are accepted and normalized to null.
// - `applyMethod` is passed through verbatim and never derived from
//   `updateAvailable`.
import type {
  DevicePresentation,
  SystemIdentityResponse,
  SystemRuntimeIdentity,
  UpdateProvenanceIssue,
} from '@kontourai/station-contracts/system-status';
import type { CoreUpdateStatus } from './query-domains/systemRuntime';

/** The SHA rule `build-provenance.ts` validates its identity sha against. */
const GIT_SHA = /^[0-9a-f]{40,64}$/i;

const PROVENANCE_ISSUES: readonly UpdateProvenanceIssue[] = [
  'missing',
  'invalid-stamp',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeServerIdentity(value: unknown): SystemRuntimeIdentity | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.instanceId) ||
    !isNonEmptyString(value.bootId) ||
    typeof value.sha !== 'string' ||
    !GIT_SHA.test(value.sha)
  ) {
    return null;
  }
  const shaSource =
    value.shaSource === 'build-stamp' || value.shaSource === 'checkout'
      ? value.shaSource
      : undefined;
  return {
    instanceId: value.instanceId,
    bootId: value.bootId,
    sha: value.sha,
    ...(shaSource ? { shaSource } : {}),
  };
}

function normalizeDevicePresentation(
  value: unknown,
): DevicePresentation | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.deviceClass !== 'host' && value.deviceClass !== 'paired') ||
    !isNonEmptyString(value.hostName)
  ) {
    return undefined;
  }
  return { deviceClass: value.deviceClass, hostName: value.hostName };
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parse a `GET /api/system/identity` response. Throws when the identity
 * triple is incomplete or malformed — an identity is the one thing this
 * endpoint must not serve partially. Optional metadata (shaSource label,
 * devicePresentation) is dropped rather than trusted when it arrives
 * malformed, so an identity is never decorated with metadata nobody proved.
 */
export function parseSystemIdentityResponse(
  value: unknown,
): SystemIdentityResponse {
  if (!isRecord(value)) {
    throw new Error('System identity is unavailable');
  }
  if (
    !isNonEmptyString(value.instanceId) ||
    !isNonEmptyString(value.bootId) ||
    typeof value.sha !== 'string' ||
    !GIT_SHA.test(value.sha)
  ) {
    throw new Error('System identity is unavailable');
  }
  const devicePresentation = normalizeDevicePresentation(
    value.devicePresentation,
  );
  return {
    instanceId: value.instanceId,
    bootId: value.bootId,
    sha: value.sha,
    ...(value.shaSource === 'build-stamp' || value.shaSource === 'checkout'
      ? { shaSource: value.shaSource }
      : {}),
    ...(devicePresentation ? { devicePresentation } : {}),
  };
}

/**
 * Parse a `GET /api/system/core-update` status. Throws on a non-boolean
 * `updateAvailable` or a malformed supplied count/flag used for state
 * derivation; normalizes every optional diagnostic to a null-when-unavailable
 * value so consumers never branch on `undefined` vs a fabricated default.
 * The `error` field passes through untouched — throwing on it stays the
 * request boundary's existing behavior.
 */
export function parseSystemUpdateStatus(value: unknown): CoreUpdateStatus {
  if (!isRecord(value)) {
    throw new Error('Core update status is unavailable');
  }
  // A genuine error document is not held to the status shape: it passes
  // through with normalized diagnostics so the request boundary's existing
  // behavior — throwing on a nonempty `error` — is preserved verbatim, even
  // for an older server that sends nothing else alongside it.
  if (isNonEmptyString(value.error)) {
    return {
      updateAvailable: value.updateAvailable === true,
      error: value.error,
      serverIdentity: null,
      provenanceIssue: null,
      technicalDetail: normalizeOptionalText(value.technicalDetail),
      selfUpdateUnavailableReason: null,
    };
  }
  if (typeof value.updateAvailable !== 'boolean') {
    throw new Error('Core update status is unavailable');
  }
  for (const field of ['behind', 'ahead'] as const) {
    const supplied = value[field];
    if (supplied !== undefined && !Number.isSafeInteger(supplied)) {
      throw new Error('Core update status is unavailable');
    }
  }
  for (const field of ['noUpstream', 'remoteUnreachable'] as const) {
    const supplied = value[field];
    if (supplied !== undefined && typeof supplied !== 'boolean') {
      throw new Error('Core update status is unavailable');
    }
  }

  // An unknown provenance code is a FUTURE code: it stays unknown (null).
  // Collapsing it into 'missing' would render a specific reason the server
  // never claimed.
  const provenanceIssue = PROVENANCE_ISSUES.includes(
    value.provenanceIssue as UpdateProvenanceIssue,
  )
    ? (value.provenanceIssue as UpdateProvenanceIssue)
    : null;

  return {
    currentHash:
      typeof value.currentHash === 'string' ? value.currentHash : undefined,
    remoteHash:
      typeof value.remoteHash === 'string' ? value.remoteHash : undefined,
    branch: typeof value.branch === 'string' ? value.branch : undefined,
    behind: value.behind as number | undefined,
    ahead: value.ahead as number | undefined,
    updateAvailable: value.updateAvailable,
    noUpstream: value.noUpstream as boolean | undefined,
    installKind: value.installKind as CoreUpdateStatus['installKind'],
    channel: typeof value.channel === 'string' ? value.channel : undefined,
    applyMethod: value.applyMethod as CoreUpdateStatus['applyMethod'],
    remoteUnreachable: value.remoteUnreachable as boolean | undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
    serverIdentity: normalizeServerIdentity(value.serverIdentity),
    provenanceIssue,
    technicalDetail: normalizeOptionalText(value.technicalDetail),
    selfUpdateUnavailableReason: normalizeOptionalText(
      value.selfUpdateUnavailableReason,
    ),
  };
}
