import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button } from '../components/Button';
import {
  backgroundTaskElapsedMs,
  TaskRow,
} from '../components/chat-dock/backgroundTaskRows';
import { Empty, ErrorState, SkeletonBlock } from '../components/state';
import { useApiBase } from '../contexts/ApiBaseContext';
import type { ChatUIState } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  type BackgroundTaskEntry,
  backgroundTasksStore,
} from '../contexts/background-tasks-store';
import {
  childWorkGlobalStore,
  type GlobalChildWorkState,
} from '../contexts/child-work-global-store';
import { useNavigation } from '../contexts/NavigationContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { ensureOrchestrationEventStream } from '../hooks/orchestration/ensureOrchestrationEventStream';
import {
  useChatBackgroundTasks,
  useChatStoreKey,
} from '../hooks/useBackgroundTasks';
import { ChildWorkRow } from './agents/ChildWorkRow';
import {
  type ChildWorkListView,
  type ChildWorkRowModel,
  type ChildWorkScope,
  type ChildWorkSelectorInput,
  emptyStateFor,
  selectChatChildWork,
  selectGlobalChildWork,
  subagentNoticeFor,
  threadInChat,
  uniqueChatKey,
} from './agents/childWorkSelectors';
import './agents/AgentsWorkspacePane.css';

/**
 * The Agents pane (#2050, #2459): the work the conversation on screen set
 * running, or every conversation's child work.
 *
 * "This conversation" reads the chat's tool calls and delegated tasks from
 * the background-tasks store through `TaskRow` — the SAME list, live and
 * bounded, that the dock's badge counts and the sheet shows — and the chat's
 * engine subagents from the child-work contract through `ChildWorkRow`.
 * "All" reads every delegate from the session read model and every engine
 * subagent from the window-wide child-work registry.
 *
 * One bridge, and it retires itself: a running engine subagent whose child
 * item carries the pre-contract per-task stop seam (Claude's legacy path),
 * on an engine whose `subagentControl` cell is not yet `wired`, renders
 * through `TaskRow` in "This conversation" so its shipped Stop is not lost.
 * `ChildWorkRow` renders a Stop only from a wired cell; once the cell is
 * wired, the bridge selects nothing.
 *
 * The pane registers this authority's `QueryClient` with the orchestration
 * stream, as `ChatDock` does (#2307), so session read-model facts refresh
 * "All" even where no dock is mounted.
 *
 * Scope is display state, not pane identity: the occurrence still binds
 * nothing, and the choice is a per-device preference.
 */

const SCOPE_STORAGE_KEY = 'station.agents-pane.scope';
const EMPTY_SESSIONS: OrchestrationSessionSummary[] = [];

