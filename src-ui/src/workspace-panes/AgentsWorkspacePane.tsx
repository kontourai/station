import { childWorkKindOf } from '@kontourai/station-contracts/child-work';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
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
import { DisclosureToggle } from '../components/DisclosureToggle';
import { Empty, ErrorState, SkeletonBlock } from '../components/state';
import { useAgents } from '../contexts/AgentsContext';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useClientBootstrapReadiness } from '../contexts/AuthorityPersistenceContext';
import {
  activeChatDurableId,
  type ChatUIState,
} from '../contexts/active-chats-state';
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
import { useActiveStationName } from '../hooks/useActiveStationName';
import {
  useChatBackgroundTasks,
  useChatStoreKey,
} from '../hooks/useBackgroundTasks';
import { useElapsedClock } from '../hooks/useElapsedClock';
import { sessionIconAgent } from '../utils/sessionDisplay';
import { ChildWorkRow } from './agents/ChildWorkRow';
import {
  type AllChatsGroup,
  type AllChatsRow,
  type ChildWorkListView,
  type ChildWorkRowModel,
  type ChildWorkScope,
  type ChildWorkSelectorInput,
  countWork,
  emptyStateFor,
  isListedTaskCard,
  selectAllChatsWork,
  selectChatChildWork,
  selectGlobalChildWork,
  subagentNoticeFor,
  threadInChat,
  uniqueChatKey,
  workCountLabel,
} from './agents/childWorkSelectors';
import './agents/AgentsWorkspacePane.css';

/**
 * The Agents pane (#2050, #2459): the work the chat on screen set running,
 * or every chat's.
 *
 * "This chat" reads the chat's tool calls and delegated tasks from the
 * background-tasks store through `TaskRow` — the SAME list, live and
 * bounded, that the dock's badge counts and the sheet shows — and the chat's
 * engine subagents from the child-work contract through `ChildWorkRow`.
 * "All chats" reads every delegate from the session read model, every engine
 * subagent from the window-wide child-work registry, and every chat's
 * tool-call and delegated-task cards from the same background-tasks store,
 * so it lists at least what any one chat lists. It groups that work by chat.
 * The store holds what this window has seen: tool calls from when it
 * connected, and finished ones only while their chat is open.
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
const COLLAPSED_STORAGE_KEY = 'station.agents-pane.collapsed-chats';
/** Remembered collapsed chats, newest last; older ones are forgotten. */
const COLLAPSED_LIMIT = 100;
const EMPTY_SESSIONS: OrchestrationSessionSummary[] = [];

function readCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? '[]',
    );
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeCollapsed(keys: readonly string[]): void {
  try {
    localStorage.setItem(
      COLLAPSED_STORAGE_KEY,
      JSON.stringify(keys.slice(-COLLAPSED_LIMIT)),
    );
  } catch {
    /* Remembered collapse is a convenience; storage failure must not break the pane. */
  }
}

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
        chat.projectName ?? '',
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
  apiBase: string,
): {
  input: ChildWorkSelectorInput;
  tasks: ReturnType<typeof backgroundTasksStore.getSnapshot>;
} {
  const readTasks = useCallback(
    () => backgroundTasksStore.getSnapshot(apiBase),
    [apiBase],
  );
  const tasks = useSyncExternalStore(
    backgroundTasksStore.subscribe,
    readTasks,
    readTasks,
  );
  const chatSignature = useSyncExternalStore(
    activeChatsStore.subscribe,
    readChatIndexSignature,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatSignature is the change signal for the chat-store reads below.
  const input = useMemo(
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
        return {
          provider: chat?.orchestrationProvider,
          title: chat?.title,
          project: chat?.projectName,
          durableId: activeChatDurableId(chatKey, chat),
        };
      },
      reporterChatOf: (threadId: string) => tasks.providerReporters?.[threadId],
      toolCallStartedAt: (toolCallId: string) =>
        tasks.entries[toolCallId]?.startedAt,
    }),
    [sessions, global, tasks, chatSignature],
  );
  return { input, tasks };
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
  const { apiBase } = useApiBase();
  const stationName = useActiveStationName();
  const tools = useChatBackgroundTasks(
    scope === 'chat' ? chatKey : null,
    apiBase,
  );
  const agents = useAgents();
  const sessionsQuery = useOrchestrationSessionsQuery();
  const sessions = sessionsQuery.data ?? EMPTY_SESSIONS;
  const global = useChildWorkPartition(apiBase);
  const { input, tasks: tasksState } = useChildWorkInput(
    sessions,
    global,
    apiBase,
  );
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const showSurface = useShowSurface();

  // #2307, the mechanism ChatDock uses: register this authority's client
  // with the stream so read-model facts (a new delegate's first turn) reach
  // the sessions query this pane reads, with or without a dock mounted.
  const queryClient = useQueryClient();
  const bootstrap = useClientBootstrapReadiness();
  const streamAuthorityKey = bootstrap.authorityKey;
  useEffect(() => {
    if (bootstrap.status !== 'settled') return;
    return ensureOrchestrationEventStream(
      apiBase,
      queryClient,
      streamAuthorityKey,
      false,
      bootstrap.sharedRealtime,
    );
  }, [
    apiBase,
    queryClient,
    streamAuthorityKey,
    bootstrap.status,
    bootstrap.sharedRealtime,
  ]);

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
    isListedTaskCard(entry, spawningToolCalls);
  const taskRunning =
    scope === 'chat' ? [...tools.running.filter(isTaskRow), ...bridged] : [];
  const taskFinished = scope === 'chat' ? tools.finished.filter(isTaskRow) : [];

  const allChats = useMemo(
    () =>
      scope === 'all'
        ? selectAllChatsWork(
            input,
            view,
            Object.values(tasksState.entries),
            chatKey ?? undefined,
          )
        : undefined,
    [scope, input, view, tasksState, chatKey],
  );

  const runningRows: AllChatsRow[] = allChats
    ? allChats.groups.flatMap((group) => group.running)
    : [
        ...taskRunning.map((entry) => {
          // A bridged card stands for an engine child; count it as one.
          const item =
            entry.source === 'provider-task'
              ? engineItemFor(global, entry)
              : undefined;
          return {
            kind: 'task' as const,
            entry,
            ...(item ? { workKind: childWorkKindOf(item) } : {}),
          };
        }),
        ...childRunning.map((row) => ({ kind: 'child' as const, row })),
      ];
  const finishedRows: AllChatsRow[] = allChats
    ? allChats.groups.flatMap((group) => group.finished)
    : [
        ...view.finished.map((row) => ({ kind: 'child' as const, row })),
        ...taskFinished.map((entry) => ({ kind: 'task' as const, entry })),
      ];
  const runningCount = runningRows.length;
  const finishedCount = finishedRows.length;
  const finishedOmitted = allChats?.finishedOmitted ?? view.finishedOmitted;

  // The shared elapsed clock for every Running row, only while one runs.
  const now = useElapsedClock(runningCount > 0);

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
    showSurface('chat', { session: threadId });

  const sessionByThread = useMemo(
    () => new Map(sessions.map((session) => [session.threadId, session])),
    [sessions],
  );
  const delegateIcon = (threadId: string | undefined) => {
    const session = threadId ? sessionByThread.get(threadId) : undefined;
    return session ? sessionIconAgent(session, agents) : undefined;
  };
  const taskRow = (entry: BackgroundTaskEntry) => (
    <TaskRow
      key={entry.id}
      entry={entry}
      agent={delegateIcon(entry.delegateThreadId)}
      provider={
        sessionByThread.get(
          entry.sessionThreadId ?? entry.delegateThreadId ?? '',
        )?.provider
      }
      elapsedMs={backgroundTaskElapsedMs(entry, now)}
      // Every row in this pane carries its status, as `ChildWorkRow` does:
      // All mixes running and finished work in one chat's group.
      outcomeChip={entry.state}
      onOpenTranscript={openSession}
    />
  );
  const childRow = (row: ChildWorkRowModel, showProvenance: boolean) => (
    <ChildWorkRow
      key={row.key}
      row={row}
      stationName={stationName}
      now={now}
      agent={
        row.item.producer === 'station-delegate'
          ? delegateIcon(row.item.childId)
          : undefined
      }
      showProvenance={showProvenance}
      onOpenSession={openSession}
      onOpenChild={(item, title) => {
        if (item.producer === 'station-delegate') {
          const handle = item.result?.handle;
          const sessionId =
            handle?.kind === 'session' ? handle.threadId : item.childId;
          showSurface(
            'chat',
            item.reporterThreadId === sessionId
              ? { session: sessionId }
              : {
                  session: item.reporterThreadId,
                  childSessionId: sessionId,
                  childTitle: title,
                },
          );
        } else
          showSurface('chat', {
            session: item.reporterThreadId,
            childId: item.childId,
            childTitle: title,
          });
      }}
    />
  );
  // Inside a chat's group the chat is the heading; only work from outside
  // any chat says where it came from.
  const workRow = (row: AllChatsRow, showProvenance: boolean) =>
    row.kind === 'task'
      ? taskRow(row.entry)
      : childRow(row.row, showProvenance);

  const toggleGroup = (key: string) =>
    setCollapsed((current) => {
      const next = current.includes(key)
        ? current.filter((entry) => entry !== key)
        : [...current, key];
      writeCollapsed(next);
      return next;
    });

  // "All" reads delegates from the session read model. Until it answers, or
  // when it cannot, an empty list is not "no agent work".
  const readModelPending = scope === 'all' && sessionsQuery.data === undefined;
  const readModelFailed = readModelPending && sessionsQuery.isError;
  // D3: a failed refresh behind cached data — the list shown may be stale.
  const readModelStale =
    scope === 'all' && !readModelPending && sessionsQuery.isError === true;
  const retry = () => void sessionsQuery.refetch();
  const toolHistoryLimited =
    scope === 'chat'
      ? tools.toolHistoryLimited === true
      : Object.keys(tasksState.limitedToolChats ?? {}).length > 0;

  const sectionLabel = (label: string, rows: readonly AllChatsRow[]) => (
    <h3 className="background-tasks-sheet__section-label">
      <span>{label}</span>{' '}
      <span className="agents-pane__section-qualifier">
        · {workCountLabel(countWork(rows))}
        {scope === 'chat' && toolHistoryLimited && label === 'Running'
          ? ' shown'
          : ''}
      </span>
    </h3>
  );

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
            Retry
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
              Retry
            </Button>
          </p>
        )}
        {readModelStale && (
          <p className="agents-pane__note" role="status">
            Delegated tasks may be out of date: the last refresh failed.{' '}
            <Button size="sm" variant="link" onClick={retry}>
              Retry
            </Button>
          </p>
        )}
        {readModelPending && !readModelFailed && (
          <SkeletonBlock count={1} label="Loading delegated tasks" />
        )}
        {toolHistoryLimited && (
          <p className="agents-pane__note" role="status">
            Older tool rows are omitted. Running counts cover retained rows.
          </p>
        )}
        {allChats ? (
          <>
            <p className="agents-pane__summary">
              {runningCount > 0 && (
                <span>Running: {workCountLabel(countWork(runningRows))}</span>
              )}
              {finishedCount > 0 && (
                <span>Finished: {workCountLabel(countWork(finishedRows))}</span>
              )}
            </p>
            {allChats.groups.map((group) => (
              <ChatWorkGroup
                key={group.key}
                group={group}
                collapsed={collapsed.includes(group.key)}
                onToggle={() => toggleGroup(group.key)}
                onOpen={openSession}
              >
                {group.running.map((row) => workRow(row, group.outsideChat))}
                {group.finished.map((row) => workRow(row, group.outsideChat))}
              </ChatWorkGroup>
            ))}
            {finishedOmitted > 0 && (
              <p className="agents-pane__note">
                {finishedOmitted} older delegated tasks not shown.
              </p>
            )}
            {[...runningRows, ...finishedRows].some(
              (row) => row.kind === 'task' && row.entry.kind === 'tool',
            ) && (
              <p className="agents-pane__note">
                Tool calls are listed from when this window opened.
              </p>
            )}
          </>
        ) : (
          <>
            {runningCount > 0 && (
              <section className="background-tasks-sheet__section">
                {sectionLabel('Running', runningRows)}
                <ul className="background-tasks-sheet__list">
                  {runningRows.map((row) => workRow(row, false))}
                </ul>
              </section>
            )}
            {finishedCount > 0 && (
              <section className="background-tasks-sheet__section">
                {sectionLabel('Finished', finishedRows)}
                <ul className="background-tasks-sheet__list">
                  {finishedRows.map((row) => workRow(row, false))}
                </ul>
                {finishedOmitted > 0 && (
                  <p className="agents-pane__note">
                    {finishedOmitted} older not shown.
                  </p>
                )}
              </section>
            )}
          </>
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
          This chat
        </Button>
        <Button
          size="sm"
          variant="ghost"
          active={scope === 'all'}
          aria-pressed={scope === 'all'}
          onClick={() => chooseScope('all')}
        >
          All chats
        </Button>
      </fieldset>
      {body}
    </div>
  );
}

