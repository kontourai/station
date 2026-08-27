import type { Notification } from '@kontourai/station-contracts/notification';
import type { RequestAnswerability } from '@kontourai/station-contracts/orchestration';
import {
  unanswerableRequestNotice,
  unknownAnswerabilityNotice,
} from '@kontourai/station-contracts/orchestration';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';

/**
 * The UI's read of the `answerability` decoration ADR 0012 put on the wire —
 * one module, so the notification popover, the notifications page, the
 * delegated-task coordinator, the session detail card and Home cannot drift
 * into four different answers about one session.
 *
 * NOTHING HERE RECOMPUTES THE FACT. `projectRequestAnswerability` is
 * process-local (two of its three inputs are the serving process's adapter
 * registry and thread-attachment table); the browser is a different process
 * over HTTP and structurally cannot evaluate it. Every function below reads
 * the decorated summary the SDK already normalized
 * (`withNormalizedAnswerability`) and renders its basis.
 */

/**
 * What a surface knows about one row's answerability. Four states, not a
 * boolean, because "observed answerable", "observed unanswerable", "could
 * not look" and "this row has no session behind it at all" are four
 * different facts and only one of them justifies disabling an action.
 */
export type AnswerabilityView =
  /** No orchestration session backs this row — nothing to join, nothing to say. */
  | { status: 'not-applicable' }
  /** Joined, and the serving process said it could still answer. */
  | { status: 'answerable' }
  /** Joined, and the serving process said nothing there could answer it. */
  | { status: 'unanswerable'; notice: string }
  /** A session was named but not found in the summaries this surface holds. */
  | { status: 'unknown'; notice: string };

export const NOT_APPLICABLE: AnswerabilityView = { status: 'not-applicable' };

/**
 * Turn a decorated summary into the view. `provider` is threaded through so
 * the `provider_absent` arm can name the provider it has no adapter for
 * rather than gesturing at one.
 */
export function answerabilityViewFor(
  answerability: RequestAnswerability,
  provider?: string,
): AnswerabilityView {
  const notice = unanswerableRequestNotice(answerability, { provider });
  return notice ? { status: 'unanswerable', notice } : { status: 'answerable' };
}

/** True only for an OBSERVED negative. An unknown or unjoinable row is not. */
export function isUnanswerableView(view: AnswerabilityView): boolean {
  return view.status === 'unanswerable';
}

/**
 * The session a session-backed row is decorated by. Deliberately reads the
 * summary's own member rather than a re-fold of `lifecycleState` — the
 * whole point of the required wire member is that this is the one answer.
 */
export function sessionAnswerabilityView(
  session: Pick<OrchestrationSessionSummary, 'answerability' | 'provider'>,
): AnswerabilityView {
  return answerabilityViewFor(session.answerability, session.provider);
}

/** Convenience predicate for the fold family in `sessionDisplay.ts`. */
export function isSessionUnanswerable(
  session: Pick<OrchestrationSessionSummary, 'answerability'>,
): boolean {
  return !session.answerability.answerable;
}

/**
 * The thread id an approval notification names, or `undefined` when the
 * notification is not orchestration-backed.
 *
 * The scope boundary is the same one `attention-projection.ts` draws
 * server-side (`isNotificationSessionUnanswerable`): only
 * `requestKind: 'orchestration'` notifications have a session and an event
 * stream behind them. A registry-kind approval (`ApprovalRegistry`, no
 * orchestration session) and a plain notification posted through
 * `POST /api/notifications` have nothing to join to, and inventing a join
 * for them would be the fuzzy-match this repo's honesty bar forbids.
 */
export function notificationThreadId(
  notification: Notification,
): string | undefined {
  const metadata = notification.metadata ?? {};
  if (metadata.requestKind !== 'orchestration') return undefined;
  const threadId = metadata.threadId;
  return typeof threadId === 'string' && threadId.length > 0
    ? threadId
    : undefined;
}

/**
 * Join one notification row to the decorated summaries a surface already
 * holds.
 *
 * `sessionsLoaded` is required rather than inferred from an empty map,
 * because "the sessions query has not resolved yet" and "the serving Station
 * does not list this session" are different facts and only the second one is
 * an honest gap worth rendering. Before the query settles the row is left
 * alone (`not-applicable`) — annotating a row with "unknown" for the
 * duration of a fetch would be a claim about the Station, made by a spinner.
 */
export function notificationAnswerabilityView(
  notification: Notification,
  sessionsById: Map<string, OrchestrationSessionSummary>,
  sessionsLoaded: boolean,
): AnswerabilityView {
  const threadId = notificationThreadId(notification);
  if (!threadId) return NOT_APPLICABLE;
  const session = sessionsById.get(threadId);
  if (session) return sessionAnswerabilityView(session);
  if (!sessionsLoaded) return NOT_APPLICABLE;
  return {
    status: 'unknown',
    notice: unknownAnswerabilityNotice(`session ${threadId}`),
  };
}

/** Index decorated summaries by thread id for the joins above. */
export function sessionsByThreadId(
  sessions: OrchestrationSessionSummary[],
): Map<string, OrchestrationSessionSummary> {
  return new Map(sessions.map((session) => [session.threadId, session]));
}
