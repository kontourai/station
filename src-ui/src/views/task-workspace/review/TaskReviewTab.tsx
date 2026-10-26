import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  type TaskReviewAnchor,
  type TaskReviewArtifactKind,
  type TaskReviewItem,
  type TaskReviewThreadSummary,
} from '@kontourai/station-contracts/task-review';
import {
  fetchTaskCaptureContent,
  fetchTaskReviewThread,
  taskReviewThreadQueryKey,
  useCaptureToTaskMutation,
  useCreateReviewThreadMutation,
  useReopenReviewThreadMutation,
  useReplyReviewThreadMutation,
  useResolveReviewThreadMutation,
  useSendReviewThreadsMutation,
  useTaskCaptureSessionsQuery,
  useTaskReviewItemQuery,
  useTaskReviewQuery,
  useTaskReviewThreadQuery,
} from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import {
  ErrorState,
  SkeletonBlock,
  SkeletonList,
} from '../../../components/state';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../../contexts/ApiBaseContext';
import {
  useNavigation,
  useNavigationActions,
} from '../../../contexts/NavigationContext';
import { ReviewCommentsRail, type ReviewFilter } from './ReviewCommentsRail';
import { ReviewDocumentView } from './ReviewDocumentView';
import { ReviewImageView } from './ReviewImageView';
import { ReviewItemList } from './ReviewItemList';
import { ReviewThreadCard } from './ReviewThreadCard';
import { copyReviewThreadsForAgent } from './review-copy';
import { type ReviewThreadActions, sameReviewArtifact } from './review-types';
import { TaskReviewLayout } from './TaskReviewLayout';

type AvailableSummary = Extract<
  TaskReviewThreadSummary,
  { status: 'available' }
>;
const NO_THREADS: readonly TaskReviewThreadSummary[] = [];
const NO_ITEMS: readonly TaskReviewItem[] = [];
const NO_COUNTS = { open: 0, outdated: 0, resolved: 0 };

function reviewError(error: unknown): string {
  if (error instanceof StationHttpError) {
    switch (error.code) {
      case 'invalid-transition':
        return 'This thread changed. Refresh and try again.';
      case 'no-live-agent':
        return 'Start the lead agent before sending.';
      case 'sender-not-task-owner':
        return 'Only the lead agent’s owner can send these threads.';
      case 'message-too-large':
        return 'Send fewer threads, or use Copy for agent.';
      case 'workspace-changed':
        return 'Commit workspace changes before capturing.';
      case 'workspace-unobservable':
        return 'This workspace can’t be pinned for a capture.';
      case 'thread-limit':
        return 'This Task has reached its thread limit.';
      case 'event-limit':
        return 'This thread has reached its reply limit.';
      case 'screenshot-too-large':
        return 'This Screen is too large to capture.';
      case 'operation-conflict':
        return 'This action changed. Refresh and try again.';
      case 'capture-unavailable':
      case 'capture-corrupt':
        return 'This Screen is unavailable. Capture it again.';
      case 'capture-limit':
        return 'This Task has reached its Screen limit.';
      case 'capture-home-limit':
        return 'This Station has reached its Screen storage limit.';
      case 'anchor-mismatch':
        return 'The text changed. Select it again to comment.';
      case 'artifact-unavailable':
        return 'This item is unavailable. Refresh and try again.';
    }
  }
  return 'Review action failed. Try again.';
}

async function inlineAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new Error(reviewError(error));
  }
}

function ThreadDetails({
  taskId,
  summary,
  expanded,
  onExpand,
  actions,
}: {
  taskId: string;
  summary: AvailableSummary;
  expanded: boolean;
  onExpand: () => void;
  actions: ReviewThreadActions;
}) {
  const detail = useTaskReviewThreadQuery(taskId, summary.threadId, {
    enabled: expanded,
    eventCount: summary.eventCount,
    revision: summary.currentRevision,
  });
  if (!expanded)
    return (
      <ReviewThreadCard thread={summary} {...actions} onExpand={onExpand} />
    );
  if (detail.error)
    return (
      <ErrorState
        variant="compact"
        title={`Couldn’t load thread ${summary.ordinal}.`}
        action={
          <Button size="sm" onClick={() => void detail.refetch()}>
            Retry thread
          </Button>
        }
      />
    );
  if (!detail.data)
    return (
      <SkeletonBlock count={1} label={`Loading thread ${summary.ordinal}`} />
    );
  return (
    <ReviewThreadCard
      thread={{ ...detail.data.thread, deliveryStatus: summary.deliveryStatus }}
      {...actions}
    />
  );
}

