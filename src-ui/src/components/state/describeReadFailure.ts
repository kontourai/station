import type { StationConnection } from '../../connections/station-connection';
import {
  describeStationFailure,
  STATION_FAILURE_UNREACHABLE,
  STATION_FAILURE_UNREADABLE,
} from '../../utils/stationFailure';

export const READ_FAILURE_FALLBACK = 'Try again in a moment.';
export const READ_FAILURE_UNREADABLE = STATION_FAILURE_UNREADABLE;
export const READ_FAILURE_UNREACHABLE = STATION_FAILURE_UNREACHABLE;

/** Shared safe read copy; raw errors belong behind Details. */
export function describeReadFailure(
  error: unknown,
  connection?: StationConnection,
): string {
  return describeStationFailure(error, connection).body;
}
