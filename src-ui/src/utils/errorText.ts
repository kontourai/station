import { describeStationFailure } from './stationFailure';

/** Safe request copy, including structured validation reasons. */
export function errorText(error: unknown): string {
  return describeStationFailure(error).body;
}

/** Compatibility entry point for existing form and request surfaces. */
export function userFacingErrorMessage(error: unknown): string {
  return errorText(error);
}
