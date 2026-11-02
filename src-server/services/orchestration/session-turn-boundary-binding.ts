import type {
  RecoveryLedgerProcessIdentity,
  RecoveryOwner,
} from '@kontourai/monument/recovery';
import {
  type BoundaryTerminal,
  createSessionTurnBoundaryAuthority as createAuthority,
  createInMemorySessionTurnBoundaryAuthority as createMemoryAuthority,
  ORCHESTRATION_SHUTDOWN_EXIT_REASON,
  type SessionTurnBoundaryAuthority as PortableAuthority,
  type SessionTurnBoundaryClaim as PortableClaim,
  type SessionTurnBoundaryCoordinator as PortableCoordinator,
  SHUTDOWN_RETAINED_BOUNDARIES,
} from '@kontourai/monument/session-boundary';
import {
  PROVIDER_FAILURE_RETRYABLE,
  type ProviderFailure,
  SESSION_START_INDETERMINATE_CODE,
} from '@kontourai/station-contracts/provider-failure';
import {
  type CanonicalRuntimeEvent,
  isDeferredRetriableTurnError,
} from '@kontourai/station-contracts/runtime-events';
import { SessionStartRefusedError } from '../../providers/adapter-shape.js';
import type { CapturedTurnIntent } from './prepared-turn-intent.js';
import type { TurnClaim } from './turn-deduplicator.js';

export { SESSION_START_INDETERMINATE_CODE } from '@kontourai/station-contracts/provider-failure';

import type { SessionStartBoundaryClaim } from '@kontourai/monument/session-boundary';

export type SessionTurnBoundaryCoordinator = PortableCoordinator<
  CapturedTurnIntent,
  TurnClaim
>;
export type SessionTurnBoundaryClaim = PortableClaim<
  CapturedTurnIntent,
  TurnClaim
>;
export type SessionTurnBoundaryAuthority = PortableAuthority<
  CapturedTurnIntent,
  TurnClaim,
  CanonicalRuntimeEvent
>;

function terminalFromEvent(
  event: CanonicalRuntimeEvent,
): BoundaryTerminal | undefined {
  if (
    event.method !== 'turn.completed' &&
    event.method !== 'turn.aborted' &&
    event.method !== 'runtime.error' &&
    event.method !== 'session.exited'
  )
    return undefined;
  const retire = !(
    (event.method === 'runtime.error' &&
      (event.code === SESSION_START_INDETERMINATE_CODE ||
        isDeferredRetriableTurnError(event))) ||
    (event.method === 'turn.aborted' && event.recoveryTerminal === true)
  );
  if (!retire && event.invocationId === undefined) return undefined;
  const turnId = 'turnId' in event ? event.turnId : undefined;
  return {
    threadId: event.threadId,
    retire,
    ...(typeof turnId === 'string' ? { providerTurnId: turnId } : {}),
    ...(event.invocationId === undefined
      ? {}
      : { invocationId: event.invocationId }),
    sessionTerminal:
      event.method === 'session.exited' ||
      (event.method === 'runtime.error' &&
        typeof turnId !== 'string' &&
        event.invocationId === undefined),
    terminalCreatedAt: event.createdAt,
    terminalEventId: event.eventId,
    ...(event.method === 'session.exited' &&
    event.reason === ORCHESTRATION_SHUTDOWN_EXIT_REASON
      ? { retain: SHUTDOWN_RETAINED_BOUNDARIES }
      : {}),
  };
}

export function createSessionTurnBoundaryAuthority(options: {
  coordinator: SessionTurnBoundaryCoordinator;
  owner: RecoveryOwner;
  processIdentity: RecoveryLedgerProcessIdentity;
}): SessionTurnBoundaryAuthority {
  return createAuthority({ ...options, terminalFromEvent });
}

export function createInMemorySessionTurnBoundaryAuthority(): SessionTurnBoundaryAuthority {
  return createMemoryAuthority<
    CapturedTurnIntent,
    TurnClaim,
    CanonicalRuntimeEvent
  >(terminalFromEvent);
}

/** Terminate an engine message so the explanation that follows reads as its own sentence. */
function sentence(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? `${trimmed} ` : `${trimmed}. `;
}

export class SessionStartIndeterminateError
  extends Error
  implements ProviderFailure
{
  readonly kind = 'indeterminate';
  readonly failurePhase = 'indeterminate';
  get retryable(): boolean {
    return PROVIDER_FAILURE_RETRYABLE[this.kind];
  }
  readonly code = SESSION_START_INDETERMINATE_CODE;
  constructor(cause?: unknown, reportedMessage?: string) {
    super(
      reportedMessage ??
        `${cause instanceof Error ? sentence(cause.message) : ''}Provider session creation may have completed. Inspect the session before retrying.`,
      { cause },
    );
    this.name = 'SessionStartIndeterminateError';
  }
}

/** Invoke only after policy/resource admission; retain uncertainty across restart. */
export async function runSessionStartWithBoundary<T>(
  authority: SessionTurnBoundaryAuthority,
  threadId: string,
  invoke: () => Promise<T>,
  admission?: SessionStartBoundaryClaim,
): Promise<T> {
  if (admission && admission.threadId !== threadId)
    throw new Error(
      'Session start admission does not match the requested session.',
    );
  const owned = admission
    ? { kind: 'owner' as const, claim: admission }
    : authority.claimSessionStart(threadId, new Date().toISOString());
  if (owned.kind !== 'owner')
    throw new Error(
      'Session start admission is unavailable; no provider call was made.',
    );
  if (
    owned.claim.beginInvocation(new Date().toISOString()).kind !== 'applied'
  ) {
    owned.claim.indeterminate(new Date().toISOString());
    throw new Error(
      'Session start admission is unavailable; no provider call was made.',
    );
  }
  let result: T;
  try {
    result = await invoke();
  } catch (error) {
    // A definitive refusal settles the start: the thread is not fenced behind
    // an inspection that has nothing to find. Anything the claim cannot confirm
    // releasing stays the conservative indeterminate start.
    if (
      error instanceof SessionStartRefusedError &&
      owned.claim.refused?.().kind === 'applied'
    )
      throw error;
    owned.claim.indeterminate(new Date().toISOString());
    throw new SessionStartIndeterminateError(error);
  }
  if (owned.claim.started().kind !== 'applied')
    throw new SessionStartIndeterminateError();
  return result;
}
