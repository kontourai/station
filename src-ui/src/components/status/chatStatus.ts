import type { ConversationTurnActivity } from '@kontourai/station-contracts/orchestration';
import type { ChatActivityHint } from '../../contexts/active-chats-state';
import type { ChatStreamStatus } from '../../hooks/orchestration/useChatStreamStatus';
import { formatToolName } from '../../utils/chat-progress';
import { openTurnStartedAtMs } from '../../utils/conversation-activity';
import type { LiveStatusGlyphKind, LiveStatusTone } from './LiveStatusGlyph';

export type ChatStatusKind =
  | 'approval'
  | 'blocked'
  | 'reconnecting'
  | 'catching-up'
  | 'restored'
  | 'resumed'
  | 'waiting'
  | 'working';

export interface ChatStatus {
  kind: ChatStatusKind;
  tone: LiveStatusTone;
  glyph: LiveStatusGlyphKind;
  /** What the pill says. Kind-level: the announcement for screen readers. */
  label: string;
  /** Epoch ms the clock counts from — the OPEN TURN's start, never a phase's. */
  clockFrom?: number;
  /** Pending approvals, shown as a badge when more than one. */
  count?: number;
  /**
   * Lines shown when the pill is expanded. A line with `since` is followed by
   * the time elapsed since then, kept current while the details are open.
   */
  details: Array<{ text: string; since?: number }>;
  /** What a tap does. */
  action: 'reveal-approval' | 'repair' | 'details' | undefined;
}

export interface ChatStatusInput {
  /** This chat's open approval requests. */
  approvalCount: number;
  stream?: ChatStreamStatus;
  turnLive: boolean;
  /** Paused for the user with no approval behind it (needs input). */
  waitingOnUser: boolean;
  activity?: ConversationTurnActivity;
  activityHint?: ChatActivityHint;
  /** The witnessed turn start, for a server without an activity record. */
  turnStartedAt?: number;
}

const STREAM_DETAIL =
  'Live updates are paused; the remote request may still be running.';

function epochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

const OUTCOME_WORDS = {
  success: 'done',
  error: 'failed',
  cancelled: 'cancelled',
  unresolved: 'no result',
} as const;

/**
 * The one status a chat pane shows, by priority: a decision the user owes
 * (approval) outranks the transport (blocked, reconnecting, catching up),
 * which outranks the brief "restored" confirmation, which outranks what the
 * turn is doing (waiting on the user, working). Nothing live → undefined.
 *
 * Pure; times are carried as epoch starts, never as rendered durations, so
 * the result does not go stale between renders. Every fact comes from the chat's own record or
 * the server's activity record; the pill never estimates progress.
 */
export function deriveChatStatus(
  input: ChatStatusInput,
): ChatStatus | undefined {
  const { stream, activity } = input;
  if (input.approvalCount > 0) {
    return {
      kind: 'approval',
      tone: 'attention',
      glyph: 'approval',
      label:
        input.approvalCount === 1
          ? 'Approval needed'
          : `${input.approvalCount} approvals needed`,
      count: input.approvalCount > 1 ? input.approvalCount : undefined,
      details: [],
      action: 'reveal-approval',
    };
  }
  if (stream?.kind === 'blocked') {
    return {
      kind: 'blocked',
      tone: 'broken',
      glyph: 'attention',
      label: stream.label,
      details: [{ text: STREAM_DETAIL }],
      action: 'repair',
    };
  }
  if (stream?.kind === 'reconnecting' || stream?.kind === 'catching-up') {
    return {
      kind: stream.kind,
      tone: 'neutral',
      glyph: 'reconnecting',
      label: stream.label,
      details: [{ text: STREAM_DETAIL }],
      action: 'details',
    };
  }
  if (stream?.kind === 'restored') {
    return {
      kind: 'restored',
      tone: 'active',
      glyph: 'done',
      label: stream.label,
      details: [],
      action: undefined,
    };
  }
  if (!input.turnLive) return undefined;

  const clockFrom = activity
    ? openTurnStartedAtMs(activity)
    : input.turnStartedAt;
  if (input.waitingOnUser) {
    return {
      kind: 'waiting',
      tone: 'attention',
      glyph: 'attention',
      label: 'Waiting on you',
      clockFrom,
      details: [],
      action: undefined,
    };
  }
  const details: ChatStatus['details'] = [];
  const running = activity?.openTurn ? (activity.runningTools ?? []) : [];
  const current = running.at(-1);
  let label: string;
  if (current) {
    const more = running.length > 1 ? ` (+${running.length - 1} more)` : '';
    label = `Running ${formatToolName(current.name)}${more}`;
    details.push({
      text: `Running ${formatToolName(current.name)}${more}`,
      since: epochMs(current.startedAt),
    });
  } else {
    label =
      input.activityHint?.kind === 'thinking'
        ? 'Thinking'
        : input.activityHint?.kind === 'compacting'
          ? 'Compacting context'
          : 'Working';
    const last = activity?.lastTool;
    const lastAt = epochMs(last?.completedAt);
    const turnAt = epochMs(activity?.openTurn?.startedAt);
    if (
      last &&
      lastAt !== undefined &&
      turnAt !== undefined &&
      lastAt >= turnAt
    )
      details.push({
        text: `Last: ${formatToolName(last.name)} · ${OUTCOME_WORDS[last.outcome]}`,
      });
  }
  const silentSince = epochMs(activity?.progressSilence?.silentSinceEventAt);
  if (silentSince !== undefined)
    details.push({ text: 'No output for', since: silentSince });
  return {
    kind: 'working',
    tone: 'active',
    glyph: 'working',
    label,
    clockFrom,
    details,
    action: 'details',
  };
}
