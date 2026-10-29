import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';
import type { OutboundDeliveryLookup } from './outboundQueue';

/**
 * Station's delivery lookup (`GET …/turn-deliveries/:key`) as the outbox and
 * the live send use it. Loaded only when a send is slow or a row needs
 * reconciling.
 */

/** No answer to a send after this long: ask Station whether it has it. */
export const IN_FLIGHT_FIRST_CHECK_MS = 5_000;
/** Backoff ceiling for asking again while Station keeps answering `received`. */
export const DELIVERY_CHECK_MAX_INTERVAL_MS = 30_000;

/** The conversation id a send named; a first send names its chat's id. */
export function lookupTurnDelivery(apiBase: string): OutboundDeliveryLookup {
  return async (turn) => {
    const { getTurnDelivery } = await import('@kontourai/station-sdk/client');
    return getTurnDelivery(
      apiBase,
      turn.conversationId ?? turn.sessionId,
      turn.clientTurnId,
      turn.projectSlug ? { projectSlug: turn.projectSlug } : undefined,
    );
  };
}

/**
 * While a send's request is still out, asks Station after
 * {@link IN_FLIGHT_FIRST_CHECK_MS} and then with doubling backoff what it knows
 * about the key, reporting each answer. Reports only: it never resends or
 * aborts, since the request in flight may still land. Stops at a final
 * answer (started, indeterminate, expired) or when the returned stop is
 * called.
 */
export function watchInFlightDelivery(input: {
  apiBase: string;
  conversationId: string;
  clientTurnId: string;
  projectSlug?: string;
  onAnswer: (outcome: TurnDeliveryOutcome) => void;
  firstCheckMs?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lookup = lookupTurnDelivery(input.apiBase);
  const schedule = (delay: number) => {
    timer = setTimeout(async () => {
      if (stopped) return;
      let outcome: TurnDeliveryOutcome | undefined;
      try {
        const answer = await lookup({
          clientTurnId: input.clientTurnId,
          conversationId: input.conversationId,
          sessionId: input.conversationId,
          projectSlug: input.projectSlug,
        } as Parameters<OutboundDeliveryLookup>[0]);
        if (answer.clientTurnId === input.clientTurnId)
          outcome = answer.outcome;
      } catch {
        // Unreachable right now; the request itself will settle or fail.
      }
      if (stopped) return;
      if (outcome) input.onAnswer(outcome);
      if (
        outcome === 'started' ||
        outcome === 'indeterminate' ||
        outcome === 'expired' ||
        outcome === 'unknown'
      )
        return;
      schedule(Math.min(delay * 2, DELIVERY_CHECK_MAX_INTERVAL_MS));
    }, delay);
  };
  schedule(input.firstCheckMs ?? IN_FLIGHT_FIRST_CHECK_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * The user's re-check of one unconfirmed message: asks the Station this
 * renderer is connected to about the message's own key and applies the
 * answer (`outboundDispatch.check`). Never resends: a row that proves never
 * received becomes not sent, for the user to retry with the same key.
 */
export async function recheckOutboundTurn(
  clientTurnId: string,
): Promise<TurnDeliveryOutcome | undefined> {
  const { outboundDispatch, currentOutboundStation } = await import(
    './outboundQueue'
  );
  const station = currentOutboundStation();
  if (!station) throw new Error('Reconnect before checking this message.');
  return outboundDispatch.check(
    clientTurnId,
    lookupTurnDelivery(station.apiBase),
  );
}
