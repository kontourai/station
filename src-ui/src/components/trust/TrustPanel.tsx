import {
  type TrustBundleSummaryVM,
  type TrustReportClaimVM,
  type TrustReportResultVM,
  useTrustBundlesQuery,
  useTrustReportQuery,
} from '@kontourai/station-sdk';
import { Badge, toneClass } from '@kontourai/ui/react';
import { useMemo, useState } from 'react';
import { surfaceClaimTone } from '../kontour/station-tones';
import { Empty, SkeletonBlock } from '../state';
import './TrustPanel.css';

// ─── TrustPanel ───────────────────────────────────────────────────────────────
// Surface trust state for project artifacts (roadmap). Renders the trust
// bundles a project's plugins/tools have written (workspace
// `.station/trust-bundles/` plus the station-home fallback) as a Surface
// TrustReport: claim summary by status, claims with evidence drill-down, and
// transparency gaps. Secondary, collapsible surface — it sits next to the
// readiness panel in the coding layout without crowding it.
//
// Styled on the Console Kit contract: `.panel`/`.panel-head`
// chrome, `Badge` + tone classes for claim statuses, `Empty` for the empty
// state, `--k-*` tokens throughout (primitives from @kontourai/ui/react;
// see TrustPanel.css for the adoption notes).

function formatStatusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
}

function bundleLabel(bundle: TrustBundleSummaryVM): string {
  const origin =
    bundle.source === 'station-home'
      ? (bundle.plugin ?? 'station-home')
      : 'workspace';
  return `${bundle.id} (${origin})`;
}

