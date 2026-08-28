import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import type { OrchestrationEvent } from '../hooks/orchestration/types';

/**
 * The one failure fold every session surface reads.
 *
 * archive#3213: this lived inline in `useMutableSessionDetailState`, so the
 * session detail was the only surface that could say a session had failed —
 * the chat dock rendered nothing at all on a cold arrival at a failed
 * session. The fix is extraction, not a second derivation: two surfaces
 * describing the same failure from two folds is precisely how they come to
 * disagree (archive#3139, archive#3136, archive#3203 are all that same family).
 */

/**
 * What a failed session says when nothing recorded WHY it failed. Declared
 * HERE, on the leaf, and re-exported by `attention.ts` for its existing
 * importers: this module is reached from the dock's eagerly-loaded composer
 * pane, and taking the constant the other way round would hoist the attention
 * helpers into the entry chunk for one string. One definition either way.
 */
export const NO_FAILURE_DETAIL_RECORDED =
  'No failure detail was recorded for this session.';

/** What the session record itself carries about this session's identity. */
export type SessionFailureFacts = Pick<
  OrchestrationSessionSummary,
  'lifecycleState' | 'status' | 'blockedReason'
>;

/**
 * A session the serving Station folded to `failed`. `lifecycleState` is the
 * lifecycle fold; `status` is the coarse provider process state, read only
 * when no lifecycle fold is present.
 */
export function isFailedSession(
  session: Pick<SessionFailureFacts, 'lifecycleState' | 'status'>,
): boolean {
  return (session.lifecycleState ?? session.status) === 'failed';
}

/** The most recent runtime.error's own message, from the live feed — the
 * honest source for "what failed" (session-lifecycle-service.ts mirrors the
 * same event into `session.blockedReason`, used as the list-level fallback
 * when the live feed hasn't loaded this far back yet). */
export function lastRuntimeErrorMessage(
  events: readonly OrchestrationEvent[],
): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.method === 'runtime.error') return event.message;
  }
  return undefined;
}

/**
 * `null` unless this session failed; otherwise the recorded cause, or the
 * one shared sentence for an unrecorded one — never a guess, and never a
 * cause invented from an adjacent field.
 *
 * `events` is optional because a caller with no event feed loaded (a cold
 * arrival before the bounded window resolves) still has `blockedReason`, the
 * server-side mirror of the same `runtime.error`. Passing the events it does
 * have is what keeps two surfaces on one session from quoting two different
 * causes — so pass them whenever they exist.
 */
export function sessionFailureText(
  session: SessionFailureFacts | null | undefined,
  events: readonly OrchestrationEvent[] = [],
): string | null {
  if (!session || !isFailedSession(session)) return null;
  return (
    lastRuntimeErrorMessage(events) ??
    session.blockedReason ??
    NO_FAILURE_DETAIL_RECORDED
  );
}

/** The transcript-row shape this module needs to inspect — structural on
 * purpose, so this leaf does not grow a dependency on the UI's `ChatMessage`
 * type (see the file-header note on why this module stays light). */
type TranscriptMessageText = {
  content?: string;
  contentParts?: ReadonlyArray<{
    content?: string;
    /**
     * archive#3769: stamped by the durable event projection on the row it
     * writes for a `runtime.error`. See `rendersAsFailureSurface`.
     */
    runtimeError?: boolean;
  }> | null;
  /** Stamped by `createEphemeralMessageState`; the dock renders every one. */
  ephemeral?: boolean;
};

/**
 * archive#3299: whether the rendered transcript already carries this failure
 * ON A SURFACE THE READER CAN SEE — the arbitration input for which surface
 * owns a failure's presentation. See `rendersAsFailureSurface` for why mere
 * text presence is not that test. No visible carrier
 * means the
 * transcript says nothing about this failure and the session banner remains
 * the only surface that can (archive#3213's cold arrival).
 *
 * Callers pass the needles (typically the raw cause and its
 * `translateChatError(...).body`) rather than this module deriving them —
 * deliberately, so this leaf does not import the translation table into the
 * eagerly-loaded composer chunk on its own account.
 */