function CapturePicker({
  taskId,
  visible,
  onCaptured,
}: {
  taskId: string;
  visible: boolean;
  onCaptured: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState<string>();
  const sessions = useTaskCaptureSessionsQuery(taskId, {
    enabled: visible && open,
    staleTime: 0,
  });
  const capture = useCaptureToTaskMutation(taskId);
  const attempt = useRef<{ source: string; operationId: string } | undefined>(
    undefined,
  );
  const choices = sessions.data?.sessions ?? [];
  const selected = choices.some(
    (session) => session.browserSessionId === sessionId,
  )
    ? sessionId
    : choices[0]?.browserSessionId;
  return (
    <div className="review-capture-picker">
      <Button
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        Capture
      </Button>
      <Dialog
        open={open}
        historyMode="none"
        title="Capture from Browser"
        closeLabel="Close capture picker"
        onClose={() => setOpen(false)}
        size="sm"
      >
        <form
          className="review-capture-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selected || capture.isPending) return;
            setError(undefined);
            if (attempt.current?.source !== selected)
              attempt.current = {
                source: selected,
                operationId: randomCorrelationId(),
              };
            capture.mutate(
              {
                sourceKind: 'browser',
                sourceSessionId: selected,
                operationId: attempt.current.operationId,
              },
              {
                onSuccess: (result) => {
                  attempt.current = undefined;
                  onCaptured(result.capture.captureId);
                  setOpen(false);
                },
                onError: (cause) => setError(reviewError(cause)),
              },
            );
          }}
        >
          {sessions.isLoading ? (
            <SkeletonList
              count={2}
              withIcon={false}
              label="Loading Browser sessions"
            />
          ) : sessions.error ? (
            <ErrorState
              variant="compact"
              title="Couldn’t load Browser sessions."
            />
          ) : choices.length === 0 ? (
            <p>Open a Browser session in this Project first.</p>
          ) : (
            <>
              <label>
                Browser session
                <select
                  value={selected}
                  onChange={(event) => setSessionId(event.target.value)}
                >
                  {choices.map((session) => (
                    <option
                      key={session.browserSessionId}
                      value={session.browserSessionId}
                    >
                      {session.url
                        ? new URL(session.url).host || 'Blank page'
                        : 'Blank page'}
                    </option>
                  ))}
                </select>
              </label>
              <Button size="sm" type="submit" pending={capture.isPending}>
                Capture Screen
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => void sessions.refetch()}>
            Refresh sessions
          </Button>
          {error && <ErrorState variant="compact" title={error} />}
        </form>
      </Dialog>
    </div>
  );
}

function CaptureImage({
  taskId,
  item,
  threads,
  actions,
  onCreateThread,
  onSelectThread,
}: {
  taskId: string;
  item: Extract<TaskReviewItem, { status: 'available' }>;
  threads: readonly AvailableSummary[];
  actions: ReviewThreadActions;
  onCreateThread: (anchor: TaskReviewAnchor, body: string) => Promise<void>;
  onSelectThread: (id: string) => void;
}) {
  const content = useQuery({
    queryKey: [
      'task-review-capture-content',
      taskId,
      item.id,
      item.artifact.digest,
    ],
    queryFn: ({ signal }) => fetchTaskCaptureContent(taskId, item.id, signal),
    gcTime: 0,
    staleTime: Infinity,
  });
  const [image, setImage] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!content.data) return;
    const url = URL.createObjectURL(content.data);
    setImage({ blob: content.data, url });
    return () => URL.revokeObjectURL(url);
  }, [content.data]);
  if (content.error)
    return (
      <ErrorState
        variant="compact"
        title="Couldn’t load this Screen."
        action={
          <Button size="sm" onClick={() => void content.refetch()}>
            Retry Screen
          </Button>
        }
      />
    );
  if (!image || image.blob !== content.data)
    return <SkeletonBlock count={1} label="Loading Screen" />;
  if (item.artifact.kind !== 'capture') return null;
  return (
    <ReviewImageView
      src={image.url}
      alt={item.label}
      artifact={{ ...item.artifact, kind: 'capture' }}
      capture={item.capture}
      draftScope={actions.draftScope}
      threads={threads}
      onSelectThread={onSelectThread}
      onCreateThread={onCreateThread}
    />
  );
}

