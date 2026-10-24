import {
  isLiveTaskRecord,
  TASK_MEMORY_LIMITS,
  type TaskMemoryAuthor,
  type TaskMemoryRecord,
  type TaskRecordKind,
  type TaskSummaryRevision,
  taskMemoryRefusalMessage,
  taskSummaryRefusal,
} from '@kontourai/station-contracts/task-memory';
import {
  TaskSummaryConflictError,
  useTaskMemoryQuery,
  useUpdateTaskSummaryMutation,
  useWriteTaskRecordMutation,
} from '@kontourai/station-sdk';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { useNavigation } from '../../contexts/NavigationContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';
import { absoluteTime, relativeTime } from '../../utils/relativeTime';

const LIVE_SECTIONS: ReadonlyArray<{
  kind: TaskRecordKind;
  title: string;
  empty: string;
}> = [
  {
    kind: 'question',
    title: 'Open questions',
    empty: 'Nothing is waiting on a person',
  },
  { kind: 'decision', title: 'Decisions', empty: 'No decisions recorded' },
  { kind: 'dead_end', title: 'Dead ends', empty: 'No dead ends recorded' },
];

const TIER_LABELS = { standing: 'Standing', on_topic: 'On topic' } as const;

/**
 * Task memory (#4003): the Task's judgment layer. A summary agents and
 * people rewrite (every revision kept, edits refused on a stale revision),
 * and keyed decisions, open questions and dead ends. People edit the summary
 * and answer questions here under the same rules agents' tools follow.
 */