/**
 * One chat's work in "All chats": a collapsible group whose title opens the
 * chat. Work started outside any chat has no chat to open.
 */
function ChatWorkGroup({
  group,
  collapsed,
  onToggle,
  onOpen,
  children,
}: {
  group: AllChatsGroup;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (threadId: string) => void;
  children: ReactNode;
}) {
  const listId = `agents-pane-group-${useId()}`;
  const title = group.outsideChat
    ? 'Started outside a chat'
    : (group.title ?? 'Untitled chat');
  const counts = [
    ...(group.running.length > 0 ? [`${group.running.length} running`] : []),
    ...(group.finished.length > 0 ? [`${group.finished.length} finished`] : []),
  ].join(' · ');
  const openThreadId = group.openThreadId;
  return (
    <section
      className="background-tasks-sheet__section agents-pane__group"
      data-current={group.current ? 'true' : undefined}
    >
      <div className="agents-pane__group-header">
        <DisclosureToggle
          expanded={!collapsed}
          onToggle={onToggle}
          controls={collapsed ? undefined : listId}
          className="agents-pane__group-toggle"
        >
          <span className="sr-only">
            {collapsed ? 'Expand' : 'Collapse'} {title}
          </span>
        </DisclosureToggle>
        <span className="agents-pane__group-text">
          <h3 className="agents-pane__group-heading">
            {openThreadId && !group.outsideChat ? (
              <button
                type="button"
                className="agents-pane__group-title"
                // Distinct from the caret's "Collapse …"; starts with the
                // visible title's words after the verb.
                aria-label={`Open ${title}`}
                onClick={() => onOpen(openThreadId)}
              >
                {title}
              </button>
            ) : (
              <span className="agents-pane__group-title">{title}</span>
            )}
          </h3>
          <span className="agents-pane__group-meta">
            {[
              ...(group.current ? ['This chat'] : []),
              ...(group.project ? [group.project] : []),
              counts,
            ].join(' · ')}
          </span>
        </span>
      </div>
      {!collapsed && (
        <ul id={listId} className="background-tasks-sheet__list">
          {children}
        </ul>
      )}
    </section>
  );
}

function rowKey(threadId: string, childId: string) {
  return `${threadId}\u0000${childId}`;
}
