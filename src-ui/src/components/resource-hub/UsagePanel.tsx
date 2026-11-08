import type {
  UsageCoverage,
  UsageRollup,
  UsageRollupRow,
} from '@kontourai/station-contracts/usage-rollup';
import { Field, Select } from '@kontourai/ui/react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '../Button';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../state';
import { DailyBars } from './DailyBars';
import { FactList } from './FactList';
import { MetricTiles } from './MetricTiles';
import './resource-hub.css';

export type UsageDays = 7 | 30;

/**
 * What the panel can say. Each non-ready state is a different fact, never a
 * zero: no access, a host too old to scope the read, an engine that keeps
 * no receipts, a failed read.
 */
export type UsagePanelState =
  | { kind: 'loading' }
  | { kind: 'access-denied' }
  | { kind: 'unsupported' }
  | { kind: 'context-only' }
  | { kind: 'error'; error: unknown; onRetry: () => void }
  | { kind: 'ready'; data: UsageRollup };

type Measure = 'auto' | 'tokens' | 'reported' | 'estimated';
type Money = { amount: number; currency: string };

function amountLabel(amount: number, currency: string) {
  return currency === 'USD'
    ? `$${amount.toFixed(2)}`
    : `${currency} ${amount.toFixed(2)}`;
}

function costTotal(items: Money[]) {
  const totals = new Map<string, number>();
  for (const item of items)
    totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amount);
  return (
    [...totals]
      .map(([currency, amount]) => amountLabel(amount, currency))
      .join(' · ') || '—'
  );
}

function coverageIsPartial(coverage: UsageCoverage[], provider?: string) {
  return coverage.some(
    (c) =>
      c.droppedReceiptCount ||
      c.state === 'offline' ||
      c.state === 'stale' ||
      c.state === 'unknown' ||
      c.state === 'partial' ||
      c.providers?.some(
        (p) =>
          (provider === undefined || p.provider === provider) &&
          p.state !== 'complete',
      ),
  );
}

/**
 * Station-observed usage for one resource over 7 or 30 days: headline
 * tiles, a daily chart that keeps unreported days distinct, and the token
 * breakdown and capture coverage behind a disclosure. The caller decides
 * the read and its state; this only presents it.
 */
export function UsagePanel({
  state,
  days,
  onDaysChange,
  provider,
  scope,
  unattributed,
  controls,
  label,
}: {
  state: UsagePanelState;
  days: UsageDays;
  onDaysChange: (days: UsageDays) => void;
  /** Keeps only this provider kind's rows and coverage. */
  provider?: string;
  /** What the figures cover ("This Station · this engine"). */
  scope?: string;
  /**
   * For a read scoped to one connection: runs recorded before Station kept
   * the connection on usage receipts belong to none, so they are missing
   * here rather than counted as zero.
   */
  unattributed?: string;
  /** Scope controls beside the period, such as an account picker. */
  controls?: ReactNode;
  /** The chart's subject in its accessible name. */
  label: string;
}) {
  const period = useId();
  return (
    <section className="usage-panel" aria-label="Usage">
      <div className="usage-panel__heading">
        <h3>Usage</h3>
        <fieldset className="usage-panel__period">
          <legend className="sr-only">Usage period</legend>
          {([7, 30] as const).map((value) => (
            <label
              key={value}
              className={`usage-panel__choice${days === value ? ' is-active' : ''}`}
            >
              <input
                type="radio"
                name={period}
                value={value}
                checked={days === value}
                onChange={() => onDaysChange(value)}
              />
              {value} days
            </label>
          ))}
        </fieldset>
      </div>
      {controls}
      {scope && <small>{scope}</small>}
      {unattributed && <small>{unattributed}</small>}
      {state.kind === 'loading' ? (
        <SkeletonBlock count={2} label="Loading usage" />
      ) : state.kind === 'access-denied' ? (
        <Empty
          variant="compact"
          label="Usage needs credential-management access"
          description="Ask the Station owner for access:manage on this device."
        />
      ) : state.kind === 'unsupported' ? (
        <Empty
          variant="compact"
          label="Update Station to see this engine's usage"
          description="This Station can't total usage for one engine yet."
        />
      ) : state.kind === 'context-only' ? (
        <Empty
          variant="compact"
          label="Context use only"
          description="This engine reports how full its context is, not usage receipts."
        />
      ) : state.kind === 'error' ? (
        <ErrorState
          variant="compact"
          title="Usage could not be loaded"
          description={describeReadFailure(state.error)}
          action={<Button onClick={state.onRetry}>Retry</Button>}
        />
      ) : (
        <UsageFigures
          data={state.data}
          provider={provider}
          label={label}
          unattributed={unattributed}
        />
      )}
    </section>
  );
}

