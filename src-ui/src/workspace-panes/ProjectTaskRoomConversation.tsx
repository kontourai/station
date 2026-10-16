import type { ProjectTaskRoomBrowserRecord } from '@kontourai/station-contracts/project-task-room-browser';
import {
  useCreateTaskReferenceMutation,
  useTaskTurnReferencesQuery,
} from '@kontourai/station-sdk';
import {
  continueDelegatedTask,
  interruptDelegatedTask,
} from '@kontourai/station-sdk/client';
import {
  useProjectTaskRoomDiscoveryQuery,
  useProjectTaskRoomHistoryQuery,
  useTaskRoomAgentRequestsQuery,
} from '@kontourai/station-sdk/project-task-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { LazyMarkdown } from '../components/chat/LazyMarkdown';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { openChatsStore } from '../contexts/open-chats-store';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';
import { RoomAvatar } from './ProjectTaskRoomPresence';
import { TaskRoomComposer } from './TaskRoomComposer';

function Time({ at }: { at?: string }) {
  return at && Number.isFinite(Date.parse(at)) ? (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {new Date(at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })}
    </time>
  ) : null;
}
function systemText(record: ProjectTaskRoomBrowserRecord) {
  const body = record.body;
  if (body.kind === 'human-message') return body.text;
  if (body.kind === 'output-feedback')
    return `${record.actor.label} ${body.review === 'accepted' ? 'accepted' : body.review === 'changes-requested' ? 'requested changes on' : 'reviewed'} an output: ${body.text}`;
  if (body.kind === 'live-work-started')
    return `${record.actor.label} ${record.actor.kind === 'agent' ? 'started work' : 'joined'}`;
  if (body.kind === 'live-work-presence-ended')
    return `${record.actor.label} left`;
  if (body.kind === 'live-work-finished')
    return `${record.actor.label} · ${body.outcome}`;
  return `${record.actor.label} shared ${body.link.kind}`;
}

