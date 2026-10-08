import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { Button } from '../../components/Button';
import { useNavigationOptional } from '../../contexts/NavigationContext';
import { sessionRecency, sessionTitle } from '../../utils/sessionDisplay';

export function SessionDiagnostics({
  sessions,
  readStatus,
}: {
  sessions: OrchestrationSessionSummary[] | undefined;
  readStatus: 'pending' | 'success' | 'error';
}) {
  const navigation = useNavigationOptional();
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
        {navigation && (
          <Button size="sm" onClick={() => navigation.navigate('/activity')}>
            Open Activity
          </Button>
        )}
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
          {active.length > 50 && (
            <p>
              Showing 50 of {active.length} session records. Open Activity for
              the full inventory.
            </p>
          )}
        </div>
      ) : (
        <p>
          No sessions in this read report running work, a blocker, or a runtime
          error.
        </p>
      )}
    </details>
  );
}
