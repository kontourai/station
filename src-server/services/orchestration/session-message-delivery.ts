/**
 * #3160: the one seam that puts a message into another Session.
 *
 * Station Control's `send_to_session` uses it, and the delegation result
 * delivery (#3158) will reuse it, so the rule for "idle: start a turn; busy:
 * steer it once or say busy" lives in one place.
 *
 * The seam decides and sequences; it performs nothing itself. The caller
 * supplies the ports (the live turn fold, a turn start, a receipted steer),
 * each already authorized for the acting principal. It never reads who may
 * send: the route that calls it has done that.
 *
 * Idempotence is the caller's job and is built into the inputs: `deliveryId`
 * is the `clientTurnId` of a start and the `clientInputId` of a steer, so the
 * layers below (the durable chat-turn claim, the steer receipt) deduplicate a
 * re-driven delivery. `decided` pins the branch a first attempt took, so a
 * re-drive never switches from a steer to a start because the turn ended in
 * between: that would deliver the same text twice.
 *
 * #3419: the text a port receives is never the sender's bare text. The seam
 * frames it (`frameAgentMessage`) as another agent's message, naming the
 * sender, so no caller can put an agent's words in front of an engine as if
 * the person had written them. The ports are handed the framed text; the
 * caller stamps the same sender on the turn's `clientOrigin` for the record.
 */
import type { ClientOriginSender } from '@kontourai/station-contracts/client-origin';
import { frameAgentMessage } from '@kontourai/station-shared/agent-message-frame';

export type SessionSendMode = 'auto' | 'start' | 'steer';

/** The branch that has an effect. */
export type SessionDeliveryBranch = 'start' | 'steer';

/** `start:<threadId>` / `steer:<threadId>`: the branch an attempt pinned. */
export function parseSessionDeliveryDecision(
  decision: string | undefined,
): { branch: SessionDeliveryBranch; threadId: string } | undefined {
  if (!decision) return undefined;
  const split = decision.indexOf(':');
  const branch = decision.slice(0, split);
  if (split < 1 || (branch !== 'start' && branch !== 'steer')) return undefined;
  return { branch, threadId: decision.slice(split + 1) };
}

export type SessionDeliveryDecision =
  | { readonly kind: 'deliver'; readonly branch: SessionDeliveryBranch }
  | {
      readonly kind: 'session_busy';
      /** `turn-active`: a start was asked for while a turn runs. */
      readonly reason: 'turn-active';
    }
  | { readonly kind: 'no_active_turn' };

/**
 * Which branch a send takes, from its mode and whether a turn is open.
 *
 * - `start`: only an idle Session starts a turn; a running one is busy.
 * - `steer`: only a running Session can be steered; an idle one has no turn.
 * - `auto`: steer a running Session, start an idle one.
 */
export function decideSessionDelivery(
  mode: SessionSendMode,
  busy: boolean,
): SessionDeliveryDecision {
  if (mode === 'start')
    return busy
      ? { kind: 'session_busy', reason: 'turn-active' }
      : { kind: 'deliver', branch: 'start' };
  if (mode === 'steer')
    return busy
      ? { kind: 'deliver', branch: 'steer' }
      : { kind: 'no_active_turn' };
  return { kind: 'deliver', branch: busy ? 'steer' : 'start' };
}

/** A receipted steer's outcomes (`SteerTurnResult`), as the seam consumes them. */
export type SessionSteerResult =
  | { readonly outcome: 'steered'; readonly turnId: string }
  | { readonly outcome: 'indeterminate' }
  | { readonly outcome: 'no-active-turn' }
  | { readonly outcome: 'unsupported-engine' }
  | { readonly outcome: 'concurrent-steer' };

export type SessionStartResult =
  | {
      readonly outcome: 'started';
      readonly conversationId: string;
      readonly sessionId: string;
      readonly turnId: string;
    }
  /** The turn may have started; it must not be sent again. */
  | { readonly outcome: 'indeterminate' };

export interface SessionMessageDeliveryPorts {
  /** Whether the Session has a turn open or in flight right now. */
  isBusy(threadId: string): boolean;
  /** Start a turn with this text; throws when the start was cleanly refused. */
  start(input: {
    readonly threadId: string;
    readonly text: string;
    readonly clientTurnId: string;
  }): Promise<SessionStartResult>;
  /** Steer the running turn once (`steerTurnOnce`); a failure reads `indeterminate`. */
  steer(input: {
    readonly threadId: string;
    readonly text: string;
    readonly clientInputId: string;
  }): Promise<SessionSteerResult>;
}

export type SessionMessageDelivery =
  | {
      readonly outcome: 'started';
      readonly conversationId: string;
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly outcome: 'steered';
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly outcome: 'session_busy';
      /**
       * `turn-active`: a start was asked for while a turn runs.
       * `steer-unsupported`: the engine cannot take input mid-turn.
       * `steer-in-flight`: another steer to this Session is still settling.
       */
      readonly reason: 'turn-active' | 'steer-unsupported' | 'steer-in-flight';
    }
  | { readonly outcome: 'no_active_turn' }
  /** The message may have been delivered; do not send it again. */
  | { readonly outcome: 'indeterminate' };

