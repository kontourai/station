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
  watchProjectSharedTaskHistory,
} from '@kontourai/station-sdk/project-shared-tasks';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { LazyMarkdown } from '../../components/chat/LazyMarkdown';
import {
  projectTaskHistory,
  SharedTaskHistoryList,
} from '../../components/conversation/SharedTaskHistoryList';
import { IconButton } from '../../components/IconButton';
import { CloseGlyph, RefreshGlyph } from '../../components/icons/Glyph';
import {
  PageFrameActions,
  useIsPageFramed,
  usePageHeader,
} from '../../components/page-frame';
import { Empty, SkeletonBlock, SkeletonList } from '../../components/state';
import { nextTabIndex } from '../../utils/tab-navigation';
import { GuestTaskReply } from './GuestTaskReply';
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
  initialShareId,
  onSelectShare,
  onScopeLost,
}: {
  apiBase: string;
  principalId: string;
  project: { id: string; slug: string; name?: string };
  initialShareId?: string;
  onSelectShare?: (shareId?: string) => void;
  onScopeLost: () => void;
}) {
  const client = useQueryClient();
  const [manualTaskId, setManualTaskId] = useState<string>();
  const [selectedShareId, setSelectedShareId] = useState(initialShareId);
  const selectShare = useCallback(
    (shareId?: string) => {
      setSelectedShareId(shareId);
      if (!shareId) setManualTaskId(undefined);
      onSelectShare?.(shareId);
    },
    [onSelectShare],
  );
  const [tab, setTab] = useState(initialShareId ? 'Brief' : 'Chat');
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
  const selected = tasks.data?.find((candidate) =>
    manualTaskId
      ? candidate.task.id === manualTaskId
      : candidate.shareId === selectedShareId,
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
            expectedShareId: selected.shareId,
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
  const refreshHistory = historyPages.refetch;
  useEffect(() => {
    if (!selected || tab !== 'Chat' || !historyPages.isSuccess) return;
    const controller = new AbortController();
    const stream = watchProjectSharedTaskHistory(
      apiBase,
      selected,
      () => {
        if (!controller.signal.aborted) void refreshHistory();
      },
      requestOptions(controller.signal),
    );
    return () => {
      controller.abort();
      stream.close();
    };
  }, [apiBase, selected, tab, refreshHistory, historyPages.isSuccess]);
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
          { ...requestOptions(signal), expectedShareId: selected.shareId },
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
    !!selectedShareId && tasks.isSuccess && selected === undefined;
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
    selectShare();
    setNotice('This Task is no longer shared. Shared Tasks were refreshed.');
    void tasks.refetch();
  }, [taskUnshared, tasks, selectShare]);
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
    if (selected) {
      void history.refetch();
      void document.refetch();
    }
  };
  const framedTask =
    useIsPageFramed() &&
    !!initialShareId &&
    !!selected &&
    !scopeLost &&
    tasks.isSuccess;
  usePageHeader(
    framedTask
      ? { title: selected.task.title, eyebrow: project.name, subtitle: '' }
      : null,
  );
  if (scopeLost) return null;
  if (tasks.isPending)
    return <SkeletonList count={1} label="Reading shared Tasks" />;
  if (tasks.isError)
    return (
      <div className="account-entry__shared-state" role="alert">
        <p>Shared Tasks are unavailable.</p>
        <Button onClick={() => void tasks.refetch()}>Retry</Button>
      </div>
    );

  const refreshAction = (
    <IconButton aria-label="Refresh shared Tasks" onClick={refreshTasks}>
      <RefreshGlyph />
    </IconButton>
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
                    setManualTaskId(summary.task.id);
                    selectShare(summary.shareId);
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
          {framedTask ? (
            <PageFrameActions>{refreshAction}</PageFrameActions>
          ) : (
            <div className="account-entry__shared-task-heading">
              <h5>{selected.task.title}</h5>
              {refreshAction}
              <IconButton
                aria-label="Close"
                onClick={() => {
                  const taskId = selected.task.id;
                  selectShare();
                  requestAnimationFrame(() =>
                    taskTriggers.current.get(taskId)?.focus(),
                  );
                }}
              >
                <CloseGlyph />
              </IconButton>
            </div>
          )}
          <div
            className="task-room-tabs"
            role="tablist"
            aria-label="Shared Task views"
          >
            {(framedTask ? ['Brief', 'Chat'] : ['Chat', 'Brief']).map(
              (name, index, names) => (
                <Button
                  key={name}
                  role="tab"
                  tabIndex={tab === name ? 0 : -1}
                  aria-selected={tab === name}
                  onClick={() => setTab(name)}
                  onKeyDown={(event) => {
                    const next = nextTabIndex(index, names.length, event.key);
                    if (next === null) return;
                    event.preventDefault();
                    setTab(names[next]);
                    const tabs =
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      );
                    tabs?.[next]?.focus();
                  }}
                >
                  {name}
                </Button>
              ),
            )}
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
          <GuestTaskReply
            key={selected.shareId}
            apiBase={apiBase}
            principalId={principalId}
            shared={selected}
            onSent={() => {
              setTab('Chat');
              void history.refetch();
            }}
          />
        </section>
      )}
    </section>
  );
}

import '../TaskWorkspaceView.css';
