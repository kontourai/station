import {
  LEARNING_REVIEW_PREVIEW,
  type LearningReviewAction,
  type LearningReviewDetail,
  type LearningReviewIntentInput,
  type LearningReviewOwnerRef,
  type LearningReviewProposalInput,
  type LearningReviewRevisionRef,
  type LearningReviewSourceSelection,
} from '@kontourai/station-contracts/learning-review';
import {
  type LearningReviewRequestScope,
  useProjectLearningDetailQuery,
  useProjectLearningIntentMutation,
  useProjectLearningQuery,
  useProposeProjectLearningMutation,
} from '@kontourai/station-sdk/learning-review-query';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { Badge } from '@kontourai/ui/react';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';
import './LearningReviewPanel.css';

type Available = Extract<LearningReviewDetail, { state: 'available' }>;
const refKey = (ref: LearningReviewRevisionRef) => JSON.stringify([ref.authority, ref.kind, ref.id, ref.revision]);
const gapLabels: Record<string, string> = { 'not-captured': 'Not captured', restricted: 'Restricted', unavailable: 'Unavailable',
  'unsupported-version': 'Owner version unsupported', corrupt: 'Owner data corrupt' };
const gapLabel = (state: string) => gapLabels[state] ?? state;

export function LearningReviewPanel(props: {
  slug: string;
  projectId: string;
  authority: LearningReviewRequestScope;
  proposalSource?: { selection: LearningReviewSourceSelection; title: string; body: string };
  evidenceOptions?: { ref: LearningReviewRevisionRef; label: string }[];
}) {
  const flags = useSurfaceVisibilityFlags();
  return flags.has(LEARNING_REVIEW_PREVIEW) ? <ProjectLearningReview {...props} /> : null;
}

