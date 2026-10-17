/** Only the server build banner supplies this value; runtime environment cannot enable it. */
export const STATION_AUTHOR_TELEMETRY_ENDPOINT =
  (
    globalThis as typeof globalThis & {
      __STATION_AUTHOR_TELEMETRY_ENDPOINT__?: string;
    }
  ).__STATION_AUTHOR_TELEMETRY_ENDPOINT__ ?? '';
