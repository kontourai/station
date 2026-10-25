import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  countThreads,
  type TaskReviewAnchor,
  type TaskReviewArtifactKind,
  type TaskReviewAuthor,
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

function reviewError(error: unknown): string {
  if (error instanceof StationHttpError) {
    switch (error.code) {
      case 'invalid-transition':
        return 'This thread changed. Refresh and try again.';
      case 'no-live-agent':
        return 'Start the lead agent before sending.';
      case 'workspace-changed':
        return 'Commit workspace changes before capturing.';
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
      <article
        className="review-thread"
        data-review-thread={summary.threadId}
        id={`review-thread-${summary.threadId}`}
        tabIndex={-1}
        aria-label={`Thread ${summary.ordinal}`}
      >
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={false}
          onClick={onExpand}
          aria-label={`Expand thread ${summary.ordinal}`}
        >
          Thread {summary.ordinal} ·{' '}
          {summary.state === 'outdated'
            ? 'Outdated'
            : summary.baseState === 'agent-replied'
              ? 'Replied'
              : summary.baseState === 'resolved'
                ? 'Resolved'
                : summary.baseState === 'sent'
                  ? 'Sent'
                  : 'Open'}
        </Button>
        {summary.state === 'outdated' && (
          <blockquote>
            {summary.quote ??
              (summary.anchor.kind === 'text-quote'
                ? summary.anchor.exact
                : '')}
          </blockquote>
        )}
        {'body' in summary.lastEvent && (
          <p className="review-thread__body">{summary.lastEvent.body}</p>
        )}
      </article>
    );
  if (detail.error)
    return (
      <div role="alert">
        Couldn’t load thread {summary.ordinal}.{' '}
        <Button size="sm" onClick={() => void detail.refetch()}>
          Retry thread
        </Button>
      </div>
    );
  if (!detail.data)
    return <p role="status">Loading thread {summary.ordinal}…</p>;
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
        Capture from Browser
      </Button>
      {open && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!selected || capture.isPending) return;
            setError(undefined);
            if (attempt.current?.source !== selected)
              attempt.current = {
                source: selected,
                operationId: randomCorrelationId(),
              };
            try {
              const result = await capture.mutateAsync({
                sourceKind: 'browser',
                sourceSessionId: selected,
                operationId: attempt.current.operationId,
              });
              attempt.current = undefined;
              onCaptured(result.capture.captureId);
              setOpen(false);
            } catch (cause) {
              setError(reviewError(cause));
            }
          }}
        >
          {sessions.isLoading ? (
            <p role="status">Loading Browser sessions…</p>
          ) : sessions.error ? (
            <p role="alert">Couldn’t load Browser sessions.</p>
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
                      {session.url || 'Blank page'} · {session.browserSessionId}
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
          {error && <p role="alert">{error}</p>}
        </form>
      )}
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
      <p role="alert">
        Couldn’t load this Screen.{' '}
        <Button size="sm" onClick={() => void content.refetch()}>
          Retry Screen
        </Button>
      </p>
    );
  if (!image || image.blob !== content.data)
    return <p role="status">Loading Screen…</p>;
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
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
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
      summaries.filter(
        (thread) => thread.status === 'unavailable' || threads.includes(thread),
      ),
    [summaries, threads],
  );
  const counts = useMemo(() => countThreads(threads), [threads]);
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
    setFilter('all');
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
    expand(result.thread.threadId);
  }
  const actions: ReviewThreadActions = {
    draftScope,
    resolveAuthor: (author: TaskReviewAuthor) => ({
      name:
        author.kind === 'person'
          ? author.principalId
          : author.sessionId === task.sessionId
            ? 'Lead agent'
            : author.sessionId,
    }),
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
      setDeliveryNotice(undefined);
      const result = await inlineAction(() =>
        send.mutateAsync({
          threadIds,
          mode,
          operationId: randomCorrelationId(),
        }),
      );
      if (result.status === 'failed') throw new Error('Not sent. Try again.');
      setDeliveryNotice(
        result.status === 'unconfirmed'
          ? 'Send unconfirmed. Check with the lead agent before sending again.'
          : 'Sent to the lead agent.',
      );
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
        <p role="alert">
          Couldn’t refresh Review.{' '}
          <Button size="sm" onClick={() => void review.refetch()}>
            Retry Review
          </Button>
        </p>
      )}
      {deliveryNotice && (
        <p className="review-notice" role="status">
          {deliveryNotice}
        </p>
      )}
      <TaskReviewLayout
        items={
          <>
            <ReviewItemList
              items={items}
              selectedItemId={selected?.id}
              selectedKind={selected?.kind}
              onSelectItem={(item) => select(item.kind, item.id)}
            />
            <Button size="sm" variant="ghost" onClick={() => select('capture')}>
              Screens
            </Button>
          </>
        }
        content={
          kind === 'capture' || selected?.kind === 'capture' ? (
            <>
              <CapturePicker
                taskId={task.id}
                visible={visible}
                onCaptured={(id) => select('capture', id)}
              />
              {content?.status === 'available' &&
              selected?.kind === 'capture' ? (
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
              )}
            </>
          ) : review.isLoading || item.isLoading ? (
            <p role="status">Loading Review…</p>
          ) : item.error ? (
            <p role="alert">
              Couldn’t load this item.{' '}
              <Button size="sm" onClick={() => void item.refetch()}>
                Retry item
              </Button>
            </p>
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
                  Thread {thread.ordinal} is unavailable.
                </p>
              )
            }
          />
        }
      />
    </>
  );
}