function ProjectLearningReview({ slug, projectId, authority, proposalSource, evidenceOptions = [] }: Parameters<typeof LearningReviewPanel>[0]) {
  const index = useProjectLearningQuery(slug, projectId, authority);
  const [selected, setSelected] = useState('');
  const [compareId, setCompareId] = useState<string>();
  const read = useProjectLearningDetailQuery(slug, projectId, selected, compareId, authority);
  const mutate = useProjectLearningIntentMutation(slug, projectId, authority);
  const [action, setAction] = useState<LearningReviewAction>('evaluate');
  const [text, setText] = useState('');
  const [evidenceKey, setEvidenceKey] = useState('');
  const [assessment, setAssessment] = useState<'supported' | 'countered' | 'unresolved'>('unresolved');
  const [evaluation, setEvaluation] = useState<'supported' | 'countered' | 'mixed' | 'inconclusive'>('inconclusive');
  const [replacementId, setReplacementId] = useState('');
  const [operation, setOperation] = useState<{ id: string; revision: number }>();
  const [localError, setLocalError] = useState('');
  const [showProposal, setShowProposal] = useState(false);
  const [showReceipts, setShowReceipts] = useState(false);
  const { guard, DiscardModal } = useUnsavedGuard(!!operation);
  const id = useId();
  const list = authority.isCurrent() && index.data?.state === 'available' ? index.data : undefined;
  const details = authority.isCurrent() && read.data?.state === 'available' && read.data.projection.scope.id === projectId ? read.data : undefined;
  const records = list?.items.filter((item): item is Available => item.state === 'available' && item.projection.scope.kind === 'project' && item.projection.scope.id === projectId) ?? [];
  const candidate = details?.projection.candidate;
  const refs = candidate?.state === 'available' ? [...candidate.value.supportingRefs, ...candidate.value.counterRefs, ...candidate.value.conflictRefs] : [];
  const choices = new Map(evidenceOptions.map(option => [refKey(option.ref), option]));
  for (const ref of refs) if (typeof ref.revision === 'string') {
    const exact = { ...ref, revision: ref.revision };
    choices.set(refKey(exact), { ref: exact, label: `${ref.kind}: ${ref.id} @ ${ref.revision}` });
  }
  const edited = () => { if (details) setOperation(current => ({ id: randomCorrelationId(), revision: current?.revision ?? details.revision })); };
  const reset = () => { setOperation(undefined); setText(''); setEvidenceKey(''); setReplacementId(''); setLocalError(''); mutate.reset(); };
  const submit = async () => {
    if (!details) return;
    const base = { intentId: operation?.id ?? randomCorrelationId(), expectedRevision: operation?.revision ?? details.revision };
    const evidence = choices.get(evidenceKey)?.ref;
    let intent: LearningReviewIntentInput;
    switch (action) {
      case 'evaluate': if (!evidence) { setLocalError('Choose verified evidence.'); return; } intent = { ...base, action, status: evaluation, evidence: [evidence] }; break;
      case 'observe-effect': if (!evidence) { setLocalError('Choose verified evidence.'); return; } intent = { ...base, action, assessment, evidence }; break;
      case 'approve': case 'reject': intent = { ...base, action, rationale: text }; break;
      case 'retire': intent = { ...base, action, reason: text }; break;
      case 'supersede': {
        const replacement = records.find(item => item.id === replacementId);
        const proposed = replacement?.projection.candidate;
        if (proposed?.state !== 'available' || !proposed.value.proposedRevisionRef) { setLocalError('Choose the exact replacement revision.'); return; }
        intent = { ...base, action, replacementId, replacementRevision: proposed.value.proposedRevisionRef.revision }; break;
      }
      default: intent = { ...base, action: 'activate' };
    }
    try { await mutate.mutateAsync({ id: details.id, intent }); reset(); }
    catch { /* The mutation error remains visible; refreshing reads owner truth. */ }
  };
  return <section className="learning-review" aria-labelledby={`${id}-title`}>
    <div className="learning-review__heading"><div><h3 id={`${id}-title`}>Learning review</h3>
      <p>Review owner evidence and register approved context guidance.</p></div>
      <Button size="sm" disabled={showProposal} onClick={() => setShowProposal(true)}>Propose from a source</Button></div>
    {showProposal && <LearningReviewProposalForm slug={slug} projectId={projectId} authority={authority} source={proposalSource} />}
    {index.isLoading ? <SkeletonBlock label="Loading owner learning records" /> : index.error ?
      <ErrorState variant="compact" title="Learning review unavailable" description={errorText(index.error)}
        action={<Button size="sm" onClick={() => void index.refetch()}>Retry</Button>} /> :
      !list ? <Empty label={index.data ? gapLabel(index.data.state) : 'Learning owner unavailable'} /> : <>
      {list.coverage === 'partial' && <p>Some owner records or evidence are unavailable.</p>}
      {records.length === 0 ? <Empty label="No reviewable learning records" /> : <label>Learning
        <select className="choice-trigger" value={selected} onChange={event => { const next = event.currentTarget.value; guard(() => { reset(); setSelected(next); setCompareId(undefined); }); }}>
          <option value="">Choose a learning</option>{records.map(item => <option key={item.id} value={item.id}>{item.projection.candidate.state === 'available' ? item.projection.candidate.value.title : item.id}</option>)}
        </select></label>}
      {selected && (read.isLoading ? <SkeletonBlock label="Loading exact learning revision" /> : read.error ?
        <ErrorState variant="compact" title="Learning revision unavailable" description={errorText(read.error)} action={<Button size="sm" onClick={() => void read.refetch()}>Retry</Button>} /> :
        !details ? <Empty label={gapLabel(read.data?.state ?? 'unavailable')} /> : <>
        <Badge value={details.active ? 'Active guidance' : details.supersededBy ? 'Superseded' : 'Not active'} />
        <p>Activation registers context guidance; installation and provider execution are separate.</p>
        <dl className="learning-review__facts"><div><dt>Revision</dt><dd>{candidate?.state === 'available' ? candidate.value.proposedRevisionRef?.revision : details.revision}</dd></div>
          <div><dt>Expected effect</dt><dd>{candidate?.state === 'available' ? candidate.value.expectedEffect : 'Not captured'}</dd></div>
          <div><dt>Decision</dt><dd>{details.projection.decision.state === 'available' ? details.projection.decision.value.status : gapLabel(details.projection.decision.state)}</dd></div>
          <div><dt>Evaluation</dt><dd>{details.projection.evaluation.state === 'available' ? details.projection.evaluation.value.status : gapLabel(details.projection.evaluation.state)}</dd></div>
          <div><dt>Source capture time</dt><dd>{gapLabel(details.projection.source.state)}</dd></div>
          <div><dt>Freshness</dt><dd>{candidate?.state === 'available' ? candidate.value.freshness.state : 'unknown'}</dd></div></dl>
        <label>Compare with<select className="choice-trigger" value={compareId ?? ''} onChange={event => setCompareId(event.target.value || undefined)}>
          <option value="">No comparison</option>{records.filter(item => item.id !== details.id).map(item => <option key={item.id} value={item.id}>{item.projection.candidate.state === 'available' ? item.projection.candidate.value.title : item.id}</option>)}</select></label>
        <div className="learning-review__compare"><div><h4>Proposed revision</h4><pre>{details.body}</pre></div>
          {details.comparison?.state === 'available' && <div><h4>{details.comparison.title}</h4><Badge value={details.comparison.active ? 'Active guidance' : 'Not active'} /><pre>{details.comparison.body}</pre></div>}{details.comparison && details.comparison.state !== 'available' && <Empty label={`Comparison: ${gapLabel(details.comparison.state)}`} />}</div>
        {candidate?.state === 'available' && <LearningSources sections={[
          { label: 'Supporting', refs: candidate.value.supportingRefs }, { label: 'Counter evidence', refs: candidate.value.counterRefs },
          { label: 'Conflicts', refs: candidate.value.conflictRefs }, { label: 'Targets', refs: candidate.value.deploymentTargets },
        ]} />}
        <h4>Observed effects</h4>{details.projection.effect.state === 'available' && details.projection.effect.value.observations.length ? <ul>{details.projection.effect.value.observations.map(observation => <li key={JSON.stringify(observation.observationRef)}>{observation.assessment} · {observation.observationRef.id} · {observation.observedAt}</li>)}</ul> : <p>No effect observed.</p>}
        {details.projection.retirement.state === 'available' && details.projection.retirement.value.status === 'retired' && <p>Retired: {details.projection.retirement.value.reason}</p>}
        {details.supersededBy && <p>Superseded by {details.supersededBy.id} @ {details.supersededBy.revision}</p>}
        <DisclosureToggle expanded={showReceipts} onToggle={() => setShowReceipts(!showReceipts)}>Decision receipts ({details.receipts.length})</DisclosureToggle>
        {showReceipts && <ul>{details.receipts.map(receipt => <li key={receipt.ref.id}>{receipt.action} · {receipt.actorId} · {receipt.at} · {receipt.ref.id}</li>)}</ul>}
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label>Action<select className="choice-trigger" value={action} onChange={event => { setAction(event.target.value as LearningReviewAction); edited(); }}>
            {['evaluate', 'approve', 'reject', 'activate', 'observe-effect', 'retire', 'supersede'].map(value => <option key={value} value={value}>{value.replaceAll('-', ' ')}</option>)}</select></label>
          {action === 'evaluate' && <label>Evaluation<select className="choice-trigger" value={evaluation} onChange={event => { setEvaluation(event.target.value as typeof evaluation); edited(); }}>{['supported', 'countered', 'mixed', 'inconclusive'].map(value => <option key={value}>{value}</option>)}</select></label>}
          {action === 'observe-effect' && <label>Assessment<select className="choice-trigger" value={assessment} onChange={event => { setAssessment(event.target.value as typeof assessment); edited(); }}>{['supported', 'countered', 'unresolved'].map(value => <option key={value}>{value}</option>)}</select></label>}
          {(action === 'evaluate' || action === 'observe-effect') && <label>Evidence<select className="choice-trigger" value={evidenceKey} onChange={event => { setEvidenceKey(event.target.value); edited(); }}><option value="">Choose verified evidence</option>{[...choices].map(([key, option]) => <option key={key} value={key}>{option.label}</option>)}</select></label>}
          {['approve', 'reject', 'retire'].includes(action) && <label>Reason<textarea value={text} maxLength={4096} required onChange={event => { setText(event.target.value); edited(); }} /></label>}
          {action === 'supersede' && <label>Replacement<select className="choice-trigger" value={replacementId} onChange={event => { setReplacementId(event.target.value); edited(); }}><option value="">Choose replacement</option>{records.filter(item => item.id !== details.id && item.active).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>}
          {(localError || mutate.error) && <ErrorState variant="compact" title="Owner action not confirmed" description={localError || errorText(mutate.error)} action={<Button size="sm" onClick={() => void read.refetch()}>Refresh owner state</Button>} />}
          <Button type="submit" disabled={mutate.isPending || !authority.isCurrent()}>{mutate.isPending ? 'Waiting for owner' : 'Submit to owner'}</Button>
        </form>
      </>)}
    </>}
    <DiscardModal />
  </section>;
}

export function LearningReviewProposalForm({ slug, projectId, authority, source }: { slug: string; projectId: string; authority: LearningReviewRequestScope; source?: { selection: LearningReviewSourceSelection; title: string; body: string } }) {
  const [draft, setDraft] = useState({ title: source?.title ?? '', body: source?.body ?? '', expectedEffect: '', taskId: '', key: '', version: '1',
    intentId: randomCorrelationId(), learningId: randomCorrelationId() });
  const mutation = useProposeProjectLearningMutation(slug, projectId, authority);
  const { DiscardModal } = useUnsavedGuard(!!(draft.title || draft.body || draft.expectedEffect || draft.taskId || draft.key));
  const change = (key: keyof typeof draft, value: string) => setDraft(current => ({ ...current, [key]: value, intentId: randomCorrelationId() }));
  return <form className="learning-review__proposal" onSubmit={event => { event.preventDefault();
    const input: LearningReviewProposalInput = { intentId: draft.intentId, learningId: draft.learningId,
      source: source?.selection ?? { kind: 'task-standing', taskId: draft.taskId, recordKind: 'decision', key: draft.key, version: Number(draft.version) },
      kind: 'guideline', title: draft.title, body: draft.body, expectedEffect: draft.expectedEffect };
    void mutation.mutateAsync(input).then(() => setDraft({ title: '', body: '', expectedEffect: '', taskId: '', key: '', version: '1', intentId: randomCorrelationId(), learningId: randomCorrelationId() })).catch(() => {});
  }}>
    <h4>Propose from {source?.selection.kind === 'rated-feedback' ? 'rated feedback' : 'a Task standing decision'}</h4>
    {!source && <><label>Task ID<input required value={draft.taskId} onChange={event => change('taskId', event.target.value)} /></label>
      <label>Decision key<input required value={draft.key} onChange={event => change('key', event.target.value)} /></label>
      <label>Decision version<input required type="number" min="1" value={draft.version} onChange={event => change('version', event.target.value)} /></label></>}
    <label>Title<input required maxLength={240} value={draft.title} onChange={event => change('title', event.target.value)} /></label>
    <label>Proposed guidance<textarea required maxLength={16384} value={draft.body} onChange={event => change('body', event.target.value)} /></label>
    <label>Expected effect<textarea required maxLength={2048} value={draft.expectedEffect} onChange={event => change('expectedEffect', event.target.value)} /></label>
    {mutation.error && <ErrorState variant="compact" title="Proposal not confirmed" description={errorText(mutation.error)} />}
    {mutation.isSuccess && <p>Owner proposal receipt recorded. Approval and activation remain separate.</p>}
    <Button type="submit" disabled={mutation.isPending || !authority.isCurrent()}>Propose to owner</Button><DiscardModal />
  </form>;
}


function LearningSources({ sections }: { sections: { label: string; refs: readonly LearningReviewOwnerRef[] }[] }) {
  return <div className="learning-review__sources">{sections.map(section => <div key={section.label}>
    <h4>{section.label}</h4>{section.refs.length ? <ul>{section.refs.map(ref => <li key={JSON.stringify(ref)}>
      {ref.authority} · {ref.kind} · {ref.id} · {ref.revision ?? 'revision unknown'}
    </li>)}</ul> : <p>None reported</p>}
  </div>)}</div>;
}
