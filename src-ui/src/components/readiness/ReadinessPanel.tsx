import {
  type ReadinessRequirementVM,
  type ReadinessSnapshotVM,
  type ReadinessStatus,
  type ReadinessTrustReportVM,
  useReadinessQuery,
  useRefreshReadinessMutation,
} from '@kontourai/station-sdk';
import { Badge, StatusBadge, toneClass } from '@kontourai/ui/react';
import type React from 'react';
import { useState } from 'react';
import {
  readinessStatusTone,
  surfaceClaimTone,
} from '../kontour/station-tones';
import { Empty, SkeletonBlock } from '../state';
import './ReadinessPanel.css';

// ─── ReadinessPanel ───────────────────────────────────────────────────────────
// Veritas merge readiness for the project workspace (roadmap). Renders the
// requirement list + status chips from `veritas readiness` and a per-item
// "Why is this allowed to merge?" evidence detail from the Surface trust
// report. Bespoke Station rendering — the <surface-trust-panel> web component
// only styles against Console Kit --k-* tokens and has no hooks into
// Station tokens, so we render from the JSON trust report instead.
//
// Styled on the Console Kit contract: `.panel`/`.panel-head`
// chrome, `StatusBadge` for the overall verdict, `Badge` + tone classes for
// requirement/claim statuses, `--k-*` tokens throughout. Tone mapping for the
// seven readiness statuses lives in components/kontour/station-tones.ts.

const STATUS_ORDER: ReadinessStatus[] = [
  'satisfied',
  'missing',
  'stale',
  'failing',
  'advisory',
  'recheckable',
  'accepted',
];

const STATUS_LABELS: Record<ReadinessStatus, string> = {
  satisfied: 'Satisfied',
  missing: 'Missing',
  stale: 'Stale',
  failing: 'Failing',
  advisory: 'Advisory',
  recheckable: 'Recheckable',
  accepted: 'Accepted',
};

