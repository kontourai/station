import type { ProjectTaskRoomBrowserRecord } from '@kontourai/station-contracts/project-task-room-browser';
import {
  useCreateTaskReferenceMutation,
  useTaskTurnReferencesQuery,
} from '@kontourai/station-sdk';
import { continueDelegatedTask } from '@kontourai/station-sdk/client';
import {
  useProjectTaskRoomDiscoveryQuery,
  useProjectTaskRoomHistoryQuery,
  useTaskRoomAgentRequestsQuery,
} from '@kontourai/station-sdk/project-task-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatDuration } from '../utils/relativeTime';

/** Rows revealed per step when reading back through loaded history. */
const HISTORY_WINDOW = 50;

import { ActionRow } from '../components/ActionRow';
import { Button } from '../components/Button';
import { LazyMarkdown } from '../components/chat/LazyMarkdown';
import { ConversationStopControl } from '../components/conversation/ConversationStopControl';
import {
  projectTaskHistory,
  SharedTaskHistoryList,
} from '../components/conversation/SharedTaskHistoryList';
import { createTaskConversationActions } from '../components/conversation/task-conversation-actions';
import { taskHistoryReadDenied } from '../components/conversation/task-history-policy';
import { IconButton } from '../components/IconButton';
import { CloseGlyph } from '../components/icons/Glyph';
import { RoomAvatar } from '../components/room/RoomAvatar';
import { RoomComposer } from '../components/room/RoomComposer';
import {
  RoomConversation,
  type RoomConversationRow,
} from '../components/room/RoomConversation';
import { RoomThreadSummary } from '../components/room/RoomThreadSummary';
import { useMarkRoomRead } from '../components/room/useMarkRoomRead';
import { roomDraftKey, useRoomDraft } from '../components/room/useRoomDraft';
import { SplitPaneCompanion } from '../components/SplitPaneLayout';
import { SkeletonBlock } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { openChatsStore } from '../contexts/open-chats-store';
import { useElapsedClock } from '../hooks/useElapsedClock';
import { useSurfaceVisibilityFlags } from '../hooks/useSurfaceVisibilityFlags';
import { useTaskRoomAttachments } from '../hooks/useTaskRoomAttachments';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { describeStationFailure } from '../utils/stationFailure';
import { useProjectTaskRoomContext } from './ProjectTaskRoomContext';
import { TaskRoomAttachmentImages } from './TaskRoomAttachmentImages';
import { TaskRoomComposer } from './TaskRoomComposer';

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
  const collaborationEnabled =
    useSurfaceVisibilityFlags().has('task-collaboration');
  const discover = useProjectTaskRoomDiscoveryQuery(taskId);
  const shared = useProjectTaskRoomContext(taskId);
  const history = useProjectTaskRoomHistoryQuery(taskId);
  const room = shared?.discovery ?? discover;
  const capabilities =
    room.data?.kind === 'opened' || room.data?.kind === 'existing'
      ? room.data.capabilities
      : undefined;
  const readable =
    scope?.isCurrent() === true &&
    capabilities?.historyRead === true &&
    !taskHistoryReadDenied(history.error);
  const pages = history.data?.pages ?? [];
  const historyProjection = projectTaskHistory(pages);
  const records = readable ? historyProjection.records : [];
  const writable =
    capabilities?.messageWrite === true && shared?.stream !== 'terminal';
  const requests = useTaskRoomAgentRequestsQuery(
    taskId,
    taskCreatedAt ?? '',
    scope,
    capabilities?.historyRead,
  );
  const [thread, setThread] = useState<string>();
  // A thread's unsent reply survives leaving the Task and a reload; keyed by
  // the reload partition (not the per-reload authority epoch), Task and
  // Session so it never reaches another agent (#4810 review 1).
  const [reply, setReply] = useRoomDraft(
    roomDraftKey(
      scope?.draftRecoveryKey ?? scope?.authorityKey,
      scope?.apiBase,
      taskId,
      thread,
      'task-thread',
    ),
  );

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
  const [historyWindow, setHistoryWindow] = useState(HISTORY_WINDOW);
  const now = useElapsedClock(running.length > 0);
  // The history contract pages forward through a fixed checkpoint. Read to that
  // checkpoint before presenting its newest messages; reveal older rows locally.
  useEffect(() => {
    if (
      readable &&
      history.hasNextPage &&
      !history.isFetching &&
      !history.isError
    )
      void history.fetchNextPage({ cancelRefetch: false });
  }, [
    history.hasNextPage,
    history.isFetching,
    history.isError,
    history.fetchNextPage,
    readable,
  ]);
  // Read through the checkpoint once every page up to it is shown (#3075,
  // #4794): the Task's row in the sidebar loses its unread state.
  const shownThrough =
    readable && history.data && !history.hasNextPage
      ? Math.max(
          0,
          ...history.data.pages.map((page) =>
            'checkpoint' in page && page.checkpoint
              ? page.checkpoint.throughSeq
              : 0,
          ),
        )
      : undefined;
  useMarkRoomRead(
    readable ? { kind: 'task-room', taskId } : undefined,
    shownThrough,
  );
  const followup = useMutation({
    mutationFn: async () => {
      if (!scope?.isCurrent() || !thread || !taskCreatedAt)
        throw new Error('Task connection changed.');
      let attachments: Awaited<ReturnType<typeof replyAttachments.prepare>>;
      try {
        attachments = await replyAttachments.prepare();
      } catch (error) {
        throw Object.assign(new Error(describeStationFailure(error).body), {
          code: 'task_room_reply_refused',
        });
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
        `Not delivered · ${describeStationFailure(error).body}${notSent ? '' : ' Check the full run before resending.'}`,
      );
    },
  });
  const followupPending = useRef(followup.isPending);
  followupPending.current = followup.isPending;
  const stopCapability =
    writable && scope?.isCurrent()
      ? { state: 'allowed' as const }
      : { state: 'denied' as const, reason: 'permission-required' as const };
  const taskActions = createTaskConversationActions({
    apiBase: scope?.apiBase ?? '',
    requestScope: scope,
    capabilities: {
      stop: stopCapability,
      approvalAnswer: { state: 'denied', reason: 'permission-required' },
    },
  });
  const stop = useMutation({
    mutationFn: async (sessionId: string) => {
      return taskActions.stop(sessionId);
    },
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
    onError: (error) => setNotice(describeStationFailure(error).body),
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
  const viewerId = shared?.live?.viewerActorId;
  const isKept = (execution: { sessionId: string; turnId: string }) =>
    kept.has(`${execution.sessionId}:${execution.turnId}`) ||
    !!references.data?.some(
      (reference) =>
        reference.state === 'available' &&
        reference.sessionId === execution.sessionId &&
        reference.turnId === execution.turnId,
    );
  const toRow = (
    record: ProjectTaskRoomBrowserRecord,
    inThread = false,
  ): RoomConversationRow => {
    const id = String(record.sequence);
    if (
      record.body.kind === 'live-work-finished' &&
      record.body.outcome === 'failed'
    ) {
      const sessionId = record.body.sessionId;
      return {
        id,
        kind: 'system',
        tone: 'failed',
        at: record.occurredAt,
        text: `${record.actor.label} couldn’t finish`,
        actions: (
          <>
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
          </>
        ),
      };
    }
    if (record.system || record.body.kind !== 'human-message')
      return {
        id,
        kind: 'system',
        at: record.occurredAt,
        body: (
          <>
            {record.system && <span>{record.actor.label} · </span>}
            <span>{systemText(record)}</span>
          </>
        ),
      };
    const authorLabel =
      record.actor.standing === 'member' && !collaborationEnabled
        ? 'Teammate'
        : record.actor.label;
    const execution = record.execution;
    const replies = execution
      ? records.filter(
          (item) =>
            item.sequence !== record.sequence &&
            (item.execution?.sessionId === execution.sessionId ||
              item.threadSessionId === execution.sessionId),
        )
      : [];
    const repliers = [
      ...new Map(
        replies.map((item) => [
          item.actor.id ?? `${item.actor.kind}:${item.actor.label}`,
          item.actor,
        ]),
      ).values(),
    ].slice(0, 3);
    const lastReply = replies.at(-1)?.occurredAt;
    return {
      id,
      kind: 'message',
      author: {
        // Records without an actor id fall back to kind and label.
        id: record.actor.id ?? `${record.actor.kind}:${record.actor.label}`,
        label: authorLabel,
        agent: record.actor.kind === 'agent',
      },
      at: record.occurredAt,
      own: !!viewerId && record.actor.id === viewerId,
      attachments: (
        <TaskRoomAttachmentImages
          attachments={record.body.attachments}
          taskId={taskId}
          taskCreatedAt={taskCreatedAt ?? ''}
        />
      ),
      ...(execution
        ? {
            body: (
              <RoomAnswer
                text={record.body.text}
                expanded={expanded.has(record.sequence)}
                onToggle={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(record.sequence)) next.delete(record.sequence);
                    else next.add(record.sequence);
                    return next;
                  })
                }
              />
            ),
            footer:
              !inThread && replies.length ? (
                <RoomThreadSummary
                  repliers={repliers.map((actor) => ({
                    key: actor.id ?? `${actor.kind}:${actor.label}`,
                    label: actor.label,
                    agent: actor.kind === 'agent',
                  }))}
                  count={replies.length}
                  lastAt={lastReply}
                  disabled={followup.isPending}
                  onOpen={() => changeThread(execution.sessionId)}
                />
              ) : undefined,
            actions: (
              <ActionRow
                className="task-room-message-actions"
                primary={
                  !inThread && !replies.length ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={followup.isPending}
                      onClick={() => changeThread(execution.sessionId)}
                    >
                      Reply in thread
                    </Button>
                  ) : undefined
                }
                secondary={
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={keep.isPending || isKept(execution)}
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
                        setNotice(describeStationFailure(error).body);
                      }
                    }}
                  >
                    {isKept(execution) ? 'Kept' : 'Keep'}
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
            ),
          }
        : { text: record.body.text }),
    };
  };
  const runningRows = running.length ? (
    <div className="task-room-live">
      {running.map((participant) => (
        <div
          className="task-room-running"
          role="status"
          key={participant.actor.actorId}
        >
          <RoomAvatar name={participant.actor.label} agent />
          <div className="task-room-running__main">
            {participant.work.workState === 'blocked' &&
            participant.work.workName === "Answer couldn't be posted" ? (
              <span className="task-room-running__line">
                <strong>{participant.actor.label}</strong>
                <span>Answer couldn't be posted</span>
              </span>
            ) : (
              <span className="task-room-running__text">
                <span className="task-room-running__line">
                  <strong>{participant.actor.label}</strong>
                  <span>is {participant.work.workState}</span>
                  <span className="task-room-live-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
                <span className="task-room-running__meta">
                  {[
                    participant.work.workName &&
                    participant.work.workName !== 'Project task work'
                      ? participant.work.workName
                      : '',
                    participant.work.startedAt
                      ? formatDuration(now - participant.work.startedAt)
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            )}
            <span className="task-room-running__actions">
              {participant.work.workState === 'blocked' &&
              participant.work.workName === "Answer couldn't be posted" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void openRun(participant.work.sessionId)}
                >
                  Open full run
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void openRun(participant.work.sessionId)}
                  >
                    Watch
                  </Button>
                  <ConversationStopControl
                    intent={{ kind: 'task', name: participant.actor.label }}
                    capability={stopCapability}
                    stopPending={stop.isPending}
                    onCancel={() =>
                      stop.mutateAsync(participant.work.sessionId)
                    }
                  />
                </>
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  ) : undefined;
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
  const canReply =
    writable &&
    (!!reply.trim() || replyAttachments.files.length > 0) &&
    !replyAttachments.busy &&
    !followup.isPending &&
    !uncertain;
  return (
    <section
      className={`project-task-room-conversation${thread ? ' task-room-conversation--thread-open' : ''}`}
      aria-label="Task room conversation"
    >
      <SplitPaneCompanion
        sheet={{
          label: `${threadRecords[0]?.actor.label ?? 'Agent'} · Thread`,
          onDismiss: () => changeThread(),
          page: true,
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
              <RoomConversation
                label="Thread messages"
                regionLabel="Messages in this thread"
                className="task-room-thread-messages"
                rows={threadRecords.map((record) => toRow(record, true))}
              />
              <RoomComposer
                id="task-thread-reply"
                className="task-room-thread-composer"
                label="Reply to this agent"
                placeholder="Reply in thread…"
                value={reply}
                onValueChange={(value) => {
                  setReply(value);
                  setNotice('');
                  replyOperation.current = undefined;
                }}
                onSend={() => followup.mutate()}
                canSend={canReply}
                pending={followup.isPending}
                sendLabel="Send reply"
                readOnly={!writable || followup.isPending || uncertain}
                attachments={{
                  port: replyAttachments,
                  locked: !writable || followup.isPending || uncertain,
                  owner: `${thread}|${scope?.authorityKey}`,
                }}
                tools={
                  <label className="task-room-brief-choice">
                    <input
                      type="checkbox"
                      checked={attachBrief}
                      disabled={followup.isPending || uncertain}
                      onChange={(event) => setAttachBrief(event.target.checked)}
                    />
                    Brief attached
                  </label>
                }
                below={
                  <>
                    {attachBrief &&
                      requests.data?.context?.text.includes(
                        'Brief shortened to fit',
                      ) && (
                        <p className="room-composer__status" role="status">
                          The brief exceeds 16,000 characters. A shortened
                          version with a notice will be attached.
                        </p>
                      )}
                    {notice && (
                      <p className="room-composer__status" role="status">
                        {notice}{' '}
                        {uncertain && (
                          <Button
                            size="sm"
                            onClick={() => void openRun(thread)}
                          >
                            Open full run
                          </Button>
                        )}
                      </p>
                    )}
                  </>
                }
              />
            </section>
          ) : null
        }
      >
        <SharedTaskHistoryList
          records={visible}
          readable={readable}
          pending={history.isLoading}
          failed={history.isError}
          outcome={historyProjection.outcome}
          hasEarlier={allVisible.length > historyWindow || history.hasNextPage}
          loadingEarlier={history.isFetchingNextPage}
          onLoadEarlier={() =>
            allVisible.length > historyWindow
              ? setHistoryWindow((count) => count + HISTORY_WINDOW)
              : void history.fetchNextPage()
          }
          onRetry={() =>
            void (history.isFetchNextPageError
              ? history.fetchNextPage()
              : history.refetch())
          }
          label="Task room history"
          emptyLabel="Start the conversation"
          renderList={(list) => (
            <RoomConversation
              label={list.label}
              regionLabel="Messages in this Task room"
              className="task-room-messages"
              rows={list.records.map((record) => toRow(record))}
              loading={list.pending}
              status={list.status}
              empty={list.empty}
              hasOlder={list.hasEarlier}
              loadingOlder={list.loadingEarlier}
              onLoadOlder={list.onLoadEarlier}
              trailing={runningRows}
            />
          )}
        />
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

export function TaskRoomHistoryDetails({
  taskId,
  requestScope,
}: {
  taskId: string;
  requestScope: ReturnType<typeof useHostRequestAuthorityScope>;
}) {
  const history = useProjectTaskRoomHistoryQuery(taskId);
  const readable =
    requestScope?.isCurrent() === true && !taskHistoryReadDenied(history.error);
  return (
    <details
      className="task-workspace__record-details"
      aria-busy={history.isFetching}
      onToggle={(event) => {
        if (readable && event.currentTarget.open) void history.refetch();
      }}
    >
      <summary>Raw room history</summary>
      {!readable ? (
        <p role="status">History is not shared with this connection.</p>
      ) : history.isError ? (
        <p role="alert">Room history unavailable.</p>
      ) : (
        <pre>{JSON.stringify(history.data?.pages ?? [], null, 2)}</pre>
      )}
    </details>
  );
}