export async function deliverSessionMessage(
  ports: SessionMessageDeliveryPorts,
  input: {
    readonly threadId: string;
    /** The sender's own text; the seam frames it before any port sees it. */
    readonly text: string;
    /** Who is sending: named in the frame the receiving engine reads. */
    readonly sender: ClientOriginSender;
    readonly mode: SessionSendMode;
    /** The id the layers below deduplicate on (see the module note). */
    readonly deliveryId: string;
    /** The branch an earlier attempt of this same request took, if any. */
    readonly decided?: SessionDeliveryBranch;
    /** Persist the branch before its effect, so a re-drive can pin it. */
    readonly recordDecision?: (branch: SessionDeliveryBranch) => void;
  },
): Promise<SessionMessageDelivery> {
  const decision: SessionDeliveryDecision = input.decided
    ? { kind: 'deliver', branch: input.decided }
    : decideSessionDelivery(input.mode, ports.isBusy(input.threadId));
  if (decision.kind === 'session_busy')
    return { outcome: 'session_busy', reason: decision.reason };
  if (decision.kind === 'no_active_turn') return { outcome: 'no_active_turn' };
  // Framed before the branch is pinned, so a sender that cannot be framed
  // leaves no pinned decision behind for an effect that never happened.
  const text = frameAgentMessage(input.sender, input.text);
  if (!input.decided) input.recordDecision?.(decision.branch);

  if (decision.branch === 'start') {
    const started = await ports.start({
      threadId: input.threadId,
      text,
      clientTurnId: input.deliveryId,
    });
    return started.outcome === 'started'
      ? started
      : { outcome: 'indeterminate' };
  }

  const steered = await ports.steer({
    threadId: input.threadId,
    text,
    clientInputId: input.deliveryId,
  });
  switch (steered.outcome) {
    case 'steered':
      return {
        outcome: 'steered',
        sessionId: input.threadId,
        turnId: steered.turnId,
      };
    case 'indeterminate':
      return { outcome: 'indeterminate' };
    case 'no-active-turn':
      return { outcome: 'no_active_turn' };
    case 'unsupported-engine':
      return { outcome: 'session_busy', reason: 'steer-unsupported' };
    case 'concurrent-steer':
      return { outcome: 'session_busy', reason: 'steer-in-flight' };
  }
}

/** What the turn ledger holds for a key across every Session of a conversation. */
export type ConversationKeyInspection =
  | { readonly outcome: 'not-received' | 'expired' }
  | {
      readonly outcome: 'received' | 'indeterminate';
      /** The Session whose live claim holds it, when known. */
      readonly sessionId?: string;
      /**
       * Indeterminate only by age: a live or unknown owner's claim past the
       * in-flight bound, which may still resolve (#3660).
       */
      readonly ageOnly?: true;
    }
  | {
      readonly outcome: 'started';
      readonly sessionId: string;
      readonly turnId: string;
    }
  | null
  | undefined;

/** `client_turn_in_flight`: another attempt still holds the key. */
const KEY_IN_FLIGHT_CODE = 'client_turn_in_flight';

/** Refused as retryable: another attempt still holds the key; nothing sent. */
export function keyInFlightError(): Error {
  return Object.assign(
    new Error('An earlier attempt of this message still holds its key.'),
    { code: KEY_IN_FLIGHT_CODE },
  );
}

/**
 * #3568: what the whole conversation's turn ledger says about a key, as the
 * one rule every start that may land in a new Session applies before it
 * starts. Turn deduplication is per Session, and a continuation reserves a
 * successor Session when the one an earlier attempt used has ended, or the
 * requested model needs a restart, so a start that went straight to its
 * Session could send the same text again under a claim of its own:
 *
 * - `started`: an earlier attempt's turn; answered without sending;
 * - `may-have-been-sent` (`indeterminate` or `expired`): never sent again.
 *   Only a claim given up after a possible effect, a dead owner's, or an
 *   expired one: an unresolved claim that is only old (`ageOnly`) is
 *   `in-flight`, since a live owner may still deliver it (#3660);
 * - `in-flight` (`received`): a live attempt still holds the key, on
 *   `sessionId` when known; nothing sent, and a caller may join that turn;
 * - `start` (`not-received`, or nothing materialized yet): no Session took
 *   it, so it is safe to start in whichever Session the continuation picks.
 */
export function conversationKeyDecision(held: ConversationKeyInspection):
  | {
      readonly kind: 'started';
      readonly sessionId: string;
      readonly turnId: string;
    }
  | { readonly kind: 'in-flight'; readonly sessionId?: string }
  | { readonly kind: 'may-have-been-sent' | 'start' } {
  if (held?.outcome === 'started')
    return { kind: 'started', sessionId: held.sessionId, turnId: held.turnId };
  if (
    held?.outcome === 'received' ||
    (held?.outcome === 'indeterminate' && held.ageOnly)
  )
    return {
      kind: 'in-flight',
      ...(held.sessionId ? { sessionId: held.sessionId } : {}),
    };
  if (held?.outcome === 'indeterminate' || held?.outcome === 'expired')
    return { kind: 'may-have-been-sent' };
  return { kind: 'start' };
}

/**
 * #3568 fix round (D1): start a re-drivable delivery only when no Session of
 * the conversation holds its key (`conversationKeyDecision`).
 */
export async function startUnlessDelivered(input: {
  readonly conversationId: string;
  readonly inspect: () => ConversationKeyInspection;
  readonly start: () => Promise<SessionStartResult>;
}): Promise<SessionStartResult> {
  const decision = conversationKeyDecision(input.inspect());
  switch (decision.kind) {
    case 'started':
      return {
        outcome: 'started',
        conversationId: input.conversationId,
        sessionId: decision.sessionId,
        turnId: decision.turnId,
      };
    case 'may-have-been-sent':
      return { outcome: 'indeterminate' };
    case 'in-flight':
      throw keyInFlightError();
    case 'start':
      return input.start();
  }
}
