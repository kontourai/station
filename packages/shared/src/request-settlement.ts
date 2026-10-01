/**
 * Which requests a turn's abort has settled (#3071).
 *
 * Shared, not server-only, because the question is asked wherever a
 * `request.opened` / `request.resolved` log is folded: the server's session
 * summary and attention feed, and clients that fold the event stream
 * themselves (the CLI's `approvals` and `operate`). A fold that only looks
 * for `request.resolved` keeps offering a request nothing can answer.
 */
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * #3071: the requests a turn's abort has settled.
 *
 * A request is settled when the turn it belonged to is aborted after the
 * request was opened and nothing resolved it in between: the turn that asked
 * is gone, so no answer can reach it. Two aborts settle, by two different
 * links, because they prove different things.
 *
 * 1. A RECOVERY abort (`turn.aborted` with `recoveryTerminal`, written only
 *    by Station's interrupted-turn recovery) says the PROCESS died mid-turn.
 *    Everything that process was waiting on died with it, so it settles
 *    every unresolved request opened since that turn's `turn.started`,
 *    whether or not the request names a turn. Position is the only link most
 *    adapters leave (they stamp no turn id on a request), and here position
 *    is enough: a background subagent, a retry after an error, the turn
 *    itself — none of them outlived the process. A request opened before the
 *    turn started is not touched.
 *
 * 2. A LIVE abort — any other `turn.aborted`, or the
 *    `turn.completed(finishReason: 'cancelled')` an engine publishes to
 *    confirm a stop — says only that this one turn stopped. It settles the
 *    requests that NAME that turn (`request.opened.turnId`), and nothing
 *    else. A request with no turn id is NOT settled, deliberately: an engine
 *    can open one for work that outlives the turn (a background subagent
 *    that survives a stop, in the gap between the stop being asked and its
 *    abort being published), and a stale approval left visible is a smaller
 *    harm than a live one hidden. An adapter stamps a turn id only on a
 *    request it knows the turn itself is waiting on; the adapter holding a
 *    pending request also resolves it at the source on every live abort
 *    path, so this arm is a backstop, not the mechanism.
 *
 * Deliberately NOT settled:
 * - by an ordinary `turn.completed`. A background subagent can outlive the
 *   turn that spawned it, and its request stays answerable.
 * - by a `runtime.error` or `session.exited` alone. A deferred-retry error
 *   keeps the turn alive, and archive#1548 pins an approval that survives a
 *   failure as still outstanding.
 *
 * Aborts are matched by turn id, with no `acceptsTurnTerminalEvent` check:
 * an abort the lifecycle fold rejects as stale still says its own turn is
 * dead.
 *
 * Both arms read only the request's own event and the named turn's own
 * start and terminals, so the answer is the same over the full log and over
 * Station's bounded session projection, which carries exactly those rows
 * for every unresolved request (`EventStore.listRequestSettlementFacts`).
 */
export function requestIdsSettledByTurnAbort(
  events: readonly CanonicalRuntimeEvent[],
): Set<string> {
  const settled = new Set<string>();
  const open = new Map<string, { position: number; turnId?: string }>();
  const startPositionByTurnId = new Map<string, number>();
  events.forEach((event, position) => {
    if (event.method === 'turn.started') {
      if (event.turnId) startPositionByTurnId.set(event.turnId, position);
    } else if (event.method === 'request.opened') {
      // A re-opened request is a new ask; its earlier settlement is history.
      settled.delete(event.requestId);
      open.set(event.requestId, {
        position,
        ...(event.turnId ? { turnId: event.turnId } : {}),
      });
    } else if (event.method === 'request.resolved') {
      open.delete(event.requestId);
      settled.delete(event.requestId);
    } else if (event.method === 'turn.aborted' && event.recoveryTerminal) {
      const startedAt = startPositionByTurnId.get(event.turnId);
      if (startedAt === undefined) return;
      for (const [requestId, request] of open) {
        if (request.position < startedAt) continue;
        open.delete(requestId);
        settled.add(requestId);
      }
    } else if (
      event.turnId &&
      (event.method === 'turn.aborted' ||
        (event.method === 'turn.completed' &&
          event.finishReason === 'cancelled'))
    ) {
      for (const [requestId, request] of open) {
        if (request.turnId !== event.turnId) continue;
        open.delete(requestId);
        settled.add(requestId);
      }
    }
  });
  return settled;
}
