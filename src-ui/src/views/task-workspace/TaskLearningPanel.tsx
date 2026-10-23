import type {
  TaskLearningCandidate,
  TaskLearningStore,
  TaskLearningView,
} from '@kontourai/station-contracts/task-memory';
import {
  useDismissTaskLearningMutation,
  usePromoteTaskLearningMutation,
  useTaskLearningQuery,
} from '@kontourai/station-sdk';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { useNavigation } from '../../contexts/NavigationContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';

const KIND_LABEL = { decision: 'Decision', dead_end: 'Dead end' } as const;

function defaultTitle(candidate: TaskLearningCandidate) {
  const { kind, key } = candidate.record;
  return `${KIND_LABEL[kind]}: ${key.replaceAll('-', ' ')}`;
}

/**
 * Learning (#4003, layer 4): a done Task's standing decisions and dead ends,
 * offered for the Project's knowledge store. A person promotes each one,
 * edited, or dismisses it. Nothing is promoted on its own.
 */
export function TaskLearningPanel({ taskId }: { taskId: string }) {
  const learning = useTaskLearningQuery(taskId);
  const titleId = useId();
  const view = learning.data;
  // A pending promotion still needs a person: it stays with the open ones.
  const needsReview = (c: TaskLearningCandidate) =>
    c.review.state === 'open' || c.review.state === 'pending';
  const open = view?.candidates.filter(needsReview) ?? [];
  const reviewed = view?.candidates.filter((c) => !needsReview(c)) ?? [];
  return (
    <section
      className="task-workspace__section task-memory task-learning"
      aria-labelledby={titleId}
      data-testid="task-learning-panel"
    >
      <div className="task-workspace__section-heading">
        <div>
          <h3 id={titleId} className="task-workspace__section-title">
            Lessons for the Project
          </h3>
          <p>
            This Task is done. Promote the decisions and dead ends worth keeping
            into the Project’s knowledge store, or dismiss them.
          </p>
        </div>
      </div>
      {learning.isLoading ? (
        <SkeletonList count={2} label="Reading the Task’s lessons" />
      ) : learning.error || !view ? (
        <ErrorState
          variant="compact"
          title="Couldn’t read the Task’s lessons"
          description={errorText(learning.error)}
          action={
            <Button onClick={() => void learning.refetch()}>Retry</Button>
          }
        />
      ) : (
        <>
          {view.stores.length === 0 ? <NoStore view={view} /> : null}
          {view.candidates.length === 0 ? (
            <Empty
              variant="compact"
              label="Nothing to promote"
              description="This Task recorded no standing decisions or dead ends."
            />
          ) : open.length === 0 ? (
            <Empty variant="compact" label="Every lesson has been reviewed" />
          ) : (
            <ul className="task-memory__entries">
              {open.map((candidate) => (
                <CandidateItem
                  key={candidate.knowledgeRecordId}
                  taskId={taskId}
                  candidate={candidate}
                  stores={view.stores}
                />
              ))}
            </ul>
          )}
          {reviewed.length ? (
            <details className="task-memory__history">
              <summary>Reviewed ({reviewed.length})</summary>
              <ul className="task-memory__entries">
                {reviewed.map((candidate) => (
                  <li
                    key={candidate.knowledgeRecordId}
                    className="task-memory__entry"
                    data-testid="task-learning-reviewed"
                  >
                    <p className="task-memory__text">{candidate.record.text}</p>
                    <p className="task-memory__meta">
                      <span className="task-memory__tier">
                        {KIND_LABEL[candidate.record.kind]}
                      </span>
                      <code className="task-memory__key">
                        {candidate.record.key}
                      </code>
                      <span>
                        {candidate.review.state === 'promoted'
                          ? `Promoted to ${storeName(view.stores, candidate.review.rootId)}`
                          : candidate.review.state === 'promotion-store-gone'
                            ? 'Promotion recorded; its store is no longer one of this Project’s'
                            : 'Dismissed'}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function storeName(stores: readonly TaskLearningStore[], rootId: string) {
  return stores.find((s) => s.rootId === rootId)?.displayName ?? rootId;
}

function NoStore({ view }: { view: TaskLearningView }) {
  const { setProject } = useNavigation();
  return (
    <div className="task-learning__no-store" role="status">
      <p>
        This Project has no knowledge store, so nothing can be promoted yet.
        Create one under Knowledge stores on the Project page.
      </p>
      <Button size="sm" onClick={() => setProject(view.projectSlug)}>
        Open the Project
      </Button>
    </div>
  );
}

function CandidateItem({
  taskId,
  candidate,
  stores,
}: {
  taskId: string;
  candidate: TaskLearningCandidate;
  stores: readonly TaskLearningStore[];
}) {
  const { record, review } = candidate;
  // A promotion is recorded and its store is here, but the record is not in
  // it: it can only be finished, in that store (review round 5).
  const pending = review.state === 'pending' ? review : undefined;
  const pinnedStores = pending
    ? stores.filter((store) => store.rootId === pending.rootId)
    : stores;
  const promote = usePromoteTaskLearningMutation(taskId);
  const dismiss = useDismissTaskLearningMutation(taskId);
  const [draft, setDraft] = useState<
    { title: string; text: string; rootId: string } | undefined
  >(undefined);
  const dirty =
    draft !== undefined &&
    (draft.text !== record.text || draft.title !== defaultTitle(candidate));
  const { DiscardModal } = useUnsavedGuard(dirty);
  const identity = {
    kind: record.kind,
    key: record.key,
    version: record.version,
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft?.text.trim() || !draft.title.trim()) return;
    promote.mutate({ ...identity, ...draft });
  };
  const busy = promote.isPending || dismiss.isPending;
  return (
    <li className="task-memory__entry" data-testid="task-learning-candidate">
      <p className="task-memory__text">{record.text}</p>
      <p className="task-memory__meta">
        <span className="task-memory__tier" data-tier="standing">
          {KIND_LABEL[record.kind]}
        </span>
        <code className="task-memory__key">{record.key}</code>
        {record.version > 1 ? <span>v{record.version}</span> : null}
      </p>
      {pending ? (
        <p className="task-memory__note" role="status">
          {`A promotion into ${storeName(stores, pending.rootId)} is recorded, but its record is not in that store yet. Finish the promotion to write it there.`}
        </p>
      ) : null}
      {draft ? (
        <form className="task-memory__form" onSubmit={submit}>
          <label className="task-memory__field">
            <span>Title</span>
            <input
              className="task-learning__input"
              value={draft.title}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label className="task-memory__field">
            <span>What the Project should keep</span>
            <textarea
              value={draft.text}
              rows={4}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, text: event.target.value })
              }
            />
          </label>
          {pinnedStores.length > 1 ? (
            <label className="task-memory__field">
              <span>Knowledge store</span>
              <select
                className="task-learning__input"
                value={draft.rootId}
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, rootId: event.target.value })
                }
              >
                {pinnedStores.map((store) => (
                  <option key={store.rootId} value={store.rootId}>
                    {store.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="task-memory__hint">
              Into {pinnedStores[0]?.displayName ?? 'the Project store'}, with
              this Task and record version as its source.
            </p>
          )}
          {promote.error ? (
            <p className="task-memory__note" role="alert">
              {errorText(promote.error)}
            </p>
          ) : null}
          <div className="task-memory__actions">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={!draft.text.trim() || !draft.title.trim()}
              pending={promote.isPending}
              pendingLabel={pending ? 'Finishing…' : 'Promoting…'}
            >
              {pending ? 'Finish promotion' : 'Promote'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(undefined);
                promote.reset();
              }}
            >
              Cancel
            </Button>
          </div>
          <DiscardModal />
        </form>
      ) : (
        <div className="task-memory__actions">
          {
            <Button
              size="sm"
              disabled={pinnedStores.length === 0 || busy}
              onClick={() =>
                setDraft({
                  title: defaultTitle(candidate),
                  text: record.text,
                  rootId: pinnedStores[0]?.rootId ?? '',
                })
              }
            >
              {pending ? 'Finish promotion…' : 'Promote…'}
            </Button>
          }
          {pending ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              pending={dismiss.isPending}
              pendingLabel="Dismissing…"
              onClick={() => dismiss.mutate(identity)}
            >
              Dismiss
            </Button>
          )}
          {dismiss.error ? (
            <p className="task-memory__note" role="alert">
              {errorText(dismiss.error)}
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}
