import type { StationStateSource } from '../../connections/station-state';
import type { BackgroundTaskEntry } from '../../contexts/background-tasks-store';
import {
  useChatBackgroundTasks,
  useChatStoreKey,
} from '../../hooks/useBackgroundTasks';
import { useElapsedClock } from '../../hooks/useElapsedClock';
import { formatChildWorkElapsed } from '../../utils/child-work-display';
import { ChildWorkActivity } from './ChildWorkActivity';
import './BackgroundTaskActivity.css';

/**
 * #2459: a card's elapsed time, or undefined when no start was reported —
 * a running card counts to `now`, a settled one to its end.
 */
export function backgroundTaskElapsedMs(
  entry: BackgroundTaskEntry,
  now: number,
): number | undefined {
  if (entry.startedAt === undefined) return undefined;
  return entry.state === 'running'
    ? now - entry.startedAt
    : (entry.endedAt ?? entry.startedAt) - entry.startedAt;
}

const KIND_LABEL: Record<BackgroundTaskEntry['kind'], string> = {
  tool: 'Tool',
  agent: 'Agent',
};

/**
 * A task's activity line: its latest tool and progress while it runs (its
 * kind otherwise), then its elapsed time. The one line every background-task
 * list shows, the chat's background banner included.
 */
export function BackgroundTaskActivity({
  entry,
  latestTool,
  elapsedMs,
}: {
  entry: BackgroundTaskEntry;
  /** A delegate's latest tool, read from its own transcript. */
  latestTool?: string;
  elapsedMs: number | undefined;
}) {
  return (
    <span className="background-tasks-sheet__meta">
      {entry.state === 'running' && (entry.latestTool || latestTool) ? (
        <ChildWorkActivity
          tool={entry.latestTool ?? latestTool}
          progress={entry.source === 'provider-task' ? entry.detail : undefined}
        />
      ) : (
        KIND_LABEL[entry.kind]
      )}
      {/* A flex item drops a leading plain space; keep the gap before "·". */}
      {elapsedMs !== undefined && ` · ${formatChildWorkElapsed(elapsedMs)}`}
    </span>
  );
}

/**
 * The chat's own view of its running background tasks, under the banner that
 * says work continues: each task's title, latest activity and elapsed time,
 * from the same store and row line the Background tasks sheet reads.
 */
export function RunningBackgroundTaskLines({
  running,
  now,
}: {
  running: readonly BackgroundTaskEntry[];
  now: number;
}) {
  if (running.length === 0) return null;
  return (
    <ul className="background-tasks-banner__tasks">
      {running.map((entry) => (
        <li key={entry.id} className="background-tasks-banner__task">
          <span className="background-tasks-banner__task-title">
            {entry.title}
          </span>
          <BackgroundTaskActivity
            entry={entry}
            elapsedMs={backgroundTaskElapsedMs(entry, now)}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * The running lines for one chat, live. Its own component so the one-second
 * elapsed clock re-renders these lines, not the transcript around them.
 *
 * A task the transcript already draws as its card (`cardedTaskIds`: child ids
 * and spawning call ids) is left out; the card carries its own activity and
 * elapsed time. With every running task carded, nothing is listed.
 */
export function ChatRunningBackgroundTasks({
  chatThreadId,
  source,
  cardedTaskIds,
}: {
  chatThreadId: string;
  source?: StationStateSource;
  cardedTaskIds?: ReadonlySet<string>;
}) {
  // The store key the Agents pane resolves for the same chat.
  const chatKey = useChatStoreKey(chatThreadId);
  const { running } = useChatBackgroundTasks(chatKey, source);
  const uncarded = cardedTaskIds?.size
    ? running.filter((entry) => !cardedTaskIds.has(entry.id))
    : running;
  return uncarded.length > 0 ? (
    <UncardedRunningLines running={uncarded} />
  ) : null;
}

/** Holds the ticking clock only while there are lines to tick. */
function UncardedRunningLines({
  running,
}: {
  running: readonly BackgroundTaskEntry[];
}) {
  const now = useElapsedClock();
  return <RunningBackgroundTaskLines running={running} now={now} />;
}
