import {
  type AnalyticsSavedView,
  type AnalyticsViewDefinition,
  parseAnalyticsViewDefinition,
  resolveAnalyticsViewWindows,
} from '@kontourai/station-contracts/analytics-views';
import type { UsageRollupRow } from '@kontourai/station-contracts/usage-rollup';
import { StationHttpError } from '@kontourai/station-sdk/client';
import {
  exportSavedAnalyticsView,
  type PrivateInsightsAuthority,
  type PrivateInsightsSource,
  usePrivateInsightsInventory,
  usePrivateInsightsResult,
  usePrivateInsightsSyncWindow,
  useSavedAnalyticsViewMutation,
} from '@kontourai/station-sdk/private-insights-query';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import { Empty, SkeletonBlock } from '../state';
import './PersonalInsights.css';
import { AnalyticsSourceSetup } from './AnalyticsSourceSetup';

function errorText(error: unknown) {
  if (error instanceof StationHttpError) {
    if (error.code === 'private_usage_provision_required')
      return 'An operator must prepare private storage before this source can sync.';
    if (error.code === 'private_usage_sync_required')
      return 'Sync this source before querying the selected window.';
    if (error.code === 'saved_view_conflict')
      return 'This view changed elsewhere. Reload it before saving again.';
    if (error.status === 401 || error.status === 403)
      return 'Access changed. Check your signed-in person and source authorization.';
  }
  return error instanceof Error
    ? error.message
    : 'This request could not be completed.';
}
const groupLabels: Record<AnalyticsViewDefinition['groupBy'], string> = {
  day: 'Day',
  provider: 'Provider',
  model: 'Model',
  station: 'Station',
};
const measureLabels: Record<AnalyticsViewDefinition['measure'], string> = {
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cacheReadTokens: 'Cache read tokens',
  cacheWriteTokens: 'Cache write tokens',
  reportedCost: 'Reported cost',
  estimatedCost: 'Estimated cost',
};
const fresh = (): AnalyticsViewDefinition => ({
  title: 'Personal usage',
  sources: [],
  range: { kind: 'relative', days: 14 },
  groupBy: 'model',
  measure: 'reportedCost',
  timeZone: 'UTC',
});
const signature = (d: AnalyticsViewDefinition) =>
  JSON.stringify({ ...d, title: undefined });
