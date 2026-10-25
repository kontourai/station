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
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActionRow } from '../components/ActionRow';
import { Button } from '../components/Button';
import { LazyMarkdown } from '../components/chat/LazyMarkdown';
import { IconButton } from '../components/IconButton';
import { CloseGlyph } from '../components/icons/Glyph';
import { SplitPaneCompanion } from '../components/SplitPaneLayout';
import { Empty, SkeletonBlock, SkeletonList } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { openChatsStore } from '../contexts/open-chats-store';
import { useTaskRoomAttachments } from '../hooks/useTaskRoomAttachments';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';
import { RoomAvatar } from './ProjectTaskRoomPresence';
import { TaskRoomAttachmentComposer } from './TaskRoomAttachmentComposer';
import { TaskRoomAttachmentImages } from './TaskRoomAttachmentImages';
import { TaskRoomComposer } from './TaskRoomComposer';
import { TaskRoomMessageInput } from './TaskRoomMessageInput';

function RoomAnswer({
  text,
  expanded,
  onToggle,
}: {
  text: string;
  expanded: boolean;
  onToggle(): void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(expanded);
  useLayoutEffect(() => {
    void text;
    const element = body.current;
    if (!element) return;
    const measure = () => {
      if (!expanded)
        setOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  const clamped = overflowing && !expanded;
  return (
    <div className={clamped ? 'task-room-message-content--clamped' : undefined}>
      <div
        ref={body}
        className={`task-room-answer${expanded ? '' : ' task-room-answer--preview'}${clamped ? ' task-room-answer--clamped' : ''}`}
        onFocusCapture={() => {
          if (clamped) onToggle();
        }}
      >
        <LazyMarkdown
          loadingProjection={<SkeletonBlock label="Loading answer" />}
        >
          {text}
        </LazyMarkdown>
      </div>
      {overflowing && (
        <Button
          variant="ghost"
          className="task-room-expand"
          size="sm"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

function Time({ at, compact = false }: { at?: string; compact?: boolean }) {
  return at && Number.isFinite(Date.parse(at)) ? (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {new Date(at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        ...(compact ? { hour12: false } : {}),
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
  const replyAttachments = useTaskRoomAttachments(
    taskId,
    taskCreatedAt ?? '',
    scope,
    () => {
      replyOperation.current = undefined;
    },
  );
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
  const { DiscardModal, guard } = useUnsavedGuard(
    !!reply || replyAttachments.files.length > 0,
  );
  const running =
    shared?.live?.participants.filter(
      (participant) =>
        participant.publication === 'published' &&
        participant.actor.kind === 'agent',
    ) ?? [];
  const messages = useRef<HTMLDivElement>(null);
  const anchored = useRef(true);
  const [jumpToLatest, setJumpToLatest] = useState(false);
  const previousHeight = useRef<number | undefined>(undefined);
  const [historyWindow, setHistoryWindow] = useState(50);
  const lastSequence = records.at(-1)?.sequence;
  const runningCount = running.length;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!runningCount) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningCount]);
  const goLatest = () => {
    const list = messages.current;
    if (list) list.scrollTop = list.scrollHeight;
    anchored.current = true;
    setJumpToLatest(false);
  };
  useLayoutEffect(() => {
    void lastSequence;
    void runningCount;
    void records.length;
    void historyWindow;
    const list = messages.current;
    if (!list) return;
    if (previousHeight.current !== undefined) {
      list.scrollTop += list.scrollHeight - previousHeight.current;
      previousHeight.current = undefined;
    } else if (anchored.current) list.scrollTop = list.scrollHeight;
    else setJumpToLatest(true);
  }, [lastSequence, runningCount, records.length, historyWindow]);
  // The history contract pages forward through a fixed checkpoint. Read to that
  // checkpoint before presenting its newest messages; reveal older rows locally.
  useEffect(() => {
    if (history.hasNextPage && !history.isFetching && !history.isError)
      void history.fetchNextPage({ cancelRefetch: false });
  }, [
    history.hasNextPage,
    history.isFetching,
    history.isError,
    history.fetchNextPage,
  ]);
  const loadEarlier = () => {
    previousHeight.current = messages.current?.scrollHeight;
    setHistoryWindow((count) => count + 50);
  };
  useLayoutEffect(() => {
    void thread;
    const list = messages.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (anchored.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    const content = list.querySelector('ol');
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [thread]);
  const followup = useMutation({
    mutationFn: async () => {
      if (!scope?.isCurrent() || !thread || !taskCreatedAt)
        throw new Error('Task connection changed.');
      let attachments: Awaited<ReturnType<typeof replyAttachments.prepare>>;
      try {
        attachments = await replyAttachments.prepare();
      } catch (error) {
        throw Object.assign(
          new Error(
            error instanceof Error
              ? error.message
              : 'Files could not be uploaded.',
          ),
          { code: 'task_room_reply_refused' },
        );
      }
      if (!scope.isCurrent()) throw new Error('Task connection changed.');
      replyOperation.current ??= randomCorrelationId();
      const result = await continueDelegatedTask(
        scope.apiBase,
        thread,
        {
          message: reply.trim() || 'See attached files.',
          taskRoomReply: {
            taskId,
            taskCreatedAt,
            operationId: replyOperation.current,
            attachBrief,
            ...(attachments.length ? { attachments } : {}),
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
      replyAttachments.clear();
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
  const followupPending = useRef(followup.isPending);
  followupPending.current = followup.isPending;
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
  const retryFailed = useMutation({
    mutationFn: async (sessionId: string) => {
      const request = requests.data?.records.find(
        (item) => item.sessionId === sessionId,
      );
      if (!scope?.isCurrent() || !request || !taskCreatedAt)
        throw new Error(
          'The original request is unavailable. Open the run to continue.',
        );
      return continueDelegatedTask(
        scope.apiBase,
        sessionId,
        {
          message: request.prompt,
          taskRoomReply: {
            taskId,
            taskCreatedAt,
            operationId: randomCorrelationId(),
            attachBrief: !!request.context,
            ...(request.attachments?.length
              ? { attachments: request.attachments }
              : {}),
          },
        },
        { requestScope: scope },
      );
    },
    onSuccess: () => {
      void history.refetch();
      void requests.refetch();
    },
    onError: (error) => setNotice(error.message),
  });
  const roots = new Map<string, number>();
  for (const record of records)
    if (record.execution && !roots.has(record.execution.sessionId))
      roots.set(record.execution.sessionId, record.sequence);
  const allVisible = records.filter(
    (record) =>
      ![
        'live-work-started',
        'live-work-presence-ended',
        'outcome-link',
      ].includes(record.body.kind) &&
      (record.body.kind !== 'live-work-finished' ||
        record.body.outcome === 'failed') &&
      !record.threadSessionId &&
      (!record.execution ||
        roots.get(record.execution.sessionId) === record.sequence),
  );
  const visible = allVisible.slice(-historyWindow);
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
    inThread = false,
  ) => {
    if (
      record.body.kind === 'live-work-finished' &&
      record.body.outcome === 'failed'
    ) {
      const sessionId = record.body.sessionId;
      return (
        <li className="task-room-system task-room-failed" key={record.sequence}>
          <span>{record.actor.label} couldn’t finish</span>
          <Time at={record.occurredAt} />
          <Button
            variant="ghost"
            size="sm"
            disabled={
              !writable ||
              retryFailed.isPending ||
              !requests.data?.records.some(
                (item) => item.sessionId === sessionId,
              )
            }
            onClick={() => retryFailed.mutate(sessionId)}
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void openRun(sessionId)}
          >
            Open run
          </Button>
        </li>
      );
    }
    if (record.system || record.body.kind !== 'human-message')
      return (
        <li className="task-room-system" key={record.sequence}>
          {record.system && <span>{record.actor.label} · </span>}
          <span>{systemText(record)}</span> <Time at={record.occurredAt} />
        </li>
      );
    const grouped =
      previous?.body.kind === 'human-message' &&
      !previous.system &&
      (previous.actor.id ?? previous.actor.label) ===
        (record.actor.id ?? record.actor.label) &&
      previous.actor.kind === record.actor.kind;
    const execution = record.execution;
    const mention = /^\*\*@(.+?)\*\*\s+/.exec(record.body.text);
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
            <Time at={record.occurredAt} compact={grouped} />
          </header>
          <TaskRoomAttachmentImages
            attachments={record.body.attachments}
            taskId={taskId}
            taskCreatedAt={taskCreatedAt ?? ''}
          />
          <div className="task-room-message-content">
            {execution ? (
              <RoomAnswer
                text={record.body.text}
                expanded={expanded.has(record.sequence)}
                onToggle={() => {
                  anchored.current = false;
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(record.sequence)) next.delete(record.sequence);
                    else next.add(record.sequence);
                    return next;
                  });
                }}
              />
            ) : (
              <div className="task-room-message-text">
                {mention ? (
                  <>
                    <span className="task-room-mention">@{mention[1]}</span>
                    <LazyMarkdown>
                      {record.body.text.slice(mention[0].length)}
                    </LazyMarkdown>
                  </>
                ) : (
                  <LazyMarkdown>{record.body.text}</LazyMarkdown>
                )}
              </div>
            )}
          </div>
          {execution && (
            <ActionRow
              className="task-room-message-actions"
              primary={
                !inThread && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={followup.isPending}
                    onClick={() => changeThread(execution.sessionId)}
                  >
                    {replies
                      ? `${replies} ${replies === 1 ? 'reply' : 'replies'}`
                      : 'Reply in thread'}
                  </Button>
                )
              }
              secondary={
                <Button
                  variant="ghost"
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
              }
              overflowLabel="More answer actions"
              overflow={[
                {
                  key: 'open-run',
                  label: 'Open full run',
                  onSelect: () => void openRun(execution.sessionId),
                },
              ]}
            />
          )}
        </article>
      </li>
    );
  };
  const changeThread = (next?: string) => {
    if (next === thread || followupPending.current) return;
    guard(() => {
      if (followupPending.current) return;
      setThread(next);
      setReply('');
      replyAttachments.clear();
      replyOperation.current = undefined;
      setAttachBrief(true);
      setUncertain(false);
      setNotice('');
    });
  };
  return (
    <section
      className={`project-task-room-conversation${thread ? ' task-room-conversation--thread-open' : ''}`}
      aria-label="Task room conversation"
    >
      <SplitPaneCompanion
        sheet={{
          label: `${threadRecords[0]?.actor.label ?? 'Agent'} · Thread`,
          onDismiss: () => changeThread(),
        }}
        companion={
          thread ? (
            <section className="task-room-thread" aria-label="Agent thread">
              <header className="split-pane-companion__detail-header">
                <h3>{threadRecords[0]?.actor.label ?? 'Agent'} · Thread</h3>
                <IconButton
                  aria-label="Close thread"
                  disabled={followup.isPending}
                  onClick={() => changeThread()}
                >
                  <CloseGlyph />
                </IconButton>
              </header>
              <ol className="task-room-thread-messages">
                {threadRecords.map((record, index) =>
                  message(record, threadRecords[index - 1], true),
                )}
              </ol>
              <form
                className="task-room-composer task-room-thread-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    writable &&
                    (reply.trim() || replyAttachments.files.length) &&
                    !replyAttachments.busy &&
                    !followup.isPending &&
                    !uncertain
                  )
                    followup.mutate();
                }}
              >
                <label className="sr-only" htmlFor="task-thread-reply">
                  Reply to this agent
                </label>
                <TaskRoomAttachmentComposer
                  attachments={replyAttachments}
                  locked={!writable || followup.isPending || uncertain}
                  owner={`${thread}|${scope?.authorityKey}`}
                >
                  <TaskRoomMessageInput
                    onSend={() => {
                      if (
                        writable &&
                        (reply.trim() || replyAttachments.files.length) &&
                        !replyAttachments.busy &&
                        !followup.isPending &&
                        !uncertain
                      )
                        followup.mutate();
                    }}
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
                </TaskRoomAttachmentComposer>
                <div className="task-room-composer-actions">
                  <label className="task-room-brief-choice">
                    <input
                      type="checkbox"
                      checked={attachBrief}
                      disabled={followup.isPending || uncertain}
                      onChange={(event) => setAttachBrief(event.target.checked)}
                    />
                    Brief attached
                  </label>
                  <Button
                    className="task-room-send"
                    aria-label={followup.isPending ? 'Sending…' : 'Send reply'}
                    pending={followup.isPending}
                    pendingLabel="Sending…"
                    type="submit"
                    disabled={
                      !writable ||
                      (!reply.trim() && !replyAttachments.files.length) ||
                      replyAttachments.busy ||
                      followup.isPending ||
                      uncertain
                    }
                  >
                    Send
                  </Button>
                </div>
              </form>
              {attachBrief &&
                requests.data?.context?.text.includes(
                  'Brief shortened to fit',
                ) && (
                  <p className="task-room-inline-status" role="status">
                    The brief exceeds 16,000 characters. A shortened version
                    with a notice will be attached.
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
          ) : null
        }
      >
        <div
          className="task-room-messages"
          ref={messages}
          onScroll={() => {
            const list = messages.current;
            if (!list) return;
            anchored.current =
              list.scrollHeight - list.scrollTop - list.clientHeight < 80;
            setJumpToLatest(!anchored.current);
            if (
              list.scrollTop === 0 &&
              !anchored.current &&
              allVisible.length > historyWindow
            )
              loadEarlier();
          }}
        >
          {allVisible.length > historyWindow && (
            <Button variant="ghost" onClick={loadEarlier}>
              Load earlier messages
            </Button>
          )}
          {history.isLoading && (
            <SkeletonList count={2} label="Loading messages" />
          )}
          {history.isError && (
            <p role="alert">
              Room history is unavailable.{' '}
              <Button onClick={() => void history.refetch()}>Retry</Button>
            </p>
          )}
          {capabilities && !capabilities.historyRead && (
            <p role="status">History is not shared with this connection.</p>
          )}
          {!visible.length &&
            !history.isLoading &&
            !history.hasNextPage &&
            !history.isError &&
            capabilities?.historyRead && (
              <Empty
                variant="compact"
                label="Start the conversation"
                description="Share a thought, shape the brief, or ask an agent to work on this Task."
              />
            )}
          <ol aria-live="polite" aria-label="Task room history">
            {visible.map((record, index) =>
              message(record, visible[index - 1]),
            )}
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
                    variant="ghost"
                    size="sm"
                    onClick={() => void openRun(participant.work.sessionId)}
                  >
                    Open full run
                  </Button>
                </>
              ) : (
                <>
                  <span>is {participant.work.workState}</span>
                  {participant.work.startedAt && (
                    <span>
                      ·{' '}
                      {Math.max(
                        0,
                        Math.floor((now - participant.work.startedAt) / 60000),
                      )}
                      m
                    </span>
                  )}
                  {participant.work.workName &&
                    participant.work.workName !== 'Project task work' && (
                      <span>· {participant.work.workName}</span>
                    )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void openRun(participant.work.sessionId)}
                  >
                    Watch
                  </Button>
                  <Button
                    variant="ghost"
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
        </div>
        {jumpToLatest && (
          <Button variant="ghost" className="task-room-jump" onClick={goLatest}>
            Jump to latest
          </Button>
        )}
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
                    variant="ghost"
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
      </SplitPaneCompanion>
      <DiscardModal />
    </section>
  );
}

export function TaskRoomHistoryDetails({ taskId }: { taskId: string }) {
  const history = useProjectTaskRoomHistoryQuery(taskId);
  return (
    <details
      className="task-workspace__record-details"
      aria-busy={history.isFetching}
      onToggle={(event) => {
        if (event.currentTarget.open) void history.refetch();
      }}
    >
      <summary>Raw room history</summary>
      {history.isError ? (
        <p role="alert">Room history unavailable.</p>
      ) : (
        <pre>{JSON.stringify(history.data?.pages ?? [], null, 2)}</pre>
      )}
    </details>
  );
}
