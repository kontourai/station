import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { ConversationTurnActivity } from '@kontourai/station-contracts/orchestration';
import { useElapsedClock } from '../../hooks/useElapsedClock';
import { formatToolName } from '../../utils/chat-progress';
import { formatDuration } from '../../utils/relativeTime';

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

/**
 * A tool line in three pieces so the tool's name — which can be a whole
 * command line — is the one part that shrinks to an ellipsis, while the
 * lead ("Running") and the outcome or elapsed time stay readable.
 */
type ToolLine = { lead: string; name: string; tail: string };

type TurnActivityProgressParts = {
  /** "Running bash · 4m", with "(+1 more)" for parallel calls. */
  running?: ToolLine;
  /** "Last: bash · failed", only between tools of the open turn. */
  lastTool?: ToolLine;
  /** "No progress from Codex for 12m", only while the watchdog holds an observation. */
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
    parts.running = {
      lead: 'Running ',
      name: formatToolName(current.name),
      tail: `${
        startedAt === undefined ? '' : ` · ${formatDuration(now - startedAt)}`
      }${others > 0 ? ` (+${others} more)` : ''}`,
    };
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
      parts.lastTool = {
        lead: 'Last: ',
        name: formatToolName(activity.lastTool.name),
        tail: ` · ${OUTCOME_WORDS[activity.lastTool.outcome]}`,
      };
    }
  }
  const silentSince = epochMs(activity.progressSilence?.silentSinceEventAt);
  if (silentSince !== undefined) {
    // The status ladder's word ("No progress"), naming who went quiet.
    parts.silence = `No progress from ${engineDisplayLabel(activity.progressSilence?.provider ?? '') ?? 'the agent'} for ${formatDuration(now - silentSince)}`;
  }
  return parts;
}

/**
 * The compact progress row under the streaming message: the running tool
 * with its elapsed time, or the last tool and its outcome between tools, and
 * the watchdog's silence observation when the server holds one. Renders
 * nothing when the record has none of these.
 */
export function TurnActivityProgress({
  activity,
  showSilence = true,
}: {
  activity: ConversationTurnActivity | undefined;
  /** False when the host presents the silence itself (the dock's notice). */
  showSilence?: boolean;
}) {
  const running = Boolean(
    activity?.openTurn && (activity.runningTools?.length ?? 0) > 0,
  );
  const silence = Boolean(
    showSilence && activity?.openTurn && activity.progressSilence,
  );
  // Tick only while an elapsed time is on screen; "Last: bash · done" is
  // static and needs no clock.
  const now = useElapsedClock(running || silence);
  if (!activity?.openTurn) return null;
  const parts = describeTurnActivity(activity, now);
  if (!showSilence) parts.silence = undefined;
  const tool = parts.running ?? parts.lastTool;
  if (!tool && !parts.silence) return null;
  return (
    <div
      className="streaming-activity streaming-activity--progress"
      data-testid="turn-activity-progress"
      aria-live="off"
    >
      {tool ? (
        <span
          className="elapsed-wait turn-activity-progress__tool"
          title={`${tool.lead}${tool.name}${tool.tail}`}
        >
          <span className="turn-activity-progress__fixed">{tool.lead}</span>
          <span className="turn-activity-progress__name">{tool.name}</span>
          <span className="turn-activity-progress__fixed">{tool.tail}</span>
        </span>
      ) : null}
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
