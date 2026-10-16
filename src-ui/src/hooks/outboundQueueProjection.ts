import { activeChatsStore } from '../contexts/active-chats-store';
import {
  currentOutboundStation,
  type OutboundDispatchTurn,
  rowBelongsToStation,
} from '../lib/outboundQueue';

export interface OutboundQueuedTurnProjection {
  clientTurnId: string;
  content: string;
  attachments?: OutboundDispatchTurn['attachments'];
  createdAt: number;
  status: 'pending' | 'invoking' | 'accepted' | 'failed' | 'may-have-started';
  lastError?: string;
  /** Station's newest delivery-lookup answer for this row's key. */
  deliveryCheck?: OutboundDispatchTurn['deliveryCheck'];
  /**
   * The row was written for another Station (its API base): it waits for
   * that Station and is never sent anywhere else.
   */
  waitingForStation?: string;
  /**
   * Held behind a turn by another window or by one that closed: nothing
   * sends it until the user does.
   */
  heldElsewhere?: true;
  /** Pending behind an earlier not-sent row of its chat (see `claimNext`). */
  behindUnsent?: true;
  /** No answer came back; Station's delivery lookup decides it. */
  awaitingLookup?: true;
  /** Claimed by a renderer still running: its send is under way there. */
  sendUnderWay?: true;
}

/**
 * Keys of pending rows that `claimNext` cannot reach until the user acts: an
 * earlier row of the same session was not sent (`failed`). Rows it skips (an
 * unconfirmed one, or a held copy) hold nothing back; rows it waits on while
 * they are under way (`invoking`, `accepted`, an earlier `pending`) carry the
 * block along. Read from every row, including ones not listed.
 */
function pendingBehindUnsent(
  entries: readonly OutboundDispatchTurn[],
): Set<string> {
  const blocked = new Set<string>();
  const sessionsBlocked = new Set<string>();
  for (const entry of entries) {
    if (entry.status === 'failed' && !entry.heldBy) {
      sessionsBlocked.add(entry.sessionId);
    } else if (
      entry.status === 'pending' &&
      !entry.heldBy &&
      sessionsBlocked.has(entry.sessionId)
    ) {
      blocked.add(entry.clientTurnId);
    }
  }
  return blocked;
}

