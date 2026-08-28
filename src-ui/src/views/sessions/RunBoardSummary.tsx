import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import {
  STATUS_GLYPH_BY_STATE,
  statusGlyphPresentation,
} from '../../components/status/StatusGlyph';
import { LIFECYCLE_PRIORITY } from '../../utils/lifecycle-priority';
import {
  activeTurnProgress,
  orchestrationLifecycleLabel,
  type SessionStateLabel,
} from '../../utils/session-state';
import './RunBoardSummary.css';

// DERIVED, not hand-declared (a third copy of this order is how a
// state silently drops from the board). The glyph map's keys are compile-time
// exhaustive over SessionStateLabel (StatusGlyphExhaustive), and the lane
// authority already ranks them — so every state renders, in lane order, by
// construction.
const RUN_BOARD_STATE_ORDER = (
  Object.keys(STATUS_GLYPH_BY_STATE) as SessionStateLabel[]
).sort((a, b) => LIFECYCLE_PRIORITY[b] - LIFECYCLE_PRIORITY[a]);

type RunBoardBucket = {
  state: SessionStateLabel;
  count: number;
  firstMemberId: string;
  emphasized: boolean;
  /** : the member that CAUSED a quiet-turn emphasis, so activation
   * lands on it (not an arbitrary healthy member), and the label can say so. */
  firstQuietMemberId?: string;
};

/**
 * A compact aggregation of the canonical state each member already carries.
 * This does not classify lifecycle data itself: `orchestrationLifecycleLabel`
 * remains the sole state fold, and quiet turns stay watchdog observations.
 */
export function summarizeRunBoard(
  members: readonly OrchestrationSessionSummary[],
): RunBoardBucket[] {
  const buckets = new Map<SessionStateLabel, RunBoardBucket>();
  for (const member of members) {
    const state = orchestrationLifecycleLabel(member);
    // the SAME applicability gate the member rows use — a stale
    // observation on an inactive turn is not a live fact and must not
    // emphasize the board while the rows beneath show nothing.
    const quiet = Boolean(activeTurnProgress(member)?.progressSilence);
    const emphasized =
      state === 'Needs attention' ||
      state === 'Failed' ||
      state === 'Stopped' ||
      quiet;
    const current = buckets.get(state);
    if (current) {
      current.count += 1;
      current.emphasized ||= emphasized;
      if (quiet && !current.firstQuietMemberId)
        current.firstQuietMemberId = member.threadId;
    } else {
      buckets.set(state, {
        state,
        count: 1,
        firstMemberId: member.threadId,
        emphasized,
        ...(quiet ? { firstQuietMemberId: member.threadId } : {}),
      });
    }
  }
  return RUN_BOARD_STATE_ORDER.flatMap((state) => {
    const bucket = buckets.get(state);
    return bucket ? [bucket] : [];
  });
}

function boardSentence(buckets: readonly RunBoardBucket[]): string {
  return buckets
    .map(({ state, count }) => {
      const label = statusGlyphPresentation(state).ariaLabel.toLowerCase();
      return `${count} ${label}`;
    })
    .join(', ');
}

export function RunBoardSummary({
  members,
  onFocusMember,
}: {
  members: readonly OrchestrationSessionSummary[];
  onFocusMember: (memberId: string) => void;
}) {
  const buckets = summarizeRunBoard(members);
  return (
    <fieldset
      className="run-board"
      data-testid="run-board"
      aria-label={boardSentence(buckets)}
    >
      {buckets.map((bucket) => {
        const presentation = statusGlyphPresentation(bucket.state);
        const label = presentation.ariaLabel.toLowerCase();
        // When the SILENCE is the sole reason this
        // cluster is emphasized (state itself unremarkable), activation lands
        // on the member that caused it and the name says why — in the USER'S
        // words for this observation ("no recent progress", aligned with
        // ProgressSilenceObservation's copy; 'quiet' is internal vocabulary,
        // archive#1783 class). For states that are emphasized in their own
        // right (Needs attention/Failed/Stopped), the state IS the reason:
        // standard first-member naming and targeting.
        const stateEmphasized =
          bucket.state === 'Needs attention' ||
          bucket.state === 'Failed' ||
          bucket.state === 'Stopped';
        const silenceDriven =
          Boolean(bucket.firstQuietMemberId) && !stateEmphasized;
        const focus = () =>
          onFocusMember(
            silenceDriven
              ? (bucket.firstQuietMemberId ?? bucket.firstMemberId)
              : bucket.firstMemberId,
          );
        const clusterName = silenceDriven
          ? `Focus ${label} member with no recent progress (${bucket.count} ${label})`
          : `Focus first ${label} member (${bucket.count})`;
        return (
          <button
            key={bucket.state}
            type="button"
            className={`run-board__cluster${bucket.emphasized ? ' run-board__cluster--emphasis' : ''}`}
            data-run-board-state={bucket.state}
            data-testid={`run-board-cluster-${bucket.state}`}
            aria-label={clusterName}
            onClick={focus}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                focus();
              }
            }}
          >
            <span
              aria-hidden="true"
              className={`status-glyph status-glyph--${presentation.color}`}
            >
              {presentation.glyph}
            </span>
            <span aria-hidden="true">{bucket.count}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
