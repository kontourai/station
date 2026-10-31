import {
  type LearningReviewAction,
  type LearningReviewDetail,
  type LearningReviewIntentInput,
  type LearningReviewOwnerRef,
  type LearningReviewProposalInput,
  type LearningReviewRevisionRef,
  type LearningReviewSourceSelection,
} from '@kontourai/station-contracts/learning-review';
import { isLearningAccessRefusal } from '@kontourai/station-sdk/client/learning-review';
import {
  type LearningReviewRequestScope,
  useProjectLearningDetailQuery,
  useProjectLearningEvidenceQuery,
  useProjectLearningIntentMutation,
  useProjectLearningQuery,
  useProposeProjectLearningMutation,
} from '@kontourai/station-sdk/learning-review-query';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { Badge } from '@kontourai/ui/react';
import {
  type SelectHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useState,
} from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { ArrowDownGlyph } from '../../components/icons/Glyph';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { openChatsStore } from '../../contexts/open-chats-store';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';
import './LearningReviewPanel.css';

type Available = Extract<LearningReviewDetail, { state: 'available' }>;
const refKey = (ref: LearningReviewRevisionRef) =>
  JSON.stringify([ref.authority, ref.kind, ref.id, ref.revision]);
const gapLabels: Record<string, string> = {
  'not-captured': 'Not captured',
  restricted: 'Restricted',
  unavailable: 'Unavailable',
  'unsupported-version': 'Owner version unsupported',
  corrupt: 'Owner data corrupt',
};
const gapLabel = (state: string) => gapLabels[state] ?? state;

export function LearningReviewPanel(props: {
  slug: string;
  projectId: string;
  authority: LearningReviewRequestScope;
  proposalSource?: {
    selection: LearningReviewSourceSelection;
    title: string;
    body: string;
  };
  evidenceOptions?: { ref: LearningReviewRevisionRef; label: string }[];
}) {
  const flags = useSurfaceVisibilityFlags();
  return flags.has('learning-lifecycle-review') ? (
    <ProjectLearningReview {...props} />
  ) : null;
}