export function ProjectTaskRoomConversation({
  taskId,
  projectSlug,
  taskCreatedAt,
}: {
  taskId: string;
  projectSlug?: string;
  taskCreatedAt?: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const discover = useProjectTaskRoomDiscoveryQuery(taskId);
  const shared = useProjectTaskRoomContext(taskId);
  const history = useProjectTaskRoomHistoryQuery(taskId);
  const room = shared?.discovery ?? discover;
  const pages = history.data?.pages ?? [];
  const records = pages
    .flatMap((page) => (page.kind === 'available' ? page.records : []))
    .sort((a, b) => a.sequence - b.sequence);
  const capabilities =
    room.data?.kind === 'opened' || room.data?.kind === 'existing'
      ? room.data.capabilities
      : undefined;
  const writable =
    capabilities?.messageWrite === true && shared?.stream !== 'terminal';
  const requests = useTaskRoomAgentRequestsQuery(
    taskId,
    taskCreatedAt ?? '',
    scope,
    capabilities?.historyRead,
  );
  const [thread, setThread] = useState<string>();
  const [reply, setReply] = useState('');
  const [attachBrief, setAttachBrief] = useState(true);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice || notice.startsWith('Not delivered')) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const openRun = async (sessionId: string) => {
    setNotice('');
    if (!(await openChatsStore.openConversation(sessionId)))
      setNotice(
        'This run could not be opened. Try again when the chat dock is ready.',
      );
  };
  const replyOperation = useRef<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [kept, setKept] = useState<Set<string>>(new Set());
  const references = useTaskTurnReferencesQuery(taskId);
  const [uncertain, setUncertain] = useState(false);
  const keep = useCreateTaskReferenceMutation();
  const { DiscardModal, guard } = useUnsavedGuard(!!reply);
  const running =
    shared?.live?.participants.filter(
      (participant) =>
        participant.publication === 'published' &&
        participant.actor.kind === 'agent',
    ) ?? [];
  const bottom = useRef<HTMLDivElement>(null);
  const lastSequence = records.at(-1)?.sequence;
  const runningCount = running.length;
  useEffect(() => {
    void lastSequence;
    void runningCount;
    bottom.current?.scrollIntoView?.({ block: 'nearest' });
  }, [lastSequence, runningCount]);
  const followup = useMutation({
    mutationFn: async () => {
      if (!scope?.isCurrent() || !thread || !taskCreatedAt)
        throw new Error('Task connection changed.');
      replyOperation.current ??= randomCorrelationId();
      const result = await continueDelegatedTask(
        scope.apiBase,
        thread,
        {
          message: reply.trim(),
          taskRoomReply: {
            taskId,
            taskCreatedAt,
            operationId: replyOperation.current,
            attachBrief,
          },
        },
        { requestScope: scope },
      );
      if (!scope.isCurrent()) throw new Error('Task connection changed.');
      if (result.sessionId !== thread)
        throw new Error(
          'The agent continued in a different Session. Open full run to inspect it.',
        );
      return result;
    },
    onSuccess: (result) => {
      if (result.taskRoomReplyDelivery === 'unpublished') {
        setUncertain(true);
        setNotice(
          "Not delivered to room · The agent received your reply, but it couldn't be posted here. Check the full run before resending.",
        );
        return;
      }
      setReply('');
      replyOperation.current = undefined;
      setUncertain(false);
      setNotice('Reply sent to the same agent session.');
      void history.refetch();
      void requests.refetch();
    },
    onError: (error) => {
      const code = 'code' in error ? error.code : undefined;
      const notSent =
        code === 'task_room_context_unavailable' ||
        code === 'task_room_reply_refused' ||
        code === 'receiver_execution_authority_changed';
      setUncertain(!notSent);
      setNotice(
        `Not delivered · ${error.message}${notSent ? '' : ' Check the full run before resending.'}`,
      );
    },
  });
  const stop = useMutation({
    mutationFn: async (sessionId: string) => {
      if (!scope?.isCurrent()) throw new Error('Task connection changed.');
      return interruptDelegatedTask(
        scope.apiBase,
        sessionId,
        {},
        { requestScope: scope },
      );
    },
    onError: (error) => setNotice(error.message),
  });
  const roots = new Map<string, number>();
  for (const record of records)
    if (record.execution && !roots.has(record.execution.sessionId))
      roots.set(record.execution.sessionId, record.sequence);
  const visible = records.filter(
    (record) =>
      ![
        'live-work-started',
        'live-work-presence-ended',
        'live-work-finished',
        'outcome-link',
      ].includes(record.body.kind) &&
      !record.threadSessionId &&
      (!record.execution ||
        roots.get(record.execution.sessionId) === record.sequence),
  );
  const threadRecords = thread
    ? records.filter(
        (record) =>
          record.execution?.sessionId === thread ||
          record.threadSessionId === thread,
      )
    : [];
  const message = (
    record: ProjectTaskRoomBrowserRecord,
    previous?: ProjectTaskRoomBrowserRecord,
  ) => {
    if (record.system || record.body.kind !== 'human-message')
      return (
        <li className="task-room-system" key={record.sequence}>
          {systemText(record)} <Time at={record.occurredAt} />
        </li>
      );
    const grouped =
      previous?.body.kind === 'human-message' &&
      !previous.system &&
      (previous.actor.id ?? previous.actor.label) ===
        (record.actor.id ?? record.actor.label) &&
      previous.actor.kind === record.actor.kind;
    const execution = record.execution;
    const replies = execution
      ? records.filter(
          (item) =>
            item.sequence !== record.sequence &&
            (item.execution?.sessionId === execution.sessionId ||
              item.threadSessionId === execution.sessionId),
        ).length
      : 0;
    return (
      <li
        className={`task-room-message${grouped ? ' task-room-message--grouped' : ''}`}
        key={record.sequence}
      >
        {!grouped && (
          <RoomAvatar
            name={record.actor.label}
            agent={record.actor.kind === 'agent'}
          />
        )}
        <article>
          <header>
            {!grouped && (
              <>
                <strong>{record.actor.label}</strong>
                {record.actor.kind === 'agent' && (
                  <span className="task-room-agent-badge">Agent</span>
                )}
              </>
            )}
            <Time at={record.occurredAt} />
          </header>
          <div
            className={
              execution
                ? `task-room-answer${expanded.has(record.sequence) ? '' : ' task-room-answer--clamped'}`
                : 'task-room-message-text'
            }
          >
            <LazyMarkdown>{record.body.text}</LazyMarkdown>
          </div>
          {execution && (
            <Button
              size="sm"
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(record.sequence)) next.delete(record.sequence);
                  else next.add(record.sequence);
                  return next;
                })
              }
            >
              {expanded.has(record.sequence) ? 'Show less' : 'Show more'}
            </Button>
          )}
          {execution && (
            <div className="task-room-message-actions">
              <Button
                size="sm"
                onClick={() =>
                  guard(() => {
                    setThread(execution.sessionId);
                    setUncertain(false);
                    setNotice('');
                  })
                }
              >
                {replies
                  ? `${replies} ${replies === 1 ? 'reply' : 'replies'}`
                  : 'Reply in thread'}
              </Button>
              <Button
                size="sm"
                disabled={
                  keep.isPending ||
                  kept.has(`${execution.sessionId}:${execution.turnId}`) ||
                  references.data?.some(
                    (reference) =>
                      reference.state === 'available' &&
                      reference.sessionId === execution.sessionId &&
                      reference.turnId === execution.turnId,
                  )
                }
                onClick={async () => {
                  try {
                    await keep.mutateAsync({
                      taskId,
                      kind: 'turn',
                      sessionId: execution.sessionId,
                      turnId: execution.turnId,
                      sourceSurface: 'task-room',
                    });
                    setKept((current) =>
                      new Set(current).add(
                        `${execution.sessionId}:${execution.turnId}`,
                      ),
                    );
                    setNotice('Answer kept in Results.');
                  } catch (error) {
                    setNotice(
                      error instanceof Error
                        ? error.message
                        : 'Could not keep this answer.',
                    );
                  }
                }}
              >
                {kept.has(`${execution.sessionId}:${execution.turnId}`) ||
                references.data?.some(
                  (reference) =>
                    reference.state === 'available' &&
                    reference.sessionId === execution.sessionId &&
                    reference.turnId === execution.turnId,
                )
                  ? 'Kept'
                  : 'Keep'}
              </Button>
              <Button
                size="sm"
                onClick={() => void openRun(execution.sessionId)}
              >
                Open full run
              </Button>
            </div>
          )}
        </article>
      </li>
    );
  };
  return (
    <section
      className={`project-task-room-conversation${thread ? ' task-room-conversation--thread-open' : ''}`}
      aria-label="Task room conversation"
    >
      {shared?.presenceError && <p role="alert">{shared.presenceError}</p>}
      <div className="task-room-messages">
        {history.isError && (
          <p role="alert">
            Room history is unavailable.{' '}
            <Button onClick={() => void history.refetch()}>Retry</Button>
          </p>
        )}
        {capabilities && !capabilities.historyRead && (
          <p role="status">History is not shared with this connection.</p>
        )}
        {!records.length && !history.isLoading && (
          <div className="task-room-chat-empty">
            <h2>Start the conversation</h2>
            <p>
              Share a thought, shape the brief, or ask an agent to work on this
              Task.
            </p>
          </div>
        )}
        <ol aria-live="polite" aria-label="Task room history">
          {visible.map((record, index) => message(record, visible[index - 1]))}
        </ol>
        {running.map((participant) => (
          <div
            className="task-room-running"
            role="status"
            key={participant.actor.actorId}
          >
            <span className="task-room-live-dot" />
            <strong>{participant.actor.label}</strong>
            {participant.work.workState === 'blocked' &&
            participant.work.workName === "Answer couldn't be posted" ? (
              <>
                <span>Answer couldn't be posted ·</span>
                <Button
                  size="sm"
                  onClick={() => void openRun(participant.work.sessionId)}
                >
                  Open full run
                </Button>
              </>
            ) : (
              <>
                <span>is {participant.work.workState}</span>
                <Button
                  size="sm"
                  onClick={() => void openRun(participant.work.sessionId)}
                >
                  Watch
                </Button>
                <Button
                  size="sm"
                  disabled={!writable || stop.isPending}
                  onClick={() => stop.mutate(participant.work.sessionId)}
                >
                  Stop
                </Button>
              </>
            )}
          </div>
        ))}
        {pages.some((page) => page.kind === 'gap') && (
          <p role="alert">Earlier room history is unavailable.</p>
        )}
        {history.hasNextPage && (
          <Button
            onClick={() => void history.fetchNextPage()}
            disabled={history.isFetchingNextPage}
          >
            Load more messages
          </Button>
        )}
        <div ref={bottom} />
      </div>
      {records
        .filter(
          (record) =>
            record.body.kind === 'live-work-finished' &&
            record.body.outcome === 'completed' &&
            !records.some(
              (answer) =>
                answer.execution?.sessionId ===
                (record.body.kind === 'live-work-finished'
                  ? record.body.sessionId
                  : undefined),
            ),
        )
        .map(
          (record) =>
            record.body.kind === 'live-work-finished' && (
              <p
                key={`unposted:${record.sequence}`}
                className="task-room-inline-status"
                role="status"
              >
                Answer couldn't be posted ·{' '}
                <Button
                  size="sm"
                  onClick={() =>
                    record.body.kind === 'live-work-finished' &&
                    void openRun(record.body.sessionId)
                  }
                >
                  Open full run
                </Button>
              </p>
            ),
        )}
      {thread && (
        <section className="task-room-thread" aria-label="Agent thread">
          <header>
            <h3>{threadRecords[0]?.actor.label ?? 'Agent'} · Thread</h3>
            <Button onClick={() => guard(() => setThread(undefined))}>
              Close thread
            </Button>
          </header>
          <ol className="task-room-thread-messages">
            {threadRecords.map((record, index) =>
              message(record, threadRecords[index - 1]),
            )}
          </ol>
          <form
            className="task-room-composer task-room-thread-composer"
            onSubmit={(event) => {
              event.preventDefault();
              followup.mutate();
            }}
          >
            <label className="sr-only" htmlFor="task-thread-reply">
              Reply to this agent
            </label>
            <textarea
              id="task-thread-reply"
              value={reply}
              rows={1}
              placeholder="Reply…"
              onChange={(event) => {
                setReply(event.target.value);
                setNotice('');
                replyOperation.current = undefined;
              }}
              readOnly={!writable || followup.isPending || uncertain}
            />
            <label className="task-room-brief-choice">
              <input
                type="checkbox"
                checked={attachBrief}
                disabled={followup.isPending || uncertain}
                onChange={(event) => setAttachBrief(event.target.checked)}
              />
              Brief
            </label>
            <Button
              className="task-room-send"
              aria-label="Send reply"
              type="submit"
              disabled={
                !writable || !reply.trim() || followup.isPending || uncertain
              }
            >
              ↑
            </Button>
          </form>
          {attachBrief &&
            requests.data?.context?.text.includes('Brief shortened to fit') && (
              <p className="task-room-inline-status" role="status">
                The brief exceeds 16,000 characters. A shortened version with a
                notice will be attached.
              </p>
            )}
          {notice && (
            <p className="task-room-inline-status" role="status">
              {notice}{' '}
              {uncertain && (
                <Button size="sm" onClick={() => void openRun(thread)}>
                  Open full run
                </Button>
              )}
            </p>
          )}
        </section>
      )}
      {!thread && notice && (
        <p className="task-room-inline-status" role="status">
          {notice}
        </p>
      )}
      <TaskRoomComposer
        taskId={taskId}
        projectSlug={projectSlug ?? ''}
        taskCreatedAt={taskCreatedAt ?? ''}
        writable={writable && !!projectSlug && !!taskCreatedAt}
        readable={capabilities?.historyRead === true}
      />
      <DiscardModal />
    </section>
  );
}

export function TaskRoomHistoryDetails({ taskId }: { taskId: string }) {
  const history = useProjectTaskRoomHistoryQuery(taskId);
  return (
    <details className="task-workspace__record-details">
      <summary>Raw room history</summary>
      {history.isError ? (
        <p role="alert">Room history unavailable.</p>
      ) : (
        <pre>{JSON.stringify(history.data?.pages ?? [], null, 2)}</pre>
      )}
    </details>
  );
}
