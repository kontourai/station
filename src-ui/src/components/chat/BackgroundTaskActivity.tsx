import type { StationStateSource } from '../../connections/station-state';
import type { ChatBackgroundTask } from '../../contexts/active-chats-state';
import type { BackgroundTaskEntry } from '../../contexts/background-tasks-store';
import {
  useChatBackgroundTasks,
  useChatStoreKey,
} from '../../hooks/useBackgroundTasks';
import { useElapsedClock } from '../../hooks/useElapsedClock';
import {
  backgroundWorkCounts,
  backgroundWorkRunningLabel,
  backgroundWorkTotal,
} from '../../utils/background-work-label';
import { formatChildWorkElapsed } from '../../utils/child-work-display';
import { AgentGlyph, TerminalGlyph } from '../icons/Glyph';
import { LoadingDots } from '../LoadingDots';
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

/** One running task in the chat's background strip: its kind, title, latest
 * activity and elapsed time on one line. */
function RunningBackgroundTaskLine({
  entry,
  now,
}: {
  entry: BackgroundTaskEntry;
  now: number;
}) {
  return (
    <li className="background-tasks-banner__task">
      <span className="background-tasks-banner__task-glyph" aria-hidden="true">
        {entry.kind === 'tool' ? <TerminalGlyph /> : <AgentGlyph />}
      </span>
      <span className="background-tasks-banner__task-title">{entry.title}</span>
      <BackgroundTaskActivity
        entry={entry}
        elapsedMs={backgroundTaskElapsedMs(entry, now)}
      />
    </li>
  );
}

/**
 * The chat's own view of its running background tasks, inside the strip that
 * says work continues: each task's title, latest activity and elapsed time,
 * from the same store and row line the Agents pane reads.
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
        <RunningBackgroundTaskLine key={entry.id} entry={entry} now={now} />
      ))}
    </ul>
  );
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

/**
 * The chat's tool calls still running after its turn ended, as the Agents
 * pane lists them: tool cards opened by `tool.started` and not yet closed.
 */
export function useChatRunningToolCount(
  chatThreadId: string | null,
  source?: StationStateSource,
): number {
  const chatKey = useChatStoreKey(chatThreadId);
  const { running } = useChatBackgroundTasks(chatKey, source);
  return running.filter((entry) => entry.source === 'tool-event').length;
}

/**
 * The strip's one line. The chat's engine children name their kind (agents,
 * commands, monitors) and running tool calls are counted beside them, as
 * the status pill counts them. One task is named; several are counted, since
 * their cards and the Agents pane name each one.
 */
export function backgroundStripLabel({
  localTasks,
  runningToolCount,
  serverCount,
  singleToolTitle,
}: {
  localTasks: readonly ChatBackgroundTask[];
  runningToolCount: number;
  serverCount: number;
  singleToolTitle?: string;
}): string {
  if (localTasks.length === 0) {
    if (serverCount === 0 && runningToolCount > 0)
      return runningToolCount === 1 && singleToolTitle
        ? `Tool running — ${singleToolTitle}`
        : backgroundWorkRunningLabel(
            backgroundWorkCounts([], runningToolCount),
          );
    // Only Station's count is known, not what kind of work it is.
    return serverCount === 1
      ? 'Background task running'
      : `${serverCount} background tasks running`;
  }
  const counts = backgroundWorkCounts(localTasks, runningToolCount);
  if (backgroundWorkTotal(counts) > 1)
    return backgroundWorkRunningLabel(counts);
  const only = localTasks[0]!;
  const kind = only.workKind ?? 'agent';
  const description = only.description || `background ${kind}`;
  return kind === 'agent'
    ? `Background agent working — ${description}`
    : kind === 'monitor'
      ? `Monitor watching — ${description}`
      : `Background command running — ${description}`;
}

/**
 * The strip under a settled turn whose background work continues: one line
 * that counts the work, then the running tasks the transcript does not
 * already draw as cards, all in one card.
 *
 * A task the transcript already draws as its card (`cardedTaskIds`: child ids
 * and spawning call ids) is left out of the list; the card carries its own
 * activity and elapsed time. With every running task carded, no list renders.
 */
export function ChatBackgroundStrip({
  chatThreadId,
  source,
  cardedTaskIds,
  localTasks,
  serverCount,
  liveStatusUnavailable,
  onOpen,
}: {
  chatThreadId: string;
  source?: StationStateSource;
  cardedTaskIds?: ReadonlySet<string>;
  /** The chat's own engine children (`ChatSession.backgroundTasks`). */
  localTasks: readonly ChatBackgroundTask[];
  /** Station's count of the conversation's running child work. */
  serverCount: number;
  /** The conversation cannot be observed: the line is last known. */
  liveStatusUnavailable: boolean;
  /** Opens the Background tasks sheet, when the host has one. */
  onOpen?: () => void;
}) {
  // The store key the Agents pane resolves for the same chat.
  const chatKey = useChatStoreKey(chatThreadId);
  const { running } = useChatBackgroundTasks(chatKey, source);
  const tools = running.filter((entry) => entry.source === 'tool-event');
  const current = backgroundStripLabel({
    localTasks,
    runningToolCount: tools.length,
    serverCount,
    singleToolTitle: tools[0]?.title,
  });
  const label = liveStatusUnavailable
    ? `Last known: ${current.charAt(0).toLowerCase()}${current.slice(1)} (status unavailable)`
    : current;
  // Animated dots claim the work is happening now; omit them for a
  // last-known label.
  const dots = liveStatusUnavailable ? null : <LoadingDots />;
  const uncarded = cardedTaskIds?.size
    ? running.filter((entry) => !cardedTaskIds.has(entry.id))
    : running;
  return (
    <div className="background-tasks-strip">
      {onOpen && localTasks.length > 0 ? (
        // archive#1301: a `<button>` cannot also carry `role="status"` (an
        // interactive element and a live region are mutually exclusive ARIA
        // roles), so a visually hidden sibling carries the live region and
        // the button stays the one interactive element.
        <>
          <button
            type="button"
            className="background-tasks-banner"
            onClick={onOpen}
            aria-label={`${label} — open background tasks`}
          >
            {dots}
            <span className="background-tasks-banner__label" aria-hidden="true">
              {label}
            </span>
          </button>
          <span className="background-tasks-banner__sr-status" role="status">
            {label}
          </span>
        </>
      ) : (
        <div className="background-tasks-banner" role="status">
          {dots}
          <span className="background-tasks-banner__label">{label}</span>
        </div>
      )}
      {/* Outside the live region: a ticking clock must not be re-announced.
          A last-known strip shows no live lines. */}
      {!liveStatusUnavailable && uncarded.length > 0 && (
        <UncardedRunningLines running={uncarded} />
      )}
    </div>
  );
}