export function transcriptCarriesFailureText(
  messages: readonly TranscriptMessageText[],
  needles: readonly string[],
): boolean {
  const usable = needles.filter((needle) => needle.length > 0);
  if (usable.length === 0) return false;
  return messages.some(
    (message) =>
      rendersAsFailureSurface(message) &&
      usable.some((needle) => messageText(message).includes(needle)),
  );
}

function messageText(message: TranscriptMessageText): string {
  return [
    message.content ?? '',
    ...(message.contentParts ?? []).map((part) => part.content ?? ''),
  ].join('\n');
}

/**
 * ownership is about whether the reader will SEE a
 * reason, not about whether the text exists somewhere in state.
 *
 * The predicate above used to answer "does any message contain this string",
 * and the answer was yes for a row that renders nothing: `handleRuntimeErrorEvent`
 * writes the cause into the streaming shell and, in the same update, flips
 * `status` to `error` and closes the turn — which suppresses that shell. The
 * banner then stood down for a surface that had just been hidden, and a
 * session killed mid-turn showed a red Failed chip over a transcript that
 * simply stopped, with the reason nowhere on screen.
 *
 * Three shapes actually render a failure the reader can see here:
 *  - an ephemeral system notice (`createEphemeralMessageState` stamps
 *    `ephemeral: true`; the dock renders every one of them);
 *  - a `[SYSTEM_EVENT] [CHAT_ERROR…]` marker, which `ChatDockBody` renders as
 *    a `SystemEventMessage` card with its retry/new-chat affordance;
 *  - a durable-projection error row (archive#3769): a thread cold-opened from
 *    its event window replays `runtime.error` through
 *    `runtime-event-projection.ts`, which writes the cause as an ordinary
 *    assistant text part. That part renders — the reader sees the cause under
 *    the turn — so the banner must defer to it exactly as it does to the live
 *    marker, or one incident is described twice in two vocabularies. It is
 *    recognised by the projection's own `runtimeError` flag, never by the
 *    `⚠️` its display text starts with: a prefix is presentation, and a
 *    predicate that reads presentation breaks the moment the copy changes.
 * Anything else — a streaming part, an ordinary assistant row — leaves the
 * banner as the only surface that can speak, which is what it is for.
 */
function rendersAsFailureSurface(message: TranscriptMessageText): boolean {
  if (message.ephemeral === true) return true;
  if (message.contentParts?.some((part) => part.runtimeError === true))
    return true;
  return messageText(message).trimStart().startsWith(CHAT_ERROR_MARKER_PREFIX);
}

/**
 * The marker shape `turnHandlers.ts` writes and `ChatDockBody` parses. Declared
 * here so the ownership predicate and the renderer cannot drift apart.
 */
export const CHAT_ERROR_MARKER_PREFIX = '[SYSTEM_EVENT] [CHAT_ERROR';

/** True for the local failure card `handleRuntimeErrorEvent` appends. */
export function isChatErrorMarker(message: TranscriptMessageText): boolean {
  return messageText(message).trimStart().startsWith(CHAT_ERROR_MARKER_PREFIX);
}

/**
 * Drops failure cards that belong to a turn other than `currentTurnId`.
 *
 * a marker is a statement about ONE turn,
 * but nothing ever removed it — a later successful turn appended its answer
 * beside the old failure card, and a second failure left two cards with
 * different wording claiming the same conversation. Every terminal for a turn
 * prunes the markers that are no longer about the latest one; a marker with no
 * turn identity at all predates this and is left alone rather than guessed at.
 */
export function pruneStaleFailureMarkers<
  T extends TranscriptMessageText & { turnId?: string },
>(messages: readonly T[], currentTurnId: string | undefined): T[] {
  return messages.filter(
    (message) =>
      !isChatErrorMarker(message) ||
      message.turnId === undefined ||
      message.turnId === currentTurnId,
  );
}