function ProjectLearningReview({
  slug,
  projectId,
  authority,
  proposalSource,
  evidenceOptions = [],
}: Parameters<typeof LearningReviewPanel>[0]) {
  const index = useProjectLearningQuery(slug, projectId, authority);
  const [selected, setSelected] = useState('');
  const [compareId, setCompareId] = useState<string>();
  const read = useProjectLearningDetailQuery(
    slug,
    projectId,
    selected,
    compareId,
    authority,
  );
  const mutate = useProjectLearningIntentMutation(slug, projectId, authority);
  const [action, setAction] = useState<LearningReviewAction>('evaluate');
  const [text, setText] = useState('');
  const [evidenceKey, setEvidenceKey] = useState('');
  const [assessment, setAssessment] = useState<
    'supported' | 'countered' | 'unresolved'
  >('unresolved');
  const [evaluation, setEvaluation] = useState<
    'supported' | 'countered' | 'mixed' | 'inconclusive'
  >('inconclusive');
  const [replacementId, setReplacementId] = useState('');
  const [inspected, setInspected] = useState<LearningReviewRevisionRef>();
  const [operation, setOperation] = useState<{
    id: string;
    revision: number;
  }>();
  const [localError, setLocalError] = useState('');
  const [showProposal, setShowProposal] = useState(false);
  const [showReceipts, setShowReceipts] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const cachedOwner =
    index.data?.state === 'available' || read.data?.state === 'available';
  const refused =
    isLearningAccessRefusal(mutate.error) ||
    (cachedOwner &&
      (isLearningAccessRefusal(index.error) ||
        (!!selected && isLearningAccessRefusal(read.error)))) ||
    (!index.isFetching && index.data?.state === 'restricted') ||
    (!!selected && !read.isFetching && read.data?.state === 'restricted');
  const { guard, DiscardModal } = useUnsavedGuard(!!operation);
  const id = useId();
  const list =
    authority.isCurrent() && index.data?.state === 'available'
      ? index.data
      : undefined;
  const details =
    authority.isCurrent() &&
    !read.error &&
    read.data?.state === 'available' &&
    read.data.projection.scope.id === projectId
      ? read.data
      : undefined;
  const records =
    list?.items.filter(
      (item): item is Available =>
        item.state === 'available' &&
        item.projection.scope.kind === 'project' &&
        item.projection.scope.id === projectId,
    ) ?? [];
  const candidate = details?.projection.candidate;
  const refs =
    candidate?.state === 'available'
      ? [
          ...candidate.value.supportingRefs,
          ...candidate.value.counterRefs,
          ...candidate.value.conflictRefs,
        ]
      : [];
  const choices = new Map(
    evidenceOptions.map((option) => [refKey(option.ref), option]),
  );
  for (const ref of refs)
    if (typeof ref.revision === 'string') {
      const exact = { ...ref, revision: ref.revision };
      choices.set(refKey(exact), {
        ref: exact,
        label: `${ref.kind}: ${ref.id} @ ${ref.revision}`,
      });
    }
  const edited = () => {
    if (details)
      setOperation((current) => ({
        id: randomCorrelationId(),
        revision: current?.revision ?? details.revision,
      }));
  };
  const resetMutation = mutate.reset;
  const reset = useCallback(() => {
    setOperation(undefined);
    setText('');
    setEvidenceKey('');
    setReplacementId('');
    setLocalError('');
    setInspected(undefined);
    resetMutation();
  }, [resetMutation]);
  useEffect(() => {
    if (!refused) return;
    setAccessLost(true);
    setSelected('');
    setCompareId(undefined);
    setShowProposal(false);
    setShowReceipts(false);
    reset();
  }, [refused, reset]);
  const submit = async () => {
    if (!details) return;
    const base = {
      intentId: operation?.id ?? randomCorrelationId(),
      expectedRevision: operation?.revision ?? details.revision,
    };
    const evidence = choices.get(evidenceKey)?.ref;
    let intent: LearningReviewIntentInput;
    switch (action) {
      case 'evaluate':
        if (!evidence) {
          setLocalError('Choose verified evidence.');
          return;
        }
        intent = { ...base, action, status: evaluation, evidence: [evidence] };
        break;
      case 'observe-effect':
        if (!evidence) {
          setLocalError('Choose verified evidence.');
          return;
        }
        intent = { ...base, action, assessment, evidence };
        break;
      case 'approve':
      case 'reject':
        intent = { ...base, action, rationale: text };
        break;
      case 'retire':
        intent = { ...base, action, reason: text };
        break;
      case 'supersede': {
        const replacement = records.find((item) => item.id === replacementId);
        const proposed = replacement?.projection.candidate;
        if (
          proposed?.state !== 'available' ||
          !proposed.value.proposedRevisionRef
        ) {
          setLocalError('Choose the exact replacement revision.');
          return;
        }
        intent = {
          ...base,
          action,
          replacementId,
          replacementRevision: proposed.value.proposedRevisionRef.revision,
        };
        break;
      }
      default:
        intent = { ...base, action: 'activate' };
    }
    try {
      await mutate.mutateAsync({ id: details.id, intent });
      reset();
    } catch {
      /* The mutation error remains visible; refreshing reads owner truth. */
    }
  };
  if (refused || accessLost)
    return (
      <ErrorState
        variant="compact"
        title="Learning access changed"
        description="Read current owner state before continuing."
        action={
          <Button
            onClick={() => {
              void index.refetch().then((result) => {
                if (!result.error && result.data?.state === 'available')
                  setAccessLost(false);
              });
            }}
          >
            Check access
          </Button>
        }
      />
    );
  return (
    <section className="learning-review" aria-labelledby={`${id}-title`}>
      <div className="learning-review__heading">
        <div>
          <h3 id={`${id}-title`}>Learning review</h3>
          <p>
            Review owner evidence and register approved context instructions.
          </p>
        </div>
        {proposalSource && (
          <Button
            size="sm"
            disabled={showProposal}
            onClick={() => setShowProposal(true)}
          >
            Review as learning
          </Button>
        )}
      </div>
      {showProposal && proposalSource && (
        <LearningReviewProposalForm
          slug={slug}
          projectId={projectId}
          authority={authority}
          source={proposalSource}
          onComplete={() => setShowProposal(false)}
        />
      )}
      {!proposalSource && (
        <p>Start a proposal from a Task lesson or rated response.</p>
      )}
      {index.isLoading ? (
        <SkeletonBlock label="Loading owner learning records" />
      ) : index.error ? (
        <ErrorState
          variant="compact"
          title="Learning review unavailable"
          description={errorText(index.error)}
          action={
            <Button size="sm" onClick={() => void index.refetch()}>
              Retry
            </Button>
          }
        />
      ) : !list ? (
        <Empty
          label={
            index.data
              ? gapLabel(index.data.state)
              : 'Learning owner unavailable'
          }
        />
      ) : (
        <>
          {list.coverage === 'partial' && (
            <p>Some owner records or evidence are unavailable.</p>
          )}
          {records.length === 0 ? (
            <Empty label="Nothing to review" />
          ) : (
            <label htmlFor={`${id}-learning`}>
              Learning
              <LearningSelect
                id={`${id}-learning`}
                className="choice-trigger"
                value={selected}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  guard(() => {
                    reset();
                    setSelected(next);
                    setCompareId(undefined);
                  });
                }}
              >
                <option value="">Choose a learning</option>
                {records.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.projection.candidate.state === 'available'
                      ? item.projection.candidate.value.title
                      : item.id}
                  </option>
                ))}
              </LearningSelect>
            </label>
          )}
          {selected &&
            (read.isLoading ? (
              <SkeletonBlock label="Loading exact learning revision" />
            ) : read.error ? (
              <ErrorState
                variant="compact"
                title="Learning revision unavailable"
                description={errorText(read.error)}
                action={
                  <Button size="sm" onClick={() => void read.refetch()}>
                    Retry
                  </Button>
                }
              />
            ) : !details ? (
              <Empty label={gapLabel(read.data?.state ?? 'unavailable')} />
            ) : (
              <>
                <Badge
                  value={
                    details.active
                      ? 'Active learning'
                      : details.supersededBy
                        ? 'Superseded'
                        : 'Not active'
                  }
                />
                <p>
                  Activation registers context instructions; installation and
                  provider execution are separate.
                </p>
                <dl className="learning-review__facts">
                  <div>
                    <dt>Scope</dt>
                    <dd>
                      {details.projection.scope.kind} ·{' '}
                      {details.projection.scope.id}
                    </dd>
                  </div>
                  <div>
                    <dt>Revision</dt>
                    <dd>
                      {candidate?.state === 'available'
                        ? candidate.value.proposedRevisionRef?.revision
                        : details.revision}
                    </dd>
                  </div>
                  <div>
                    <dt>Expected effect</dt>
                    <dd>
                      {candidate?.state === 'available'
                        ? candidate.value.expectedEffect
                        : 'Not captured'}
                    </dd>
                  </div>
                  <div>
                    <dt>Decision</dt>
                    <dd>
                      {details.projection.decision.state === 'available'
                        ? details.projection.decision.value.status
                        : gapLabel(details.projection.decision.state)}
                    </dd>
                  </div>
                  <div>
                    <dt>Evaluation</dt>
                    <dd>
                      {details.projection.evaluation.state === 'available'
                        ? details.projection.evaluation.value.status
                        : gapLabel(details.projection.evaluation.state)}
                    </dd>
                  </div>
                  <div>
                    <dt>Source capture time</dt>
                    <dd>{gapLabel(details.projection.source.state)}</dd>
                  </div>
                  <div>
                    <dt>Freshness</dt>
                    <dd>
                      {candidate?.state === 'available'
                        ? candidate.value.freshness.state
                        : 'unknown'}
                    </dd>
                  </div>
                </dl>
                <label htmlFor={`${id}-comparison`}>
                  Compare with
                  <LearningSelect
                    id={`${id}-comparison`}
                    className="choice-trigger"
                    value={compareId ?? ''}
                    onChange={(event) =>
                      setCompareId(event.target.value || undefined)
                    }
                  >
                    <option value="">Without comparison</option>
                    {records
                      .filter((item) => item.id !== details.id)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.projection.candidate.state === 'available'
                            ? item.projection.candidate.value.title
                            : item.id}
                        </option>
                      ))}
                  </LearningSelect>
                </label>
                <div className="learning-review__compare">
                  <div>
                    <h4>Proposed revision</h4>
                    <pre>{details.body}</pre>
                  </div>
                  {details.comparison?.state === 'available' && (
                    <div>
                      <h4>{details.comparison.title}</h4>
                      <Badge
                        value={
                          details.comparison.active
                            ? 'Active learning'
                            : 'Not active'
                        }
                      />
                      <pre>{details.comparison.body}</pre>
                    </div>
                  )}
                  {details.comparison &&
                    details.comparison.state !== 'available' && (
                      <Empty
                        label={`Comparison: ${gapLabel(details.comparison.state)}`}
                      />
                    )}
                </div>
                {candidate?.state === 'available' && (
                  <LearningSources
                    onInspect={setInspected}
                    sections={[
                      {
                        label: 'Supporting',
                        refs: candidate.value.supportingRefs,
                      },
                      {
                        label: 'Counter evidence',
                        refs: candidate.value.counterRefs,
                      },
                      {
                        label: 'Conflicts',
                        refs: candidate.value.conflictRefs,
                      },
                      {
                        label: 'Targets',
                        refs: candidate.value.deploymentTargets,
                      },
                    ]}
                  />
                )}
                {details.projection.activation.state === 'available' &&
                  details.projection.activation.value.status !== 'inactive' && (
                    <section aria-label="Recorded learning contributions">
                      <h4>Attached to recent Task turns</h4>
                      <p>
                        {details.contributionCoverage ===
                        'up-to-100-recent-task-turns'
                          ? 'Up to 100 recent Task turns; later brief reads are not counted.'
                          : 'Attachment history unavailable.'}
                      </p>
                      {details.projection.activation.value
                        .contributionDisclosures.length ? (
                        <ul>
                          {details.projection.activation.value.contributionDisclosures.map(
                            (disclosure) => (
                              <li key={JSON.stringify(disclosure.turnRef)}>
                                {disclosure.turnRef.id} ·{' '}
                                {disclosure.turnRef.revision ??
                                  'revision unknown'}
                                {disclosure.coordinate && (
                                  <Button
                                    size="sm"
                                    onClick={() => {
                                      void openChatsStore
                                        .openConversation(
                                          disclosure.coordinate!.conversationId,
                                          () => authority.isCurrent(),
                                          { revealDock: true },
                                        )
                                        .then((opened) => {
                                          if (!opened)
                                            setLocalError(
                                              'Contributing conversation unavailable.',
                                            );
                                        });
                                    }}
                                  >
                                    Open conversation
                                  </Button>
                                )}
                              </li>
                            ),
                          )}
                        </ul>
                      ) : (
                        <p>Attachment receipts not returned.</p>
                      )}
                    </section>
                  )}
                <h4>Observed effects</h4>
                {details.projection.effect.state === 'available' &&
                details.projection.effect.value.observations.length ? (
                  <ul>
                    {details.projection.effect.value.observations.map(
                      (observation) => (
                        <li key={JSON.stringify(observation.observationRef)}>
                          {observation.assessment} ·{' '}
                          {observation.observationRef.id} ·{' '}
                          {observation.observedAt}
                        </li>
                      ),
                    )}
                  </ul>
                ) : (
                  <p>Effect not observed.</p>
                )}
                {details.projection.retirement.state === 'available' &&
                  details.projection.retirement.value.status === 'retired' && (
                    <p>Retired: {details.projection.retirement.value.reason}</p>
                  )}
                {details.supersededBy && (
                  <p>
                    Superseded by {details.supersededBy.id} @{' '}
                    {details.supersededBy.revision}
                  </p>
                )}
                <DisclosureToggle
                  expanded={showReceipts}
                  onToggle={() => setShowReceipts(!showReceipts)}
                >
                  Decision receipts ({details.receipts.length})
                </DisclosureToggle>
                {showReceipts && (
                  <ul>
                    {details.receipts.map((receipt) => (
                      <li key={receipt.ref.id}>
                        {receipt.action} · {receipt.actorId} · {receipt.at} ·{' '}
                        {receipt.ref.id}
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <label htmlFor={`${id}-action`}>
                    Action
                    <LearningSelect
                      id={`${id}-action`}
                      className="choice-trigger"
                      value={action}
                      onChange={(event) => {
                        setAction(event.target.value as LearningReviewAction);
                        edited();
                      }}
                    >
                      {[
                        'evaluate',
                        'approve',
                        'reject',
                        'activate',
                        'observe-effect',
                        'retire',
                        'supersede',
                      ].map((value) => (
                        <option key={value} value={value}>
                          {value.replaceAll('-', ' ')}
                        </option>
                      ))}
                    </LearningSelect>
                  </label>
                  {action === 'evaluate' && (
                    <label htmlFor={`${id}-evaluation`}>
                      Evaluation
                      <LearningSelect
                        id={`${id}-evaluation`}
                        className="choice-trigger"
                        value={evaluation}
                        onChange={(event) => {
                          setEvaluation(
                            event.target.value as typeof evaluation,
                          );
                          edited();
                        }}
                      >
                        {[
                          'supported',
                          'countered',
                          'mixed',
                          'inconclusive',
                        ].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </LearningSelect>
                    </label>
                  )}
                  {action === 'observe-effect' && (
                    <label htmlFor={`${id}-assessment`}>
                      Assessment
                      <LearningSelect
                        id={`${id}-assessment`}
                        className="choice-trigger"
                        value={assessment}
                        onChange={(event) => {
                          setAssessment(
                            event.target.value as typeof assessment,
                          );
                          edited();
                        }}
                      >
                        {['supported', 'countered', 'unresolved'].map(
                          (value) => (
                            <option key={value}>{value}</option>
                          ),
                        )}
                      </LearningSelect>
                    </label>
                  )}
                  {(action === 'evaluate' || action === 'observe-effect') && (
                    <label htmlFor={`${id}-evidence`}>
                      Evidence
                      <LearningSelect
                        id={`${id}-evidence`}
                        className="choice-trigger"
                        value={evidenceKey}
                        onChange={(event) => {
                          setEvidenceKey(event.target.value);
                          edited();
                        }}
                      >
                        <option value="">Choose verified evidence</option>
                        {[...choices].map(([key, option]) => (
                          <option key={key} value={key}>
                            {option.label}
                          </option>
                        ))}
                      </LearningSelect>
                    </label>
                  )}
                  {['approve', 'reject', 'retire'].includes(action) && (
                    <label>
                      Reason
                      <textarea
                        value={text}
                        maxLength={4096}
                        required
                        onChange={(event) => {
                          setText(event.target.value);
                          edited();
                        }}
                      />
                    </label>
                  )}
                  {action === 'observe-effect' && (
                    <p>
                      For later evidence, use Review as learning on its Task
                      lesson or rated response.
                    </p>
                  )}
                  {action === 'supersede' && (
                    <label htmlFor={`${id}-replacement`}>
                      Replacement
                      <LearningSelect
                        id={`${id}-replacement`}
                        className="choice-trigger"
                        value={replacementId}
                        onChange={(event) => {
                          setReplacementId(event.target.value);
                          edited();
                        }}
                      >
                        <option value="">Choose replacement</option>
                        {records
                          .filter(
                            (item) => item.id !== details.id && item.active,
                          )
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.id}
                            </option>
                          ))}
                      </LearningSelect>
                    </label>
                  )}
                  {(localError || mutate.error) && (
                    <ErrorState
                      variant="compact"
                      title="Owner action not confirmed"
                      description={localError || errorText(mutate.error)}
                      action={
                        <Button size="sm" onClick={() => void read.refetch()}>
                          Refresh owner state
                        </Button>
                      }
                    />
                  )}
                  <Button
                    type="submit"
                    disabled={mutate.isPending || !authority.isCurrent()}
                  >
                    {mutate.isPending ? 'Waiting for owner' : 'Submit to owner'}
                  </Button>
                </form>
              </>
            ))}
        </>
      )}
      {inspected && details && (
        <LearningEvidenceDialog
          slug={slug}
          projectId={projectId}
          id={details.id}
          reference={inspected}
          authority={authority}
          onClose={() => setInspected(undefined)}
        />
      )}
      <DiscardModal />
    </section>
  );
}

