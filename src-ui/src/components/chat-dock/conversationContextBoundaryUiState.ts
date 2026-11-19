import type {
  ConversationContextBoundaryPolicy,
  ConversationContextBoundaryProjection,
} from '@kontourai/station-contracts/conversation-context-boundary';
import {
  type ApiRequestScope,
  useConversationContextBoundaryStatusQuery,
} from '@kontourai/station-sdk';
import { ChatHttpError } from '@kontourai/station-sdk/client';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

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
  recordedAt?: number;
  boundaryId?: string;
}

interface BoundaryObservation extends StoredBoundary {
  legacy?: true;
}

const CHANGED_EVENT = 'station:context-boundary-change';

function scopedPrefix(scope: ContextBoundaryScope): string {
  return (
    'station.conversation-context-boundary.v2:' +
    [scope.namespace, scope.conversationId, scope.sessionId]
      .map(encodeURIComponent)
      .join(':')
  );
}

function scopedKey(scope: ContextBoundaryScope, key: string): string {
  return `${scopedPrefix(scope)}:${encodeURIComponent(key)}`;
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
      ...(typeof value.recordedAt === 'number'
        ? { recordedAt: value.recordedAt }
        : {}),
      ...(typeof value.boundaryId === 'string'
        ? { boundaryId: value.boundaryId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function readCandidates(
  scope: ContextBoundaryScope | undefined,
): string | null {
  if (!scope?.isCurrent()) return null;
  try {
    const prefix = `${scopedPrefix(scope)}:`;
    const candidates: StoredBoundary[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      const candidate = raw && readCandidate(scope, raw);
      if (candidate && scopedKey(scope, candidate.idempotencyKey) === key)
        candidates.push(candidate);
    }
    candidates.sort(
      (left, right) =>
        Number(Boolean(right.boundaryId)) - Number(Boolean(left.boundaryId)) ||
        (left.recordedAt ?? 0) - (right.recordedAt ?? 0) ||
        left.idempotencyKey.localeCompare(right.idempotencyKey),
    );
    const raw = localStorage.getItem(legacyKey(scope.conversationId));
    const legacy = raw && readCandidate(scope, raw);
    if (
      legacy &&
      !candidates.some(
        (candidate) => candidate.idempotencyKey === legacy.idempotencyKey,
      )
    )
      candidates.push(legacy);
    return candidates.length ? JSON.stringify(candidates) : null;
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
    localStorage.setItem(
      scopedKey(scope, intent.idempotencyKey),
      JSON.stringify({
        idempotencyKey: intent.idempotencyKey,
        policy: intent.policy,
        recordedAt: intent.recordedAt ?? Date.now(),
        ...(intent.stopped ? { stopped: true } : {}),
        ...(intent.boundaryId ? { boundaryId: intent.boundaryId } : {}),
      }),
    );
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
    const key = scopedKey(scope, idempotencyKey);
    if (localStorage.getItem(key) === null) return;
    localStorage.removeItem(key);
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
  let raw: string | null;
  try {
    raw = localStorage.getItem(
      intent.legacy
        ? legacyKey(scope.conversationId)
        : scopedKey(scope, intent.idempotencyKey),
    );
  } catch {
    return false;
  }
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
        recordedAt: intent.recordedAt,
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
    () => readCandidates(scope),
    () => null,
  );
  const candidates = useMemo(
    () => (raw ? (JSON.parse(raw) as BoundaryObservation[]) : []),
    [raw],
  );
  const [probe, setProbe] = useState<{ raw: string; index: number }>();
  const index = probe?.raw === raw ? probe.index : 0;
  const candidate = candidates[index];
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
  useEffect(() => {
    if (
      raw &&
      query.error instanceof ChatHttpError &&
      query.error.stationEnvelope &&
      query.error.status === 404 &&
      index + 1 < candidates.length
    )
      setProbe({ raw, index: index + 1 });
  }, [raw, query.error, index, candidates.length]);
  return {
    candidate,
    boundary,
    refreshCurrent: query.refetch,
    refetch: () => {
      if (index > 0) setProbe(undefined);
      else void query.refetch();
    },
  };
}
