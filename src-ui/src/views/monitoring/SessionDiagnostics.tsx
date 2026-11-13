import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { Empty } from '../../components/state';
import { sessionRecency, sessionTitle } from '../../utils/sessionDisplay';

export function SessionDiagnostics({
  sessions,
  readStatus,
}: {
  sessions: OrchestrationSessionSummary[] | undefined;
  readStatus: 'pending' | 'success' | 'error';
}) {
  if (readStatus !== 'success') return null;
  const active = (sessions ?? [])
    .filter(
      (session) =>
        session.hasActiveTurn ||
        session.blockedReason ||
        session.lastRuntimeErrorMessage,
    )
    .sort(
      (left, right) =>
        Number(!!right.hasActiveTurn) - Number(!!left.hasActiveTurn) ||
        sessionRecency(right) - sessionRecency(left),
    );
  return (
    <details className="monitoring-sessions">
      <summary>
        Session diagnostics · {active.length} running or reporting a
        blocker/error
      </summary>
      <div className="developer-tab__header-row">
        <p className="developer-tab__hint">
          Current session records, independent of the event time filter.
        </p>
      </div>
      {active.length ? (
        <div className="diagnostic-table-scroll">
          <table className="diagnostic-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Engine</th>
                <th>Reported model</th>
                <th>State</th>
                <th>Latest reported event</th>
              </tr>
            </thead>
            <tbody>
              {active.slice(0, 50).map((session) => (
                <tr key={session.threadId}>
                  <th scope="row">{sessionTitle(session)}</th>
                  <td>{session.provider}</td>
                  <td>{session.reportedModel ?? 'Not reported'}</td>
                  <td>
                    {session.lastRuntimeErrorMessage ??
                      session.blockedReason ??
                      session.lifecycleState ??
                      session.status}
                  </td>
                  <td>
                    {session.lastEventMethod ?? 'Not reported'}
                    {session.lastEventAt && (
                      <small>
                        {' '}
                        · {new Date(session.lastEventAt).toLocaleTimeString()}
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          variant="compact"
          label="Nothing requires attention in this session read."
        />
      )}
    </details>
  );
}
