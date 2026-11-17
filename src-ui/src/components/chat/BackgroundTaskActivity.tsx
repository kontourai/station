import type { ChildWorkKind } from '@kontourai/station-contracts/child-work';
import { useMemo } from 'react';
import type { StationStateSource } from '../../connections/station-state';
import type { ChatBackgroundTask } from '../../contexts/active-chats-state';
import {
  type BackgroundTaskEntry,
  backgroundTasksStore,
  providerTaskEntry,
} from '../../contexts/background-tasks-store';
import {
  useBackgroundTasksPartition,
  useChatBackgroundTasks,
  useChatStoreKey,
} from '../../hooks/useBackgroundTasks';
import { useElapsedClock } from '../../hooks/useElapsedClock';
import {
  type BackgroundWorkCounts,
  type BackgroundWorkKind,
  backgroundWorkCounts,
  backgroundWorkPhrase,
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
  kindShown = false,
}: {
  entry: BackgroundTaskEntry;
  /** A delegate's latest tool, read from its own transcript. */
  latestTool?: string;
  elapsedMs: number | undefined;
  /** The row already names the kind (its glyph): no kind word here. */
  kindShown?: boolean;
}) {
  const activity =
    entry.state === 'running' && (entry.latestTool || latestTool) ? (
      <ChildWorkActivity
        tool={entry.latestTool ?? latestTool}
        progress={entry.source === 'provider-task' ? entry.detail : undefined}
      />
    ) : kindShown ? null : (
      KIND_LABEL[entry.kind]
    );
  const elapsed =
    elapsedMs === undefined ? null : formatChildWorkElapsed(elapsedMs);
  return (
    <span className="background-tasks-sheet__meta">
      {activity}
      {/* A flex item drops a leading plain space; keep the gap before "·". */}
      {elapsed && (activity ? ` · ${elapsed}` : elapsed)}
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
      <span
        className="background-tasks-banner__task-glyph"
        role="img"
        aria-label={KIND_LABEL[entry.kind]}
      >
        {entry.kind === 'tool' ? <TerminalGlyph /> : <AgentGlyph />}
      </span>
      <span className="background-tasks-banner__task-title">{entry.title}</span>
      <BackgroundTaskActivity
        entry={entry}
        elapsedMs={backgroundTaskElapsedMs(entry, now)}
        kindShown
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

/** One piece of a chat's running background work, with its kind. */
export interface ChatBackgroundWorkItem {
  entry: BackgroundTaskEntry;
  kind: BackgroundWorkKind;
}

function isChildWork(
  item: ChatBackgroundWorkItem,
): item is ChatBackgroundWorkItem & { kind: ChildWorkKind } {
  return item.kind !== 'tool';
}

/**
 * The chat's running background work as one list: the Running entries the
 * Agents pane lists (tool calls, delegates, engine children), plus any of
 * the chat's own engine children that list does not carry yet. The strip's
 * count line, its rows and the status pill all read this list, so they
 * cannot count different work.
 */
export function useChatBackgroundWork(
  chatThreadId: string | null,
  source: StationStateSource | undefined,
  localTasks: readonly ChatBackgroundTask[] | undefined,
): readonly ChatBackgroundWorkItem[] {
  // The store key the Agents pane resolves for the same chat.
  const chatKey = useChatStoreKey(chatThreadId);
  const partition = useBackgroundTasksPartition(source);
  const { running } = useChatBackgroundTasks(chatKey, source);
  return useMemo(() => {
    const ids = new Set(running.map((entry) => entry.id));
    const workKinds = new Map(
      (localTasks ?? []).map((task) => [task.taskId, task.workKind]),
    );
    const unlisted = (localTasks ?? []).filter(
      (task) =>
        !ids.has(task.taskId) && !(task.toolCallId && ids.has(task.toolCallId)),
    );
    const state = backgroundTasksStore.getSnapshot(partition);
    return [
      ...running,
      ...unlisted.map((task) => providerTaskEntry(state, chatKey ?? '', task)),
    ].map((entry) => ({
      entry,
      kind:
        entry.kind === 'tool' ? 'tool' : (workKinds.get(entry.id) ?? 'agent'),
    }));
  }, [chatKey, localTasks, partition, running]);
}

/**
 * The counts the status pill names, or undefined when the work holds no
 * engine child or delegate: Station's count is then the better number, since
 * it knows children this client has not seen.
 */
export function namedBackgroundWork(
  work: readonly ChatBackgroundWorkItem[],
): BackgroundWorkCounts | undefined {
  if (!work.some(isChildWork)) return undefined;
  return backgroundWorkCounts(work.map((item) => item.kind));
}

const SINGLE_CHILD_LABEL: Record<ChildWorkKind, string> = {
  agent: 'Background agent working',
  command: 'Background command running',
  monitor: 'Monitor watching',
};

/**
 * The strip's one line. Work the transcript already shows (a subagent card,
 * a running call in its tool batch) is counted as "above"; the rest is
 * listed in the strip itself. One task is named; several are counted.
 * Without a named child, only Station's count is known.
 */
export function backgroundStripLabel({
  work,
  shownAbove,
  serverCount,
}: {
  work: readonly ChatBackgroundWorkItem[];
  shownAbove: (entry: BackgroundTaskEntry) => boolean;
  serverCount: number;
}): string {
  const children = work.filter(isChildWork);
  if (children.length === 0)
    return serverCount === 1
      ? 'Background task running'
      : `${serverCount} background tasks running`;
  if (work.length === 1) {
    const [{ entry, kind }] = children;
    return `${SINGLE_CHILD_LABEL[kind]} — ${entry.title}`;
  }
  const phrase = (items: readonly ChatBackgroundWorkItem[]) =>
    backgroundWorkPhrase(backgroundWorkCounts(items.map((item) => item.kind)));
  const above = work.filter((item) => shownAbove(item.entry));
  const below = work.filter((item) => !shownAbove(item.entry));
  if (above.length === 0) return `${phrase(below)} running`;
  if (below.length === 0) return `${phrase(above)} running above`;
  return `${phrase(above)} above · ${phrase(below)} running`;
}

/**
 * The strip under a settled turn whose background work continues: one line
 * that counts the work, then the running tasks the transcript does not
 * already show, all in one card.
 *
 * Each running task appears once in the transcript. A task the transcript
 * already shows (`shownTaskIds`: a subagent card, or a running call in a
 * tool batch) is counted "above" and not listed again here.
 */
export function ChatBackgroundStrip({
  chatThreadId,
  source,
  shownTaskIds,
  localTasks,
  serverCount,
  liveStatusUnavailable,
  onOpen,
}: {
  chatThreadId: string;
  source?: StationStateSource;
  /**
   * Running work the transcript already shows: subagent cards (child and
   * spawning call ids) and the tool calls of its batches.
   */
  shownTaskIds?: ReadonlySet<string>;
  /** The chat's own engine children (`ChatSession.backgroundTasks`). */
  localTasks: readonly ChatBackgroundTask[];
  /** Station's count of the conversation's running child work. */
  serverCount: number;
  /** The conversation cannot be observed: the line is last known. */
  liveStatusUnavailable: boolean;
  /** Opens the Background tasks sheet, when the host has one. */
  onOpen?: () => void;
}) {
  const work = useChatBackgroundWork(chatThreadId, source, localTasks);
  // The pill names the same work: with no child known here or to Station,
  // nothing continues in the background (a lone running call shows in its
  // batch).
  if (!namedBackgroundWork(work) && serverCount === 0) return null;
  const shownAbove = (entry: BackgroundTaskEntry) =>
    shownTaskIds?.has(entry.id) === true;
  const current = backgroundStripLabel({ work, shownAbove, serverCount });
  const label = liveStatusUnavailable
    ? `Last known: ${current.charAt(0).toLowerCase()}${current.slice(1)} (status unavailable)`
    : current;
  // Animated dots claim the work is happening now; omit them for a
  // last-known label.
  const dots = liveStatusUnavailable ? null : <LoadingDots />;
  const listed = work
    .map((item) => item.entry)
    .filter((entry) => !shownAbove(entry));
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
      {!liveStatusUnavailable && listed.length > 0 && (
        <UncardedRunningLines running={listed} />
      )}
    </div>
  );
}
