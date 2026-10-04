import type { ConversationTurnActivity } from '@kontourai/station-contracts/orchestration';
import type { ChatActivityHint } from '../../contexts/active-chats-state';
import type { ChatStreamStatus } from '../../hooks/orchestration/useChatStreamStatus';
import { retryActivityLabel } from '../../utils/chat-activity';
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
      label: 'Needs approval',
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
      label: 'Check connection',
      details: [{ text: STREAM_DETAIL }],
      action: 'repair',
    };
  }
  if (stream?.kind === 'reconnecting' || stream?.kind === 'catching-up') {
    return {
      kind: stream.kind,
      tone: 'neutral',
      glyph: 'reconnecting',
      label: stream.kind === 'reconnecting' ? 'Reconnecting' : 'Catching up',
      details: [{ text: STREAM_DETAIL }],
      action: 'details',
    };
  }
  if (stream?.kind === 'restored') {
    return {
      kind: 'restored',
      tone: 'active',
      glyph: 'done',
      label: 'Connected',
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
  const running =
    activity?.openTurn && (activity.runningTools?.length ?? 0) > 0;
  let label = running
    ? 'Working'
    : input.activityHint?.kind === 'thinking'
      ? 'Thinking'
      : input.activityHint?.kind === 'compacting'
        ? 'Compacting'
        : input.activityHint?.kind === 'requesting'
          ? 'Preparing'
          : 'Working';
  if (input.activityHint?.kind === 'retrying') {
    label = 'Retrying';
    details.push({ text: retryActivityLabel(input.activityHint) });
  }
  const silentSince = epochMs(activity?.progressSilence?.silentSinceEventAt);
  if (silentSince !== undefined && input.activityHint?.kind !== 'retrying') {
    // The ladder's word for a quiet run, not a second one: the strip says
    // "No progress" with the clock, and its detail reads exactly like the
    // row, "No progress · 4m" (the pill appends " · <duration>").
    if (!running) label = 'No progress';
    details.push({ text: 'No progress', since: silentSince });
  }
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
