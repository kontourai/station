import type {
  TokenReports,
  UsageStats,
} from '@kontourai/station-contracts/usage-stats';
import { StationHttpError } from '@kontourai/station-sdk';
import { useStationUsageQuery } from '@kontourai/station-sdk/station-usage-query';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import { ArrowDownGlyph } from '../icons/Glyph';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import './UsageRollupPanel.css';
import './StationUsagePanel.css';

type Group = 'provider' | 'model' | 'principal' | 'date';
interface Row {
  id: string;
  label: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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
  return rows.sort(
    (a, b) => b.messages - a.messages || a.label.localeCompare(b.label),
  );
}

const amount = (value: number | undefined) =>
  value === undefined ? '—' : `${value.toFixed(4)} USD`;

export function StationUsagePanel({ initiallyExpanded = false }: { initiallyExpanded?: boolean }) {
  const scope = useHostRequestAuthorityScope();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [group, setGroup] = useState<Group>('provider');
  const query = useStationUsageQuery(scope ?? undefined, {
    enabled: expanded,
    keepPreviousData: false,
  });
  const overview = scope?.isCurrent() && !query.error ? query.data : undefined;
  const rows = overview ? rowsFor(overview.stats, group) : [];
  const peak = rows.reduce((max, row) => Math.max(max, row.messages), 1);
  return (
    <section
      className="usage-rollup station-usage"
      aria-labelledby="station-usage-title"
    >
      <div className="usage-rollup__header">
        <div>
          <h3 id="station-usage-title">This Station</h3>
          <p>Operator view · local usage only</p>
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
            <dl className="station-usage__totals">
              <div>
                <dt>Messages / turns</dt>
                <dd>
                  {overview.stats.lifetime.totalMessages.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Conversations</dt>
                <dd>
                  {overview.stats.lifetime.totalConversations.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Reported cost</dt>
                <dd>{amount(overview.stats.lifetime.reportedCostUsd)}</dd>
              </div>
              <div>
                <dt>Estimate</dt>
                <dd>{amount(overview.stats.lifetime.estimatedCostUsd)}</dd>
              </div>
            </dl>
            <div className="usage-rollup__controls">
              <label className="station-usage__filter">
                <span>Breakdown</span>
                <span className="station-usage__picker">
                  <select
                    className="choice-trigger"
                    value={group}
                    onChange={(event) => setGroup(event.target.value as Group)}
                  >
                    <option value="provider">Provider / engine</option>
                    <option value="model">Model</option>
                    <option value="principal">Person</option>
                    <option value="date">UTC day</option>
                  </select>
                  <ArrowDownGlyph className="choice-caret" />
                </span>
              </label>
            </div>
            {rows.length > 0 ? (
              <ol
                className="station-usage__ranking"
                aria-label="Recorded activity breakdown"
              >
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className={
                      row.id === 'unallocated'
                        ? 'station-usage__unknown'
                        : undefined
                    }
                  >
                    <div className="station-usage__rank-label">
                      <span>{row.label}</span>
                      <strong>{row.messages.toLocaleString()}</strong>
                    </div>
                    <div className="station-usage__track" aria-hidden="true">
                      <span
                        style={{ width: `${(row.messages / peak) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty
                variant="compact"
                label="Nothing recorded in this breakdown"
              />
            )}
            <details className="station-usage__details">
              <summary>Tokens & costs</summary>
              <div className="usage-rollup__table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th>Messages / turns</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Cache read</th>
                      <th>Cache write</th>
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
                        <td>
                          {row.tokenReports?.cacheRead
                            ? (row.cacheReadTokens?.toLocaleString() ?? '—')
                            : '—'}
                        </td>
                        <td>
                          {row.tokenReports?.cacheWrite
                            ? (row.cacheWriteTokens?.toLocaleString() ?? '—')
                            : '—'}
                        </td>
                        <td>{amount(row.reportedCostUsd)}</td>
                        <td>{amount(row.estimatedCostUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <details className="station-usage__details">
              <summary>Coverage & sources</summary>
              <p>
                Retained conversations and engine sessions only. Direct
                invocations, peer serving, voice, realtime, embeddings and
                unrecorded provider activity are not metered here. Fleet usage
                saved in conversations is counted once.
              </p>
              <p>
                Missing measurements show —; reported zero stays zero. Context
                occupancy is not consumed tokens. Dates use recorded UTC days;
                people require recorded identity. Unknown attribution stays
                unallocated. Costs are partial reported totals and estimates,
                not a bill.
              </p>
              <dl className="station-usage__sources">
                <div>
                  <dt>Updated</dt>
                  <dd>
                    {overview.stats.snapshot?.rescannedAt
                      ? new Date(
                          overview.stats.snapshot.rescannedAt,
                        ).toLocaleString()
                      : 'Unknown'}
                  </dd>
                </div>
                <div>
                  <dt>Engine source</dt>
                  <dd>{overview.stats.snapshot?.engineUsage ?? 'unknown'}</dd>
                </div>
                <div>
                  <dt>Unreadable messages</dt>
                  <dd>
                    {overview.stats.snapshot?.skippedMessages ?? 'unknown'}
                  </dd>
                </div>
                <div>
                  <dt>Messages without cost</dt>
                  <dd>
                    {overview.stats.snapshot?.missingMessageCosts ?? 'unknown'}
                  </dd>
                </div>
              </dl>
            </details>
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
