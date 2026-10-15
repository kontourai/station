/**
 * Engine-neutral message delivery decisions and record-before-effect ordering.
 *
 * The host supplies already-authorized busy/start/steer ports. Invocation,
 * authentication, message schema and durable storage remain the host's job.
 * This sequence only pins a branch before calling an effect port and maps its
 * outcome; it does not run an engine or provide a durable inbox.
 *
 * The host deduplicates `deliveryId` as the `clientTurnId` of a start and the
 * `clientInputId` of a steer. `decided` pins a prior attempt, so a re-drive
 * never switches from steer to start because the turn ended in between.
 */

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

/** Outcomes the host's receipted steer port supplies. */
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
    readonly text: string;
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
  if (!input.decided) input.recordDecision?.(decision.branch);

  if (decision.branch === 'start') {
    const started = await ports.start({
      threadId: input.threadId,
      text: input.text,
      clientTurnId: input.deliveryId,
    });
    return started.outcome === 'started'
      ? started
      : { outcome: 'indeterminate' };
  }

  const steered = await ports.steer({
    threadId: input.threadId,
    text: input.text,
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
