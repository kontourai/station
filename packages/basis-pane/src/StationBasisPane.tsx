import type { StationTaskBasisKeptToolResult } from '@kontourai/station-contracts/task-basis';
import { useAnswerBasisQuery } from '@kontourai/station-sdk/answer-basis';
import { useTaskBasisQuery } from '@kontourai/station-sdk/task-basis';
import type { BasisContributionRefV2 } from '@kontourai/surface/basis';
import {
  type BasisPanelViewModel,
  buildBasisPanelViewModel,
} from '@kontourai/surface/basis/view';
import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import './station-basis-pane.css';
import type { StationTaskBasisCollectionGateEvaluationView } from './task-basis-collection-view';
import { buildStationTaskBasisCollectionView } from './task-basis-collection-view';

export type StationBasisPaneScope =
  | { kind: 'direct-answer'; sessionId: string; turnId: string }
  | { kind: 'task-answer'; taskId: string; answerReferenceId: string }
  | { kind: 'whole-task'; taskId: string };

export type StationBasisPaneExecutionResultRef = Extract<
  BasisContributionRefV2,
  { authority: '@kontourai/thread'; kind: 'result' }
>;

export type StationBasisPaneExecutionAction = 'inspect' | 'keep';

/**
 * Station owns the effectful controls. The shared pane only hands it the
 * published Surface ref and the collection's already-authorized kept row.
 */
export interface StationBasisPaneExecutionActionInput {
  ref: StationBasisPaneExecutionResultRef;
  scope: StationBasisPaneScope;
  occurrenceKey: string;
  keptReference?: StationTaskBasisKeptToolResult;
  /** The action to restore after an authorized refresh unmounted the viewer. */
  restoreFocusAction?: StationBasisPaneExecutionAction;
  /** Hosts report a user-initiated action focus while this occurrence is mounted. */
  onActionFocus?: (action: StationBasisPaneExecutionAction) => void;
  /** Hosts clear the intent when focus leaves this result's action group. */
  onActionBlur?: () => void;
  /** Hosts acknowledge a restore attempt, including when the user moved focus. */
  onFocusRestoreHandled?: () => void;
}

/** Captured by the host so Base Pane reads never cross a connection epoch. */
export interface StationBasisPaneRequestScope {
  apiBase: string;
  authorityKey: string;
}

const PAGE_SIZE = 20;
const disclosureOpen = (value: string): boolean => value === 'expanded';

type DisclosureId = 'assessment' | 'context' | 'relationships' | 'technical';

interface PaneUiState {
  identity: string;
  selectedAnswer?: string;
  visibleAnswers: number;
  disclosures: Partial<Record<DisclosureId, boolean>>;
  itemWindows: Record<string, number>;
  focusedAction?: {
    occurrenceKey: string;
    action: StationBasisPaneExecutionAction;
  };
  restoreFocus?: {
    occurrenceKey: string;
    action: StationBasisPaneExecutionAction;
  };
}

function paneIdentity(
  scope: StationBasisPaneScope,
  requestScope?: StationBasisPaneRequestScope,
): string {
  const subject =
    scope.kind === 'direct-answer'
      ? [scope.kind, scope.sessionId, scope.turnId]
      : scope.kind === 'task-answer'
        ? [scope.kind, scope.taskId, scope.answerReferenceId]
        : [scope.kind, scope.taskId];
  return JSON.stringify([
    requestScope ? [requestScope.apiBase, requestScope.authorityKey] : null,
    subject,
  ]);
}

function initialPaneUiState(
  identity: string,
  scope: StationBasisPaneScope,
): PaneUiState {
  return {
    identity,
    selectedAnswer:
      scope.kind === 'task-answer' ? scope.answerReferenceId : undefined,
    visibleAnswers: PAGE_SIZE,
    disclosures: {},
    itemWindows: {},
  };
}

function ProgressiveItems<T>({
  items,
  moreLabel,
  renderItem,
  visibleCount,
  onVisibleCountChange,
}: {
  items: readonly T[];
  moreLabel: string;
  renderItem(item: T): ReactNode;
  visibleCount: number;
  onVisibleCountChange(count: number): void;
}) {
  const visible = visibleCount;
  const hasMore = visible < items.length;
  return (
    <>
      {items.slice(0, visible).map(renderItem)}
      {items.length > PAGE_SIZE ? (
        <button
          type="button"
          aria-disabled={hasMore ? undefined : true}
          onClick={() => {
            if (!hasMore) return;
            onVisibleCountChange(Math.min(visible + PAGE_SIZE, items.length));
          }}
        >
          {hasMore ? moreLabel : 'All items shown'}
        </button>
      ) : null}
    </>
  );
}