export interface LearningReviewProposalContext {
  selection: LearningReviewSourceSelection;
  title: string;
  body: string;
  truncated?: boolean;
  expectedSourceRef?: LearningReviewRevisionRef;
}

export function LearningReviewProposalDialog({
  onClose,
  ...props
}: {
  slug: string;
  projectId: string;
  authority: LearningReviewRequestScope;
  source: LearningReviewProposalContext;
  onClose(): void;
}) {
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'proposal' | 'effect'>('proposal');
  const modeId = useId();
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  if (!props.authority.isCurrent()) return null;
  return (
    <>
      <Dialog
        title="Review as learning"
        closeLabel="Close learning proposal"
        onClose={() => guard(onClose)}
        size="lg"
      >
        <div className="learning-review">
          <label htmlFor={modeId}>Learning action</label>
          <LearningSelect
            id={modeId}
            value={mode}
            onChange={(event) => {
              const next = event.target.value as typeof mode;
              guard(() => {
                setMode(next);
                setDirty(false);
              });
            }}
          >
            <option value="proposal">Propose learning</option>
            <option value="effect">Observe effect</option>
          </LearningSelect>
        </div>
        {mode === 'proposal' ? (
          <LearningReviewProposalForm
            {...props}
            onDirty={setDirty}
            onComplete={() => {
              setDirty(false);
              onClose();
            }}
          />
        ) : (
          <LearningSourceEffectForm
            {...props}
            onDirty={setDirty}
            onComplete={() => {
              setDirty(false);
              onClose();
            }}
          />
        )}
      </Dialog>
      <DiscardModal />
    </>
  );
}

