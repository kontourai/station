import {
  createTaskAnswerBasisPaneInstance,
  createWholeTaskBasisPaneInstance,
} from '@kontourai/station-basis-pane/workspace-basis-pane';
import { isSupportedTurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import {
  type TaskTurnReferenceProjection,
  useAnswerSupportBundlesQuery,
  useAnswerSupportClaimsQuery,
  useCreateAnswerSupportMutation,
  useRemoveAnswerSupportMutation,
  useReplaceAnswerSupportMutation,
  useTaskTurnReferencesQuery,
} from '@kontourai/station-sdk';
import type { FoundAnswerCardProjection } from '@kontourai/surface';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { LazyMarkdown } from '../../components/chat/LazyMarkdown';
import { TurnProvenanceCard } from '../../components/chat/TurnProvenanceCard';
import { Dialog } from '../../components/Dialog';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { describeStationFailure } from '../../utils/stationFailure';
import { useBasisPaneLauncher } from '../../workspace-panes/BasisPaneLauncher';

type AvailableReference = Extract<
  TaskTurnReferenceProjection,
  { state: 'available' }
>;
type SupportDialogIntent = 'associate' | 'replace' | 'remove' | null;
type OpenedSupportDialog = {
  intent: Exclude<SupportDialogIntent, null>;
  referenceId: string;
  sessionId: string;
  turnId: string;
};

/** Reopens one exact Task-owned answer and its server-authorized support. */
export function TaskTurnReferenceView({
  taskId,
  projectId,
}: {
  taskId: string;
  projectId: string;
}) {
  const {
    data: references = [],
    isLoading,
    error,
    refetch,
  } = useTaskTurnReferencesQuery(taskId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenedSupportDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { openBasis, fallback: basisFallback } = useBasisPaneLauncher();
  const available = references.filter(
    (reference): reference is AvailableReference =>
      reference.state === 'available',
  );
  const selected =
    available.find((reference) => reference.id === selectedId) ??
    available.at(0) ??
    null;
  const hasUnavailable = references.some(
    (reference) => reference.state === 'unavailable',
  );
  const selectedIdentity = selected
    ? `${selected.id}:${selected.sessionId}:${selected.turnId}`
    : null;
  const noticedSelection = useRef(selectedIdentity);

  const dialogReference = dialog
    ? available.find(
        (reference) =>
          reference.id === dialog.referenceId &&
          reference.sessionId === dialog.sessionId &&
          reference.turnId === dialog.turnId,
      )
    : null;
  useEffect(() => {
    if (
      dialog &&
      (!dialogReference ||
        selected?.id !== dialog.referenceId ||
        selected.sessionId !== dialog.sessionId ||
        selected.turnId !== dialog.turnId)
    )
      setDialog(null);
  }, [dialog, dialogReference, selected]);
  useEffect(() => {
    if (noticedSelection.current !== selectedIdentity) {
      noticedSelection.current = selectedIdentity;
      setNotice(null);
    }
  }, [selectedIdentity]);

  return (
    <section
      className="task-workspace__section task-workspace__answer-basis"
      aria-labelledby="task-answer-basis"
    >
      <div className="task-workspace__section-heading">
        <div>
          <h3 id="task-answer-basis" className="task-workspace__section-title">
            Answer details
          </h3>
        </div>
        <Button
          size="sm"
          onClick={(event) =>
            openBasis(
              createWholeTaskBasisPaneInstance(projectId, taskId),
              { kind: 'whole-task', taskId },
              event.currentTarget,
            )
          }
        >
          Inspect Task evidence
        </Button>
      </div>
      {notice && (
        <p className="task-workspace__answer-support-notice" role="status">
          {notice}
        </p>
      )}
      {error ? (
        <ErrorState
          variant="compact"
          title="Unable to load kept answers"
          description={describeStationFailure(error).body}
          action={
            <Button size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : isLoading ? (
        <SkeletonList count={2} label="Loading kept answers" />
      ) : references.length === 0 ? (
        <Empty
          variant="compact"
          label="Nothing kept yet"
          description="Add a completed assistant answer to this Task to reopen it here."
        />
      ) : (
        <>
          {selected && (
            <>
              <fieldset className="task-workspace__answer-reference-list">
                <legend className="task-workspace__answer-reference-legend">
                  Available answers
                </legend>
                {available.map((reference) => {
                  const selectedReference = reference.id === selected.id;
                  return (
                    <div
                      key={reference.id}
                      className="task-workspace__answer-reference-row"
                    >
                      <button
                        type="button"
                        className={`task-workspace__answer-reference${selectedReference ? ' task-workspace__answer-reference--selected' : ''}`}
                        aria-pressed={selectedReference}
                        onClick={() => setSelectedId(reference.id)}
                      >
                        <span>Answer</span>
                        <span>
                          Session {reference.sessionId} · turn{' '}
                          {reference.turnId}
                        </span>
                      </button>
                      <Button
                        size="sm"
                        onClick={(event) =>
                          openBasis(
                            createTaskAnswerBasisPaneInstance(
                              projectId,
                              taskId,
                              reference.id,
                            ),
                            {
                              kind: 'task-answer',
                              taskId,
                              answerReferenceId: reference.id,
                            },
                            event.currentTarget,
                          )
                        }
                      >
                        Inspect evidence
                      </Button>
                    </div>
                  );
                })}
              </fieldset>
              <article
                className="task-workspace__answer"
                aria-label={`Answer from session ${selected.sessionId}, turn ${selected.turnId}`}
              >
                <div className="task-workspace__answer-content task-room-answer">
                  <LazyMarkdown>{selected.answer.content}</LazyMarkdown>
                </div>
                <div className="task-workspace__answer-provenance">
                  <TurnProvenanceCard provenance={selected.answer.provenance} />
                  {answerContextBoundaryCopy(selected.answer.provenance) && (
                    <p className="task-workspace__answer-support-boundary">
                      {answerContextBoundaryCopy(selected.answer.provenance)}
                    </p>
                  )}
                  {/* The provenance card renders nothing for an absent record. */}
                  {selected.answer.provenance == null && (
                    <p className="task-workspace__answer-support-boundary">
                      No run details were recorded for this answer.
                    </p>
                  )}
                  <AnswerSupport
                    reference={selected}
                    onRetry={() => void refetch()}
                    onOpen={(intent) => {
                      setNotice(null);
                      setDialog({
                        intent,
                        referenceId: selected.id,
                        sessionId: selected.sessionId,
                        turnId: selected.turnId,
                      });
                    }}
                  />
                </div>
              </article>
              {dialog && dialogReference && (
                <AnswerSupportDialog
                  taskId={taskId}
                  reference={dialogReference}
                  intent={dialog.intent}
                  onClose={() => setDialog(null)}
                  onCompleted={(message) => {
                    setDialog(null);
                    setNotice(message);
                  }}
                />
              )}
            </>
          )}
          {hasUnavailable && <UnavailableTaskTurnReference />}
        </>
      )}
      {basisFallback}
    </section>
  );
}

/** Exact reopening copy: a persisted boundary says what reached this answer. */
function answerContextBoundaryCopy(provenance: unknown): string | null {
  if (!isSupportedTurnProvenanceEnvelope(provenance)) return null;
  const boundary = provenance.contextBoundary;
  if (boundary?.state !== 'observed') return null;
  return boundary.value.priorTranscriptInjected
    ? 'Reopened with earlier messages in context.'
    : 'Reopened without earlier messages in context. The full transcript is still readable.';
}

function AnswerSupport({
  reference,
  onRetry,
  onOpen,
}: {
  reference: AvailableReference;
  onRetry: () => void;
  onOpen: (intent: Exclude<SupportDialogIntent, null>) => void;
}) {
  const support = reference.support;
  if (support.state === 'available')
    return (
      <section
        className="task-workspace__answer-support"
        aria-labelledby="answer-support-heading"
      >
        <div className="task-workspace__answer-support-heading">
          <div>
            <h4 id="answer-support-heading">What this answer stands on</h4>
            <p>Linked by a person, not inferred from the run.</p>
          </div>
          <div className="task-workspace__answer-support-actions">
            <Button size="sm" onClick={() => onOpen('replace')}>
              Replace
            </Button>
            <Button size="sm" onClick={() => onOpen('remove')}>
              Remove
            </Button>
          </div>
        </div>
        <SurfaceAnswerCard card={support.card} />
      </section>
    );
  const state = supportState(support);
  return (
    <section
      className="task-workspace__answer-support"
      aria-labelledby="answer-support-heading"
    >
      <div className="task-workspace__answer-support-heading">
        <div>
          <h4 id="answer-support-heading">What this answer stands on</h4>
          <p>{state.description}</p>
        </div>
        {state.canAssociate && (
          <Button size="sm" onClick={() => onOpen('associate')}>
            Link support
          </Button>
        )}
        {state.canRetry && (
          <Button size="sm" onClick={onRetry}>
            Retry support
          </Button>
        )}
      </div>
      <p
        className={`task-workspace__answer-support-state task-workspace__answer-support-state--${state.tone}`}
      >
        {state.label}
      </p>
    </section>
  );
}

function supportState(
  support: Exclude<AvailableReference['support'], { state: 'available' }>,
) {
  switch (support.state) {
    case 'unassessed':
      return {
        tone: 'quiet',
        label: 'No supporting claim linked yet.',
        description: 'Link one Surface claim that supports this answer.',
        canAssociate: true,
        canRetry: false,
      };
    case 'claim-missing':
      return {
        tone: 'warning',
        label: 'The linked claim is no longer available.',
        description:
          "It can't be replaced or removed until it can be read again. Retry.",
        canAssociate: false,
        canRetry: true,
      };
    case 'corrupt':
      return {
        tone: 'warning',
        label: "The linked Surface bundle can't be read.",
        description: "It can't be replaced until it can be read again. Retry.",
        canAssociate: false,
        canRetry: true,
      };
    case 'unsupported-version':
      return {
        tone: 'warning',
        label: "The linked claim uses a format this Station can't read.",
        description: "It can't be read or replaced from this Station.",
        canAssociate: false,
        canRetry: true,
      };
    case 'unavailable':
      return {
        tone: 'restricted',
        label: 'Support details are unavailable.',
        description: "This Station can't reopen support for this answer.",
        canAssociate: false,
        canRetry: true,
      };
  }
}

/** Renders the server-owned Surface card directly; it never folds raw records. */
function SurfaceAnswerCard({ card }: { card: FoundAnswerCardProjection }) {
  const gapSummary = transparencyGapSummary(card);
  const claimValue = formatClaimValue(card.claim.value);
  return (
    <div className="task-workspace__surface-answer-card">
      <dl className="task-workspace__surface-answer-summary">
        <div>
          <dt>Current standing</dt>
          <dd>{card.claim.status}</dd>
        </div>
        <div>
          <dt>Claim</dt>
          <dd>{card.claim.claimType}</dd>
        </div>
        <div>
          <dt>Claim ID</dt>
          <dd>{card.claim.id}</dd>
        </div>
        <div>
          <dt>Subject</dt>
          <dd>
            {card.claim.subject.subjectType} · {card.claim.subject.subjectId}
          </dd>
        </div>
        <div>
          <dt>Field / behavior</dt>
          <dd>{card.claim.fieldOrBehavior}</dd>
        </div>
        <div>
          <dt>Value</dt>
          <dd className="task-workspace__surface-answer-value">
            {claimValue.text}
            {claimValue.truncated && (
              <details>
                <summary>Show complete claim value</summary>
                <pre>{claimValue.full}</pre>
              </details>
            )}
          </dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>
            {card.claim.freshness
              ? `${card.claim.freshness.stale ? 'Stale' : 'Current'} · as of ${card.claim.freshness.asOf}`
              : 'Not provided'}
          </dd>
        </div>
        <div>
          <dt>Materiality</dt>
          <dd>{card.claim.materiality ?? 'Not provided'}</dd>
        </div>
      </dl>
      <CardBucket title="Entails" items={card.evidence.entailing} />
      <CardBucket title="Cited" items={card.evidence.cited} />
      <p className="task-workspace__surface-answer-gaps" role="status">
        {gapSummary}
      </p>
      <details className="task-workspace__surface-answer-details">
        <summary>Derivation and gaps</summary>
        <p>
          {card.derivation.available
            ? 'Direct inputs were provided by Surface.'
            : 'Surface did not provide a usable direct-input derivation.'}
        </p>
        <ul>
          {card.derivation.directInputs.map((input) => (
            <li key={`${input.claimId}:${input.source}`}>
              <code>{input.claimId}</code> · {input.status ?? 'No standing'} ·{' '}
              {input.source}
              {' · '}
              {input.edge?.method ?? 'method not provided'}
              {' · '}
              {input.edge?.supportStrength
                ? input.edge.supportStrength
                : 'support strength not provided'}
              {' · '}
              {input.edge?.rationale
                ? input.edge.rationale
                : 'rationale not provided'}
            </li>
          ))}
          {card.derivation.directInputs.length === 0 && (
            <li>Direct inputs were not provided.</li>
          )}
        </ul>
        <ul>
          {card.transparencyGaps.map((gap) => (
            <li key={gap.id}>
              {gap.type} · {gap.severity} · {gap.message}
            </li>
          ))}
          {card.transparencyGaps.length === 0 && (
            <li>Transparency gaps were not provided.</li>
          )}
        </ul>
      </details>
    </div>
  );
}

type FormattedClaimValue = { text: string; full: string; truncated: boolean };
const MAX_CLAIM_VALUE_CHARS = 480;

/** Deterministic display only; this does not evaluate or alter Surface's value. */
export function formatClaimValue(value: unknown): FormattedClaimValue {
  const full = stableValueText(value);
  return full.length > MAX_CLAIM_VALUE_CHARS
    ? {
        text: `${full.slice(0, MAX_CLAIM_VALUE_CHARS)}…`,
        full,
        truncated: true,
      }
    : { text: full, full, truncated: false };
}

function stableValueText(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'undefined') return 'undefined';
  try {
    return JSON.stringify(sortJsonValue(value, new WeakSet())) ?? 'undefined';
  } catch {
    return 'Unserializable claim value';
  }
}

function sortJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('cycle');
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => sortJsonValue(item, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item, seen)]),
  );
}

