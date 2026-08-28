/**
 * Process-local admission for a reviewed Session work-item projection.
 *
 * This is deliberately not an EventStore, MCP, or projection API. The staged
 * candidate cannot be parsed or persisted as a durable association: only an
 * ordered canonical tool terminal supplies eventId and observedAt at `take`.
 */
import type { ToolCompletedEvent } from '@kontourai/station-contracts/runtime-events';
import {
  parseSessionWorkItemAssociation,
  type SessionWorkItemAssociation,
} from '@kontourai/station-contracts/session-work-item';
import {
  isIssuedSessionWorkItemCandidate,
  parseSessionWorkItemCandidate,
  type SessionWorkItemCandidate,
} from './session-work-item-candidate.js';

export const SESSION_WORK_ITEM_ADMISSION_TTL_MS = 60_000;
export const SESSION_WORK_ITEM_ADMISSION_MAX_ENTRIES = 256;
export const SESSION_WORK_ITEM_ADMISSION_MAX_PER_SESSION = 16;

const admissionClaimBrand = Symbol('session-work-item-admission-claim');
/** Opaque process-local claim; it cannot be reconstructed from JSON. */
export type SessionWorkItemAdmissionClaim = Readonly<{
  readonly [admissionClaimBrand]: true;
}>;

export type SessionWorkItemAdmissionStageOutcome =
  | { kind: 'staged' }
  | {
      kind: 'refused';
      reason:
        | 'authority-lost'
        | 'invalid-candidate'
        | 'duplicate'
        | 'closed'
        | 'global-capacity'
        | 'session-capacity';
    };

export type SessionWorkItemAdmissionTakeOutcome =
  | {
      kind: 'taken';
      claim: SessionWorkItemAdmissionClaim;
      association: SessionWorkItemAssociation;
    }
  | {
      /** A terminal failure has no association, but still closes this tuple. */
      kind: 'closed';
      claim: SessionWorkItemAdmissionClaim;
      reason: 'failed' | 'cancelled' | 'authority-lost';
    }
  | {
      kind: 'refused';
      reason:
        | 'missing'
        | 'claimed'
        | 'closed'
        | 'replay'
        | 'mismatch'
        | 'failed'
        | 'cancelled'
        | 'authority-lost';
    };

export type SessionWorkItemAdmissionClaimOutcome =
  | { kind: 'committed' }
  | { kind: 'rolled-back' }
  | { kind: 'refused'; reason: 'invalid-claim' };

/**
 * These are server-owned canonical facts. In particular, `output` and
 * `error` are intentionally absent, so this registry cannot retain raw MCP
 * result material by construction.
 */
export type SessionWorkItemCanonicalToolCompletion = Omit<
  Pick<
    ToolCompletedEvent,
    'eventId' | 'threadId' | 'turnId' | 'toolCallId' | 'method' | 'status'
  >,
  'turnId'
> & {
  conversationId: string;
  turnId: string;
  observedAt: string;
};

export interface SessionWorkItemAdmissionRegistry {
  stage(input: {
    /** Must be an already-projected, server-only pre-terminal candidate. */
    candidate: SessionWorkItemCandidate;
    /** Rechecked at terminal take; false closes this exact source tuple. */
    current: () => boolean;
  }): SessionWorkItemAdmissionStageOutcome;
  /**
   * Atomically moves one pending candidate to an opaque in-flight claim. The
   * caller must `commit` only after its SQLite SAVEPOINT has been released,
   * or `rollback` after that write path fails.
   */
  take(
    completion: SessionWorkItemCanonicalToolCompletion,
  ): SessionWorkItemAdmissionTakeOutcome;
  commit(
    claim: SessionWorkItemAdmissionClaim,
  ): SessionWorkItemAdmissionClaimOutcome;
  rollback(
    claim: SessionWorkItemAdmissionClaim,
  ): SessionWorkItemAdmissionClaimOutcome;
}