function readScope(): ChildWorkScope | undefined {
  try {
    const raw = localStorage.getItem(SCOPE_STORAGE_KEY);
    return raw === 'chat' || raw === 'all' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writeScope(scope: ChildWorkScope): void {
  try {
    localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    /* A remembered scope is a convenience; storage failure must not break the pane. */
  }
}

/**
 * The chat facts the selectors read, as a value that changes only when THEY
 * change — the chat store notifies on every streamed token, and the pane must
 * not re-derive on each one.
 */
function chatIndexSignature(chats: Record<string, ChatUIState>): string {
  return Object.entries(chats)
    .map(([key, chat]) =>
      [
        key,
        chat.currentSessionId ?? '',
        chat.conversationId ?? '',
        chat.orchestrationProvider ?? '',
        chat.title ?? '',
      ].join('\u0000'),
    )
    .join('\u0001');
}

const readChatIndexSignature = () =>
  chatIndexSignature(activeChatsStore.getSnapshot());

/** This Station's partition of the window-wide child-work registry (D1). */
function useChildWorkPartition(apiBase: string): GlobalChildWorkState {
  const read = useCallback(
    () => childWorkGlobalStore.getPartition(apiBase),
    [apiBase],
  );
  return useSyncExternalStore(childWorkGlobalStore.subscribe, read, read);
}

function useChildWorkInput(
  sessions: readonly OrchestrationSessionSummary[],
  global: GlobalChildWorkState,
): ChildWorkSelectorInput {
  const tasks = useSyncExternalStore(
    backgroundTasksStore.subscribe,
    backgroundTasksStore.getSnapshot,
  );
  const chatSignature = useSyncExternalStore(
    activeChatsStore.subscribe,
    readChatIndexSignature,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatSignature is the change signal for the chat-store reads below.
  return useMemo(
    () => ({
      sessions,
      engine: global.registry,
      settledObservedAt: global.settledObservedAt,
      delegateParentOf: (threadId: string) => tasks.delegateParents[threadId],
      // Declines an ambiguous match (R-B) rather than taking the first chat.
      chatKeyFor: (threadId: string) =>
        uniqueChatKey(activeChatsStore.getSnapshot(), threadId),
      chatFacts: (chatKey: string) => {
        const chat = activeChatsStore.getSnapshot()[chatKey];
        return { provider: chat?.orchestrationProvider, title: chat?.title };
      },
      toolCallStartedAt: (toolCallId: string) =>
        tasks.entries[toolCallId]?.startedAt,
    }),
    [sessions, global, tasks, chatSignature],
  );
}

/** The engine subagent a provider-task card stands for, in the global registry. */
function engineItemFor(
  global: GlobalChildWorkState,
  entry: BackgroundTaskEntry,
) {
  return global.registry.items[
    JSON.stringify(['engine-subagent', entry.sessionThreadId ?? '', entry.id])
  ];
}

export function AgentsWorkspacePane() {
  const activeChat = useNavigation((state) => state.activeChat);
  // Navigation carries the chat's DURABLE id; the stores are keyed by the
  // session key. `useChatStoreKey` is the store's own resolution.
  const chatKey = useChatStoreKey(activeChat ?? null);
  const [storedScope, setStoredScope] = useState(readScope);
  // No chat on screen: there is no "this conversation" to show.
  const scope: ChildWorkScope = chatKey ? (storedScope ?? 'chat') : 'all';
  const tools = useChatBackgroundTasks(scope === 'chat' ? chatKey : null);
  const sessionsQuery = useOrchestrationSessionsQuery();
  const sessions = sessionsQuery.data ?? EMPTY_SESSIONS;
  const { apiBase } = useApiBase();
  const global = useChildWorkPartition(apiBase);
  const input = useChildWorkInput(sessions, global);
  const showSurface = useShowSurface();
  const [now, setNow] = useState(() => Date.now());

  // #2307, the mechanism ChatDock uses: register this authority's client
  // with the stream so read-model facts (a new delegate's first turn) reach
  // the sessions query this pane reads, with or without a dock mounted.
  const queryClient = useQueryClient();
  useEffect(
    () => ensureOrchestrationEventStream(apiBase, queryClient),
    [apiBase, queryClient],
  );

  // D2: a cached session list can predate work that started while this pane
  // was closed; the query does not refetch on mount, and the stream's
  // snapshot does not refresh it. Re-read it on mount, and again whenever
  // All — the scope that lists every delegate from it — is chosen.
  const refetchSessions = useRef(sessionsQuery.refetch);
  refetchSessions.current = sessionsQuery.refetch;
  const refetchedOnMount = useRef(false);
  useEffect(() => {
    if (scope !== 'all' && refetchedOnMount.current) return;
    refetchedOnMount.current = true;
    void refetchSessions.current?.();
  }, [scope]);

  const chooseScope = (next: ChildWorkScope) => {
    setStoredScope(next);
    writeScope(next);
  };

  const view: ChildWorkListView = useMemo(
    () =>
      scope === 'chat' && chatKey
        ? selectChatChildWork(input, chatKey)
        : selectGlobalChildWork(input),
    [input, scope, chatKey],
  );

  // The Claude Stop bridge (see the module comment): only a RUNNING child
  // whose own item carries the pre-contract stop seam, on an engine whose
  // cell does not yet render one. A child with no seam (a Codex subagent)
  // is never bridged, and one the registry already settled is not shown
  // running beside its own finished row.
  const bridged: BackgroundTaskEntry[] =
    scope === 'chat'
      ? tools.running.filter((entry) => {
          if (entry.source !== 'provider-task') return false;
          const item = engineItemFor(global, entry);
          return (
            item?.status === 'running' &&
            item.controls?.stop === 'provider-task-stop' &&
            !view.running.some(
              (row) =>
                row.key ===
                  JSON.stringify([
                    'engine-subagent',
                    item.reporterThreadId,
                    item.childId,
                  ]) && row.stop,
            )
          );
        })
      : [];
  const bridgedKeys = new Set(
    bridged.map((entry) => rowKey(entry.sessionThreadId ?? '', entry.id)),
  );
  const childRunning = view.running.filter(
    (row) =>
      !(
        row.item.producer === 'engine-subagent' &&
        bridgedKeys.has(rowKey(row.item.reporterThreadId, row.item.childId))
      ),
  );

  // A tool call that spawned a subagent is shown as that subagent.
  const spawningToolCalls = new Set(
    [...view.running, ...view.finished]
      .map((row) => row.item.parent?.toolCallId)
      .filter((id): id is string => Boolean(id)),
  );
  // Per chat, tool calls AND delegated tasks are the background-tasks
  // store's cards, exactly as the badge and the sheet select them.
  const isTaskRow = (entry: BackgroundTaskEntry) =>
    entry.source === 'delegate-session' ||
    (entry.source === 'tool-event' && !spawningToolCalls.has(entry.id));
  const taskRunning =
    scope === 'chat' ? [...tools.running.filter(isTaskRow), ...bridged] : [];
  const taskFinished = scope === 'chat' ? tools.finished.filter(isTaskRow) : [];

  const runningCount = taskRunning.length + childRunning.length;
  const finishedCount = taskFinished.length + view.finished.length;
  const finishedHasSubagents = view.finished.some(
    (row) => row.item.producer === 'engine-subagent',
  );

  // One 1s ticker for every Running row's elapsed time, only while mounted.
  useEffect(() => {
    if (runningCount === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runningCount]);

  // One session index per input, not one per reporter (R-D).
  const chatMembership = useMemo(
    () => (chatKey ? threadInChat(input, chatKey) : undefined),
    [input, chatKey],
  );
  const subagentNotice =
    scope === 'chat' && chatKey
      ? subagentNoticeFor({
          provider:
            activeChatsStore.getSnapshot()[chatKey]?.orchestrationProvider,
          // D4: the selector's own membership rule, so a continuation
          // session's refusal (resolved through its conversation) counts.
          observed: Object.entries(global.observability)
            .filter(([threadId]) => chatMembership?.(threadId))
            .map(([, observed]) => observed),
        })
      : undefined;

  const openSession = (threadId: string) =>
    showSurface('activity', { session: threadId });

  const childRow = (row: ChildWorkRowModel) => (
    <ChildWorkRow
      key={row.key}
      row={row}
      now={now}
      showProvenance={scope === 'all'}
      onOpenSession={openSession}
    />
  );

  // "All" reads delegates from the session read model. Until it answers, or
  // when it cannot, an empty list is not "no agent work".
  const readModelPending = scope === 'all' && sessionsQuery.data === undefined;
  const readModelFailed = readModelPending && sessionsQuery.isError;
  // D3: a failed refresh behind cached data — the list shown may be stale.
  const readModelStale =
    scope === 'all' && !readModelPending && sessionsQuery.isError === true;
  const retry = () => void sessionsQuery.refetch();

  const nothing = runningCount === 0 && finishedCount === 0;
  let body: ReactNode;
  if (nothing && (readModelFailed || readModelStale))
    body = (
      <ErrorState
        variant="compact"
        title={
          readModelFailed
            ? 'Could not load agent work'
            : 'Could not refresh agent work'
        }
        description="Delegated tasks come from this Station's session list, which did not answer."
        action={
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        }
      />
    );
  else if (nothing && readModelPending)
    body = <SkeletonBlock count={3} label="Loading agent work" />;
  else if (nothing)
    body = (
      <Empty
        variant="compact"
        {...emptyStateFor({
          scope,
          hasChat: Boolean(chatKey),
          subagentNotice,
        })}
      />
    );
  else
    body = (
      <div className="background-tasks-sheet__body">
        {subagentNotice && (
          <p className="agents-pane__note">
            {subagentNotice.label}
            {subagentNotice.description
              ? ` — ${subagentNotice.description}`
              : ''}
          </p>
        )}
        {readModelFailed && (
          <p className="agents-pane__note" role="status">
            Delegated tasks could not be loaded.{' '}
            <Button size="sm" variant="link" onClick={retry}>
              Try again
            </Button>
          </p>
        )}
        {readModelStale && (
          <p className="agents-pane__note" role="status">
            Delegated tasks may be out of date: the last refresh failed.{' '}
            <Button size="sm" variant="link" onClick={retry}>
              Try again
            </Button>
          </p>
        )}
        {readModelPending && !readModelFailed && (
          <SkeletonBlock count={1} label="Loading delegated tasks" />
        )}
        {runningCount > 0 && (
          <section className="background-tasks-sheet__section">
            <h3 className="background-tasks-sheet__section-label">
              Running ({runningCount})
            </h3>
            <ul className="background-tasks-sheet__list">
              {taskRunning.map((entry) => (
                <TaskRow
                  key={entry.id}
                  entry={entry}
                  elapsedMs={backgroundTaskElapsedMs(entry, now)}
                  onOpenTranscript={openSession}
                />
              ))}
              {childRunning.map(childRow)}
            </ul>
          </section>
        )}
        {finishedCount > 0 && (
          <section className="background-tasks-sheet__section">
            <h3 className="background-tasks-sheet__section-label">
              <span>Finished ({finishedCount})</span>
              {finishedHasSubagents && (
                <span className="agents-pane__section-qualifier">
                  subagents: since this window connected
                </span>
              )}
            </h3>
            <ul className="background-tasks-sheet__list">
              {view.finished.map(childRow)}
              {taskFinished.map((entry) => (
                <TaskRow
                  key={entry.id}
                  entry={entry}
                  elapsedMs={backgroundTaskElapsedMs(entry, now)}
                  outcomeChip={entry.state}
                  onOpenTranscript={openSession}
                />
              ))}
            </ul>
            {view.finishedOmitted > 0 && (
              <p className="agents-pane__note">
                {view.finishedOmitted} older not shown.
              </p>
            )}
          </section>
        )}
      </div>
    );

  return (
    <div className="agents-pane">
      <fieldset className="agents-pane__scope-actions">
        <legend className="sr-only">Show</legend>
        <Button
          size="sm"
          variant="ghost"
          active={scope === 'chat'}
          aria-pressed={scope === 'chat'}
          disabled={!chatKey}
          onClick={() => chooseScope('chat')}
        >
          This conversation
        </Button>
        <Button
          size="sm"
          variant="ghost"
          active={scope === 'all'}
          aria-pressed={scope === 'all'}
          onClick={() => chooseScope('all')}
        >
          All
        </Button>
      </fieldset>
      {body}
    </div>
  );
}

function rowKey(threadId: string, childId: string) {
  return `${threadId}\u0000${childId}`;
}