export function LearningReviewProposalForm({
  slug,
  projectId,
  authority,
  source,
  onDirty,
  onComplete,
}: {
  slug: string;
  projectId: string;
  authority: LearningReviewRequestScope;
  source: LearningReviewProposalContext;
  onDirty?(dirty: boolean): void;
  onComplete(): void;
}) {
  const [draft, setDraft] = useState(() => ({
    title: source.title,
    body: source.body,
    expectedEffect: '',
    intentId: randomCorrelationId(),
    learningId: randomCorrelationId(),
  }));
  const [dirty, setDirty] = useState(false);
  const mutation = useProposeProjectLearningMutation(
    slug,
    projectId,
    authority,
  );
  const { DiscardModal } = useUnsavedGuard(!onDirty && dirty);
  const [accessLost, setAccessLost] = useState(false);
  const refused = isLearningAccessRefusal(mutation.error);
  useEffect(() => {
    if (!refused) return;
    setAccessLost(true);
    setDraft((current) => ({
      ...current,
      title: '',
      body: '',
      expectedEffect: '',
    }));
    setDirty(false);
    onDirty?.(false);
    mutation.reset();
  }, [refused, mutation.reset, onDirty]);
  const change = (key: 'title' | 'body' | 'expectedEffect', value: string) => {
    setDirty(true);
    onDirty?.(true);
    setDraft((current) => ({
      ...current,
      [key]: value,
      intentId: randomCorrelationId(),
    }));
  };
  if (refused || accessLost)
    return (
      <ErrorState
        variant="compact"
        title="Source access changed"
        description="Check owner state before proposing again."
        action={<Button onClick={onComplete}>Close</Button>}
      />
    );
  return (
    <form
      className="learning-review learning-review__proposal"
      onSubmit={(event) => {
        event.preventDefault();
        const input: LearningReviewProposalInput = {
          intentId: draft.intentId,
          learningId: draft.learningId,
          source: source.selection,
          expectedSourceRef: source.expectedSourceRef,
          kind: 'guideline',
          title: draft.title,
          body: draft.body,
          expectedEffect: draft.expectedEffect,
        };
        void mutation
          .mutateAsync(input)
          .then(() => {
            setDirty(false);
            onDirty?.(false);
            onComplete?.();
          })
          .catch(() => {});
      }}
    >
      <h4>
        {source.selection.kind === 'rated-feedback'
          ? 'From rated response'
          : source.selection.recordKind === 'dead-end'
            ? 'From Task dead end'
            : 'From Task standing decision'}
      </h4>
      <p>
        Proposal only. Approval and activation are separate owner decisions.
      </p>
      {source.truncated && (
        <p>
          Source excerpt; review the full response before proposing a learning.
        </p>
      )}
      <label>
        Title
        <input
          required
          maxLength={240}
          value={draft.title}
          onChange={(event) => change('title', event.target.value)}
        />
      </label>
      <label>
        Proposed instructions
        <textarea
          required
          maxLength={16384}
          value={draft.body}
          onChange={(event) => change('body', event.target.value)}
        />
      </label>
      <label>
        Expected effect
        <textarea
          required
          maxLength={2048}
          value={draft.expectedEffect}
          onChange={(event) => change('expectedEffect', event.target.value)}
        />
      </label>
      {mutation.error && (
        <ErrorState
          variant="compact"
          title="Proposal not confirmed"
          description={errorText(mutation.error)}
        />
      )}
      {mutation.isSuccess && <p>Owner proposal receipt recorded.</p>}
      <Button
        type="submit"
        disabled={mutation.isPending || !authority.isCurrent()}
      >
        Propose to owner
      </Button>
      <DiscardModal />
    </form>
  );
}