type Pending = {
  candidate: SessionWorkItemCandidate;
  current: () => boolean;
  expiresAt: number;
};
type Claimed = Pending & { key: string; eventId: string };
type Closed = { sessionId: string; eventId?: string; expiresAt: number };

function keyOf(input: {
  sessionId: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
}): string {
  return JSON.stringify([
    input.sessionId,
    input.conversationId,
    input.turnId,
    input.toolCallId,
  ]);
}

function isCurrent(current: () => boolean): boolean {
  try {
    return current() === true;
  } catch {
    return false;
  }
}

/**
 * Builds a bounded, two-phase registry. `maxPending` remains a compatibility
 * alias for the total live-entry cap; closed replay fences count toward it.
 */
export function createSessionWorkItemAdmissionRegistry(
  input: {
    now?: () => number;
    ttlMs?: number;
    maxEntries?: number;
    maxPending?: number;
    maxPerSession?: number;
  } = {},
): SessionWorkItemAdmissionRegistry {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? SESSION_WORK_ITEM_ADMISSION_TTL_MS;
  const maxEntries =
    input.maxEntries ??
    input.maxPending ??
    SESSION_WORK_ITEM_ADMISSION_MAX_ENTRIES;
  const maxPerSession =
    input.maxPerSession ?? SESSION_WORK_ITEM_ADMISSION_MAX_PER_SESSION;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isSafeInteger(maxPerSession) ||
    maxPerSession < 1
  )
    throw new Error(
      'Session work-item admission bounds must be positive integers.',
    );

  const pending = new Map<string, Pending>();
  const pendingBySession = new Map<string, Set<string>>();
  const entriesBySession = new Map<string, Set<string>>();
  const claims = new WeakMap<object, Claimed>();
  const claimsByKey = new Map<string, SessionWorkItemAdmissionClaim>();
  const closed = new Map<string, Closed>();

  const entryCount = () => pending.size + claimsByKey.size + closed.size;
  const removeSessionEntry = (sessionId: string, key: string) => {
    const entries = entriesBySession.get(sessionId);
    entries?.delete(key);
    if (entries?.size === 0) entriesBySession.delete(sessionId);
  };
  const removePending = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    const sessionEntries = pendingBySession.get(entry.candidate.sessionId);
    sessionEntries?.delete(key);
    if (sessionEntries?.size === 0)
      pendingBySession.delete(entry.candidate.sessionId);
  };
  const prune = () => {
    const at = now();
    for (const [key, entry] of pending) {
      if (entry.expiresAt <= at) {
        removePending(key);
        removeSessionEntry(entry.candidate.sessionId, key);
      }
    }
    // Claims are output-savepoint fences and remain live through TTL until
    // their exact caller settles them. Never evict them for capacity.
    for (const [key, entry] of closed) {
      if (entry.expiresAt <= at) {
        closed.delete(key);
        removeSessionEntry(entry.sessionId, key);
      }
    }
  };

  return {
    stage({ candidate, current }) {
      prune();
      if (!isCurrent(current))
        return { kind: 'refused', reason: 'authority-lost' };
      if (!isIssuedSessionWorkItemCandidate(candidate))
        return { kind: 'refused', reason: 'invalid-candidate' };
      const parsed = parseSessionWorkItemCandidate(candidate);
      if (!parsed) return { kind: 'refused', reason: 'invalid-candidate' };
      const key = keyOf(parsed);
      if (closed.has(key)) return { kind: 'refused', reason: 'closed' };
      if (claimsByKey.has(key)) return { kind: 'refused', reason: 'duplicate' };
      if (pending.has(key)) return { kind: 'refused', reason: 'duplicate' };
      if (entryCount() >= maxEntries)
        return { kind: 'refused', reason: 'global-capacity' };
      if ((entriesBySession.get(parsed.sessionId)?.size ?? 0) >= maxPerSession)
        return { kind: 'refused', reason: 'session-capacity' };
      // Parsing untrusted candidate data can invoke getters before rejecting;
      // only a post-parse current authority may receive a pending slot.
      if (!isCurrent(current))
        return { kind: 'refused', reason: 'authority-lost' };
      pending.set(key, {
        candidate,
        current,
        expiresAt: now() + ttlMs,
      });
      const sessionEntries =
        pendingBySession.get(parsed.sessionId) ?? new Set<string>();
      sessionEntries.add(key);
      pendingBySession.set(parsed.sessionId, sessionEntries);
      const allSessionEntries =
        entriesBySession.get(parsed.sessionId) ?? new Set<string>();
      allSessionEntries.add(key);
      entriesBySession.set(parsed.sessionId, allSessionEntries);
      return { kind: 'staged' };
    },

    take(completion) {
      prune();
      const key = keyOf({
        sessionId: completion.threadId,
        conversationId: completion.conversationId,
        turnId: completion.turnId,
        toolCallId: completion.toolCallId,
      });
      const prior = closed.get(key);
      if (prior)
        return {
          kind: 'refused',
          reason: prior.eventId === completion.eventId ? 'replay' : 'closed',
        };
      if (claimsByKey.has(key)) return { kind: 'refused', reason: 'claimed' };
      const entry = pending.get(key);
      if (!entry) return { kind: 'refused', reason: 'missing' };
      if (completion.method !== 'tool.completed')
        return { kind: 'refused', reason: 'mismatch' };
      const closeReason =
        completion.status !== 'success'
          ? completion.status === 'cancelled'
            ? ('cancelled' as const)
            : ('failed' as const)
          : !isCurrent(entry.current)
            ? ('authority-lost' as const)
            : undefined;
      if (closeReason) {
        removePending(key);
        const claim = Object.freeze({
          [admissionClaimBrand]: true as const,
        }) as SessionWorkItemAdmissionClaim;
        claims.set(claim, { ...entry, key, eventId: completion.eventId });
        claimsByKey.set(key, claim);
        return { kind: 'closed', claim, reason: closeReason };
      }
      const association = parseSessionWorkItemAssociation({
        ...entry.candidate,
        eventId: completion.eventId,
        observedAt: completion.observedAt,
      });
      if (!association) return { kind: 'refused', reason: 'mismatch' };
      if (
        association.sessionId !== completion.threadId ||
        association.conversationId !== completion.conversationId ||
        association.turnId !== completion.turnId ||
        association.toolCallId !== completion.toolCallId
      )
        return { kind: 'refused', reason: 'mismatch' };
      removePending(key);
      const claim = Object.freeze({
        [admissionClaimBrand]: true as const,
      }) as SessionWorkItemAdmissionClaim;
      claims.set(claim, { ...entry, key, eventId: association.eventId });
      claimsByKey.set(key, claim);
      return { kind: 'taken', claim, association };
    },

    commit(claim) {
      const entry = claims.get(claim);
      if (!entry || claimsByKey.get(entry.key) !== claim)
        return { kind: 'refused', reason: 'invalid-claim' };
      claims.delete(claim);
      claimsByKey.delete(entry.key);
      closed.set(entry.key, {
        sessionId: entry.candidate.sessionId,
        eventId: entry.eventId,
        expiresAt: now() + ttlMs,
      });
      return { kind: 'committed' };
    },

    rollback(claim) {
      const entry = claims.get(claim);
      if (!entry || claimsByKey.get(entry.key) !== claim)
        return { kind: 'refused', reason: 'invalid-claim' };
      claims.delete(claim);
      claimsByKey.delete(entry.key);
      // Preserve the original expiry and exact parsed candidate; a failed
      // SQLite append must not mint a fresh admission or widen its TTL.
      pending.set(entry.key, entry);
      const sessionEntries =
        pendingBySession.get(entry.candidate.sessionId) ?? new Set<string>();
      sessionEntries.add(entry.key);
      pendingBySession.set(entry.candidate.sessionId, sessionEntries);
      return { kind: 'rolled-back' };
    },
  };
}