function GateEvaluationRef({
  label,
  value,
}: {
  label: string;
  value: { runId: string; gateId: string; evaluationId: string };
}) {
  return (
    <>
      <dt>{label} run</dt>
      <dd>
        <bdi>{value.runId}</bdi>
      </dd>
      <dt>{label} gate</dt>
      <dd>
        <bdi>{value.gateId}</bdi>
      </dd>
      <dt>{label} evaluation</dt>
      <dd>
        <bdi>{value.evaluationId}</bdi>
      </dd>
    </>
  );
}

function GateEvaluationRow({
  item,
}: {
  item: StationTaskBasisCollectionGateEvaluationView;
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleEvidence, setVisibleEvidence] = useState(PAGE_SIZE);
  return (
    <article className="station-basis-pane__gate-evaluation">
      <p>
        <strong>
          Gate <bdi>{item.gateId}</bdi>
        </strong>{' '}
        — original verdict {item.originalVerdict}. At last check:{' '}
        {item.currentStanding}; valid{' '}
        <time dateTime={item.validityAsOf}>{item.validityAsOfLabel}</time>.
      </p>
      <details
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setExpanded(open);
          if (!open) setVisibleEvidence(PAGE_SIZE);
        }}
      >
        <summary className="station-basis-pane__summary">
          Process receipt details
        </summary>
        {expanded ? (
          <>
            <dl className="station-basis-pane__facts">
              <dt>Evaluated</dt>
              <dd>{item.evaluatedAt}</dd>
              <dt>Validity as of</dt>
              <dd>
                <time dateTime={item.validityAsOf}>
                  {item.validityAsOfLabel}
                </time>
              </dd>
              <dt>Validity scope</dt>
              <dd>Retained immutable bundle</dd>
              <dt>External revocation</dt>
              <dd>Not observed</dd>
              <GateEvaluationRef label="Original" value={item.ref} />
              {item.previousRef ? (
                <GateEvaluationRef label="Previous" value={item.previousRef} />
              ) : null}
              {item.currentPersistedGateRef ? (
                <GateEvaluationRef
                  label="Current persisted"
                  value={item.currentPersistedGateRef}
                />
              ) : null}
              {item.exceptionId ? (
                <>
                  <dt>Exception</dt>
                  <dd>
                    <bdi>{item.exceptionId}</bdi>
                  </dd>
                </>
              ) : null}
              {item.routeBack ? (
                <>
                  <dt>Route-back</dt>
                  <dd>
                    <bdi>{item.routeBack.reason ?? 'Recorded by Flow'}</bdi>
                    {item.routeBack.selectedRoute ? (
                      <>
                        {' '}
                        · <bdi>{item.routeBack.selectedRoute}</bdi>
                      </>
                    ) : (
                      ''
                    )}
                  </dd>
                  {item.routeBack.attempt !== undefined ? (
                    <>
                      <dt>Route-back attempt</dt>
                      <dd>
                        {item.routeBack.attempt}
                        {item.routeBack.maxAttempts
                          ? ` of ${item.routeBack.maxAttempts}`
                          : ''}
                      </dd>
                    </>
                  ) : null}
                </>
              ) : null}
            </dl>
            <section aria-label={`Selected evidence for gate ${item.gateId}`}>
              <h4>Selected evidence</h4>
              {item.selectedEvidence.length ? (
                <>
                  <ul>
                    {item.selectedEvidence
                      .slice(0, visibleEvidence)
                      .map((evidence) => (
                        <li key={evidence.evidenceId}>
                          <strong>
                            <bdi>{evidence.evidenceId}</bdi>
                          </strong>{' '}
                          — {evidence.standing}; freshness {evidence.freshness}
                          {'; '}
                          authority {evidence.authority}
                          {evidence.sha256 ? (
                            <>
                              ; sha256 <bdi>{evidence.sha256}</bdi>
                            </>
                          ) : (
                            ''
                          )}
                          {evidence.revocationCodes.length ? (
                            <>
                              ; recorded revocation codes:{' '}
                              {evidence.revocationCodes.map((code, index) => (
                                <Fragment
                                  key={`${evidence.evidenceId}:${code}`}
                                >
                                  <bdi>{code}</bdi>
                                  {index < evidence.revocationCodes.length - 1
                                    ? ', '
                                    : ''}
                                </Fragment>
                              ))}
                            </>
                          ) : (
                            ''
                          )}
                        </li>
                      ))}
                  </ul>
                  {item.selectedEvidence.length > PAGE_SIZE ? (
                    <button
                      type="button"
                      aria-disabled={
                        visibleEvidence >= item.selectedEvidence.length
                          ? true
                          : undefined
                      }
                      onClick={() =>
                        setVisibleEvidence((current) =>
                          Math.min(
                            current + PAGE_SIZE,
                            item.selectedEvidence.length,
                          ),
                        )
                      }
                    >
                      {visibleEvidence < item.selectedEvidence.length
                        ? 'Show more selected evidence'
                        : 'All selected evidence shown'}
                    </button>
                  ) : null}
                </>
              ) : (
                <p>No selected evidence was recorded.</p>
              )}
            </section>
          </>
        ) : null}
      </details>
    </article>
  );
}