function RequirementDetail({
  requirement,
  trustReport,
}: {
  requirement: ReadinessRequirementVM;
  trustReport: ReadinessTrustReportVM | null | undefined;
}) {
  const claimIds = new Set(requirement.claimIds);
  const claims = (trustReport?.claims ?? []).filter((claim) =>
    claimIds.has(claim.id),
  );
  const evidence = (trustReport?.evidence ?? []).filter((entry) =>
    claimIds.has(entry.claimId),
  );
  const gaps = (trustReport?.transparencyGaps ?? []).filter((gap) =>
    claimIds.has(gap.claimId),
  );

  return (
    <div className="readiness-panel__detail">
      {requirement.summary && (
        <p className="readiness-panel__detail-summary">{requirement.summary}</p>
      )}
      {claims.length === 0 && (
        <p className="readiness-panel__detail-empty">
          No Surface claims back this requirement.
        </p>
      )}
      {claims.map((claim) => (
        <div key={claim.id} className="readiness-panel__claim">
          <div className="readiness-panel__claim-header">
            <span className="readiness-panel__claim-type">
              {claim.claimType}
            </span>
            <Badge
              value={claim.status}
              tone={surfaceClaimTone(claim.status)}
              className="readiness-panel__claim-status"
            />
          </div>
          <p className="readiness-panel__claim-subject">{claim.subjectId}</p>
          <ul className="readiness-panel__evidence-list">
            {evidence
              .filter((entry) => entry.claimId === claim.id)
              .map((entry) => (
                <li key={entry.id} className="readiness-panel__evidence">
                  <span className="readiness-panel__evidence-summary">
                    {entry.excerptOrSummary}
                  </span>
                  <span className="readiness-panel__evidence-meta">
                    {entry.method ? `${entry.method} · ` : ''}
                    {entry.sourceRef}
                    {entry.passing === false ? ' · failing' : ''}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
      {gaps.length > 0 && (
        <div className="readiness-panel__gaps">
          <p className="readiness-panel__gaps-title">Transparency gaps</p>
          <ul className="readiness-panel__gaps-list">
            {gaps.map((gap) => (
              <li key={gap.id} className="readiness-panel__gap">
                <span className="readiness-panel__gap-type">{gap.type}</span>
                <span className="readiness-panel__gap-message">
                  {gap.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RequirementRow({
  requirement,
  trustReport,
}: {
  requirement: ReadinessRequirementVM;
  trustReport: ReadinessTrustReportVM | null | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="readiness-panel__requirement">
      <div className="readiness-panel__requirement-row">
        <Badge
          value={STATUS_LABELS[requirement.status]}
          tone={readinessStatusTone(requirement.status)}
          className="readiness-panel__status"
        />
        <span className="readiness-panel__requirement-label">
          {requirement.label}
        </span>
        <button
          type="button"
          className="readiness-panel__why"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          Why is this allowed to merge?
        </button>
      </div>
      {expanded && (
        <RequirementDetail
          requirement={requirement}
          trustReport={trustReport}
        />
      )}
    </li>
  );
}

function ReadinessBody({
  data,
  renderSetup,
}: {
  data: ReadinessSnapshotVM;
  renderSetup?: (reason: string | undefined) => React.ReactNode;
}) {
  if (!data.configured) {
    if (data.reason === 'no-workspace') {
      return (
        <Empty
          variant="compact"
          label="No working directory"
          description="This project has no working directory yet. Set one to track Veritas merge readiness for the workspace."
        />
      );
    }
    return (
      <Empty
        variant="compact"
        label="Veritas not configured"
        description={`Track merge readiness for this workspace — evidence checks, policy, and a "why is this allowed to merge?" trail, right next to the editor.`}
        action={renderSetup?.(data.reason)}
      />
    );
  }

  const counts = data.counts;
  const requirements = data.requirements ?? [];

  return (
    <>
      <div className="readiness-panel__overall">
        <StatusBadge
          status={data.overall === 'ready' ? 'Ready to merge' : 'Not ready'}
          tone={data.overall === 'ready' ? 'positive' : 'negative'}
          className="readiness-panel__verdict"
        />
        {data.cli?.message && (
          <p className="readiness-panel__message">{data.cli.message}</p>
        )}
      </div>
      <div className="readiness-panel__chips">
        {STATUS_ORDER.filter((status) => (counts?.[status] ?? 0) > 0).map(
          (status) => (
            <span
              key={status}
              className={`badge ${toneClass(readinessStatusTone(status))} readiness-panel__chip`}
            >
              {STATUS_LABELS[status]}
              <strong>{counts?.[status]}</strong>
            </span>
          ),
        )}
      </div>
      <ul className="readiness-panel__requirements">
        {requirements.map((requirement) => (
          <RequirementRow
            key={requirement.id}
            requirement={requirement}
            trustReport={data.trustReport}
          />
        ))}
      </ul>
      {data.generatedAt && (
        <p className="readiness-panel__generated">
          Generated {new Date(data.generatedAt).toLocaleString()}
        </p>
      )}
    </>
  );
}

export function ReadinessPanel({
  projectSlug,
  renderSetup,
}: {
  projectSlug: string;
  /** Optional setup CTA rendered inside the not-configured empty state. */
  renderSetup?: (reason: string | undefined) => React.ReactNode;
}) {
  const { data, isLoading, isPlaceholderData, error } =
    useReadinessQuery(projectSlug);
  const refresh = useRefreshReadinessMutation(projectSlug);
  const refreshError =
    refresh.error instanceof Error ? refresh.error.message : null;
  // `isPlaceholderData` is true only for the held render of the OUTGOING
  // project's data while the new project's readiness is in flight — it is
  // false for a same-project background refetch. This is the signal that
  // must never go unmarked: the content on screen belongs to a different
  // project than the one currently selected (archive#3092).
  const showingPreviousProject = isPlaceholderData;

  return (
    <section
      className={`panel readiness-panel${showingPreviousProject ? ' readiness-panel--stale' : ''}`}
      aria-label="Merge readiness"
      aria-busy={showingPreviousProject || undefined}
    >
      <div className="panel-head readiness-panel__header">
        <div>
          <p className="eyebrow readiness-panel__eyebrow">Veritas</p>
          <h2 className="readiness-panel__title">Merge readiness</h2>
        </div>
        <button
          type="button"
          className="readiness-panel__refresh"
          disabled={isLoading || refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {showingPreviousProject && (
        <p className="readiness-panel__stale-notice" role="status">
          Updating for the selected project — showing the previous
          project&rsquo;s readiness until the new result arrives.
        </p>
      )}
      {isLoading && (
        <SkeletonBlock count={2} label="Running readiness checks" />
      )}
      {!isLoading && error && (
        <p className="readiness-panel__error" role="alert">
          Readiness unavailable:{' '}
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      {!isLoading && !error && refreshError && (
        <p className="readiness-panel__error" role="alert">
          Refresh failed: {refreshError}
        </p>
      )}
      {!isLoading && !error && data && (
        <ReadinessBody data={data} renderSetup={renderSetup} />
      )}
    </section>
  );
}
