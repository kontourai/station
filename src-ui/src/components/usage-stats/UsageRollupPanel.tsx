import { taskStatusLabel } from '@kontourai/station-contracts/task-graph';
import type {
  UsageCoverage,
  UsageReceipt,
  UsageRollupRow,
} from '@kontourai/station-contracts/usage-rollup';
import {
  type UsageRollupQuery,
  useUsageRollupQuery,
} from '@kontourai/station-sdk/usage-rollup-query';
import { Badge } from '@kontourai/ui/react';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import './UsageRollupPanel.css';

type Days = 7 | 14 | 30;
type GroupBy = NonNullable<UsageRollupQuery['groupBy']>;

function tokens(value: number | undefined) {
  return value === undefined ? '—' : value.toLocaleString();
}

function cost(
  single: { amount: number; currency: string } | undefined,
  buckets: Array<{ amount: number; currency: string }> | undefined,
) {
  if (single) return `${single.amount.toFixed(4)} ${single.currency}`;
  if (buckets?.length === 1)
    return `${buckets[0]!.amount.toFixed(4)} ${buckets[0]!.currency}`;
  if (buckets?.length)
    return `Mixed: ${buckets
      .map((bucket) => `${bucket.amount.toFixed(4)} ${bucket.currency}`)
      .join(', ')}`;
  return '—';
}

function snapshotLabel(value: {
  pricingSnapshotId: string;
  pricingSnapshotObservedAt?: string;
  pricingSnapshotCapturedAt?: string;
  pricingSnapshotSource?: string;
}) {
  const capturedAt =
    value.pricingSnapshotObservedAt ?? value.pricingSnapshotCapturedAt;
  return `${value.pricingSnapshotId}${value.pricingSnapshotSource ? ` from ${value.pricingSnapshotSource}` : ''}${capturedAt ? `, captured ${capturedAt}` : ''}`;
}