function LearningSourceEffectForm({
  slug,
  projectId,
  authority,
  source,
  onDirty,
  onComplete,
}: {
  slug: string;
  projectId: string;
  authority: LearningReviewRequestScope;
  source: LearningReviewProposalContext;
  onDirty(dirty: boolean): void;
  onComplete(): void;
}) {
  const read = useProjectLearningQuery(slug, projectId, authority);
  const mutation = useProjectLearningIntentMutation(slug, projectId, authority);
  const [target, setTarget] = useState<{ id: string; revision: number }>();
  const [assessment, setAssessment] = useState<
    'supported' | 'countered' | 'unresolved'
  >('unresolved');
  const [intentId, setIntentId] = useState(randomCorrelationId);
  const [accessLost, setAccessLost] = useState(false);
  const refused = isLearningAccessRefusal(mutation.error);
  useEffect(() => {
    if (!refused) return;
    setAccessLost(true);
    setTarget(undefined);
    onDirty(false);
    mutation.reset();
  }, [refused, mutation.reset, onDirty]);
  const id = useId();
  const records =
    read.data?.state === 'available'
      ? read.data.items.filter(
          (item): item is Available =>
            item.state === 'available' &&
            item.active &&
            item.projection.scope.id === projectId,
        )
      : [];
  if (refused || accessLost)
    return (
      <ErrorState
        variant="compact"
        title="Source access changed"
        description="Check owner state before recording another effect."
        action={<Button onClick={onComplete}>Close</Button>}
      />
    );
  return (
    <form
      className="learning-review"
      onSubmit={(event) => {
        event.preventDefault();
        if (!target) return;
        void mutation
          .mutateAsync({
            id: target.id,
            intent: {
              intentId,
              expectedRevision: target.revision,
              action: 'observe-effect',
              assessment,
              source: source.selection,
              expectedSourceRef: source.expectedSourceRef,
            },
          })
          .then(() => {
            onDirty(false);
            onComplete();
          })
          .catch(() => {});
      }}
    >
      <p>Record a source-backed observation.</p>
      <pre>{source.body}</pre>
      {read.isLoading ? (
        <SkeletonBlock label="Reading active learning revisions" />
      ) : read.error ? (
        <ErrorState
          variant="compact"
          title="Active learning unavailable"
          action={<Button onClick={() => void read.refetch()}>Retry</Button>}
        />
      ) : records.length ? (
        <>
          <label htmlFor={`${id}-target`}>Active learning</label>
          <LearningSelect
            id={`${id}-target`}
            required
            value={target?.id ?? ''}
            onChange={(event) => {
              const item = records.find(
                (item) => item.id === event.target.value,
              );
              setTarget(
                item ? { id: item.id, revision: item.revision } : undefined,
              );
              setIntentId(randomCorrelationId());
              onDirty(true);
            }}
          >
            <option value="">Choose active learning</option>
            {records.map((item) => (
              <option key={item.id} value={item.id}>
                {item.projection.candidate.state === 'available'
                  ? item.projection.candidate.value.title
                  : item.id}
              </option>
            ))}
          </LearningSelect>
        </>
      ) : (
        <Empty label="Nothing active to assess" />
      )}
      <label htmlFor={`${id}-assessment`}>Assessment</label>
      <LearningSelect
        id={`${id}-assessment`}
        value={assessment}
        onChange={(event) => {
          setAssessment(event.target.value as typeof assessment);
          setIntentId(randomCorrelationId());
          onDirty(true);
        }}
      >
        <option value="unresolved">Unresolved</option>
        <option value="supported">Supported</option>
        <option value="countered">Countered</option>
      </LearningSelect>
      {mutation.error && (
        <ErrorState
          variant="compact"
          title="Effect not confirmed"
          description={errorText(mutation.error)}
          action={
            <Button onClick={() => void read.refetch()}>
              Refresh owner state
            </Button>
          }
        />
      )}
      <Button
        type="submit"
        disabled={!target || mutation.isPending || !authority.isCurrent()}
      >
        Record observed effect
      </Button>
    </form>
  );
}

