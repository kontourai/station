/**
 * Who "this Station" is, for claims that are only true of ONE process
 * (station#1778 / ADR 0012).
 *
 * The answerability decoration on a session summary is such a claim: two
 * Station instances share `~/.station`, and the one holding an adapter for
 * `acme` and the one without it must truthfully give different answers for
 * the same session. `observedBy` is what makes that difference legible
 * instead of looking like a contradiction.
 *
 * `STATION_INSTANCE_ID` is the operator-facing name (`./station start
 * --instance=…`), and it is what a human recognises — but it is OPTIONAL and
 * defaults to `default`, so on a host running two unnamed instances it
 * identifies neither. The pid is appended unconditionally for that reason:
 * the instance label is the readable part and the pid is the part that
 * actually distinguishes, so the composite is a process identity rather than
 * a label that might be shared. Deliberately NOT stable across restarts —
 * an observation is only ever claimed for the process that made it, and a
 * restarted process re-observes.
 */
const SERVING_INSTANCE_IDENTITY = `${
  process.env.STATION_INSTANCE_ID || 'default'
}#${process.pid}`;

export function servingInstanceIdentity(): string {
  return SERVING_INSTANCE_IDENTITY;
}