export function BasisStandingAssessmentSummary({
  identity,
  model,
  assessmentOpen,
  onAssessmentOpenChange,
  visibleItemCount,
  onVisibleItemCountChange,
}: {
  identity: string;
  model: BasisPanelViewModel;
  assessmentOpen: boolean;
  onAssessmentOpenChange(open: boolean): void;
  visibleItemCount(resetKey: string): number;
  onVisibleItemCountChange(resetKey: string, count: number): void;
}) {
  return (
    <>
      <h2>{model.title}</h2>
      <p
        className="station-basis-pane__status"
        role="status"
        aria-live="polite"
      >
        <strong>{model.standing.label}</strong> — {model.standing.description}
      </p>
      <section className="station-basis-pane__gap">
        <h3>Gaps ({model.gaps.length})</h3>
        {model.gaps.length ? (
          model.gaps.map((gap) => (
            <p key={`${gap.code}:${gap.message}`}>{gap.message}</p>
          ))
        ) : (
          <p>None recorded.</p>
        )}
      </section>
      {model.assessment ? (
        <details
          className="station-basis-pane__section"
          open={assessmentOpen}
          onToggle={(event) => onAssessmentOpenChange(event.currentTarget.open)}
        >
          <summary className="station-basis-pane__summary">Assessment</summary>
          <dl className="station-basis-pane__facts">
            <dt>Claim status</dt>
            <dd>{model.assessment.claimStatus ?? 'not available'}</dd>
            <dt>Freshness</dt>
            <dd>{model.assessment.freshness ?? 'not stated'}</dd>
          </dl>
          {model.assessment.policy ? (
            <p>Policy: {model.assessment.policy.outcome}</p>
          ) : null}
          {model.assessment.evidence.map((partition) => (
            <section key={partition.id}>
              <h4>{partition.label}</h4>
              {partition.items.length ? (
                <ProgressiveItems
                  items={partition.items}
                  moreLabel={`Show more ${partition.label}`}
                  visibleCount={visibleItemCount(
                    `${identity}:assessment:${partition.id}`,
                  )}
                  onVisibleCountChange={(count) =>
                    onVisibleItemCountChange(
                      `${identity}:assessment:${partition.id}`,
                      count,
                    )
                  }
                  renderItem={(item) => (
                    <p key={item.id}>
                      {item.label} — {item.source} · {item.observedAt}
                    </p>
                  )}
                />
              ) : (
                <p>None recorded.</p>
              )}
            </section>
          ))}
        </details>
      ) : (
        <section className="station-basis-pane__section">
          <h3>Assessment</h3>
          <p>Not captured.</p>
        </section>
      )}
    </>
  );
}

