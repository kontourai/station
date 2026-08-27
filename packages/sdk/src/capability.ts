/**
 * Feature-detection accessor for the public handshake's `capabilities`
 * flags (station#1095, `PublicStationHandshake.capabilities`,
 * `StationCapabilityFlags` in `@kontourai/station-contracts`).
 *
 * Absence — of the whole `capabilities` object, or of a specific key —
 * always reads as unsupported, never as an error: it is either an older
 * host that predates the flag, or a host that never seeded it. Callers
 * should treat `hasCapability` the same way they would treat any other
 * feature-detection check: gate behavior on it, don't throw when it is
 * false.
 */
import type {
  PublicStationHandshake,
  StationCapabilityFlags,
} from '@kontourai/station-contracts';

export function hasCapability(
  descriptor: Pick<PublicStationHandshake, 'capabilities'> | null | undefined,
  name: keyof StationCapabilityFlags,
): boolean {
  return descriptor?.capabilities?.[name] === true;
}