export function TaskMemoryPanel({ taskId }: { taskId: string }) {
  const memory = useTaskMemoryQuery(taskId);
  const titleId = useId();
  const records = memory.data?.records ?? [];
  const history = records.filter((record) => !isLiveTaskRecord(record));
  return (
    <section
      className="task-workspace__section task-memory"
      aria-labelledby={titleId}
      data-testid="task-memory-panel"
    >
      <div className="task-workspace__section-heading">
        <div>
          <h3 id={titleId} className="task-workspace__section-title">
            Task memory
          </h3>
          <p>
            What this Task's Sessions and people decided, asked and ruled out.
            Every earlier version is kept.
          </p>
        </div>
      </div>
      {memory.isLoading ? (
        <SkeletonList count={2} label="Reading the Task memory" />
      ) : memory.error || !memory.data ? (
        <ErrorState
          variant="compact"
          title="Couldn’t read the Task memory"
          description={errorText(memory.error)}
          action={<Button onClick={() => void memory.refetch()}>Retry</Button>}
        />
      ) : (
        <>
          <TaskSummaryBlock taskId={taskId} summary={memory.data.summary} />
          <div className="task-memory__sections">
            {LIVE_SECTIONS.map((section) => (
              <TaskRecordList
                key={section.kind}
                taskId={taskId}
                title={section.title}
                empty={section.empty}
                records={records
                  .filter(
                    (record) =>
                      record.kind === section.kind && isLiveTaskRecord(record),
                  )
                  .reverse()}
              />
            ))}
          </div>
          {history.length ? (
            <details className="task-memory__history">
              <summary>Answered and retired ({history.length})</summary>
              <ul className="task-memory__entries">
                {[...history].reverse().map((record) => (
                  <TaskRecordItem
                    key={`${record.kind}:${record.key}`}
                    record={record}
                  />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

function AuthorLabel({ author }: { author: TaskMemoryAuthor }) {
  const { updateParams } = useNavigation();
  if (author.kind === 'person')
    return <span className="task-memory__author">{author.principalId}</span>;
  const { sessionId } = author;
  return (
    <button
      type="button"
      className="task-memory__author task-memory__session-link"
      title={`Open Session ${sessionId}`}
      onClick={() => updateParams({ chat: sessionId })}
    >
      Session {sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId}
    </button>
  );
}

function When({ at }: { at: string }) {
  const time = Date.parse(at);
  return (
    <time dateTime={at} title={absoluteTime(time)}>
      {relativeTime(time, Date.now())}
    </time>
  );
}

function TaskSummaryBlock({
  taskId,
  summary,
}: {
  taskId: string;
  summary: TaskSummaryRevision | undefined;
}) {
  const save = useUpdateTaskSummaryMutation(taskId);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  /** The revision the draft is based on; a conflict moves it forward. */
  const [base, setBase] = useState(0);
  const [conflict, setConflict] = useState<TaskSummaryRevision | null>();
  const headingId = useId();
  const editing = draft !== undefined;
  const dirty = editing && draft !== (summary?.text ?? '');
  const { DiscardModal } = useUnsavedGuard(dirty);
  const refusal = editing ? taskSummaryRefusal(draft) : undefined;

  const startEditing = () => {
    setDraft(summary?.text ?? '');
    setBase(summary?.revision ?? 0);
    setConflict(undefined);
    save.reset();
  };
  const stop = () => {
    setDraft(undefined);
    setConflict(undefined);
    save.reset();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft === undefined || refusal) return;
    // Saving after a conflict writes over the revision the person was shown.
    const baseRevision =
      conflict === undefined ? base : (conflict?.revision ?? 0);
    save.mutate(
      { text: draft, baseRevision },
      {
        onSuccess: stop,
        onError: (error) => {
          if (error instanceof TaskSummaryConflictError)
            setConflict(error.current);
        },
      },
    );
  };
  return (
    <section className="task-memory__summary" aria-labelledby={headingId}>
      <div className="task-memory__summary-heading">
        <h4 id={headingId} className="task-memory__section-title">
          Summary
        </h4>
        {summary ? (
          <p className="task-memory__meta" data-testid="task-summary-meta">
            Revision {summary.revision}
            <span aria-hidden="true"> · </span>
            <AuthorLabel author={summary.author} />
            <span aria-hidden="true"> · </span>
            <When at={summary.createdAt} />
          </p>
        ) : null}
        {editing ? null : (
          <div className="task-memory__actions">
            <Button size="sm" onClick={startEditing}>
              {summary ? 'Edit' : 'Write summary'}
            </Button>
          </div>
        )}
      </div>
      {editing ? (
        <form className="task-memory__form" onSubmit={submit}>
          {conflict !== undefined ? (
            <div className="task-memory__conflict" role="alert">
              <p>
                {conflict
                  ? `Someone saved revision ${conflict.revision} while you were editing. Your text is below; their current summary is here. Merge what you need, then save over revision ${conflict.revision}.`
                  : 'The summary changed while you were editing. Save again to write it.'}
              </p>
              {conflict ? (
                <>
                  <p className="task-memory__meta">
                    Revision {conflict.revision}
                    <span aria-hidden="true"> · </span>
                    <AuthorLabel author={conflict.author} />
                  </p>
                  <pre className="task-memory__summary-text task-memory__summary-text--theirs">
                    {conflict.text}
                  </pre>
                  <div className="task-memory__actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDraft(conflict.text);
                        setBase(conflict.revision);
                        setConflict(undefined);
                        save.reset();
                      }}
                    >
                      Use their text
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          <label className="task-memory__field">
            <span>
              What is true now, what works, what is next, what is risky
            </span>
            <textarea
              value={draft}
              rows={8}
              disabled={save.isPending}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <p className="task-memory__hint" aria-live="polite">
            {refusal
              ? taskMemoryRefusalMessage(refusal)
              : `${draft.length}/${TASK_MEMORY_LIMITS.summaryChars}`}
          </p>
          {save.error && !(save.error instanceof TaskSummaryConflictError) ? (
            <p className="task-memory__note" role="alert">
              {errorText(save.error)}
            </p>
          ) : null}
          <div className="task-memory__actions">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={Boolean(refusal)}
              pending={save.isPending}
              pendingLabel="Saving…"
            >
              {conflict ? `Save over revision ${conflict.revision}` : 'Save'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={stop}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : summary ? (
        <pre className="task-memory__summary-text">{summary.text}</pre>
      ) : (
        <Empty
          variant="compact"
          label="Nothing here yet"
          description="Agents write one at milestones."
        />
      )}
      <DiscardModal />
    </section>
  );
}

function TaskRecordList({
  taskId,
  title,
  empty,
  records,
}: {
  taskId: string;
  title: string;
  empty: string;
  records: TaskMemoryRecord[];
}) {
  const headingId = useId();
  return (
    <section className="task-memory__section" aria-labelledby={headingId}>
      <h4 id={headingId} className="task-memory__section-title">
        {title}
        {records.length ? (
          <span className="task-memory__count">{records.length}</span>
        ) : null}
      </h4>
      {records.length ? (
        <ul className="task-memory__entries">
          {records.map((record) => (
            <TaskRecordItem
              key={`${record.kind}:${record.key}`}
              record={record}
              taskId={taskId}
            />
          ))}
        </ul>
      ) : (
        <Empty variant="compact" label={empty} />
      )}
    </section>
  );
}

function TaskRecordItem({
  record,
  taskId,
}: {
  record: TaskMemoryRecord;
  /** Present where the record can be answered from here. */
  taskId?: string;
}) {
  return (
    <li className="task-memory__entry" data-testid="task-memory-record">
      <p className="task-memory__text">{record.text}</p>
      {record.answer ? (
        <p className="task-memory__answer">Answer: {record.answer}</p>
      ) : null}
      {record.reason ? (
        <p className="task-memory__answer">Retired: {record.reason}</p>
      ) : null}
      <p className="task-memory__meta">
        <span className="task-memory__tier" data-tier={record.importance}>
          {TIER_LABELS[record.importance]}
        </span>
        <code className="task-memory__key">{record.key}</code>
        {record.version > 1 ? <span>v{record.version}</span> : null}
        {/* An answer's version is the answerer's: an agent may answer
            (#4003 accepted gap F11a), so the panel says who did. */}
        {record.state === 'answered' ? <span>answered by</span> : null}
        <AuthorLabel author={record.author} />
        <When at={record.createdAt} />
      </p>
      {taskId && record.state === 'open' ? (
        <AnswerForm taskId={taskId} record={record} />
      ) : null}
    </li>
  );
}

function AnswerForm({
  taskId,
  record,
}: {
  taskId: string;
  record: TaskMemoryRecord;
}) {
  const answer = useWriteTaskRecordMutation(taskId);
  const [text, setText] = useState<string | undefined>(undefined);
  const { DiscardModal } = useUnsavedGuard(Boolean(text));
  if (text === undefined)
    return (
      <div className="task-memory__actions">
        <Button size="sm" onClick={() => setText('')}>
          Answer
        </Button>
      </div>
    );
  const tooLong = text.length > TASK_MEMORY_LIMITS.recordTextChars;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || tooLong) return;
    answer.mutate(
      { kind: 'question', key: record.key, action: 'answer', text },
      { onSuccess: () => setText(undefined) },
    );
  };
  return (
    <form className="task-memory__form" onSubmit={submit}>
      <label className="task-memory__field">
        <span>Your answer</span>
        <textarea
          value={text}
          rows={2}
          disabled={answer.isPending}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <p className="task-memory__hint" aria-live="polite">
        {text.length}/{TASK_MEMORY_LIMITS.recordTextChars}
      </p>
      {answer.error ? (
        <p className="task-memory__note" role="alert">
          {errorText(answer.error)}
        </p>
      ) : null}
      <div className="task-memory__actions">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={!text.trim() || tooLong}
          pending={answer.isPending}
          pendingLabel="Answering…"
        >
          Send answer
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={answer.isPending}
          onClick={() => setText(undefined)}
        >
          Cancel
        </Button>
      </div>
      <DiscardModal />
    </form>
  );
}
