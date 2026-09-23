import type { ConversationTurnActivity } from '@kontourai/station-contracts/orchestration';
import { useEffect, useState } from 'react';
import { formatToolName } from '../../utils/chat-progress';

/** "42s", "4m 10s", "1h 5m": a duration read at a glance. */
function formatActivityDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const OUTCOME_WORDS: Record<
  NonNullable<ConversationTurnActivity['lastTool']>['outcome'],
  string
> = {
  success: 'done',
  error: 'failed',
  cancelled: 'cancelled',
  // The session ended with the call open: no outcome was observed at all.
  unresolved: 'no result',
};

function epochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

type TurnActivityProgressParts = {
  /** "Running bash · 4m 10s", with "(+1 more)" for parallel calls. */
  running?: string;
  /** "Last: bash · failed", only between tools of the open turn. */
  lastTool?: string;
  /** "No output for 12m 3s", only while the watchdog holds an observation. */
  silence?: string;
};

/**
 * #2309: what the open turn is doing, read off the server's record and
 * nothing else, so every device shows the same thing — including through a
 * silent long tool call, where no event arrives for minutes and the stream
 * alone would show nothing at all.
 *
 * Every part is an observation with its own timestamp. Elapsed times are on
 * this client's clock against the server's timestamps, so clock skew shows up
 * in them; nothing here estimates progress or completion.
 */
function describeTurnActivity(
  activity: ConversationTurnActivity,
  now: number,
): TurnActivityProgressParts {
  const openTurn = activity.openTurn;
  if (!openTurn) return {};
  const parts: TurnActivityProgressParts = {};
  const running = activity.runningTools ?? [];
  const current = running.at(-1);
  if (current) {
    const startedAt = epochMs(current.startedAt);
    const others = running.length - 1;
    parts.running = `Running ${formatToolName(current.name)}${
      startedAt === undefined
        ? ''
        : ` · ${formatActivityDuration(now - startedAt)}`
    }${others > 0 ? ` (+${others} more)` : ''}`;
  } else if (activity.lastTool) {
    // `lastTool` is the newest terminal on ANY child, in or out of a turn.
    // Only one that settled inside this turn says what this turn is between.
    const completedAt = epochMs(activity.lastTool.completedAt);
    const turnStartedAt = epochMs(openTurn.startedAt);
    if (
      completedAt !== undefined &&
      turnStartedAt !== undefined &&
      completedAt >= turnStartedAt
    ) {
      parts.lastTool = `Last: ${formatToolName(activity.lastTool.name)} · ${
        OUTCOME_WORDS[activity.lastTool.outcome]
      }`;
    }
  }
  const silentSince = epochMs(activity.progressSilence?.silentSinceEventAt);
  if (silentSince !== undefined) {
    parts.silence = `No output for ${formatActivityDuration(now - silentSince)}`;
  }
  return parts;
}

/** Re-renders once a second while mounted, for the elapsed readings. */
function useSecondClock(enabled: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/**
 * The compact progress row under the streaming message: the running tool
 * with its elapsed time, or the last tool and its outcome between tools, and
 * the watchdog's silence observation when the server holds one. Renders
 * nothing when the record has none of these.
 */
export function TurnActivityProgress({
  activity,
}: {
  activity: ConversationTurnActivity | undefined;
}) {
  const hasContent = Boolean(
    activity?.openTurn &&
      ((activity.runningTools?.length ?? 0) > 0 ||
        activity.lastTool ||
        activity.progressSilence),
  );
  const now = useSecondClock(hasContent);
  if (!activity || !hasContent) return null;
  const parts = describeTurnActivity(activity, now);
  const tool = parts.running ?? parts.lastTool;
  if (!tool && !parts.silence) return null;
  return (
    <div
      className="streaming-activity streaming-activity--progress"
      data-testid="turn-activity-progress"
      aria-live="off"
    >
      {tool ? <span className="elapsed-wait">{tool}</span> : null}
      {parts.silence ? (
        <span
          className="elapsed-wait"
          title={`Observed by the server's turn watchdog since ${activity.progressSilence?.silentSinceEventAt}; the turn may still be working`}
        >
          {tool ? '· ' : ''}
          {parts.silence}
        </span>
      ) : null}
    </div>
  );
}
