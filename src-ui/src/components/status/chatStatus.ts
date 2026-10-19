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
  | 'sending'
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
  pending?: boolean;
  /**
   * Lines shown when the pill is expanded. A line with `since` is followed by
   * the time elapsed since then, kept current while the details are open.
   */
  details: Array<{ text: string; since?: number }>;
  /** What a tap does. */
  action: 'reveal-approval' | 'repair' | 'resync' | 'details' | undefined;
}

export interface ChatStatusInput {
  /** A history or continuation read failed; cached activity is not current proof. */
  observationUnavailable?: boolean;
  resyncPending?: boolean;
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
  /** This chat's own send is out and its turn has not started yet. */
  sendAwaitingTurnStart?: boolean;
  /** Station's delivery lookup said it has that send (`received`). */
  stationHasSend?: boolean;
  /**
   * The Station keeps running when this app closes (`useStationOutlivesApp`).
   * Only `true` lets the pill say closing the app is safe.
   */
  stationOutlivesApp?: boolean;
}

const STREAM_DETAIL =
  'Live updates are paused; the remote request may still be running.';

function epochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The one status a chat pane shows: transport recovery, then failed-read
 * recovery, then approvals, connection confirmation and turn activity.
 * Cached approvals cannot hide repair while their observation is unverified.
 *
 * Pure; times are carried as epoch starts, never as rendered durations, so
 * the result does not go stale between renders. Every fact comes from the chat's own record or
 * the server's activity record; the pill never estimates progress.
 */
export function deriveChatStatus(
  input: ChatStatusInput,
): ChatStatus | undefined {
  const { stream, activity } = input;
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
  // Auth and reconnect status take priority over failed reads: Resync is
  // offered again once transport recovery has settled.
  if (input.observationUnavailable)
    return {
      kind: 'blocked',
      tone: 'broken',
      glyph: 'attention',
      label: input.resyncPending
        ? 'Resyncing conversation'
        : 'Status unavailable',
      pending: input.resyncPending,
      details: [
        {
          text: 'Station could not verify this conversation. The remote turn may still be running.',
        },
      ],
      action: 'resync',
    };
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
  // The chat's own send, before the agent has its turn: the message is on
  // its way, not being worked on. Only while no turn is open on the server.
  if (input.sendAwaitingTurnStart && !activity?.openTurn) {
    return {
      kind: 'sending',
      tone: 'neutral',
      glyph: 'working',
      label: 'Sending',
      details: input.stationHasSend
        ? [
            {
              text:
                input.stationOutlivesApp === true
                  ? 'Station has your message and is starting the agent. It is safe to close the app.'
                  : 'Station has your message and is starting the agent.',
            },
          ]
        : [],
      action: input.stationHasSend ? 'details' : undefined,
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
