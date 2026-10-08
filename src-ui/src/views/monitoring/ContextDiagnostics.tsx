import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useStats } from '../../contexts/StatsContext';
import { sessionTitle } from '../../utils/sessionDisplay';

export function ContextDiagnostics({
  sessions,
  readStatus,
}: {
  sessions: OrchestrationSessionSummary[] | undefined;
  readStatus: 'pending' | 'error' | 'success';
}) {
  const candidates =
    readStatus === 'success'
      ? (sessions ?? []).filter(
          (session) => session.assignedAgentSlug && session.conversationId,
        )
      : [];
  const [selected, setSelected] = useState('');
  const session =
    candidates.find((candidate) => candidate.threadId === selected) ??
    candidates[0];
  const { stats, error, loading, refetch } = useStats(
    session?.assignedAgentSlug ?? '',
    session?.conversationId ?? '',
    undefined,
    !!session,
    5_000,
  );
  const source = stats?.measurement?.source;
  const value =
    stats?.notFound || !source ? undefined : stats?.contextWindowPercentage;
  const percentage =
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  return (
    <section className="monitoring-page__scroll" aria-label="Context usage">
      <h2>Context usage</h2>
      <p className="developer-tab__hint">
        Latest conversation statistics. Engine observations and Station
        estimates are labeled separately. Context occupancy is not consumed
        tokens.
      </p>
      {readStatus === 'error' ? (
        <ErrorState variant="compact" title="Session inventory unavailable" />
      ) : readStatus === 'pending' ? (
        <SkeletonBlock count={1} label="Reading sessions" />
      ) : !session ? (
        <Empty
          variant="compact"
          label="Conversation statistics binding unavailable"
          description="Open a conversation with a configured Agent to inspect its reported context."
        />
      ) : (
        <>
          <label>
            Conversation
            <select
              className="editor-select"
              value={session.threadId}
              onChange={(event) => setSelected(event.target.value)}
            >
              {candidates.map((candidate) => (
                <option key={candidate.threadId} value={candidate.threadId}>
                  {sessionTitle(candidate)}
                </option>
              ))}
            </select>
          </label>
          {loading ? (
            <SkeletonBlock count={1} label="Reading context" />
          ) : error ? (
            <ErrorState
              variant="compact"
              title="Context could not be read"
              action={
                <Button size="sm" onClick={() => void refetch()}>
                  Retry
                </Button>
              }
            />
          ) : (
            <dl className="system-tab__facts">
              <div>
                <dt>
                  {source === 'station-memory'
                    ? 'Estimated context occupancy'
                    : 'Reported context occupancy'}
                </dt>
                <dd>
                  {percentage === undefined
                    ? 'Not reported'
                    : `${percentage.toFixed(1)}%`}
                </dd>
              </div>
              <div>
                <dt>Engine</dt>
                <dd>{session.provider}</dd>
              </div>
              <div>
                <dt>Reported model</dt>
                <dd>{session.reportedModel ?? 'Not reported'}</dd>
              </div>
            </dl>
          )}
        </>
      )}
    </section>
  );
}
