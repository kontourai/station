import { DetailHeader } from '../../components/DetailHeader';

export function MonitoringHeader({
  sessionCounts,
  sessionReadStatus,
  onRetrySessionRead,
  connectionStatus,
  children,
}: {
/**
* Derived from the orchestration session read-model — the same projection
* the chat dock and Developer -> Archive read. These used
* to be `stats.summary.activeAgents/runningAgents`, folded from the
* monitoring event store, which reported 0/0 while a real turn was running
* in the dock.
*/
  sessionCounts: { activeSessions: number; runningTurns: number } | null;
/** The session read's own state — see the counts' honesty note below. */
  sessionReadStatus: 'pending' | 'error' | 'success';
  onRetrySessionRead: () => void;
  connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'error';
  children: React.ReactNode;
}) {
  return (
    <DetailHeader
      title="Monitoring"
      subtitle="Live agent activity, health, and usage"
      icon={
        <div
          className="status-badge"
          role="status"
          aria-label={`Monitoring connection ${connectionStatus}`}
          title={`Monitoring connection ${connectionStatus}`}
        >
          <span className={`status-dot status-dot-${connectionStatus}`}></span>
        </div>
      }
    >
      <div className="monitoring-summary">
 {/* A number here is a claim about this Station.
            Until the read succeeds there is no number to make — `—` while it
            is in flight, and a retry when it failed, rather than a `0` that
            reads as "nothing is running". */}
        <span className="stat-item">
{/* Named for what is now counted: sessions, not agents. */}
          <span className="stat-label">Active sessions:</span>
          <span className="stat-value" data-testid="monitoring-active-sessions">
            {sessionCounts ? sessionCounts.activeSessions : '—'}
          </span>
        </span>
        <span className="stat-item">
          <span className="stat-label">Running turns:</span>
          <span className="stat-value" data-testid="monitoring-running-turns">
            {sessionCounts ? sessionCounts.runningTurns : '—'}
          </span>
        </span>
        {sessionReadStatus === 'pending' && (
          <span className="stat-item" role="status">
            <span className="stat-label">Reading sessions…</span>
          </span>
        )}
        {sessionReadStatus === 'error' && (
          <span className="stat-item" role="alert">
            <span className="stat-label">Session records unavailable</span>
            <button
              type="button"
              className="button button--secondary"
              onClick={onRetrySessionRead}
            >
              Retry
            </button>
          </span>
        )}
      </div>
      <div className="monitoring-header-actions">{children}</div>
    </DetailHeader>
  );
}