function UsageFigures({
  data,
  provider,
  label,
  unattributed,
}: {
  data: UsageRollup;
  provider?: string;
  label: string;
  unattributed?: string;
}) {
  const [currency, setCurrency] = useState('USD');
  const [measure, setMeasure] = useState<Measure>('auto');
  const measureGroup = useId();
  const currencyId = useId();
  const rows = data.rows.filter(
    (row) => provider === undefined || row.provider === provider,
  );
  const partial = coverageIsPartial(data.coverage, provider);
  if (!rows.length) {
    const incomplete = data.coverage.some((c) => c.state !== 'complete');
    return (
      <Empty
        variant="compact"
        label={incomplete ? 'Usage unavailable' : 'Usage will appear here'}
        description={
          incomplete
            ? 'No usage was returned. Some sources could not be read.'
            : unattributed
              ? undefined
              : 'Runs through this Station are recorded here.'
        }
      />
    );
  }
  const reported = rows.flatMap((row) =>
    row.reportedCost ? [row.reportedCost] : (row.reportedCostBuckets ?? []),
  );
  const estimates = rows.flatMap((row) =>
    row.estimatedCost ? [row.estimatedCost] : (row.estimatedCostBuckets ?? []),
  );
  const tokensReported = rows.some(
    (row) => row.inputTokens !== undefined || row.outputTokens !== undefined,
  );
  const tokens = rows.reduce(
    (sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
    0,
  );
  const costSource =
    measure === 'reported' || measure === 'estimated'
      ? measure
      : reported.length
        ? 'reported'
        : 'estimated';
  const chartCosts = costSource === 'reported' ? reported : estimates;
  const currencies = [...new Set(chartCosts.map((item) => item.currency))];
  const chartCurrency = currencies.includes(currency)
    ? currency
    : (currencies[0] ?? 'USD');
  const costShown =
    measure !== 'tokens' && (measure !== 'auto' || chartCosts.length > 0);
  const bars = dailyBars(data, rows, (row) => {
    if (!costShown)
      return row.inputTokens === undefined && row.outputTokens === undefined
        ? undefined
        : (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    const single =
      costSource === 'reported' ? row.reportedCost : row.estimatedCost;
    const buckets =
      costSource === 'reported'
        ? row.reportedCostBuckets
        : row.estimatedCostBuckets;
    const amounts = (single ? [single] : (buckets ?? [])).filter(
      (item) => item.currency === chartCurrency,
    );
    return amounts.length
      ? amounts.reduce((sum, item) => sum + item.amount, 0)
      : undefined;
  }).map((bar) => ({
    ...bar,
    valueLabel:
      bar.value === undefined
        ? undefined
        : costShown
          ? amountLabel(bar.value, chartCurrency)
          : bar.value.toLocaleString(),
  }));
  const measureName = costShown ? `${costSource} cost` : 'tokens';
  return (
    <>
      <MetricTiles
        metrics={[
          {
            label: 'Tokens',
            value: tokensReported ? tokens.toLocaleString() : '—',
          },
          { label: 'Reported cost', value: costTotal(reported) },
          { label: 'Estimated cost', value: costTotal(estimates) },
        ]}
      />
      <fieldset className="usage-panel__measure">
        <legend className="sr-only">Trend measure</legend>
        {(['tokens', 'reported', 'estimated'] as const).map((value) => (
          <label
            key={value}
            className={`usage-panel__choice${
              (
                measure === 'auto'
                  ? costShown
                    ? costSource === value
                    : value === 'tokens'
                  : measure === value
              )
                ? ' is-active'
                : ''
            }`}
          >
            <input
              type="radio"
              name={measureGroup}
              value={value}
              checked={
                measure === 'auto'
                  ? costShown
                    ? costSource === value
                    : value === 'tokens'
                  : measure === value
              }
              onChange={() => setMeasure(value)}
            />
            {value === 'tokens'
              ? 'Tokens'
              : value === 'reported'
                ? 'Reported cost'
                : 'Estimated cost'}
          </label>
        ))}
      </fieldset>
      {costShown && currencies.length > 1 && (
        <Field label="Currency" htmlFor={currencyId}>
          <Select
            id={currencyId}
            value={chartCurrency}
            onChange={(event) => setCurrency(event.target.value)}
            options={currencies.map((item) => ({ label: item, value: item }))}
          />
        </Field>
      )}
      {costShown && !chartCosts.length && (
        <small>No {costSource} cost observations in this period.</small>
      )}
      <DailyBars
        bars={bars}
        caption={`Daily ${measureName}`}
        {...(costShown ? { unit: chartCurrency } : {})}
        label={`${label} daily ${measureName} from ${data.window.from} to ${data.window.to}`}
      />
      <details className="usage-panel__details">
        <summary>Token breakdown & capture coverage</summary>
        <small>
          Totals include reported values only. Missing token categories and
          turns remain gaps.
        </small>
        <FactList facts={breakdownFacts(rows, estimates)} />
        {data.coverage.map((coverage, index) => (
          <FactList
            key={`${coverage.stationId}:${index}`}
            facts={coverageFacts(coverage, provider)}
          />
        ))}
      </details>
      {partial && <small>Some activity is missing.</small>}
      <small>
        Reported and estimated costs are separate. Subscription allowance is not
        a bill.
      </small>
    </>
  );
}

/** Every day in the window, including the ones with no row. */
function dailyBars(
  data: UsageRollup,
  rows: UsageRollupRow[],
  value: (row: UsageRollupRow) => number | undefined,
) {
  const firstDay = Date.parse(data.window.from);
  const dayCount = Math.min(
    30,
    Math.round((Date.parse(data.window.to) - firstDay) / 86400000) + 1,
  );
  return Array.from({ length: dayCount }, (_, index) => {
    const day = new Date(firstDay + index * 86400000)
      .toISOString()
      .slice(0, 10);
    const dayRows = rows.filter((row) => row.day === day);
    const values = dayRows
      .map(value)
      .filter((item): item is number => item !== undefined);
    return {
      day,
      value: values.length ? values.reduce((a, b) => a + b, 0) : undefined,
    };
  });
}

const TOKEN_FIELDS = [
  ['inputTokens', 'Input tokens'],
  ['outputTokens', 'Output tokens'],
  ['cacheReadTokens', 'Cache read tokens'],
  ['cacheWriteTokens', 'Cache write tokens'],
] as const;

function breakdownFacts(
  rows: UsageRollupRow[],
  estimates: Array<
    Money & { pricingSnapshotId: string; pricingSnapshotSource?: string }
  >,
) {
  return [
    ...TOKEN_FIELDS.map(([key, label]) => ({
      label,
      value: rows.some((row) => row[key] !== undefined)
        ? rows.reduce((sum, row) => sum + (row[key] ?? 0), 0).toLocaleString()
        : undefined,
    })),
    {
      label: 'Usage receipts',
      value: rows
        .reduce((sum, row) => sum + row.receiptCount, 0)
        .toLocaleString(),
    },
    {
      label: 'Pricing',
      value: [...new Set(rows.map((row) => row.pricingStatus))].join(', '),
    },
    {
      label: 'Estimate sources',
      value:
        [
          ...new Set(
            estimates.map((item) => item.pricingSnapshotSource).filter(Boolean),
          ),
        ].join(', ') || undefined,
    },
    {
      label: 'Pricing snapshots',
      value:
        [
          ...new Set(
            estimates.map((item) => item.pricingSnapshotId).filter(Boolean),
          ),
        ].join(', ') || undefined,
    },
  ];
}

function coverageFacts(coverage: UsageCoverage, provider?: string) {
  return [
    { label: 'Capture status', value: coverage.state },
    { label: 'Source freshness', value: coverage.freshness },
    { label: 'Source observed through', value: coverage.observedThrough },
    { label: 'Source observed turns', value: coverage.observedTurnCount },
    {
      label: 'Source turns with usage',
      value: coverage.usageReportedTurnCount,
    },
    { label: 'Source reason', value: coverage.reason },
    { label: 'Dropped receipts', value: coverage.droppedReceiptCount },
    ...(coverage.providers
      ?.filter((item) => provider === undefined || item.provider === provider)
      .flatMap((item) => [
        { label: `${item.provider} capture`, value: item.state },
        {
          label: `${item.provider} observed turns`,
          value: item.observedTurnCount,
        },
        {
          label: `${item.provider} turns with usage`,
          value: item.usageReportedTurnCount,
        },
        { label: `${item.provider} freshness`, value: item.freshness },
        {
          label: `${item.provider} observed through`,
          value: item.observedThrough,
        },
        { label: `${item.provider} reason`, value: item.reason },
      ]) ?? []),
  ];
}
