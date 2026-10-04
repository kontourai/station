import type {
  TokenReports,
  UsageStats,
} from '@kontourai/station-contracts/usage-stats';
import { StationHttpError, useStationUsageQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import './UsageRollupPanel.css';

type Group = 'provider' | 'model' | 'principal' | 'date';
interface Row {
  id: string;
  label: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  tokenReports?: TokenReports;
  reportedCostUsd?: number;
  estimatedCostUsd?: number;
}

function rowsFor(stats: UsageStats, group: Group): Row[] {
  const rows: Row[] =
    group === 'principal'
      ? Object.entries(stats.byPrincipal ?? {}).map(([id, entry]) => ({
          id: `${group}:${id}`,
          label: entry.principal.display,
          ...entry.usage,
        }))
      : Object.entries(
          group === 'provider'
            ? (stats.byProvider ?? {})
            : group === 'model'
              ? stats.byModel
              : stats.byDate,
        ).map(([id, usage]) => ({ id: `${group}:${id}`, label: id, ...usage }));
  const unknown = stats.unallocated?.[group];
  if (unknown)
    rows.push({
      id: 'unallocated',
      label: 'Unknown / unallocated',
      ...unknown,
    });
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

const amount = (value: number | undefined) =>
  value === undefined ? '—' : `${value.toFixed(4)} USD`;

export function StationUsagePanel() {
  const scope = useHostRequestAuthorityScope();
  const [expanded, setExpanded] = useState(false);
  const [group, setGroup] = useState<Group>('provider');
  const query = useStationUsageQuery(scope ?? undefined, { enabled: expanded });
  const overview = scope?.isCurrent() && !query.error ? query.data : undefined;
  const rows = overview ? rowsFor(overview.stats, group) : [];
  return (
    <section className="usage-rollup" aria-labelledby="station-usage-title">
      <div className="usage-rollup__header">
        <div>
          <h3 id="station-usage-title">This Station · operator overview</h3>
          <p>
            Recorded usage across this instance. Peer Stations are excluded.
          </p>
        </div>
        <Button
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Hide overview' : 'View station usage'}
        </Button>
      </div>
      {expanded &&
        (!scope ? (
          <p>Connect to this Station to read its overview.</p>
        ) : query.isLoading ? (
          <SkeletonBlock count={2} label="Loading station usage" />
        ) : query.error ? (
          <ErrorState
            variant="compact"
            title="Station overview unavailable"
            description={
              query.error instanceof StationHttpError &&
              [401, 403].includes(query.error.status)
                ? 'Local operator access is required. Automatic refresh is paused.'
                : 'The current connection could not read this instance.'
            }
            action={
              <Button size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            }
          />
        ) : overview ? (
          <>
            <p>
              {overview.stats.lifetime.totalMessages.toLocaleString()} recorded
              messages or completed turns
              {' · '}
              {overview.stats.lifetime.totalConversations.toLocaleString()}{' '}
              conversations
            </p>
            <p>
              Snapshot rebuilt{' '}
              {overview.stats.snapshot?.rescannedAt ?? 'at an unknown time'}.{' '}
              Figures cover retained observations. Missing measurements and
              attribution remain unknown.
            </p>
            <div className="usage-rollup__controls">
              <label>
                Breakdown{' '}
                <select
                  value={group}
                  onChange={(event) => setGroup(event.target.value as Group)}
                >
                  <option value="provider">Recorded engine / provider</option>
                  <option value="model">Model</option>
                  <option value="principal">Recorded person / principal</option>
                  <option value="date">Recorded UTC day</option>
                </select>
              </label>
            </div>
            <p>
              Reported costs and estimates are separate subtotals. A person is
              attributed only from recorded identity evidence.
            </p>
            <details>
              <summary>Measurement coverage</summary>
              <p>
                This overview includes retained conversation history and engine
                sessions. Direct invocations, inference served for peers, voice,
                realtime, embeddings, and provider activity outside recorded
                sessions are not independently metered here. Fleet-routed usage
                recorded in a conversation is counted once.
              </p>
              <p>
                Context occupancy is not consumed tokens. Some harnesses report
                activity without token or cost measurements. UTC days describe
                recorded observations, not exact billing dates.
              </p>
              <p>
                Engine source:{' '}
                {overview.stats.snapshot?.engineUsage ?? 'unknown'}. Skipped
                message records:{' '}
                {overview.stats.snapshot?.skippedMessages ?? 'unknown'}. Saved
                messages missing cost:{' '}
                {overview.stats.snapshot?.missingMessageCosts ?? 'unknown'}.
              </p>
            </details>
            <div className="usage-rollup__table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Messages / turns</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Reported cost</th>
                    <th>Estimate</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">{row.label}</th>
                      <td>{row.messages.toLocaleString()}</td>
                      <td>
                        {row.tokenReports?.input
                          ? row.inputTokens.toLocaleString()
                          : '—'}
                      </td>
                      <td>
                        {row.tokenReports?.output
                          ? row.outputTokens.toLocaleString()
                          : '—'}
                      </td>
                      <td>{amount(row.reportedCostUsd)}</td>
                      <td>{amount(row.estimatedCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {overview.stats.snapshot?.mirroredEngineActivity && (
              <p>{overview.stats.snapshot.mirroredEngineActivity.reason}</p>
            )}
            {overview.stats.snapshot?.ambiguousRelayActivity && (
              <p>
                {overview.stats.snapshot.ambiguousRelayActivity.completedTurns.toLocaleString()}{' '}
                unresolved relay turns are excluded from these totals:{' '}
                {overview.stats.snapshot.ambiguousRelayActivity.reason}
              </p>
            )}
            {overview.stats.legacySummary && (
              <p>
                An older summary is retained as unverified migration evidence
                and excluded from these totals.
              </p>
            )}
          </>
        ) : (
          <Empty variant="compact" label="Station usage not reported" />
        ))}
    </section>
  );
}