function Viewer({
  identity,
  model,
  scope,
  keptToolResults,
  renderExecutionActions,
  disclosureOpen,
  onDisclosureChange,
  visibleItemCount,
  onVisibleItemCountChange,
  executionFocus,
}: {
  identity: string;
  model: BasisPanelViewModel;
  scope: StationBasisPaneScope;
  keptToolResults: readonly StationTaskBasisKeptToolResult[];
  renderExecutionActions?: (
    input: StationBasisPaneExecutionActionInput,
  ) => ReactNode;
  disclosureOpen(id: DisclosureId, defaultValue: string): boolean;
  onDisclosureChange(id: DisclosureId, open: boolean): void;
  visibleItemCount(resetKey: string): number;
  onVisibleItemCountChange(resetKey: string, count: number): void;
  executionFocus(
    occurrenceKey: string,
  ): Omit<
    StationBasisPaneExecutionActionInput,
    'ref' | 'scope' | 'occurrenceKey' | 'keptReference'
  >;
}) {
  return (
    <>
      <BasisStandingAssessmentSummary
        identity={identity}
        model={model}
        assessmentOpen={disclosureOpen(
          'assessment',
          model.disclosures.assessment,
        )}
        onAssessmentOpenChange={(open) =>
          onDisclosureChange('assessment', open)
        }
        visibleItemCount={visibleItemCount}
        onVisibleItemCountChange={onVisibleItemCountChange}
      />
      <details
        className="station-basis-pane__section"
        open={disclosureOpen('context', model.disclosures.context)}
        onToggle={(event) =>
          onDisclosureChange('context', event.currentTarget.open)
        }
      >
        <summary className="station-basis-pane__summary">
          Context — {model.contextNotice}
        </summary>
        {model.contextGroups.map((group) => (
          <section key={group.id}>
            <h3>{group.label}</h3>
            {group.items.length ? (
              <ProgressiveItems
                items={group.items}
                moreLabel={`Show more ${group.label}`}
                visibleCount={visibleItemCount(
                  `${identity}:context:${group.id}`,
                )}
                onVisibleCountChange={(count) =>
                  onVisibleItemCountChange(
                    `${identity}:context:${group.id}`,
                    count,
                  )
                }
                renderItem={(item) => {
                  const ref = isThreadResultRef(item.ref) ? item.ref : null;
                  const keptReference = ref
                    ? keptToolResults.find((kept) =>
                        sameResultRef(kept.ref, ref),
                      )
                    : undefined;
                  return (
                    <article key={item.id}>
                      <strong>{item.label}</strong>
                      <dl className="station-basis-pane__facts">
                        {item.facts.map((fact) => (
                          <Fragment key={`${item.id}:${fact.label}`}>
                            <dt>{fact.label}</dt>
                            <dd>{fact.value}</dd>
                          </Fragment>
                        ))}
                      </dl>
                      {keptReference ? <p>Kept</p> : null}
                      {group.id === 'execution' && ref ? (
                        renderExecutionActions?.({
                          ref,
                          scope,
                          occurrenceKey: JSON.stringify([
                            identity,
                            'execution',
                            item.id,
                          ]),
                          keptReference,
                          ...executionFocus(
                            JSON.stringify([identity, 'execution', item.id]),
                          ),
                        })
                      ) : group.id === 'execution' ? (
                        <ExecutionIdentityUnavailable />
                      ) : null}
                      {item.gaps.map((gap) => (
                        <p key={`${gap.code}:${gap.message}`}>{gap.message}</p>
                      ))}
                    </article>
                  );
                }}
              />
            ) : (
              <p>None recorded.</p>
            )}
          </section>
        ))}
      </details>
      <details
        className="station-basis-pane__section"
        open={disclosureOpen('relationships', model.disclosures.relationships)}
        onToggle={(event) =>
          onDisclosureChange('relationships', event.currentTarget.open)
        }
      >
        <summary className="station-basis-pane__summary">Relationships</summary>
        {model.relationships.length ? (
          model.relationships.map((relationship) => (
            <article key={relationship.id}>
              <p>
                <strong>{relationship.label}</strong> — {relationship.prose}{' '}
                From {relationship.from.value}; to {relationship.to.value}.
              </p>
              {relationship.gaps.map((gap) => (
                <p key={`${gap.code}:${gap.message}`}>{gap.message}</p>
              ))}
            </article>
          ))
        ) : (
          <p>None recorded.</p>
        )}
      </details>
      <details
        className="station-basis-pane__section"
        open={disclosureOpen('technical', model.disclosures.technical)}
        onToggle={(event) =>
          onDisclosureChange('technical', event.currentTarget.open)
        }
      >
        <summary className="station-basis-pane__summary">
          Technical details
        </summary>
        {model.technical ? (
          <dl className="station-basis-pane__facts">
            <dt>Answer owner</dt>
            <dd>{model.technical.answerOwner}</dd>
            <dt>Answer state</dt>
            <dd>{model.technical.answerState}</dd>
            <dt>Assessment owner</dt>
            <dd>{model.technical.assessmentOwner}</dd>
            <dt>Assessment state</dt>
            <dd>{model.technical.assessmentState}</dd>
            <dt>Bundle</dt>
            <dd>{model.technical.bundleId ?? 'not available'}</dd>
            <dt>Claim</dt>
            <dd>{model.technical.claimId ?? 'not available'}</dd>
          </dl>
        ) : (
          <p>Not available.</p>
        )}
      </details>
      <footer>{model.footer}</footer>
    </>
  );
}

