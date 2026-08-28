import type { DiagnosticsEntry } from '../../utils/sessionDiagnosticsLog';

/**
 * #1170: demoted, collapsed by default — this is the diagnostic raw log,
 * not the primary content. `entries` is already deduped/coalesced by
 * `buildDiagnosticsLog` (duplicate event names, repeated identical events,
 * and split text-delta fragments) — see that module for why `renderKey`
 * (not `key`) is the React list key. Split out of `MutableSessionDetail`
 * per archive#1204.
 */
export function SessionDetailDiagnostics({
  eventCount,
  entries,
}: {
  eventCount: number;
  entries: DiagnosticsEntry[];
}) {
  return (
    <details
      className="sessions-detail__diagnostics"
      data-testid="session-diagnostics"
    >
      <summary>
        Details · {eventCount} event{eventCount === 1 ? '' : 's'}
      </summary>
      <div className="sessions-detail__feed" data-testid="session-feed">
        {eventCount === 0 ? (
          <p className="sessions-detail__feed-empty">
            Waiting for live events from this session…
          </p>
        ) : (
          entries.map((entry) => (
            <div className="sessions-detail__event" key={entry.renderKey}>
              <span className="sessions-detail__event-method">
                {entry.method}
                {entry.count > 1 ? ` ×${entry.count}` : ''}
              </span>
              {entry.body && (
                <span className="sessions-detail__event-body">
                  {entry.body}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </details>
  );
}
