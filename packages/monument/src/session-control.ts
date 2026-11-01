import { createHash } from 'node:crypto';
import type { KernelCommand, KernelResult } from './commands.js';

export interface SessionControlRequestKeyId {
  readonly callerSessionId: string;
  readonly tool: string;
  readonly key: string;
}

export type SessionControlKeyClaim =
  /** A new request: run it. */
  | { readonly kind: 'claimed' }
  /** An earlier attempt left no result: run it again with its recorded decision. */
  | { readonly kind: 'resumed'; readonly decision?: string }
  /** The same request is running right now in this process. */
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'replay'; readonly result: unknown }
  | { readonly kind: 'conflict' }
  /** `caller`: all of this caller's rows are unresolved; `station`: the backstop. */
  | { readonly kind: 'capacity'; readonly scope: 'caller' | 'station' };

export interface SessionControlRequestKeys {
  /** Claim the key for a request with this digest. */
  claim(id: SessionControlRequestKeyId, digest: string): SessionControlKeyClaim;
  /** Persist what the attempt decided to do, before it does it. */
  recordDecision(id: SessionControlRequestKeyId, decision: string): void;
  /** Persist the final result; later same-digest claims replay it. */
  complete(id: SessionControlRequestKeyId, result: unknown): void;
  /** Free a key whose attempt provably had no effect, so a retry may run. */
  release(id: SessionControlRequestKeyId): void;
  /** Stop treating the attempt as running here; the claim stays for a replay. */
  settle(id: SessionControlRequestKeyId): void;
}

const sessionControlKeyIdentity = (id: SessionControlRequestKeyId): string =>
  JSON.stringify([id.callerSessionId, id.tool, id.key]);

/** The digest of what a request asks for; a different ask is a different digest. */
export function sessionControlRequestDigest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * The id the delivery layers see for a request (`clientTurnId` of a start,
 * `clientInputId` of a steer): a function of the verified caller, the tool and
 * the key, so a replay presents the same id and the layer below deduplicates.
 */
export function sessionControlDeliveryId(
  id: SessionControlRequestKeyId,
): string {
  return `sc-${createHash('sha256').update(sessionControlKeyIdentity(id)).digest('hex').slice(0, 40)}`;
}

/** What one attempt reports back to {@link runWithSessionControlKey}. */
export type SessionControlAttempt<Result> =
  /** The request is answered; store the result for replays. */
  | { readonly settle: 'final'; readonly result: Result }
  /**
   * It provably had no effect (a clean failure): free the key. Honoured only
   * for a fresh claim; a re-driven (resumed) claim is kept instead.
   */
  | { readonly settle: 'release'; readonly result: Result }
  /** It may have had its effect: keep the claim, store nothing. */
  | { readonly settle: 'pending'; readonly result: Result };

export type SessionControlKeyedOutcome<Result> =
  | { readonly kind: 'executed'; readonly result: Result }
  | { readonly kind: 'replayed'; readonly result: Result }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'capacity'; readonly scope: 'caller' | 'station' };

/**
 * Run one keyed request exactly as the table says: claim, attempt, settle. A
 * thrown attempt is treated as `pending`: the effect may have happened, so the
 * claim stays and a replay re-drives it with its recorded decision.
 */
export async function runWithSessionControlKey<Result>(
  keys: SessionControlRequestKeys,
  id: SessionControlRequestKeyId,
  digest: string,
  attempt: (resume: {
    readonly decision?: string;
    recordDecision(decision: string): void;
  }) => Promise<SessionControlAttempt<Result>>,
): Promise<SessionControlKeyedOutcome<Result>> {
  const claim = keys.claim(id, digest);
  switch (claim.kind) {
    case 'conflict':
    case 'in-progress':
      return { kind: claim.kind };
    case 'capacity':
      return { kind: 'capacity', scope: claim.scope };
    case 'replay':
      return { kind: 'replayed', result: claim.result as Result };
    case 'claimed':
    case 'resumed':
      break;
  }
  let outcome: SessionControlAttempt<Result>;
  try {
    outcome = await attempt({
      ...(claim.kind === 'resumed' && claim.decision !== undefined
        ? { decision: claim.decision }
        : {}),
      recordDecision: (decision) => keys.recordDecision(id, decision),
    });
  } catch (error) {
    keys.settle(id);
    throw error;
  }
  if (outcome.settle === 'final') keys.complete(id, outcome.result);
  // Only a FRESH claim can be freed: no earlier attempt of it existed that
  // could have had its effect. A resumed claim is an earlier attempt that may
  // have delivered; deleting it would also delete the branch it pinned, and a
  // later call would claim afresh and could deliver the same text again by the
  // other branch. Whatever a re-drive reports, a resumed claim stays.
  else if (outcome.settle === 'release' && claim.kind === 'claimed')
    keys.release(id);
  else keys.settle(id);
  return { kind: 'executed', result: outcome.result };
}

export function createSessionControlRequestKeys(
  execute: <C extends KernelCommand>(command: C) => KernelResult<C>,
  now: () => number,
): SessionControlRequestKeys {
  // Attempts running in THIS process. A stored claim with no result and no
  // entry here is an attempt a crash or an indeterminate outcome left behind.
  const running = new Set<string>();

  return {
    claim(id, digest) {
      const claim = execute({
        type: 'requestKeys.claim',
        id,
        digest,
        now: now(),
      });
      switch (claim.kind) {
        case 'conflict':
          return { kind: 'conflict' };
        case 'replay':
          return {
            kind: 'replay',
            result: JSON.parse(claim.result) as unknown,
          };
        case 'unresolved': {
          const handle = sessionControlKeyIdentity(id);
          if (running.has(handle)) return { kind: 'in-progress' };
          running.add(handle);
          return {
            kind: 'resumed',
            ...(claim.decision !== undefined
              ? { decision: claim.decision }
              : {}),
          };
        }
        case 'capacity':
          return {
            kind: 'capacity',
            scope: claim.scope === 'store' ? 'station' : 'caller',
          };
        case 'claimed':
          running.add(sessionControlKeyIdentity(id));
          return { kind: 'claimed' };
        case 'refused':
          throw new Error(
            `Session control request key refused by ${claim.participant}: ${claim.reason}`,
          );
      }
    },
    recordDecision(id, decision) {
      execute({ type: 'requestKeys.recordDecision', id, decision });
    },
    complete(id, result) {
      try {
        const completed = execute({
          type: 'requestKeys.complete',
          id,
          result: JSON.stringify(result),
        });
        if (completed.kind !== 'applied')
          throw new Error('Session control request result was not recorded.');
      } finally {
        running.delete(sessionControlKeyIdentity(id));
      }
    },
    release(id) {
      try {
        execute({ type: 'requestKeys.release', id });
      } finally {
        running.delete(sessionControlKeyIdentity(id));
      }
    },
    settle(id) {
      running.delete(sessionControlKeyIdentity(id));
    },
  };
}