function transparencyGapSummary(card: FoundAnswerCardProjection): string {
  if (card.transparencyGaps.length === 0)
    return 'Transparency gaps: 0. No completeness conclusion is implied.';
  const severity = card.transparencyGaps.reduce(
    (highest, gap) =>
      severityRank(gap.severity) > severityRank(highest)
        ? gap.severity
        : highest,
    card.transparencyGaps[0].severity,
  );
  return `Transparency gaps: ${card.transparencyGaps.length} · highest severity: ${severity}.`;
}

function severityRank(severity: string): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[severity] ?? 0;
}

function CardBucket({
  title,
  items,
}: {
  title: string;
  items: FoundAnswerCardProjection['evidence']['cited'];
}) {
  return (
    <section
      className="task-workspace__surface-answer-bucket"
      aria-label={`${title} evidence`}
    >
      <h5>{title} evidence</h5>
      {items.length === 0 ? (
        <p>None provided.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <dl className="task-workspace__surface-answer-evidence">
                <div>
                  <dt>Evidence ID</dt>
                  <dd>{item.id}</dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{item.type}</dd>
                </div>
                <div>
                  <dt>Support strength</dt>
                  <dd>
                    {item.supportStrength ??
                      'Not declared (legacy/default bucket placement)'}
                  </dd>
                </div>
                <div>
                  <dt>Result</dt>
                  <dd>{item.result}</dd>
                </div>
                <div>
                  <dt>Effect</dt>
                  <dd>{item.blocksClaim ? 'Blocking' : 'Non-blocking'}</dd>
                </div>
                <div>
                  <dt>Method</dt>
                  <dd>{item.method}</dd>
                </div>
                <div>
                  <dt>Observed</dt>
                  <dd>{item.observedAt}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{item.sourceRef}</dd>
                </div>
                <div>
                  <dt>Locator</dt>
                  <dd>{item.locator ?? 'Not provided'}</dd>
                </div>
                <div className="task-workspace__surface-answer-evidence-summary">
                  <dt>Summary</dt>
                  <dd>{item.summary}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AnswerSupportDialog({
  taskId,
  reference,
  intent,
  onClose,
  onCompleted,
}: {
  taskId: string;
  reference: AvailableReference;
  intent: Exclude<SupportDialogIntent, null>;
  onClose: () => void;
  onCompleted: (message: string) => void;
}) {
  const isRemoval = intent === 'remove';
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const bundleFocus = useRef<HTMLButtonElement>(null);
  const bundles = useAnswerSupportBundlesQuery(taskId, reference.id, {
    enabled: !isRemoval,
  });
  const claims = useAnswerSupportClaimsQuery(
    taskId,
    reference.id,
    selectedBundleId ?? '',
    { enabled: !isRemoval && Boolean(selectedBundleId) },
  );
  const create = useCreateAnswerSupportMutation();
  const replace = useReplaceAnswerSupportMutation();
  const remove = useRemoveAnswerSupportMutation();
  const pending = create.isPending || replace.isPending || remove.isPending;
  const association =
    reference.support.state === 'available' ? reference.support : null;
  const bundleIsAuthorized = Boolean(
    !bundles.error &&
      selectedBundleId &&
      bundles.data?.some((bundle) => bundle.id === selectedBundleId),
  );
  const claimIsAuthorized = Boolean(
    !claims.error &&
      selectedClaimId &&
      claims.data?.some((claim) => claim.id === selectedClaimId),
  );
  useEffect(() => {
    if (
      selectedBundleId &&
      !bundles.isLoading &&
      (Boolean(bundles.error) || !bundleIsAuthorized)
    ) {
      setSelectedBundleId(null);
      setSelectedClaimId(null);
    }
  }, [bundleIsAuthorized, bundles.error, bundles.isLoading, selectedBundleId]);
  useEffect(() => {
    if (
      selectedClaimId &&
      !claims.isLoading &&
      (Boolean(claims.error) || !claimIsAuthorized)
    )
      setSelectedClaimId(null);
  }, [claimIsAuthorized, claims.error, claims.isLoading, selectedClaimId]);
  const execute = async () => {
    if (pending) return;
    setSubmissionError(null);
    try {
      if (intent === 'remove') {
        if (!association) return;
        await remove.mutateAsync({
          taskId,
          referenceId: reference.id,
          expectedRevision: association.revision,
        });
        onCompleted('Support link removed from this answer.');
      } else if (selectedBundleId && selectedClaimId) {
        if (intent === 'replace') {
          if (!association) return;
          await replace.mutateAsync({
            taskId,
            referenceId: reference.id,
            bundleId: selectedBundleId,
            claimId: selectedClaimId,
            expectedRevision: association.revision,
          });
          onCompleted('Support link replaced for this answer.');
        } else {
          await create.mutateAsync({
            taskId,
            referenceId: reference.id,
            bundleId: selectedBundleId,
            claimId: selectedClaimId,
          });
          onCompleted('Support link added to this answer.');
        }
      }
    } catch {
      setSelectedBundleId(null);
      setSelectedClaimId(null);
      setConfirming(false);
      setSubmissionError("Couldn't change answer support. Try again.");
    }
  };
  const title = isRemoval
    ? 'Remove answer support?'
    : confirming
      ? 'Replace answer support?'
      : intent === 'replace'
        ? 'Replace answer support'
        : 'Link answer support';
  const action = isRemoval
    ? 'Remove link'
    : confirming
      ? 'Replace link'
      : intent === 'replace'
        ? 'Review replacement'
        : 'Link support';
  const canSubmit = isRemoval
    ? Boolean(association)
    : bundleIsAuthorized && claimIsAuthorized;
  return (
    <Dialog
      eyebrow="Answer support"
      title={title}
      subtitle={`Session ${reference.sessionId} · turn ${reference.turnId}`}
      closeLabel={`Close ${title}`}
      onClose={onClose}
      role={isRemoval || confirming ? 'alertdialog' : 'dialog'}
      initialFocusRef={bundleFocus}
      initialFocusPolicy="desktop"
      size="lg"
      footer={
        <>
          <Button
            size="sm"
            onClick={confirming ? () => setConfirming(false) : onClose}
            disabled={pending}
          >
            {confirming ? 'Back' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            pending={pending}
            pendingLabel="Saving…"
            onClick={() => {
              if (intent === 'replace' && !confirming) setConfirming(true);
              else void execute();
            }}
          >
            {action}
          </Button>
        </>
      }
    >
      {submissionError && (
        <p role="alert" className="task-workspace__answer-support-dialog-error">
          {submissionError}
        </p>
      )}
      {isRemoval || confirming ? (
        <p className="task-workspace__answer-support-dialog-copy">
          {isRemoval
            ? 'Remove this link? The answer is not changed.'
            : 'Replace the linked claim?'}
        </p>
      ) : (
        <SupportSelector
          bundles={bundles}
          claims={claims}
          selectedBundleId={selectedBundleId}
          selectedClaimId={selectedClaimId}
          onBundle={(bundleId) => {
            setSelectedBundleId(bundleId);
            setSelectedClaimId(null);
          }}
          onClaim={setSelectedClaimId}
          bundleFocus={bundleFocus}
        />
      )}
    </Dialog>
  );
}

type SupportSelectorProps = {
  bundles: { data?: { id: string }[]; isLoading: boolean; error?: unknown };
  claims: { data?: { id: string }[]; isLoading: boolean; error?: unknown };
  selectedBundleId: string | null;
  selectedClaimId: string | null;
  onBundle: (id: string) => void;
  onClaim: (id: string) => void;
  bundleFocus: React.RefObject<HTMLButtonElement | null>;
};
function SupportSelector({
  bundles,
  claims,
  selectedBundleId,
  selectedClaimId,
  onBundle,
  onClaim,
  bundleFocus,
}: SupportSelectorProps) {
  if (bundles.isLoading)
    return <SkeletonList count={2} label="Loading bundles" />;
  if (bundles.error)
    return (
      <p className="task-workspace__answer-support-dialog-error" role="alert">
        Couldn't load bundles. Close this dialog and try again.
      </p>
    );
  return (
    <div className="task-workspace__answer-support-selector">
      <p className="task-workspace__answer-support-dialog-copy">
        Choose a bundle, then a claim.
      </p>
      <fieldset>
        <legend>Bundles</legend>
        {(bundles.data ?? []).map((bundle, index) => (
          <button
            ref={index === 0 ? bundleFocus : undefined}
            key={bundle.id}
            type="button"
            className={`task-workspace__support-choice${selectedBundleId === bundle.id ? ' task-workspace__support-choice--selected' : ''}`}
            aria-pressed={selectedBundleId === bundle.id}
            onClick={() => onBundle(bundle.id)}
          >
            <code>{bundle.id}</code>
          </button>
        ))}
        {(bundles.data ?? []).length === 0 && <p>Nothing to link yet.</p>}
      </fieldset>
      {selectedBundleId && (
        <fieldset>
          <legend>Claims</legend>
          {claims.isLoading ? (
            <SkeletonList count={2} label="Loading claims" />
          ) : claims.error ? (
            <p role="alert">
              Couldn't load claims. Close this dialog and try again.
            </p>
          ) : (
            (claims.data ?? []).map((claim) => (
              <button
                key={claim.id}
                type="button"
                className={`task-workspace__support-choice${selectedClaimId === claim.id ? ' task-workspace__support-choice--selected' : ''}`}
                aria-pressed={selectedClaimId === claim.id}
                onClick={() => onClaim(claim.id)}
              >
                <code>{claim.id}</code>
              </button>
            ))
          )}
        </fieldset>
      )}
    </div>
  );
}

/** The endpoint intentionally sends no identity or reason for an unavailable answer. */
function UnavailableTaskTurnReference() {
  return (
    <Empty
      variant="compact"
      label="An answer is unavailable"
      description="A pinned answer cannot be reopened by this Station."
    />
  );
}
