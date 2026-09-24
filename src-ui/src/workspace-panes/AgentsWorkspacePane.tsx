import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button } from '../components/Button';
import { TaskRow } from '../components/chat-dock/backgroundTaskRows';
import { Empty } from '../components/state';
import type { ChatUIState } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  type BackgroundTaskEntry,
  backgroundTasksStore,
} from '../contexts/background-tasks-store';
import { childWorkGlobalStore } from '../contexts/child-work-global-store';
import { useNavigation } from '../contexts/NavigationContext';
import { useShowSurface } from '../contexts/useShowSurface';
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
  engineReportsNoSubagents,
  engineStopIsWired,
  providerForThread,
  selectChatChildWork,
  selectGlobalChildWork,
} from './agents/childWorkSelectors';
import './agents/AgentsWorkspacePane.css';

/**
 * The Agents pane (#2050, #2459): the child work — engine subagents and
 * Station delegates — of the conversation on screen, or of every
 * conversation.
 *
 * Child work renders through `ChildWorkRow`, from the provider-neutral
 * contract, so it reads the same whatever engine reported it. The per-chat
 * scope still shows the chat's own TOOL calls through `TaskRow` (the sheet's
 * row), because a tool call is not child work.
 *
 * One bridge, and it retires itself: an engine subagent whose engine's
 * `subagentControl` cell is not `wired`, but which the pre-contract path
 * already offers a working per-task Stop for (Claude, until #2457 flips its
 * cell), renders through `TaskRow` in the per-chat Running list, so no
 * shipped control is lost. `ChildWorkRow` renders a Stop only from a wired
 * cell; the moment the cell is wired the bridge selects nothing and the row
 * moves over.
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

function useChildWorkInput(
  sessions: readonly OrchestrationSessionSummary[],
): ChildWorkSelectorInput {
  const global = useSyncExternalStore(
    childWorkGlobalStore.subscribe,
    childWorkGlobalStore.getSnapshot,
  );
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
      chatKeyFor: (threadId: string) =>
        activeChatsStore.getChatKeyForExecutionSession(threadId),
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

function rowKey(threadId: string, childId: string) {
  return `${threadId}\u0000${childId}`;
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
  const { data: sessions = EMPTY_SESSIONS } = useOrchestrationSessionsQuery();
  const input = useChildWorkInput(sessions);
  const showSurface = useShowSurface();
  const [now, setNow] = useState(() => Date.now());

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

  // The Claude Stop bridge (see the module comment).
  const bridged: BackgroundTaskEntry[] = useMemo(
    () =>
      scope === 'chat'
        ? tools.running.filter(
            (entry) =>
              entry.source === 'provider-task' &&
              entry.stop?.kind === 'provider-task-stop' &&
              Boolean(entry.sessionThreadId) &&
              !engineStopIsWired(
                providerForThread(entry.sessionThreadId ?? '', input),
              ),
          )
        : [],
    [scope, tools.running, input],
  );
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
  const isToolRow = (entry: BackgroundTaskEntry) =>
    entry.source === 'tool-event' && !spawningToolCalls.has(entry.id);
  const toolRunning =
    scope === 'chat' ? [...tools.running.filter(isToolRow), ...bridged] : [];
  const toolFinished = scope === 'chat' ? tools.finished.filter(isToolRow) : [];

  const runningCount = toolRunning.length + childRunning.length;
  const finishedCount = toolFinished.length + view.finished.length;

  // One 1s ticker for every Running row's elapsed time, only while mounted.
  useEffect(() => {
    if (runningCount === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runningCount]);

  const chatEngineSilent =
    scope === 'chat' && chatKey
      ? engineReportsNoSubagents(
          activeChatsStore.getSnapshot()[chatKey]?.orchestrationProvider,
        ) ||
        Object.keys(input.engine.notReported).some(
          (threadId) => input.chatKeyFor(threadId) === chatKey,
        )
      : false;

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

  const empty =
    runningCount === 0 && finishedCount === 0
      ? emptyStateFor({
          scope,
          hasChat: Boolean(chatKey),
          engineReportsNoSubagents: chatEngineSilent,
        })
      : undefined;

  return (
    <div className="agents-pane">
      <div className="agents-pane__scope" role="group" aria-label="Show">
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
      </div>
      {empty ? (
        <Empty
          variant="compact"
          label={empty.label}
          description={empty.description}
        />
      ) : (
        <div className="background-tasks-sheet__body">
          {chatEngineSilent && (
            <p className="agents-pane__note">
              This engine does not report subagents.
            </p>
          )}
          {runningCount > 0 && (
            <section className="background-tasks-sheet__section">
              <h3 className="background-tasks-sheet__section-label">
                Running ({runningCount})
              </h3>
              <ul className="background-tasks-sheet__list">
                {toolRunning.map((entry) => (
                  <TaskRow
                    key={entry.id}
                    entry={entry}
                    elapsedMs={now - entry.startedAt}
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
                Finished ({finishedCount})
                <span className="agents-pane__section-qualifier">
                  subagents since this window connected
                </span>
              </h3>
              <ul className="background-tasks-sheet__list">
                {view.finished.map(childRow)}
                {toolFinished.map((entry) => (
                  <TaskRow
                    key={entry.id}
                    entry={entry}
                    elapsedMs={
                      (entry.endedAt ?? entry.startedAt) - entry.startedAt
                    }
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
      )}
    </div>
  );
}
