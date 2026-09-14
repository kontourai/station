import { useEffect, useState } from 'react';
import { TaskRow } from '../components/chat-dock/backgroundTaskRows';
import { Empty } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { useShowSurface } from '../contexts/useShowSurface';
import {
  useChatBackgroundTasks,
  useChatStoreKey,
} from '../hooks/useBackgroundTasks';

/**
 * The work the conversation on screen set running, as a dock tab (#2050).
 *
 * The same rows `BackgroundTasksSheet` shows, from the same store, through
 * the same `TaskRow` — a placement of that list, not a second one. What it
 * shows is keyed by the ACTIVE CHAT rather than by anything the instance
 * carries, which is why the occurrence binds nothing: the pane is one pane,
 * and the conversation is navigation. Navigation's id is the DURABLE one, so
 * it is resolved to the store's key before the lookup — see `useChatStoreKey`
 * for why those are not the same string.
 *
 * Nothing is invented for a field the store does not carry. Elapsed time is
 * computed from `startedAt`/`endedAt`; tokens appear only where the provider
 * reported them (`TaskRow` drops the clause rather than printing a `0 tokens`
 * nobody measured); engine and spawn depth are not on an entry at all and so
 * are not rendered at all. An absent fact renders absent.
 *
 * It reads no region state — `useShowSurface` is the one placement-adjacent
 * hook a pane renderer may use, and it commands rather than reads — so
 * placement stays the model's and rendering stays this pane's.
 */
export function AgentsWorkspacePane() {
  const activeChat = useNavigation((state) => state.activeChat);
  // Navigation carries the chat's DURABLE id; the background-tasks store is
  // keyed by the session key, and the two diverge on every conversation
  // reopened without a provider execution. `useChatStoreKey` is the store's
  // own resolution — the same one the dock's badge effectively reads by
  // passing `activeSessionId` — so the row's count and this list are the
  // same list.
  const chatKey = useChatStoreKey(activeChat ?? null);
  const { running, finished } = useChatBackgroundTasks(chatKey);
  const showSurface = useShowSurface();
  const [now, setNow] = useState(() => Date.now());

  // One 1s ticker for every Running row's elapsed time, only while this pane
  // is mounted — the sheet's rule, for the same reason.
  useEffect(() => {
    if (running.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running.length]);

  const openTranscript = (threadId: string) =>
    showSurface('activity', { session: threadId });

  // Two empties, one label: from the reader's side both are "nothing here",
  // and only one of them has a remedy, which is what the description is for.
  if (!activeChat)
    return (
      <Empty
        variant="compact"
        label="Nothing here yet"
        description="Open a chat to see the work it set running."
      />
    );
  if (running.length === 0 && finished.length === 0)
    return <Empty variant="compact" label="Nothing here yet" />;

  return (
    <div className="background-tasks-sheet__body">
      {running.length > 0 && (
        <section className="background-tasks-sheet__section">
          <h3 className="background-tasks-sheet__section-label">
            Running ({running.length})
          </h3>
          <ul className="background-tasks-sheet__list">
            {running.map((entry) => (
              <TaskRow
                key={entry.id}
                entry={entry}
                elapsedMs={now - entry.startedAt}
                onOpenTranscript={openTranscript}
              />
            ))}
          </ul>
        </section>
      )}
      {finished.length > 0 && (
        <section className="background-tasks-sheet__section">
          <h3 className="background-tasks-sheet__section-label">
            Finished ({finished.length})
          </h3>
          <ul className="background-tasks-sheet__list">
            {finished.map((entry) => (
              <TaskRow
                key={entry.id}
                entry={entry}
                elapsedMs={(entry.endedAt ?? entry.startedAt) - entry.startedAt}
                outcomeChip={entry.state}
                onOpenTranscript={openTranscript}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
