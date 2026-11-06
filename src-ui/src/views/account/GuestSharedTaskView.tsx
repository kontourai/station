import type {
  ProjectSharedTaskHistory,
  ProjectSharedTaskSummary,
} from '@kontourai/station-contracts/project-shared-task';
import { taskStatusLabel } from '@kontourai/station-contracts/task-graph';
import { StationHttpError } from '@kontourai/station-sdk';
import {
  listProjectSharedTasks,
  readProjectSharedTaskDocument,
  readProjectSharedTaskHistory,
} from '@kontourai/station-sdk/project-shared-tasks';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { LazyMarkdown } from '../../components/chat/LazyMarkdown';
import {
  projectTaskHistory,
  SharedTaskHistoryList,
} from '../../components/conversation/SharedTaskHistoryList';
import { IconButton } from '../../components/IconButton';
import { CloseGlyph, RefreshGlyph } from '../../components/icons/Glyph';
import { Empty, SkeletonBlock, SkeletonList } from '../../components/state';
import {
  GuestAccountRequired,
  requireGuestAccount,
} from './guest-account-authority';

class GuestSharedScopeLost extends Error {}

const requestOptions = (signal: AbortSignal) => ({
  authentication: 'omit' as const,
  signal,
  timeoutMs: 15_000,
  maxResponseBytes: 1024 * 1024,
});

async function authorizedRead<Value>(
  apiBase: string,
  principalId: string,
  signal: AbortSignal,
  read: () => Promise<Value>,
) {
  try {
    await requireGuestAccount(apiBase, principalId, signal);
    const value = await read();
    await requireGuestAccount(apiBase, principalId, signal);
    return value;
  } catch (cause) {
    if (
      cause instanceof GuestAccountRequired ||
      (cause instanceof StationHttpError &&
        [401, 403, 404].includes(cause.status))
    )
      throw new GuestSharedScopeLost();
    throw cause;
  }
}

function documentState(kind: string) {
  if (kind === 'too-large') return 'Shared document is too large to display.';
  if (kind === 'unavailable') return 'Shared document is unavailable.';
  return 'This Task document is no longer shared.';
}

