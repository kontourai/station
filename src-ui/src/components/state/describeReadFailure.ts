import type { StationConnection } from '../../connections/station-connection';
import { describeStationFailure } from '../../utils/stationFailure';

export const READ_FAILURE_FALLBACK = 'Try again in a moment.';
export const READ_FAILURE_UNREADABLE =
  'Station sent a response this app could not read.';
export const READ_FAILURE_UNREACHABLE =
  'Could not reach Station. Check the connection, then try again.';

/** Shared safe read copy; raw errors belong behind Details. */
export function describeReadFailure(
  error: unknown,
  connection?: StationConnection,
): string {
  return describeStationFailure(error, connection).body;
}