function LearningSources({
  sections,
  onInspect,
}: {
  sections: { label: string; refs: readonly LearningReviewOwnerRef[] }[];
  onInspect(ref: LearningReviewRevisionRef): void;
}) {
  return (
    <div className="learning-review__sources">
      {sections.map((section) => (
        <div key={section.label}>
          <h4>{section.label}</h4>
          {section.refs.length ? (
            <ul>
              {section.refs.map((ref) => (
                <li key={JSON.stringify(ref)}>
                  {ref.authority} · {ref.kind} · {ref.id} ·{' '}
                  {ref.revision ?? 'revision unknown'}
                  {ref.revision && (
                    <Button
                      size="sm"
                      onClick={() =>
                        onInspect({ ...ref, revision: ref.revision! })
                      }
                    >
                      Inspect source
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>None reported</p>
          )}
        </div>
      ))}
    </div>
  );
}

function LearningSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="learning-review__select">
      <select {...props} className="choice-trigger" />
      <ArrowDownGlyph className="choice-caret" />
    </span>
  );
}

function LearningEvidenceDialog({
  slug,
  projectId,
  id,
  reference,
  authority,
  onClose,
}: {
  slug: string;
  projectId: string;
  id: string;
  reference: LearningReviewRevisionRef;
  authority: LearningReviewRequestScope;
  onClose(): void;
}) {
  const query = useProjectLearningEvidenceQuery(
    slug,
    projectId,
    id,
    reference,
    authority,
  );
  const data = authority.isCurrent() && !query.error ? query.data : undefined;
  return (
    <Dialog
      title="Learning source"
      closeLabel="Close learning source"
      onClose={onClose}
      size="lg"
    >
      {query.isLoading ? (
        <SkeletonBlock label="Reading exact source revision" />
      ) : query.error ? (
        <ErrorState
          variant="compact"
          title="Source unavailable"
          description={errorText(query.error)}
          action={
            <Button onClick={() => void query.refetch()}>Retry source</Button>
          }
        />
      ) : data?.state === 'available' ? (
        <div className="learning-review">
          <h4>{data.title}</h4>
          <p>
            {data.ref.authority} · {data.ref.kind} · {data.ref.id} ·{' '}
            {data.ref.revision}
          </p>
          {data.capturedAt && (
            <time dateTime={data.capturedAt}>{data.capturedAt}</time>
          )}
          {data.truncated && (
            <p>Source excerpt; omitted content is not shown.</p>
          )}
          <pre>{data.text}</pre>
        </div>
      ) : (
        <Empty label={gapLabel(data?.state ?? 'unavailable')} />
      )}
    </Dialog>
  );
}