export function GuestSharedTaskView({
  apiBase,
  principalId,
  project,
  onScopeLost,
}: {
  apiBase: string;
  principalId: string;
  project: { id: string; slug: string };
  onScopeLost: () => void;
}) {
  const client = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [tab, setTab] = useState('Chat');
  const [notice, setNotice] = useState<string>();
  const taskTriggers = useRef(new Map<string, HTMLButtonElement>());
  const onScopeLostRef = useRef(onScopeLost);
  onScopeLostRef.current = onScopeLost;
  const projectKey = [apiBase, principalId, project.id, project.slug] as const;
  const tasks = useQuery({
    queryKey: ['guest-shared-tasks', ...projectKey],
    queryFn: ({ signal }) =>
      authorizedRead(apiBase, principalId, signal, async () => {
        const values = await listProjectSharedTasks(
          apiBase,
          project.slug,
          requestOptions(signal),
        );
        if (
          values.some(
            (value) =>
              value.project.localProjectId !== project.id ||
              value.project.localProjectSlug !== project.slug,
          )
        )
          throw new Error('Shared Tasks returned a different Project scope.');
        return values;
      }),
    retry: false,
    gcTime: 0,
  });
  const selected = tasks.data?.find(
    (candidate) => candidate.task.id === selectedTaskId,
  );
  const selectedKey = selected
    ? [
        selected.project.stationId,
        selected.project.localProjectId,
        selected.project.portableProjectId,
        selected.shareId,
        selected.task.id,
        selected.task.createdAt,
      ]
    : [undefined, undefined, undefined, undefined, undefined, undefined];
  const requirePublication = (expected: ProjectSharedTaskSummary) => {
    const current = client.getQueryData<ProjectSharedTaskSummary[]>([
      'guest-shared-tasks',
      ...projectKey,
    ]);
    if (
      !current?.some(
        (candidate) =>
          candidate.project.stationId === expected.project.stationId &&
          candidate.project.localProjectId ===
            expected.project.localProjectId &&
          candidate.project.localProjectSlug ===
            expected.project.localProjectSlug &&
          candidate.project.portableProjectId ===
            expected.project.portableProjectId &&
          candidate.shareId === expected.shareId &&
          candidate.task.id === expected.task.id &&
          candidate.task.createdAt === expected.task.createdAt,
      )
    )
      throw new GuestSharedScopeLost();
  };
  const historyPages = useInfiniteQuery({
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ProjectSharedTaskHistory) =>
      page.kind === 'available' && page.hasMore ? page.nextCursor : undefined,
    queryKey: ['guest-shared-task-history', ...projectKey, ...selectedKey],
    queryFn: ({ signal, pageParam }) => {
      if (!selected) throw new GuestSharedScopeLost();
      requirePublication(selected);
      return authorizedRead(apiBase, principalId, signal, async () => {
        const value = await readProjectSharedTaskHistory(
          apiBase,
          project.slug,
          selected.task.id,
          {
            ...requestOptions(signal),
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        );
        requirePublication(selected);
        return value;
      });
    },
    enabled: !!selected,
    retry: false,
    gcTime: 0,
  });
  const history = historyPages;
  const historyProjection = projectTaskHistory(history.data?.pages ?? []);
  const document = useQuery({
    queryKey: ['guest-shared-task-document', ...projectKey, ...selectedKey],
    queryFn: ({ signal }) => {
      if (!selected) throw new GuestSharedScopeLost();
      requirePublication(selected);
      return authorizedRead(apiBase, principalId, signal, async () => {
        const value = await readProjectSharedTaskDocument(
          apiBase,
          project.slug,
          selected.task.id,
          requestOptions(signal),
        );
        if (
          value.kind === 'snapshot' &&
          (value.project.id !== selected.project.localProjectId ||
            value.project.slug !== selected.project.localProjectSlug ||
            value.task.id !== selected.task.id ||
            value.task.createdAt !== selected.task.createdAt)
        )
          throw new GuestSharedScopeLost();
        requirePublication(selected);
        return value;
      });
    },
    enabled: !!selected,
    retry: false,
    gcTime: 0,
  });
  const publicationMissing =
    !!selectedTaskId && tasks.isSuccess && selected === undefined;
  const scopeLost =
    publicationMissing ||
    [tasks.error, history.error, document.error].some(
      (error) => error instanceof GuestSharedScopeLost,
    );
  useEffect(() => {
    if (scopeLost) onScopeLostRef.current();
  }, [scopeLost]);
  const taskUnshared =
    historyProjection.outcome === 'not-found' ||
    document.data?.kind === 'not-found';
  useEffect(() => {
    if (!taskUnshared) return;
    setSelectedTaskId(undefined);
    setNotice('This Task is no longer shared. Shared Tasks were refreshed.');
    void tasks.refetch();
  }, [taskUnshared, tasks]);
  useEffect(
    () => () => {
      for (const queryKey of [
        ['guest-shared-tasks', apiBase, principalId, project.id, project.slug],
        [
          'guest-shared-task-history',
          apiBase,
          principalId,
          project.id,
          project.slug,
        ],
        [
          'guest-shared-task-document',
          apiBase,
          principalId,
          project.id,
          project.slug,
        ],
      ]) {
        void client.cancelQueries({ queryKey });
        void client.removeQueries({ queryKey });
      }
    },
    [apiBase, client, principalId, project.id, project.slug],
  );

  const refreshTasks = () => {
    setNotice(undefined);
    void tasks.refetch();
  };
  if (scopeLost) return null;
  if (tasks.isPending)
    return <SkeletonList count={1} label="Reading shared Tasks" />;
  if (tasks.isError)
    return (
      <div className="account-entry__shared-state" role="alert">
        <p>Shared Tasks are unavailable.</p>
        <Button onClick={() => void tasks.refetch()}>Try again</Button>
      </div>
    );

  return (
    <section
      className="account-entry__shared-tasks"
      aria-labelledby="shared-tasks-title"
    >
      <div hidden={!!selected}>
        <div className="account-entry__shared-tasks-heading">
          <h4 id="shared-tasks-title">Shared Tasks</h4>
          <Button onClick={refreshTasks}>Refresh shared Tasks</Button>
        </div>
        {notice && <p role="status">{notice}</p>}
        {tasks.data.length === 0 ? (
          <Empty
            variant="compact"
            label="Tasks are not currently shared from this Project."
          />
        ) : (
          <ul className="account-entry__shared-task-list">
            {tasks.data.map((summary: ProjectSharedTaskSummary) => (
              <li key={summary.shareId}>
                <div>
                  <strong>{summary.task.title}</strong>
                  <small>{taskStatusLabel(summary.task.status)}</small>
                </div>
                <Button
                  ref={(element) => {
                    if (element)
                      taskTriggers.current.set(summary.task.id, element);
                    else taskTriggers.current.delete(summary.task.id);
                  }}
                  onClick={() => {
                    setNotice(undefined);
                    setSelectedTaskId(summary.task.id);
                    setTab('Chat');
                  }}
                >
                  Read shared Task
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected && (
        <section
          className="account-entry__shared-task-detail task-room-guest"
          aria-label={`${selected.task.title} shared content`}
        >
          <div className="account-entry__shared-task-heading">
            <h5>{selected.task.title}</h5>
            <IconButton
              aria-label="Refresh shared Tasks"
              onClick={refreshTasks}
            >
              <RefreshGlyph />
            </IconButton>
            <IconButton
              aria-label="Close"
              onClick={() => {
                const taskId = selected.task.id;
                setSelectedTaskId(undefined);
                requestAnimationFrame(() =>
                  taskTriggers.current.get(taskId)?.focus(),
                );
              }}
            >
              <CloseGlyph />
            </IconButton>
          </div>
          <div
            className="task-room-tabs"
            role="tablist"
            aria-label="Shared Task views"
          >
            {['Chat', 'Brief'].map((name) => (
              <Button
                key={name}
                role="tab"
                tabIndex={tab === name ? 0 : -1}
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                onKeyDown={(event) => {
                  if (
                    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'Chat'
                      : event.key === 'End'
                        ? 'Brief'
                        : name === 'Chat'
                          ? 'Brief'
                          : 'Chat';
                  setTab(next);
                  const tabs =
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                      '[role="tab"]',
                    );
                  tabs?.[next === 'Chat' ? 0 : 1]?.focus();
                }}
              >
                {name}
              </Button>
            ))}
          </div>
          {tab === 'Chat' && (
            <SharedTaskHistoryList
              records={historyProjection.records}
              readable={
                !scopeLost && tasks.isSuccess && !tasks.isFetching && !!selected
              }
              pending={history.isPending}
              failed={history.isError}
              outcome={historyProjection.outcome}
              hasEarlier={history.hasNextPage}
              loadingEarlier={history.isFetchingNextPage}
              onLoadEarlier={() => void history.fetchNextPage()}
              onRetry={() =>
                void (history.isFetchNextPageError
                  ? history.fetchNextPage()
                  : history.refetch())
              }
            />
          )}
          {tab === 'Brief' && document.isPending && (
            <SkeletonList count={2} label="Reading shared document" />
          )}
          {tab === 'Brief' && document.isError && (
            <p role="alert">Shared document is unavailable.</p>
          )}
          {document.data?.kind === 'snapshot' ? (
            <div
              className="account-entry__shared-document task-room-brief-rendered"
              hidden={tab !== 'Brief'}
            >
              <LazyMarkdown
                skipHtml
                loadingProjection={<SkeletonBlock label="Loading brief" />}
              >
                {document.data.text}
              </LazyMarkdown>
            </div>
          ) : document.data && tab === 'Brief' ? (
            <p role="status">{documentState(document.data.kind)}</p>
          ) : null}
        </section>
      )}
    </section>
  );
}

import '../TaskWorkspaceView.css';