function ExecutionIdentityUnavailable() {
  return (
    <p>
      <button type="button" disabled>
        Result identity not captured; cannot keep
      </button>
    </p>
  );
}

export function StationBasisPane({
  scope,
  renderExecutionActions,
  requestScope,
}: {
  scope: StationBasisPaneScope;
  renderExecutionActions?: (
    input: StationBasisPaneExecutionActionInput,
  ) => ReactNode;
  requestScope?: StationBasisPaneRequestScope;
}): ReactElement {
  const identity = paneIdentity(scope, requestScope);
  const [ui, setUi] = useState(() => initialPaneUiState(identity, scope));
  const activeUi =
    ui.identity === identity ? ui : initialPaneUiState(identity, scope);
  if (ui !== activeUi) setUi(activeUi);
  const updateUi = useCallback(
    (update: (current: PaneUiState) => PaneUiState) => {
      setUi((current) =>
        current.identity === identity ? update(current) : current,
      );
    },
    [identity],
  );
  useEffect(() => {
    // User navigation cancels restoration, including during the payload-free
    // loading interval. Browser focus loss caused by removing the viewer does
    // not. Activation handlers establish a fresh intent after these captures.
    const cancelActionFocus = () =>
      updateUi((current) =>
        current.focusedAction || current.restoreFocus
          ? { ...current, focusedAction: undefined, restoreFocus: undefined }
          : current,
      );
    document.addEventListener('pointerdown', cancelActionFocus, true);
    document.addEventListener('keydown', cancelActionFocus, true);
    return () => {
      document.removeEventListener('pointerdown', cancelActionFocus, true);
      document.removeEventListener('keydown', cancelActionFocus, true);
    };
  }, [updateUi]);
  const refresh = useRef({ identity, isLoading: false });
  const direct = useAnswerBasisQuery(
    scope.kind === 'direct-answer' ? scope.sessionId : '',
    scope.kind === 'direct-answer' ? scope.turnId : '',
    { enabled: scope.kind === 'direct-answer', requestScope },
  );
  const task = useTaskBasisQuery(
    scope.kind === 'task-answer' || scope.kind === 'whole-task'
      ? scope.taskId
      : '',
    {
      ...(scope.kind === 'task-answer'
        ? { answerReferenceId: scope.answerReferenceId }
        : {}),
      config: {
        enabled: scope.kind === 'task-answer' || scope.kind === 'whole-task',
        requestScope,
      },
    },
  );
  const query = scope.kind === 'direct-answer' ? direct : task;
  // Protected Basis hooks withhold their prior payload while a reauthorization
  // refetch is in flight. React Query reserves `isLoading` for the first
  // pending read, so use the same payload-free boundary that the hook exposes
  // to avoid rendering an empty viewer (and losing its focused action).
  const queryIsLoading = query.isLoading || query.isFetching;
  const data = query.data;
  const collection =
    scope.kind === 'whole-task' && data && 'answers' in data ? data : null;
  const collectionView = useMemo(
    () =>
      collection
        ? buildStationTaskBasisCollectionView({
            kind: 'authorized-collection',
            collection,
          })
        : null,
    [collection],
  );
  useEffect(() => {
    if (
      scope.kind === 'whole-task' &&
      collectionView?.status === 'available' &&
      collectionView.answers.length &&
      !collectionView.answers.some(
        (answer) => answer.answerReferenceId === activeUi.selectedAnswer,
      )
    )
      updateUi((current) => ({
        ...current,
        selectedAnswer: collectionView.answers[0]?.answerReferenceId,
        disclosures: {},
        itemWindows: {},
        focusedAction: undefined,
        restoreFocus: undefined,
      }));
  }, [activeUi.selectedAnswer, collectionView, scope.kind, updateUi]);
  const selectedEntry =
    collectionView?.status === 'available'
      ? (collectionView.answers.find(
          (answer) => answer.answerReferenceId === activeUi.selectedAnswer,
        ) ?? collectionView.answers[0])
      : undefined;
  const projection =
    scope.kind === 'whole-task'
      ? undefined
      : data && !('answers' in data)
        ? data
        : undefined;
  const model = useMemo(() => {
    if (scope.kind === 'whole-task') return selectedEntry?.panel ?? null;
    return projection ? buildBasisPanelViewModel(projection) : null;
  }, [projection, scope.kind, selectedEntry]);
  useEffect(() => {
    const previous = refresh.current;
    refresh.current = { identity, isLoading: queryIsLoading };
    if (
      previous.identity === identity &&
      !previous.isLoading &&
      queryIsLoading &&
      activeUi.focusedAction
    )
      updateUi((current) => ({
        ...current,
        restoreFocus: current.focusedAction,
      }));
  }, [activeUi.focusedAction, identity, queryIsLoading, updateUi]);
  const isDisclosureOpen = (id: DisclosureId, defaultValue: string) =>
    activeUi.disclosures[id] ?? disclosureOpen(defaultValue);
  const setDisclosureOpen = (id: DisclosureId, open: boolean) => {
    updateUi((current) => ({
      ...current,
      disclosures: { ...current.disclosures, [id]: open },
    }));
  };
  const visibleItemCount = (resetKey: string) =>
    activeUi.itemWindows[resetKey] ?? PAGE_SIZE;
  const setVisibleItemCount = (resetKey: string, count: number) => {
    updateUi((current) => ({
      ...current,
      itemWindows: { ...current.itemWindows, [resetKey]: count },
    }));
  };
  const executionFocus = (occurrenceKey: string) => {
    const restore = activeUi.restoreFocus;
    return {
      restoreFocusAction:
        restore?.occurrenceKey === occurrenceKey ? restore.action : undefined,
      onActionFocus: (action: StationBasisPaneExecutionAction) => {
        updateUi((current) => ({
          ...current,
          focusedAction: { occurrenceKey, action },
          restoreFocus: undefined,
        }));
      },
      onActionBlur: () => {
        updateUi((current) =>
          current.focusedAction?.occurrenceKey === occurrenceKey
            ? {
                ...current,
                focusedAction: undefined,
                restoreFocus: undefined,
              }
            : current,
        );
      },
      onFocusRestoreHandled: () => {
        updateUi((current) =>
          current.restoreFocus?.occurrenceKey === occurrenceKey
            ? { ...current, restoreFocus: undefined }
            : current,
        );
      },
    };
  };
  if (query.error)
    return (
      <section className="station-basis-pane" aria-label="Basis" role="alert">
        Basis is unavailable.
        <button type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </section>
    );
  if (queryIsLoading)
    return (
      <section
        className="station-basis-pane"
        aria-label="Basis"
        aria-busy="true"
      >
        Loading Basis…
      </section>
    );
  const scopeLabel =
    scope.kind === 'direct-answer'
      ? 'Current answer'
      : scope.kind === 'task-answer'
        ? 'Kept answer'
        : 'Whole Task';
  const viewerIdentity = JSON.stringify([
    identity,
    selectedEntry?.answerReferenceId ?? null,
  ]);
  return (
    <section className="station-basis-pane" aria-label="Basis">
      <p className="station-basis-pane__scope">{scopeLabel}</p>
      {collectionView?.status === 'available' ? (
        <>
          <p>{collectionView.chrome.noAggregateStandingNotice}</p>
          {collectionView.chrome.availability.length ? (
            <section aria-label="Task Basis availability">
              <h3>{collectionView.chrome.availabilityHeading}</h3>
              {collectionView.chrome.availability.map((gap) => (
                <p key={gap.state}>{gap.message}</p>
              ))}
            </section>
          ) : null}
          {collectionView.answers.length ? (
            <>
              <fieldset className="station-basis-pane__answers">
                <legend>{collectionView.chrome.keptAnswersHeading}</legend>
                {collectionView.answers
                  .slice(0, activeUi.visibleAnswers)
                  .map((answer) => {
                    return (
                      <button
                        type="button"
                        key={answer.answerReferenceId}
                        aria-pressed={
                          selectedEntry?.answerReferenceId ===
                          answer.answerReferenceId
                        }
                        onClick={() =>
                          updateUi((current) => ({
                            ...current,
                            selectedAnswer: answer.answerReferenceId,
                            disclosures: {},
                            itemWindows: {},
                            focusedAction: undefined,
                            restoreFocus: undefined,
                          }))
                        }
                      >
                        {answer.answerReferenceId} —{' '}
                        {answer.panel.standing.label}
                      </button>
                    );
                  })}
              </fieldset>
              {collectionView.answers.length > PAGE_SIZE ? (
                <button
                  type="button"
                  aria-disabled={
                    activeUi.visibleAnswers >= collectionView.answers.length
                      ? true
                      : undefined
                  }
                  onClick={() => {
                    if (
                      activeUi.visibleAnswers >= collectionView.answers.length
                    )
                      return;
                    updateUi((current) => ({
                      ...current,
                      visibleAnswers: Math.min(
                        current.visibleAnswers + PAGE_SIZE,
                        collectionView.answers.length,
                      ),
                    }));
                  }}
                >
                  {activeUi.visibleAnswers < collectionView.answers.length
                    ? 'Show more kept answers'
                    : 'All kept answers shown'}
                </button>
              ) : null}
            </>
          ) : (
            <p>{collectionView.chrome.noAnswersMessage}</p>
          )}
          {collectionView.unassociated.length ? (
            <section>
              <h3>{collectionView.chrome.unassociatedHeading}</h3>
              <ul>
                {collectionView.chrome.unassociatedItems.map((item) => (
                  <li key={item.id}>{item.label}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <section
            className="station-basis-pane__process"
            aria-label="Process kept gate evaluations"
          >
            <h3>{collectionView.chrome.keptGateEvaluationsHeading}</h3>
            {collectionView.keptGateEvaluations.length ? (
              <ProgressiveItems
                items={collectionView.keptGateEvaluations}
                moreLabel="Show more kept gate evaluations"
                visibleCount={visibleItemCount(`${identity}:process`)}
                onVisibleCountChange={(count) =>
                  setVisibleItemCount(`${identity}:process`, count)
                }
                renderItem={(item) => (
                  <GateEvaluationRow key={item.referenceId} item={item} />
                )}
              />
            ) : (
              <p>{collectionView.chrome.noKeptGateEvaluationsMessage}</p>
            )}
          </section>
          <details className="station-basis-pane__section" open>
            <summary className="station-basis-pane__summary">Execution</summary>
            {collection?.keptToolResults.length ? (
              collection.keptToolResults.map((kept) => (
                <article
                  className="station-basis-pane__kept-result"
                  key={kept.referenceId}
                >
                  <p>Kept result {kept.ref.resultId}</p>
                  {renderExecutionActions?.({
                    ref: kept.ref,
                    scope,
                    occurrenceKey: JSON.stringify([
                      identity,
                      'kept',
                      kept.referenceId,
                    ]),
                    keptReference: kept,
                    ...executionFocus(
                      JSON.stringify([identity, 'kept', kept.referenceId]),
                    ),
                  })}
                  {kept.associatedAnswerReferenceIds.length === 0 ? (
                    <p>Kept in Task, not associated with an available answer</p>
                  ) : null}
                </article>
              ))
            ) : (
              <p>None recorded.</p>
            )}
          </details>
        </>
      ) : collectionView?.status === 'unavailable' ? (
        <p>Whole Task Basis is unavailable.</p>
      ) : null}
      {model ? (
        <Viewer
          identity={viewerIdentity}
          model={model}
          scope={scope}
          keptToolResults={collection?.keptToolResults ?? []}
          renderExecutionActions={renderExecutionActions}
          disclosureOpen={isDisclosureOpen}
          onDisclosureChange={setDisclosureOpen}
          visibleItemCount={visibleItemCount}
          onVisibleItemCountChange={setVisibleItemCount}
          executionFocus={executionFocus}
        />
      ) : null}
    </section>
  );
}

function isThreadResultRef(
  ref: BasisContributionRefV2,
): ref is StationBasisPaneExecutionResultRef {
  return ref.authority === '@kontourai/thread' && ref.kind === 'result';
}

function sameResultRef(
  left: StationBasisPaneExecutionResultRef,
  right: StationBasisPaneExecutionResultRef,
): boolean {
  return left.threadId === right.threadId && left.resultId === right.resultId;
}