/** Table-first read surface; coverage is displayed before any numeric claim. */
export function UsageRollupPanel() {
  const scope = useHostRequestAuthorityScope();
  const [days, setDays] = useState<Days>(14);
  const [groupBy, setGroupBy] = useState<GroupBy>('provider');
  const scopeKey = JSON.stringify([scope?.apiBase, scope?.authorityKey]);
  const [cursorState, setCursorState] = useState<{
    scopeKey: string;
    value: string;
  }>();
  const cursor =
    cursorState?.scopeKey === scopeKey ? cursorState.value : undefined;
  const setCursor = (value: string | undefined) =>
    setCursorState(value ? { scopeKey, value } : undefined);
  const [showCoverage, setShowCoverage] = useState(false);
  const [showReceipts, setShowReceipts] = useState(false);
  const {
    data: response,
    isLoading,
    error,
    refetch,
  } = useUsageRollupQuery(
    {
      days,
      groupBy,
      cursor,
      pageSize: 25,
    },
    {
      requestScope: scope ?? undefined,
      requireRequestScope: true,
      keepPreviousData: false,
    },
  );
  const data = scope?.isCurrent() && !error ? response : undefined;
  const coverage = error ? [] : (data?.coverage ?? []);
  const hasGap =
    coverage.length === 0 || coverage.some((item) => item.state !== 'complete');
  const neverReported = !isLoading && !error && coverage.length === 0;

  return (
    <section className="usage-rollup" aria-labelledby="usage-rollup-title">
      <div className="usage-rollup__header">
        <div>
          <h3 id="usage-rollup-title">Usage across Stations</h3>
          <p>
            Provider-reported usage and estimates remain separate. Missing data
            is not zero.
          </p>
          <p>
            Summary-generation tokens appear in compaction details, outside
            these totals.
          </p>
        </div>
        <button
          type="button"
          className={
            hasGap
              ? 'usage-rollup__coverage usage-rollup__coverage--gap'
              : 'usage-rollup__coverage'
          }
          onClick={() => setShowCoverage(true)}
        >
          {error
            ? 'Coverage unavailable'
            : !scope?.isCurrent()
              ? 'Connection required'
              : isLoading
                ? 'Loading coverage'
                : neverReported
                  ? 'Usage never reported'
                  : hasGap
                    ? 'Coverage incomplete'
                    : 'Coverage complete'}
        </button>
      </div>
      <div className="usage-rollup__controls">
        <fieldset>
          <legend>Window</legend>
          {([7, 14, 30] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={days === value}
              onClick={() => {
                setDays(value);
                setCursor(undefined);
              }}
            >
              {value} days
            </button>
          ))}
        </fieldset>
        <label>
          Group{' '}
          <select
            value={groupBy}
            onChange={(event) => {
              setGroupBy(event.target.value as GroupBy);
              setCursor(undefined);
            }}
          >
            <option value="provider">Provider</option>
            <option value="model">Model</option>
            <option value="station">Station</option>
            <option value="conversation">Conversation</option>
            <option value="task">Task</option>
            <option value="day">Day</option>
          </select>
        </label>
      </div>
      {!scope?.isCurrent() ? (
        <Empty label="Connect to this Station to view authorized usage." />
      ) : isLoading ? (
        <SkeletonBlock count={3} label="Loading usage receipts" />
      ) : error ? (
        <ErrorState
          variant="compact"
          title="Usage rollup could not be loaded"
          action={
            <Button size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          <dl className="usage-rollup__cost-boundaries">
            <div>
              <dt>Account charges</dt>
              <dd>Not reported</dd>
            </div>
            <div>
              <dt>Subscription fee allocation</dt>
              <dd>Not configured</dd>
            </div>
            <div>
              <dt>Quota consumption</dt>
              <dd>Not reported</dd>
            </div>
          </dl>
          <div className="usage-rollup__table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{groupBy}</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Reasoning</th>
                  <th>Cache read</th>
                  <th>Cache write</th>
                  <th>Reported cost</th>
                  <th>Estimate</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows ?? []).map((row: UsageRollupRow) => (
                  <tr key={row.key}>
                    <th scope="row">
                      {row.key.startsWith(`${groupBy}:`)
                        ? row.key.slice(groupBy.length + 1)
                        : row.key}
                    </th>
                    <td>{tokens(row.inputTokens)}</td>
                    <td>{tokens(row.outputTokens)}</td>
                    <td>{tokens(row.reasoningTokens)}</td>
                    <td>{tokens(row.cacheReadTokens)}</td>
                    <td>{tokens(row.cacheWriteTokens)}</td>
                    <td>{cost(row.reportedCost, row.reportedCostBuckets)}</td>
                    <td>
                      {row.estimatedCost
                        ? `${row.estimatedCost.amount.toFixed(4)} ${row.estimatedCost.currency} (${snapshotLabel(row.estimatedCost)})`
                        : row.estimatedCostBuckets?.length
                          ? `Mixed estimate currencies or snapshots: ${row.estimatedCostBuckets.map((bucket) => `${bucket.amount.toFixed(4)} ${bucket.currency} (${snapshotLabel(bucket)})`).join(', ')}`
                          : row.pricingStatus === 'unpriced'
                            ? 'Not priced'
                            : 'Partially priced'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section aria-labelledby="usage-task-outcomes-title">
            <h4 id="usage-task-outcomes-title">
              Task outcomes and recorded cost
            </h4>
            <p>
              Current workflow state; result quality is not independently
              evaluated here.
            </p>
            {data?.taskOutcomes?.length ? (
              <div className="usage-rollup__table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Task</th>
                      <th>Workflow state</th>
                      <th>Recorded cost</th>
                      <th>Receipts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.taskOutcomes.map((outcome) => (
                      <tr
                        key={JSON.stringify([
                          outcome.stationId,
                          outcome.taskId,
                        ])}
                      >
                        <td>{outcome.stationId}</td>
                        <th scope="row">
                          {outcome.taskId}
                          {outcome.state === 'available' && (
                            <small>
                              {' '}
                              ·{' '}
                              <time dateTime={outcome.taskCreatedAt}>
                                {outcome.taskCreatedAt}
                              </time>
                            </small>
                          )}
                        </th>
                        <td>
                          {outcome.state === 'available' ? (
                            <Badge value={taskStatusLabel(outcome.status)} />
                          ) : (
                            'Outcome unavailable'
                          )}
                        </td>
                        <td>{cost(undefined, outcome.reportedCostBuckets)}</td>
                        <td>{outcome.receiptCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty label="Task outcomes not reported in this usage window" />
            )}
          </section>
          <div className="usage-rollup__footer">
            <button type="button" onClick={() => setShowReceipts(true)}>
              Receipt drilldown ({data?.receipts?.length ?? 0})
            </button>
            {cursor && (
              <button type="button" onClick={() => setCursor(undefined)}>
                First page
              </button>
            )}
            {data?.nextCursor && (
              <button type="button" onClick={() => setCursor(data.nextCursor)}>
                Next receipts
              </button>
            )}
          </div>
        </>
      )}
      {showCoverage && (
        <div
          className="usage-rollup__drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Missing usage sources"
          aria-describedby="usage-coverage-description"
        >
          <div>
            <button type="button" onClick={() => setShowCoverage(false)}>
              Close
            </button>
            <h4>Source coverage</h4>
            <p id="usage-coverage-description">
              Gaps are not zero usage. Counts and freshness describe only what
              Station observed in each provider window.
            </p>
            {!isLoading && !error && coverage.length === 0 && (
              <Empty label="Usage not reported for this window" />
            )}
            {error && <p>Coverage could not be refreshed.</p>}
            {isLoading && <SkeletonBlock count={1} label="Loading coverage" />}
            {coverage.map((item: UsageCoverage) => (
              <div key={item.stationId}>
                <p>
                  <strong>{item.stationId}</strong>: {item.state}
                  {item.reason ? ` — ${item.reason}` : ''}
                  {`; window ${item.window.from} to ${item.window.to}`}
                  {item.observedThrough
                    ? `; observed through ${item.observedThrough}`
                    : '; observation time unknown'}
                  {`; ${item.freshness ?? 'unknown'} freshness`}
                  {item.observedTurnCount !== undefined
                    ? `; ${item.usageReportedTurnCount ?? '—'}/${item.observedTurnCount} turns reported usage`
                    : ''}
                  {item.droppedReceiptCount !== undefined
                    ? `; ${item.droppedReceiptCount} receipts omitted for ${item.droppedReceiptWindow?.from} to ${item.droppedReceiptWindow?.to}`
                    : ''}
                </p>
                {item.providers?.map((provider) => (
                  <p key={`${item.stationId}:${provider.provider}`}>
                    {provider.provider}: {provider.state}; window{' '}
                    {provider.window.from} to {provider.window.to};{' '}
                    {provider.freshness ?? 'unknown'} freshness;{' '}
                    {provider.usageReportedTurnCount ?? '—'}/
                    {provider.observedTurnCount ?? '—'} turns reported
                    {provider.observedThrough
                      ? `; observed through ${provider.observedThrough}`
                      : '; observation time unknown'}
                    {provider.reason ? `; ${provider.reason}` : ''}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {showReceipts && !error && (
        <div
          className="usage-rollup__drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Usage receipts"
        >
          <div>
            <button type="button" onClick={() => setShowReceipts(false)}>
              Close
            </button>
            <h4>Receipts</h4>
            {(data?.receipts ?? []).map((receipt: UsageReceipt) => (
              <p key={receipt.id}>
                {receipt.provider} · {receipt.model ?? 'model unreported'} ·{' '}
                {tokens(receipt.inputTokens)} input ·{' '}
                {receipt.observedAt ?? 'legacy ingestion time unknown'} ·{' '}
                {receipt.pricing?.status ?? 'unpriced'}
                {' · Published-rate retail: '}
                {receipt.retailEquivalent?.state === 'available' ||
                receipt.retailEquivalent?.state === 'stale'
                  ? `${receipt.retailEquivalent.amount.toFixed(6)} ${receipt.retailEquivalent.currency} (${receipt.retailEquivalent.state}; ${receipt.retailEquivalent.basis.routeId}; tariff ${receipt.retailEquivalent.basis.tariffId}; ${receipt.retailEquivalent.basis.sourceUrl})`
                  : 'Unavailable'}
                {' · Account charge: Not reported'}
                {receipt.conversationId ? (
                  <>
                    {' · '}
                    <a
                      href={`/chat/${encodeURIComponent(receipt.conversationId)}`}
                    >
                      Conversation
                    </a>
                  </>
                ) : null}
                {receipt.taskId ? (
                  <>
                    {' · '}
                    <a href={`/tasks/${encodeURIComponent(receipt.taskId)}`}>
                      Task
                    </a>
                  </>
                ) : null}
              </p>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