export function TaskReviewTab({
  task,
  visible,
}: {
  task: TaskRecord;
  visible: boolean;
}) {
  const { apiBase } = useApiBase();
  const authority = useHostRequestAuthorityScope();
  const queryClient = useQueryClient();
  const kind = useNavigation(() =>
    new URLSearchParams(window.location.search).get('reviewKind'),
  );
  const itemId = useNavigation(() =>
    new URLSearchParams(window.location.search).get('reviewItem'),
  );
  const { updateParams } = useNavigationActions();
  const review = useTaskReviewQuery(task.id, {
    enabled: visible,
    poll: visible,
    staleTime: 0,
  });
  const items = review.data?.items ?? NO_ITEMS;
  const summaries = review.data?.threads ?? NO_THREADS;
  const selected =
    items.find((item) => item.kind === kind && item.id === itemId) ??
    (kind === 'capture'
      ? items.find((item) => item.kind === 'capture')
      : items.find((item) => item.kind === 'plan'));
  const item = useTaskReviewItemQuery(
    task.id,
    selected?.kind ?? 'plan',
    selected?.id ?? '',
    {
      enabled: visible && selected?.status === 'available',
      revision:
        selected?.status === 'available'
          ? selected.artifact.revision
          : undefined,
    },
  );
  const create = useCreateReviewThreadMutation(task.id);
  const reply = useReplyReviewThreadMutation(task.id);
  const resolve = useResolveReviewThreadMutation(task.id);
  const reopen = useReopenReviewThreadMutation(task.id);
  const send = useSendReviewThreadsMutation(task.id);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedThread, setSelectedThread] = useState<string>();
  const [filter, setFilter] = useState<ReviewFilter>('open');
  const resolveAuthor: ReviewThreadActions['resolveAuthor'] = (author) =>
    review.data?.authors?.find(
      (identity) => JSON.stringify(identity.author) === JSON.stringify(author),
    ) ?? { name: author.kind === 'person' ? 'Teammate' : 'Agent' };
  const attempts = useRef(
    new Map<string, { input: string; operationId: string }>(),
  );
  async function mutate<R>(
    slot: string,
    input: unknown,
    action: (operationId: string) => Promise<R>,
  ): Promise<R> {
    const identity = JSON.stringify(input);
    let attempt = attempts.current.get(slot);
    if (attempt?.input !== identity) {
      attempt = { input: identity, operationId: randomCorrelationId() };
      attempts.current.set(slot, attempt);
    }
    const result = await inlineAction(() => action(attempt.operationId));
    attempts.current.delete(slot);
    return result;
  }
  const threads = useMemo(
    () =>
      summaries.filter(
        (thread): thread is AvailableSummary =>
          thread.status === 'available' &&
          selected?.status === 'available' &&
          sameReviewArtifact(thread.artifact, selected.artifact),
      ),
    [summaries, selected],
  );
  const railThreads = useMemo(
    () =>
      summaries.filter((thread) =>
        thread.status === 'unavailable'
          ? Boolean(
              thread.artifact &&
                selected?.status === 'available' &&
                sameReviewArtifact(thread.artifact, selected.artifact),
            )
          : threads.includes(thread),
      ),
    [summaries, threads, selected],
  );
  const counts = selected?.counts ?? NO_COUNTS;
  const draftScope = JSON.stringify([
    apiBase,
    authority?.draftRecoveryKey ?? authority?.authorityKey,
    task.id,
    task.createdAt,
  ]);
  function select(kind: TaskReviewArtifactKind, id?: string) {
    setFilter('open');
    updateParams({ reviewKind: kind, reviewItem: id ?? null });
  }
  function expand(id: string) {
    setExpanded((previous) => new Set([...previous, id]));
    setSelectedThread(id);
  }
  useEffect(() => {
    if (!selectedThread) return;
    const node = document.getElementById(`review-thread-${selectedThread}`);
    node?.scrollIntoView?.({ block: 'nearest' });
    node?.focus();
  }, [selectedThread]);
  async function createThread(
    anchor: TaskReviewAnchor,
    body: string,
    quote?: string,
  ) {
    if (item.data?.status !== 'available')
      throw new Error('Refresh this item before commenting.');
    const artifact = item.data.artifact;
    const result = await mutate(
      'create',
      { artifact, anchor, body, quote },
      (operationId) =>
        create.mutateAsync({
          artifact,
          anchor,
          body,
          quote: anchor.kind === 'block' ? quote : undefined,
          operationId,
        }),
    );
    setFilter('open');
    expand(result.thread.threadId);
  }
  const actions: ReviewThreadActions = {
    draftScope,
    resolveAuthor,
    onReply: async (threadId, body) => {
      await mutate(`reply:${threadId}`, body, (operationId) =>
        reply.mutateAsync({
          threadId,
          body,
          operationId,
        }),
      );
    },
    onResolve: async (threadId) => {
      await mutate(`resolve:${threadId}`, null, (operationId) =>
        resolve.mutateAsync({ threadId, operationId }),
      );
    },
    onReopen: async (threadId) => {
      await mutate(`reopen:${threadId}`, null, (operationId) =>
        reopen.mutateAsync({ threadId, operationId }),
      );
    },
    onSend: async (threadIds, mode) => {
      const result = await inlineAction(() =>
        send.mutateAsync({
          threadIds,
          mode,
          operationId: randomCorrelationId(),
        }),
      );
      if (result.status === 'failed') throw new Error('Not sent. Try again.');
    },
    sending: send.isPending,
    onCopyForAgent: async (ids) => {
      const full = await Promise.all(
        ids.map((id) => {
          const summary = summaries.find((thread) => thread.threadId === id);
          return queryClient.fetchQuery({
            queryKey: taskReviewThreadQueryKey(
              task.id,
              id,
              summary?.eventCount,
              summary?.status === 'available'
                ? summary.currentRevision
                : undefined,
            ),
            queryFn: ({ signal }) => fetchTaskReviewThread(task.id, id, signal),
          });
        }),
      );
      await copyReviewThreadsForAgent(full.map((entry) => entry.thread));
    },
    onCopyLink: async (id) => {
      const url = new URL(window.location.href);
      url.hash = `review-thread-${id}`;
      await navigator.clipboard.writeText(url.href);
    },
    onOpenCapture: (id) => select('capture', id),
  };
  const content = item.data;
  return (
    <>
      {review.error && (
        <ErrorState
          variant="compact"
          title="Couldn’t refresh Review."
          action={
            <Button size="sm" onClick={() => void review.refetch()}>
              Retry Review
            </Button>
          }
        />
      )}
      <TaskReviewLayout
        items={
          <ReviewItemList
            items={items}
            selectedItemId={selected?.id}
            selectedKind={selected?.kind}
            onSelectItem={(item) => select(item.kind, item.id)}
            captureAction={
              <CapturePicker
                taskId={task.id}
                visible={visible}
                onCaptured={(id) => select('capture', id)}
              />
            }
          />
        }
        content={
          kind === 'capture' || selected?.kind === 'capture' ? (
            content?.status === 'available' && selected?.kind === 'capture' ? (
              <CaptureImage
                taskId={task.id}
                item={content}
                threads={threads}
                actions={actions}
                onCreateThread={createThread}
                onSelectThread={expand}
              />
            ) : (
              <p className="review-empty">
                Capture a Browser Screen to add region comments.
              </p>
            )
          ) : review.isLoading || item.isLoading ? (
            <SkeletonBlock label="Loading Review" />
          ) : item.error ? (
            <ErrorState
              variant="compact"
              title="Couldn’t load this item."
              action={
                <Button size="sm" onClick={() => void item.refetch()}>
                  Retry item
                </Button>
              }
            />
          ) : content?.status === 'available' && content.text !== undefined ? (
            <ReviewDocumentView
              key={`${content.kind}:${content.id}`}
              artifact={content.artifact}
              previousArtifact={
                threads.find(
                  (thread) =>
                    thread.artifact.revision !== content.artifact.revision,
                )?.artifact
              }
              title={content.label}
              text={content.text}
              threads={threads}
              draftScope={draftScope}
              onCreateThread={createThread}
              onSelectThread={expand}
            />
          ) : (
            <p className="review-empty">This item is unavailable.</p>
          )
        }
        comments={
          <ReviewCommentsRail
            threads={railThreads}
            counts={counts}
            artifactKey={`${selected?.kind}:${selected?.id}`}
            filter={filter}
            onFilterChange={setFilter}
            {...actions}
            renderThread={(thread) =>
              'status' in thread && thread.status === 'available' ? (
                <ThreadDetails
                  taskId={task.id}
                  summary={thread}
                  expanded={expanded.has(thread.threadId)}
                  onExpand={() => expand(thread.threadId)}
                  actions={actions}
                />
              ) : (
                <p className="review-thread" role="status">
                  Thread #{thread.ordinal} is unavailable.
                </p>
              )
            }
          />
        }
      />
    </>
  );
}
