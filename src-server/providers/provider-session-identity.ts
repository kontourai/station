import type { ProviderSessionSourceAffinity } from '@kontourai/station-contracts/provider';
import type {
  ProviderAdapterShape,
  ProviderNativeSessionIdentity,
} from './adapter-shape.js';
import {
  isSessionSourceAffinity,
  snapshotSessionSourceAffinity,
} from './sessions/session-source-affinity.js';

const MAX_NATIVE_SESSION_ID_BYTES = 512;

/** Safely project one opaque provider cursor into its duplicate-suppression identity. */
export function providerNativeSessionIdentity(
  adapter: ProviderAdapterShape | undefined,
  resumeCursor: unknown,
): Readonly<ProviderNativeSessionIdentity> | undefined {
  try {
    const projected = adapter?.nativeSessionIdentity
      ? adapter.nativeSessionIdentity(resumeCursor)
      : typeof resumeCursor === 'string'
        ? { sessionId: resumeCursor }
        : undefined;
    if (
      !projected ||
      typeof projected !== 'object' ||
      Array.isArray(projected) ||
      typeof projected.sessionId !== 'string' ||
      !projected.sessionId.trim() ||
      Buffer.byteLength(projected.sessionId, 'utf8') >
        MAX_NATIVE_SESSION_ID_BYTES ||
      (projected.affinity !== undefined &&
        !isSessionSourceAffinity(projected.affinity))
    ) {
      return undefined;
    }
    return Object.freeze({
      sessionId: projected.sessionId,
      ...(projected.affinity
        ? { affinity: snapshotSessionSourceAffinity(projected.affinity) }
        : {}),
    });
  } catch {
    return undefined;
  }
}

/** Match an owned native identity to a discovered source without crossing known homes. */
export function nativeSessionIdentityMatchesSource(
  identity: Readonly<ProviderNativeSessionIdentity> | undefined,
  sessionId: string,
  affinity: ProviderSessionSourceAffinity | undefined,
): boolean {
  if (!identity || identity.sessionId !== sessionId) return false;
  // Old persisted string cursors and attachments predate source affinity.
  // Preserve their session-id match; once both sides know a home, require it.
  if (!identity.affinity || !affinity) return true;
  return (
    identity.affinity.kind === affinity.kind &&
    identity.affinity.ref === affinity.ref
  );
}
