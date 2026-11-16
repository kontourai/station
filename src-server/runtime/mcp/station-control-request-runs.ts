/**
 * #2377 slice D: the server records for a station-control "request run".
 *
 * Station's own engine also runs outside any orchestration session: the
 * invoke endpoints (`/agents/:slug/invoke`, `/agents/:slug/invoke/stream`,
 * `/invoke`), the raw tool call (`POST /agents/:slug/tools/:toolName`), a
 * direct chat stream, and an untargeted scheduled job. The HTTP runs act for
 * the request's resolved principal; a scheduled job's run acts for the
 * owner recorded when it was created. A run is given its own opaque id (never a session id a
 * client can name) and the principal Station resolved for the request, and
 * the caller-record resolver answers for it exactly as it answers for a
 * session's recorded owner (`createStationControlCallerRecordResolver`).
 *
 * Dependency-free on purpose: the caller module and the native tools both
 * read it, and neither may import the other's graph.
 */

export interface StationControlRequestRunRecord {
  /** The principal Station resolved for the authenticated request. */
  readonly principalId: string;
}

const RUN_PREFIX = 'station-request-run:';
const runs = new Map<string, StationControlRequestRunRecord>();

/** Register a run; the id is server-minted and unguessable. */
export function registerStationControlRequestRun(
  record: StationControlRequestRunRecord,
): string {
  const id = `${RUN_PREFIX}${crypto.randomUUID()}`;
  runs.set(id, Object.freeze({ ...record }));
  return id;
}

/** The record of a live run, or `undefined` for anything else. */
export function stationControlRequestRun(
  id: string,
): StationControlRequestRunRecord | undefined {
  return id.startsWith(RUN_PREFIX) ? runs.get(id) : undefined;
}

export function forgetStationControlRequestRun(id: string): void {
  runs.delete(id);
}

/** Test-only: how many runs are live. */
export function __countStationControlRequestRunsForTests(): number {
  return runs.size;
}