export function projectOutboundQueueEntries(
  entries: readonly OutboundDispatchTurn[],
  retired: { discarded: readonly string[]; accepted: readonly string[] } = {
    discarded: [],
    accepted: [],
  },
): void {
  settleRetiredBubbles(retired);
  const behindUnsent = pendingBehindUnsent(entries);
  const groups = new Map<string, OutboundDispatchTurn[]>();
  for (const entry of entries) {
    // A live send this renderer is still waiting on is already on screen as
    // its own bubble, with the chat saying "Sending"; listing it here too
    // would show the message twice and call the chat queued.
    if (entry.liveInFlight) continue;
    // A follow-up this window's own queue holds is listed there; its row is
    // only the durable copy. One held anywhere else (another window, or a
    // window that closed) is listed here, never sent without the user.
    if (entry.heldHere) continue;
    const group = groups.get(entry.sessionId) ?? [];
    group.push(entry);
    groups.set(entry.sessionId, group);
  }

  // A refused queued follow-up the chat already shows as "Not sent" (same
  // key) is listed once, there; its durable row stays behind it.
  for (const [sessionId, queued] of [...groups]) {
    const unsent = new Set(
      (activeChatsStore.getSnapshot()[sessionId]?.unsentMessages ?? []).map(
        (record) => record.id,
      ),
    );
    if (unsent.size === 0) continue;
    const visible = queued.filter(
      (entry) => !(entry.status === 'failed' && unsent.has(entry.clientTurnId)),
    );
    if (visible.length) groups.set(sessionId, visible);
    else groups.delete(sessionId);
  }

  for (const [sessionId, chat] of Object.entries(
    activeChatsStore.getSnapshot(),
  )) {
    if (!chat.outboundQueuedTurns?.length || groups.has(sessionId)) continue;
    activeChatsStore.updateChat(sessionId, {
      outboundQueuedTurns: [],
      ...(chat.status === 'queued' ? { status: 'idle' } : {}),
    });
  }

  for (const [sessionId, queued] of groups) {
    if (!activeChatsStore.getSnapshot()[sessionId]) {
      const first = queued[0]!;
      activeChatsStore.initChat(sessionId, {
        agentSlug: first.agentSlug,
        agentName: first.agentSlug,
        title: 'Queued message',
        conversationId: first.conversationId,
        ...(first.projectSlug ? { projectSlug: first.projectSlug } : {}),
      });
    }
    // A copy held by another or a closed window is listed first: it was
    // written before anything queued after it, and it waits on the user.
    const ordered = [
      ...queued.filter((entry) => entry.heldBy),
      ...queued.filter((entry) => !entry.heldBy),
    ];
    activeChatsStore.updateChat(sessionId, {
      status: 'queued',
      outboundQueuedTurns: ordered.map(
        ({
          clientTurnId,
          content,
          attachments,
          createdAt,
          status,
          lastError,
          mergedTurns,
          deliveryCheck,
          station,
          heldBy,
          awaitingLookup,
          sendUnderWay,
        }) => ({
          clientTurnId,
          content,
          attachments,
          createdAt,
          status,
          lastError,
          mergedTurns,
          ...(deliveryCheck ? { deliveryCheck } : {}),
          ...(heldBy ? { heldElsewhere: true as const } : {}),
          ...(awaitingLookup ? { awaitingLookup: true as const } : {}),
          ...(sendUnderWay ? { sendUnderWay: true as const } : {}),
          ...(behindUnsent.has(clientTurnId)
            ? { behindUnsent: true as const }
            : {}),
          ...(station &&
          !rowBelongsToStation({ station }, currentOutboundStation())
            ? { waitingForStation: station.apiBase }
            : {}),
        }),
      ),
    });
  }
}

/**
 * A message finished with in another window (or by the delivery lookup) is
 * settled here too. Discarded: its unsent bubble goes, as it did where it was
 * discarded. Accepted: Station started it, so the bubble records that answer
 * rather than reading as unanswered. Only this window's own unsent bubbles
 * (a key, no turn) are touched; history is never changed.
 */
function settleRetiredBubbles(retired: {
  discarded: readonly string[];
  accepted: readonly string[];
}): void {
  if (retired.discarded.length === 0 && retired.accepted.length === 0) return;
  const discarded = new Set(retired.discarded);
  const accepted = new Set(retired.accepted);
  for (const [sessionId, chat] of Object.entries(
    activeChatsStore.getSnapshot(),
  )) {
    const unsent = (chat.messages ?? []).filter(
      (message) =>
        message.role === 'user' &&
        message.clientId !== undefined &&
        message.turnId === undefined,
    );
    if (unsent.length === 0) continue;
    const drop = new Set(
      unsent
        .filter((message) => discarded.has(message.clientId!))
        .map((message) => message.clientId!),
    );
    const started = unsent
      .map((message) => message.clientId!)
      .filter(
        (key) => accepted.has(key) && chat.deliveryChecks?.[key] !== 'started',
      );
    if (drop.size === 0 && started.length === 0) continue;
    activeChatsStore.updateChat(sessionId, {
      ...(drop.size
        ? {
            messages: chat.messages?.filter(
              (message) =>
                !(
                  message.role === 'user' &&
                  message.turnId === undefined &&
                  message.clientId !== undefined &&
                  drop.has(message.clientId)
                ),
            ),
          }
        : {}),
      ...(started.length
        ? {
            deliveryChecks: {
              ...(chat.deliveryChecks ?? {}),
              ...Object.fromEntries(
                started.map((key) => [key, 'started' as const]),
              ),
            },
          }
        : {}),
      localSendKeys: chat.localSendKeys?.filter(
        (key) => !drop.has(key) && !started.includes(key),
      ),
    });
  }
}