function value(
  row: UsageRollupRow | undefined,
  measure: AnalyticsViewDefinition['measure'],
) {
  if (!row) return '—';
  if (measure === 'reportedCost' || measure === 'estimatedCost') {
    const single = row[measure];
    if (single)
      return `${single.amount.toLocaleString(undefined, { maximumSignificantDigits: 8 })} ${single.currency}`;
    const buckets =
      measure === 'reportedCost'
        ? row.reportedCostBuckets
        : row.estimatedCostBuckets;
    return buckets?.length
      ? buckets
          .map(
            (b) =>
              `${b.amount.toLocaleString(undefined, { maximumSignificantDigits: 8 })} ${b.currency}`,
          )
          .join(' · ')
      : '—';
  }
  return row[measure] === undefined ? '—' : row[measure]!.toLocaleString();
}
function WindowResult({
  scope,
  source,
  window,
  definition,
  selection,
  label,
  interval,
}: {
  scope: PrivateInsightsAuthority;
  source: AnalyticsViewDefinition['sources'][number];
  window: { from: string; to: string };
  definition: AnalyticsViewDefinition;
  selection: string;
  label: string;
  interval: number;
}) {
  const [cursor, setCursor] = useState<{
    selection: string;
    indexId: string;
    summaryId?: string;
    after: string;
  }>();
  const windowSelection = `${selection}:${window.from}:${window.to}`;
  const page = cursor?.selection === windowSelection ? cursor : undefined;
  const result = usePrivateInsightsResult(
    scope,
    source.recipientId,
    {
      ...window,
      mode: 'summary',
      groupBy: definition.groupBy,
      provider: source.provider,
      model: source.model,
      accountKey: source.accountKey,
      ...(page
        ? {
            indexId: page.indexId,
            summaryId: page.summaryId,
            after: page.after,
          }
        : {}),
    },
    selection,
    interval,
  );
  const data = result.data ?? result.historical;
  const historical = !!result.historical && !result.data;
  return (
    <section className="personal-insights-result" aria-label={label}>
      <h5>
        {label} · {window.from} – {window.to} UTC
      </h5>
      {result.error && !historical ? (
        <p role="alert">
          This source could not be refreshed. Current access and coverage are
          not verified. {errorText(result.error)}
        </p>
      ) : !data ? (
        <SkeletonBlock
          count={1}
          label="Private source results"
        />
      ) : data.phase === 'indexing' ? (
        <SkeletonBlock count={1} label="Preparing captured history…" />
      ) : data.summary?.phase === 'aggregating' ? (
        <p role="status">
          Calculating totals · {data.summary.scanned.toLocaleString()} receipts
          processed
        </p>
      ) : (
        <>
          <p className="personal-insights-coverage">
            {historical
              ? `Historical retained snapshot, last checked ${new Date(data.receivedAt).toLocaleString()}. Refresh failed; current source access is not verified. `
              : ''}
            Retained observations only · completeness unknown.{' '}
            {data.asOf.freshness === 'behind-current-source-head'
              ? 'New usage is available; sync to refresh this snapshot.'
              : 'Snapshot matched the source when checked.'}
          </p>
          {!data.summary?.rows.length ? (
            <p>
              No matching attributed observations. Missing usage is not zero.
            </p>
          ) : (
            <div className="personal-insights-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{groupLabels[definition.groupBy]}</th>
                    <th scope="col">{measureLabels[definition.measure]}</th>
                    <th scope="col">Pricing</th>
                  </tr>
                </thead>
                <tbody>
                  {data.summary.rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">
                        {row.key.slice(row.key.indexOf(':') + 1)}
                      </th>
                      <td>{value(row, definition.measure)}</td>
                      <td>
                        {row.pricingStatus}
                        {row.estimatedCostBuckets?.length ? (
                          <details>
                            <summary>Price provenance</summary>
                            {row.estimatedCostBuckets.map((b, i) => (
                              <div key={`${b.pricingSnapshotId}:${i}`}>
                                {b.pricingSnapshotId} · {b.currency}
                                {b.pricingSnapshotSource
                                  ? ` · ${b.pricingSnapshotSource}`
                                  : ''}
                                {b.pricingSnapshotCapturedAt
                                  ? ` · ${b.pricingSnapshotCapturedAt}`
                                  : ''}
                              </div>
                            ))}
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.nextAfter ? (
            <Button
              onClick={() =>
                setCursor({
                  selection: windowSelection,
                  indexId: data.indexId,
                  summaryId: data.summary?.id,
                  after: data.nextAfter!,
                })
              }
            >
              More groups
            </Button>
          ) : null}
          {page ? (
            <Button variant="ghost" onClick={() => setCursor(undefined)}>
              First groups
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
function SourceResults({
  scope,
  metadata,
  source,
  definition,
  selection,
  refresh,
  fanout,
  paused,
  onBusy,
}: {
  scope: PrivateInsightsAuthority;
  metadata?: PrivateInsightsSource;
  source: AnalyticsViewDefinition['sources'][number];
  definition: AnalyticsViewDefinition;
  selection: string;
  refresh: () => void;
  fanout: number;
  paused: boolean;
  onBusy: (value: boolean) => void;
}) {
  const sync = usePrivateInsightsSyncWindow(scope);
  const controller = useRef<
    | { controller: AbortController; authorityKey: string; selection: string }
    | undefined
  >(undefined);
  const [progress, setProgress] = useState<string>();
  useEffect(
    () => () => {
      const active = controller.current;
      if (
        active?.authorityKey === scope.authorityKey &&
        active.selection === selection
      )
        active.controller.abort();
    },
    [scope.authorityKey, selection],
  );
  const [syncError, setSyncError] = useState<string>();
  const windows = resolveAnalyticsViewWindows(
    definition,
    new Date().toISOString().slice(0, 10),
  );
  const [drill, setDrill] = useState(false);
  const [receiptCursor, setReceiptCursor] = useState<{
    selection: string;
    indexId: string;
    after: string;
  }>();
  const receiptSelection = `${selection}:${windows.primary.from}:${windows.primary.to}`;
  const receiptPage =
    receiptCursor?.selection === receiptSelection ? receiptCursor : undefined;
  const receipt = usePrivateInsightsResult(
    drill && !paused ? scope : undefined,
    source.recipientId,
    {
      ...windows.primary,
      provider: source.provider,
      model: source.model,
      accountKey: source.accountKey,
      ...(receiptPage
        ? { indexId: receiptPage.indexId, after: receiptPage.after }
        : {}),
    },
    `${receiptSelection}:receipts`,
    Math.max(2000, fanout * 2000),
  );
  return (
    <article className="personal-insights-source">
      <header>
        <h4>
          {metadata?.origin
            ? `${new URL(metadata.origin).hostname} · ${metadata.stationId}`
            : source.recipientId}
        </h4>
        <ActionRow
          overflowLabel="More source actions"
          primary={
            <Button
              disabled={paused && !sync.isPending}
              pending={sync.isPending}
              pendingLabel="Syncing history…"
              onClick={async () => {
                setSyncError(undefined);
                onBusy(true);
                try {
                  const active = new AbortController();
                  controller.current = {
                    controller: active,
                    authorityKey: scope.authorityKey,
                    selection,
                  };
                  await sync.mutateAsync({
                    id: source.recipientId,
                    windows: [
                      windows.primary,
                      ...(windows.comparison ? [windows.comparison] : []),
                    ],
                    signal: active.signal,
                    onProgress: (value) =>
                      setProgress(`${value.pages} pages processed`),
                  });
                  refresh();
                } catch (e) {
                  setSyncError(
                    e instanceof DOMException && e.name === 'AbortError'
                      ? 'Sync stopped. The unfinished page can be resumed.'
                      : e instanceof Error
                        ? e.message
                        : 'Sync unavailable',
                  );
                } finally {
                  onBusy(false);
                }
              }}
            >
              Sync source
            </Button>
          }
          secondary={
            sync.isPending ? (
              <Button
                variant="ghost"
                onClick={() => controller.current?.controller.abort()}
              >
                Stop sync
              </Button>
            ) : undefined
          }
        />
      </header>
      {sync.isPending && progress ? <p role="status">{progress}</p> : null}
      {syncError ? <p role="alert">{syncError}</p> : null}
      {sync.data ? (
        <p role="status">
          {sync.data.phase === 'facts-captured'
            ? 'Capture completed. Source access is checked when results load.'
            : 'The history window is not yet complete.'}
        </p>
      ) : null}
      {paused ? (
        <p role="status">
          History sync is running. Results will refresh when it finishes.
        </p>
      ) : metadata?.ready === false ? (
        <p>
          Source confirmation or renewed access is required before querying.
        </p>
      ) : (
        <>
          <WindowResult
            scope={scope}
            source={source}
            window={windows.primary}
            definition={definition}
            selection={`${selection}:primary`}
            label="Selected period"
            interval={Math.max(2000, fanout * 2000)}
          />
          {windows.comparison ? (
            <>
              <p>Coverage may differ between periods.</p>
              <WindowResult
                scope={scope}
                source={source}
                window={windows.comparison}
                definition={definition}
                selection={`${selection}:comparison`}
                label="Comparison period"
                interval={Math.max(2000, fanout * 2000)}
              />
            </>
          ) : null}
          <ActionRow
            overflowLabel="More receipt actions"
            primary={
              <Button variant="ghost" onClick={() => setDrill(!drill)}>
                {drill ? 'Hide receipts' : 'View receipts'}
              </Button>
            }
            secondary={
              drill && receipt.data?.nextAfter ? (
                <Button
                  onClick={() =>
                    setReceiptCursor({
                      selection: receiptSelection,
                      indexId: receipt.data!.indexId,
                      after: receipt.data!.nextAfter!,
                    })
                  }
                >
                  More receipts
                </Button>
              ) : undefined
            }
            overflow={
              drill && receiptPage
                ? [
                    {
                      key: 'first',
                      label: 'First receipts',
                      onSelect: () => setReceiptCursor(undefined),
                    },
                  ]
                : []
            }
          />
          {drill ? (
            <div className="personal-insights-table">
              {receipt.error ? (
                <p role="alert">Receipt access could not be refreshed.</p>
              ) : !receipt.data ? (
                <SkeletonBlock count={1} label="Preparing receipt page…" />
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Conversation</th>
                      <th>Task</th>
                      <th>Model</th>
                      <th>Input</th>
                      <th>Reported</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipt.data.receipts.map((r) => (
                      <tr key={r.id}>
                        <td>{r.conversationId ?? r.threadId ?? 'Unknown'}</td>
                        <td>{r.taskId ?? 'Unknown'}</td>
                        <td>{r.model ?? 'Unattributed'}</td>
                        <td>
                          {r.inputTokens === undefined
                            ? '—'
                            : r.inputTokens.toLocaleString()}
                        </td>
                        <td>
                          {r.reportedCost
                            ? `${r.reportedCost.amount} ${r.reportedCost.currency}`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}
interface Editor {
  scope: string;
  draft: AnalyticsViewDefinition;
  baseline: string;
  saved?: AnalyticsSavedView;
  applied?: AnalyticsViewDefinition;
}
export function PersonalInsights() {
  const scope = useHostRequestAuthorityScope();
  const scopeKey = JSON.stringify([scope?.apiBase, scope?.authorityKey]);
  const inventory = usePrivateInsightsInventory(scope ?? undefined);
  const mutation = useSavedAnalyticsViewMutation(scope ?? undefined);
  const [editor, setEditor] = useState<Editor>();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<{ scope: string; id: string }>();
  const [message, setMessage] = useState<string>();
  const initial = fresh();
  const current = editor?.scope === scopeKey ? editor : undefined;
  const draft = current?.draft ?? initial;
  const dirty = !!current && JSON.stringify(draft) !== current.baseline;
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  useEffect(() => {
    if (
      scope?.isCurrent() &&
      inventory.views.data &&
      (!editor || editor.scope !== scopeKey)
    ) {
      const saved = [...inventory.views.data].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      )[0];
      const definition = saved?.definition ?? fresh();
      setEditor({
        scope: scopeKey,
        draft: definition,
        baseline: JSON.stringify(definition),
        saved,
        applied: saved ? definition : undefined,
      });
    }
  }, [scope, scopeKey, inventory.views.data, editor]);
  const change = (next: AnalyticsViewDefinition) =>
    setEditor({
      ...(current ?? { scope: scopeKey, baseline: JSON.stringify(initial) }),
      draft: next,
    });
  const load = (saved?: AnalyticsSavedView) =>
    guard(() => {
      const definition = saved?.definition ?? fresh();
      setEditor({
        scope: scopeKey,
        draft: definition,
        baseline: JSON.stringify(definition),
        saved,
        applied: saved ? definition : undefined,
      });
      setRefresh((n) => n + 1);
      setMessage(undefined);
    });
  const valid = (() => {
    try {
      return parseAnalyticsViewDefinition(draft);
    } catch {
      return undefined;
    }
  })();
  const applied = current?.applied;
  const show =
    valid &&
    applied &&
    signature(draft) === signature(applied) &&
    scope?.isCurrent();
  const save = async () => {
    if (!valid) return;
    setMessage(undefined);
    try {
      const result = await mutation.mutateAsync(
        current?.saved
          ? {
              kind: 'update',
              id: current.saved.id,
              revision: current.saved.revision,
              definition: valid,
            }
          : {
              kind: 'create',
              operationId: randomCorrelationId(),
              definition: valid,
            },
      );
      if ('definition' in result)
        setEditor({
          scope: scopeKey,
          draft: result.definition,
          baseline: JSON.stringify(result.definition),
          saved: result,
          applied: result.definition,
        });
    } catch (e) {
      setMessage(errorText(e));
    }
  };
  return (
    <section className="personal-insights" aria-label="Personal Insights">
      <header>
        <h3>Enrolled private usage</h3>
        <p>
          Canonical usage from sources you explicitly enrolled.
          Connected-Station lifetime summaries and operator reliability stay
          separate.
        </p>
      </header>
      {!scope?.isCurrent() ? (
        <p>Choose an authenticated Station to use private Insights.</p>
      ) : (
        <>
          {inventory.views.error || inventory.sources.error ? (
            <p role="alert">
              Private sources or saved views are unavailable. A verified person
              is required; operator access alone does not grant personal
              history.
            </p>
          ) : null}
          <AnalyticsSourceSetup
            key={scopeKey}
            scope={scope}
            sources={inventory.sources.data ?? []}
          />
          <div className="personal-insights-controls">
            <label>
              Saved view
              <select
                value={current?.saved?.id ?? ''}
                onChange={(e) =>
                  load(
                    inventory.views.data?.find((v) => v.id === e.target.value),
                  )
                }
              >
                <option value="">New view</option>
                {inventory.views.data?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.definition.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              View name
              <input
                value={draft.title}
                maxLength={120}
                onChange={(e) => change({ ...draft, title: e.target.value })}
              />
            </label>
            <label>
              Period
              <select
                value={
                  draft.range.kind === 'relative' ? draft.range.days : 'custom'
                }
                onChange={(e) =>
                  change({
                    ...draft,
                    range:
                      e.target.value === 'custom'
                        ? {
                            kind: 'fixed',
                            from: new Date().toISOString().slice(0, 10),
                            to: new Date().toISOString().slice(0, 10),
                          }
                        : {
                            kind: 'relative',
                            days: Number(e.target.value) as 7 | 14 | 30 | 90,
                          },
                  })
                }
              >
                {[7, 14, 30, 90].map((n) => (
                  <option key={n} value={n}>
                    Last {n} UTC days
                  </option>
                ))}
                <option value="custom">Custom UTC dates</option>
              </select>
            </label>
            {draft.range.kind === 'fixed' ? (
              <>
                <label>
                  From
                  <input
                    type="date"
                    value={draft.range.from}
                    onChange={(e) =>
                      change({
                        ...draft,
                        range: {
                          kind: 'fixed',
                          from: e.target.value,
                          to:
                            draft.range.kind === 'fixed'
                              ? draft.range.to
                              : e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  To
                  <input
                    type="date"
                    value={draft.range.to}
                    onChange={(e) =>
                      change({
                        ...draft,
                        range: {
                          kind: 'fixed',
                          from:
                            draft.range.kind === 'fixed'
                              ? draft.range.from
                              : e.target.value,
                          to: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              </>
            ) : null}
            <label>
              Group by
              <select
                value={draft.groupBy}
                onChange={(e) =>
                  change({
                    ...draft,
                    groupBy: e.target
                      .value as AnalyticsViewDefinition['groupBy'],
                  })
                }
              >
                {['day', 'provider', 'model', 'station'].map((v) => (
                  <option key={v} value={v}>
                    {groupLabels[v as AnalyticsViewDefinition['groupBy']]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Measure
              <select
                value={draft.measure}
                onChange={(e) =>
                  change({
                    ...draft,
                    measure: e.target
                      .value as AnalyticsViewDefinition['measure'],
                  })
                }
              >
                {[
                  'inputTokens',
                  'outputTokens',
                  'cacheReadTokens',
                  'cacheWriteTokens',
                  'reportedCost',
                  'estimatedCost',
                ].map((v) => (
                  <option key={v} value={v}>
                    {measureLabels[v as AnalyticsViewDefinition['measure']]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Compare
              <select
                value={draft.comparison?.kind ?? 'none'}
                onChange={(e) =>
                  change({
                    ...draft,
                    comparison:
                      e.target.value === 'none'
                        ? undefined
                        : e.target.value === 'previous'
                          ? { kind: 'previous' }
                          : {
                              kind: 'fixed',
                              from: new Date().toISOString().slice(0, 10),
                              to: new Date().toISOString().slice(0, 10),
                            },
                  })
                }
              >
                <option value="none">Selected period only</option>
                <option value="previous">Previous period</option>
                <option value="fixed">Custom UTC dates</option>
              </select>
            </label>
            {draft.comparison?.kind === 'fixed' ? (
              <>
                <label>
                  Comparison from
                  <input
                    type="date"
                    value={draft.comparison.from}
                    onChange={(e) =>
                      change({
                        ...draft,
                        comparison: {
                          kind: 'fixed',
                          from: e.target.value,
                          to:
                            draft.comparison?.kind === 'fixed'
                              ? draft.comparison.to
                              : e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Comparison to
                  <input
                    type="date"
                    value={draft.comparison.to}
                    onChange={(e) =>
                      change({
                        ...draft,
                        comparison: {
                          kind: 'fixed',
                          from:
                            draft.comparison?.kind === 'fixed'
                              ? draft.comparison.from
                              : e.target.value,
                          to: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              </>
            ) : null}
          </div>
          <fieldset>
            <legend>Sources (up to four)</legend>
            {inventory.sources.isFetching ? (
              <SkeletonBlock count={1} label="Enrolled sources" />
            ) : !inventory.sources.data?.length ? (
              <Empty
                variant="compact"
                label="Enroll a private source to begin."
              />
            ) : (
              inventory.sources.data.map((item) => {
                const selected = draft.sources.find(
                  (s) => s.recipientId === item.id,
                );
                return (
                  <div
                    key={item.id}
                    className="personal-insights-source-choice"
                  >
                    <label className="personal-insights-check">
                      <input
                        type="checkbox"
                        checked={!!selected}
                        disabled={
                          !selected &&
                          (!item.ready || draft.sources.length >= 4)
                        }
                        onChange={(e) =>
                          change({
                            ...draft,
                            sources: e.target.checked
                              ? [...draft.sources, { recipientId: item.id }]
                              : draft.sources.filter(
                                  (s) => s.recipientId !== item.id,
                                ),
                          })
                        }
                      />
                      {item.origin
                        ? new URL(item.origin).hostname
                        : 'Unconfirmed address'}{' '}
                      · {item.stationId}
                      {!item.ready ? ' · needs confirmation' : ''}
                    </label>
                    {selected ? (
                      <>
                        <label>
                          Provider attribution
                          <input
                            value={selected.provider ?? ''}
                            onChange={(e) =>
                              change({
                                ...draft,
                                sources: draft.sources.map((s) =>
                                  s.recipientId === item.id
                                    ? {
                                        ...s,
                                        provider: e.target.value || undefined,
                                        accountKey: e.target.value
                                          ? s.accountKey
                                          : undefined,
                                      }
                                    : s,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          Model attribution
                          <input
                            value={selected.model ?? ''}
                            onChange={(e) =>
                              change({
                                ...draft,
                                sources: draft.sources.map((s) =>
                                  s.recipientId === item.id
                                    ? {
                                        ...s,
                                        model: e.target.value || undefined,
                                      }
                                    : s,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          Reported account key
                          <input
                            value={selected.accountKey ?? ''}
                            disabled={!selected.provider}
                            maxLength={200}
                            onChange={(e) =>
                              change({
                                ...draft,
                                sources: draft.sources.map((s) =>
                                  s.recipientId === item.id
                                    ? {
                                        ...s,
                                        accountKey: e.target.value || undefined,
                                      }
                                    : s,
                                ),
                              })
                            }
                          />
                        </label>
                      </>
                    ) : null}
                  </div>
                );
              })
            )}
          </fieldset>
          <p>
            Project and engine filters are unavailable without producer
            attribution. Missing dimensions and measurements are not guessed.
          </p>
          <ActionRow
            className="personal-insights-actions"
            overflowLabel="More view actions"
            primary={
              <Button
                disabled={!valid}
                pending={mutation.isPending}
                pendingLabel="Saving…"
                onClick={() => void save()}
              >
                {current?.saved ? 'Update view' : 'Save view'}
              </Button>
            }
            secondary={
              <Button
                disabled={!valid}
                onClick={() => {
                  setEditor({
                    ...(current ?? {
                      scope: scopeKey,
                      baseline: JSON.stringify(initial),
                    }),
                    scope: scopeKey,
                    draft,
                    baseline: current?.baseline ?? JSON.stringify(initial),
                    applied: valid,
                  });
                  setRefresh((n) => n + 1);
                }}
              >
                Apply view
              </Button>
            }
            overflow={
              current?.saved
                ? [
                    {
                      key: 'refresh',
                      label: 'Refresh results',
                      disabled: !applied,
                      onSelect: () => setRefresh((n) => n + 1),
                    },
                    {
                      key: 'reload',
                      label: 'Reload saved view',
                      onSelect: async () => {
                        try {
                          const result = await inventory.views.refetch({
                            throwOnError: true,
                          });
                          if (!scope.isCurrent()) return;
                          load(
                            result.data?.find(
                              (v) => v.id === current.saved!.id,
                            ),
                          );
                        } catch (e) {
                          setMessage(errorText(e));
                        }
                      },
                    },
                    {
                      key: 'export',
                      label: 'Export definition',
                      onSelect: async () => {
                        try {
                          const data = await exportSavedAnalyticsView(
                            scope,
                            current.saved!.id,
                          );
                          if (!scope.isCurrent()) return;
                          const url = URL.createObjectURL(
                            new Blob([JSON.stringify(data, null, 2)], {
                              type: 'application/json',
                            }),
                          );
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'station-insights-view.json';
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch (e) {
                          setMessage(errorText(e));
                        }
                      },
                    },
                    {
                      key: 'delete',
                      label: 'Delete view',
                      tone: 'danger',
                      onSelect: async () => {
                        try {
                          await mutation.mutateAsync({
                            kind: 'delete',
                            id: current.saved!.id,
                            revision: current.saved!.revision,
                          });
                          load();
                        } catch (e) {
                          setMessage(errorText(e));
                        }
                      },
                    },
                  ]
                : [
                    {
                      key: 'refresh',
                      label: 'Refresh results',
                      disabled: !applied,
                      onSelect: () => setRefresh((n) => n + 1),
                    },
                  ]
            }
          />
          {message ? <p role="alert">{message}</p> : null}
          {dirty ? <p>Unsaved view changes.</p> : null}
          {!show && applied ? (
            <p>Apply the changed selection before displaying results.</p>
          ) : null}
          {show ? (
            <div aria-live="polite">
              {applied.sources.map((source) => (
                <SourceResults
                  key={`${scopeKey}:${source.recipientId}`}
                  scope={scope}
                  metadata={inventory.sources.data?.find(
                    (s) => s.id === source.recipientId,
                  )}
                  source={source}
                  definition={applied}
                  selection={`${scopeKey}:${current?.saved?.id ?? 'draft'}:${refresh}:${signature(applied)}`}
                  refresh={() => setRefresh((n) => n + 1)}
                  fanout={applied.sources.length * (applied.comparison ? 2 : 1)}
                  paused={busy?.scope === scopeKey}
                  onBusy={(value) =>
                    setBusy((current) =>
                      value
                        ? { scope: scopeKey, id: source.recipientId }
                        : current?.scope === scopeKey &&
                            current.id === source.recipientId
                          ? undefined
                          : current,
                    )
                  }
                />
              ))}
            </div>
          ) : null}
        </>
      )}
      <DiscardModal />
    </section>
  );
}