function ClaimRow({
  claim,
  report,
}: {
  claim: TrustReportClaimVM;
  report: NonNullable<TrustReportResultVM['report']>;
}) {
  const [expanded, setExpanded] = useState(false);
  const evidence = report.evidence.filter(
    (entry) => entry.claimId === claim.id,
  );
  const gaps = report.transparencyGaps.filter(
    (gap) => gap.claimId === claim.id,
  );

  return (
    <li className="trust-panel__claim">
      <div className="trust-panel__claim-row">
        <Badge
          value={claim.status}
          tone={surfaceClaimTone(claim.status)}
          className="trust-panel__claim-status"
        />
        <span className="trust-panel__claim-type">{claim.claimType}</span>
        <button
          type="button"
          className="trust-panel__claim-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          Evidence
        </button>
      </div>
      <p className="trust-panel__claim-subject">
        {claim.fieldOrBehavior ? `${claim.fieldOrBehavior} · ` : ''}
        {claim.subjectId}
      </p>
      {expanded && (
        <div className="trust-panel__claim-detail">
          {evidence.length === 0 && (
            <p className="trust-panel__detail-empty">
              No evidence backs this claim.
            </p>
          )}
          <ul className="trust-panel__evidence-list">
            {evidence.map((entry) => (
              <li key={entry.id} className="trust-panel__evidence">
                <span className="trust-panel__evidence-summary">
                  {entry.excerptOrSummary}
                </span>
                <span className="trust-panel__evidence-meta">
                  {entry.method ? `${entry.method} · ` : ''}
                  {entry.sourceRef}
                  {entry.passing === false ? ' · failing' : ''}
                </span>
              </li>
            ))}
          </ul>
          {gaps.length > 0 && (
            <ul className="trust-panel__claim-gaps">
              {gaps.map((gap) => (
                <li key={gap.id} className="trust-panel__gap">
                  <span className="trust-panel__gap-type">{gap.type}</span>
                  <span className="trust-panel__gap-message">
                    {gap.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function ReportBody({ result }: { result: TrustReportResultVM }) {
  if (!result.valid || !result.report) {
    return (
      <p className="trust-panel__error" role="alert">
        Invalid trust bundle: {result.error ?? 'unknown validation error'}
      </p>
    );
  }

  const report = result.report;
  const byStatus =
    report.summary?.byStatus ??
    report.claims.reduce<Record<string, number>>((counts, claim) => {
      counts[claim.status] = (counts[claim.status] ?? 0) + 1;
      return counts;
    }, {});
  const statuses = Object.entries(byStatus)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);

  return (
    <>
      <div className="trust-panel__chips">
        {statuses.map(([status, count]) => (
          <span
            key={status}
            className={`badge ${toneClass(surfaceClaimTone(status))} trust-panel__chip`}
          >
            {formatStatusLabel(status)}
            <strong>{count}</strong>
          </span>
        ))}
      </div>
      <ul className="trust-panel__claims">
        {report.claims.map((claim) => (
          <ClaimRow key={claim.id} claim={claim} report={report} />
        ))}
      </ul>
      {report.transparencyGaps.length > 0 && (
        <div className="trust-panel__gaps">
          <p className="trust-panel__gaps-title">
            Transparency gaps ({report.transparencyGaps.length})
          </p>
          <ul className="trust-panel__gaps-list">
            {report.transparencyGaps.map((gap) => (
              <li key={gap.id} className="trust-panel__gap">
                <span className="trust-panel__gap-type">{gap.type}</span>
                <span className="trust-panel__gap-message">{gap.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.generatedAt && (
        <p className="trust-panel__generated">
          Report generated {new Date(report.generatedAt).toLocaleString()}
        </p>
      )}
    </>
  );
}

export function TrustPanel({ projectSlug }: { projectSlug: string }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    data: bundles,
    isLoading: bundlesLoading,
    isPlaceholderData: bundlesStale,
    error: bundlesError,
  } = useTrustBundlesQuery(projectSlug);

  const sortedBundles = useMemo(
    () =>
      [...(bundles ?? [])].sort((a, b) =>
        b.modifiedAt.localeCompare(a.modifiedAt),
      ),
    [bundles],
  );
  const activeId = selectedId ?? sortedBundles[0]?.id ?? null;

  const {
    data: result,
    isLoading: reportLoading,
    isPlaceholderData: reportStale,
    error: reportError,
  } = useTrustReportQuery(projectSlug, expanded ? activeId : null);

  const countLabel = bundles ? ` (${bundles.length})` : '';
  // True only for the held render of a PRIOR project's bundle list or a
  // prior bundle's report while the newly selected one is in flight
  // (archive#3092) — never true for a same-key background refetch.
  const showingPreviousData = bundlesStale || reportStale;

  return (
    <section
      className={`panel trust-panel${showingPreviousData ? ' trust-panel--stale' : ''}`}
      aria-label="Trust bundles"
      aria-busy={showingPreviousData || undefined}
    >
      <div className="panel-head trust-panel__header">
        <div>
          <p className="eyebrow trust-panel__eyebrow">Surface</p>
          <h2 className="trust-panel__title">Trust bundles{countLabel}</h2>
        </div>
        <button
          type="button"
          className="trust-panel__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>

      {expanded && (
        <div className="trust-panel__body">
          {showingPreviousData && (
            <p className="trust-panel__stale-notice" role="status">
              Updating — showing the previous selection&rsquo;s trust state
              until the new result arrives.
            </p>
          )}
          {bundlesLoading && (
            <SkeletonBlock count={2} label="Scanning trust bundles" />
          )}
          {!bundlesLoading && bundlesError && (
            <p className="trust-panel__error" role="alert">
              Trust bundles unavailable:{' '}
              {bundlesError instanceof Error
                ? bundlesError.message
                : String(bundlesError)}
            </p>
          )}
          {!bundlesLoading && !bundlesError && sortedBundles.length === 0 && (
            <Empty
              variant="compact"
              label="No trust bundles yet"
              description={
                <>
                  Plugins and tools project verified state into{' '}
                  <code>.station/trust-bundles/</code> in the project workspace.
                  Complete a review or projection to see trust state here.
                </>
              }
            />
          )}
          {!bundlesLoading && !bundlesError && sortedBundles.length > 1 && (
            <select
              className="trust-panel__selector"
              aria-label="Trust bundle"
              value={activeId ?? ''}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {sortedBundles.map((bundle) => (
                <option key={`${bundle.source}:${bundle.id}`} value={bundle.id}>
                  {bundleLabel(bundle)}
                </option>
              ))}
            </select>
          )}
          {sortedBundles.length > 0 && reportLoading && (
            <SkeletonBlock count={2} label="Building trust report" />
          )}
          {sortedBundles.length > 0 && !reportLoading && reportError && (
            <p className="trust-panel__error" role="alert">
              Trust report unavailable:{' '}
              {reportError instanceof Error
                ? reportError.message
                : String(reportError)}
            </p>
          )}
          {sortedBundles.length > 0 &&
            !reportLoading &&
            !reportError &&
            result && <ReportBody result={result} />}
        </div>
      )}
    </section>
  );
}
