import type {
  ConversationContextBoundaryPolicy,
  ConversationContextBoundaryProjection,
} from '@kontourai/station-contracts/conversation-context-boundary';
import {
  type ApiRequestScope,
  useConversationContextBoundaryStatusQuery,
} from '@kontourai/station-sdk';
import { useSyncExternalStore } from 'react';

export interface ContextBoundaryAuthority {
  namespace: string;
  actorId: string;
  requestScope?: ApiRequestScope;
  isCurrent: () => boolean;
}

export interface ContextBoundaryScope extends ContextBoundaryAuthority {
  conversationId: string;
  sessionId: string;
}

type ResetPolicy = Extract<
  ConversationContextBoundaryPolicy,
  'continue-from-history' | 'empty-next-cold-start'
>;

interface StoredBoundary {
  idempotencyKey: string;
  policy: ResetPolicy;
  stopped?: boolean;
  boundaryId?: string;
}

interface BoundaryObservation extends StoredBoundary {
  legacy?: true;
}

const CHANGED_EVENT = 'station:context-boundary-change';

function scopedKey(scope: ContextBoundaryScope): string {
  return (
    'station.conversation-context-boundary.v2:' +
    [scope.namespace, scope.conversationId, scope.sessionId]
      .map(encodeURIComponent)
      .join(':')
  );
}

function legacyKey(conversationId: string): string {
  return (
    'station.conversation-context-boundary.v1:' +
    encodeURIComponent(conversationId)
  );
}

function readCandidate(
  scope: ContextBoundaryScope,
  raw: string,
): BoundaryObservation | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.idempotencyKey !== 'string' ||
      !value.idempotencyKey ||
      (value.policy !== 'continue-from-history' &&
        value.policy !== 'empty-next-cold-start')
    )
      return undefined;
    const { policy, idempotencyKey } = value;
    if ('conversationId' in value) {
      return value.conversationId === scope.conversationId &&
        typeof value.boundaryId === 'string'
        ? { policy, idempotencyKey, boundaryId: value.boundaryId, legacy: true }
        : undefined;
    }
    return {
      policy,
      idempotencyKey,
      ...(value.stopped === true ? { stopped: true } : {}),
      ...(typeof value.boundaryId === 'string'
        ? { boundaryId: value.boundaryId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function readRaw(scope: ContextBoundaryScope | undefined): string | null {
  if (!scope?.isCurrent()) return null;
  try {
    return (
      localStorage.getItem(scopedKey(scope)) ??
      localStorage.getItem(legacyKey(scope.conversationId))
    );
  } catch {
    return null;
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('storage', listener);
  window.addEventListener(CHANGED_EVENT, listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener(CHANGED_EVENT, listener);
  };
}

function matches(
  scope: ContextBoundaryScope,
  intent: BoundaryObservation,
  result: ConversationContextBoundaryProjection | undefined,
): result is ConversationContextBoundaryProjection {
  return Boolean(
    scope.isCurrent() &&
      result?.conversationId === scope.conversationId &&
      result.predecessorSessionId === scope.sessionId &&
      result.actorId === scope.actorId &&
      result.policy === intent.policy &&
      (!intent.boundaryId || intent.boundaryId === result.boundaryId),
  );
}

/** A reset must be recoverable before its POST is dispatched. */
export function rememberContextBoundaryIntent(
  scope: ContextBoundaryScope,
  intent: StoredBoundary,
): boolean {
  if (!scope.isCurrent()) return false;
  try {
    localStorage.setItem(scopedKey(scope), JSON.stringify(intent));
    window.dispatchEvent(new Event(CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function forgetContextBoundaryIntent(
  scope: ContextBoundaryScope,
  idempotencyKey: string,
): void {
  if (!scope.isCurrent()) return;
  try {
    const raw = localStorage.getItem(scopedKey(scope));
    if (!raw || readCandidate(scope, raw)?.idempotencyKey !== idempotencyKey)
      return;
    localStorage.removeItem(scopedKey(scope));
    window.dispatchEvent(new Event(CHANGED_EVENT));
  } catch {
    // Reopening can still check a retained key against Station.
  }
}

export function observeContextBoundary(
  scope: ContextBoundaryScope,
  intent: BoundaryObservation,
  result: ConversationContextBoundaryProjection,
): boolean {
  if (!matches(scope, intent, result)) return false;
  const raw = readRaw(scope);
  if (
    !raw ||
    readCandidate(scope, raw)?.idempotencyKey !== intent.idempotencyKey
  )
    return false;
  const terminal =
    result.status === 'cancelled' || result.status === 'consumed';
  if (terminal) {
    forgetContextBoundaryIntent(scope, intent.idempotencyKey);
  } else if (intent.legacy || intent.boundaryId !== result.boundaryId) {
    if (
      !rememberContextBoundaryIntent(scope, {
        policy: intent.policy,
        idempotencyKey: intent.idempotencyKey,
        ...(intent.stopped ? { stopped: true } : {}),
        boundaryId: result.boundaryId,
      })
    )
      return false;
  }

  // Retire the v1 hint only after exact confirmation and, while active,
  // successful storage under the verified authority.
  if (intent.legacy) {
    try {
      if (localStorage.getItem(legacyKey(scope.conversationId)) === raw) {
        localStorage.removeItem(legacyKey(scope.conversationId));
        window.dispatchEvent(new Event(CHANGED_EVENT));
      }
    } catch {
      // Keep the hint when storage cannot be updated.
    }
  }
  return true;
}

export function useContextBoundaryRecovery(
  scope: ContextBoundaryScope | undefined,
  apiBase: string,
) {
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(scope),
    () => null,
  );
  const candidate = scope && raw ? readCandidate(scope, raw) : undefined;
  const query = useConversationContextBoundaryStatusQuery(
    scope?.conversationId ?? '',
    candidate?.idempotencyKey ?? '',
    apiBase,
    {
      enabled: Boolean(candidate),
      refetchInterval: candidate?.legacy ? 0 : 2_000,
      ...(scope?.requestScope ? { requestScope: scope.requestScope } : {}),
    },
  );
  const boundary =
    scope && candidate && matches(scope, candidate, query.data)
      ? query.data
      : undefined;
  return { candidate, boundary, refetch: query.refetch };
}
