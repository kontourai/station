import {
  INTERNAL_SESSION_READ_SCOPE,
  isSessionReadAuthority,
  type TenantExecutionContext,
} from '@kontourai/station-contracts/tenancy';
import type { ProviderSession } from '../../providers/adapter-shape.js';
import { sessionOwnerCacheOps } from '../../telemetry/metrics.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';
import type { EventStore } from './event-store.js';
// Type-only import back into the service module: erased at runtime, so no
// import cycle exists.
import type { SessionReadScope } from './orchestration-service.js';
import {
  anyPersonalOrchestrationStreamPresenceSubject,
  type OrchestrationStreamPresenceSubject,
  orchestrationStreamPresenceSubjectForSession,
} from './orchestration-stream-presence.js';

// archive#1120: bounded per-thread `threadId -> ownerUserId` cache backing
// `sessionOwnerUserId()` (the /events SSE route's per-event authorization
// gate). Sized like `attached-session-follow-service.ts`'s MAX_SEEN_EVENT_IDS
// LRU — generous relative to realistic concurrently-relevant thread counts.
const SESSION_OWNER_CACHE_MAX_ENTRIES = 2_048;

export interface SessionAuthorizationDeps {
  // Every dep is a raw option VALUE from OrchestrationServiceOptions —
  // this cluster calls no service method at all, which is what makes the
  // seam one-way. Pass the options raw (two different call forms exist for
  // requireTenantExecutionContext; ownerlessSessionAccess is compared as
  // its union, never normalized to a boolean).
  eventStore?: EventStore;
  requireTenantExecutionContext?: () => boolean;
  validateRecoveredTenantExecutionContext?: (
    context: TenantExecutionContext | undefined,
  ) => TenantExecutionContext | undefined;
  ownerlessSessionAccess?: 'deny' | 'single-user-compat';
  /**
   * One Station-home migration bridge for records written before principal
   * ownership existed. This is intentionally a single exact OS alias, not an
   * alias set and not a general personal-mode fallback.
   */
  legacyPersonalOwner?: string;
  sessionOwnerCacheMaxEntries?: number;
}

/**
 * Tenancy & owner authorization (epic archive#4024, archive#4166): the C8 cluster
 * from the seam map — the file's predicate hub (`canReadSession` was its
 * most-called private helper) and the first extracted cluster with ZERO
 * back-closures into sibling clusters, which is why both indexes
 * (`tenantContexts`, `sessionOwnerCache`) MOVE here rather than staying on
 * the service: after this slice, no code outside this module can write
 * either map. `cacheSessionOwner` is the owner cache's sole writer, so the
 * positive-only invariant its docblock argues is now structurally enforced.
 * The two `initialize()` latches (`canUserReadSession`,
 * `resolveSessionPresenceSubject`) stay on the service forwarders (T9).
 * `sessionOwnerUserId` widened from the service's `private` for its one
 * out-of-cluster caller (the station-agent turn-correlation branch).
 *
 * CONSTRUCT EXACTLY ONCE, in the OrchestrationService constructor. A second
 * instance holds empty maps and answers hosted reads `false` while every
 * C8-only test stays green — the split-map hazard the extraction plan named.
 */
export class SessionAuthorization {
  /** Never derived from command metadata; persists only in the event store. */
  private readonly tenantContexts = new Map<string, TenantExecutionContext>();
  /**
   * threadId -> ownerUserId (archive#1120). Backs `sessionOwnerUserId()`,
   * called per event per connected client from the `/events` SSE route's
   * `canUserReadSession` authorization gate. Only ever holds a POSITIVE,
   * already-resolved owner — see `cacheSessionOwner()`'s doc comment for
   * the safety argument. Bounded LRU (insertion order, refreshed on
   * access) via `SESSION_OWNER_CACHE_MAX_ENTRIES`.
   */
  private readonly sessionOwnerCache = new Map<string, string>();
  private readonly sessionOwnerCacheMaxEntries: number;
  /** Process-local currentness fence, not a second authorization/owner store. */
  private readGeneration = {};
  private transcriptReadsClosed = false;
  private readonly transcriptOwnerRead:
    | ReturnType<EventStore['createIsolatedTranscriptReads']>
    | undefined;

  constructor(private readonly deps: SessionAuthorizationDeps) {
    // Bind this owner's exact incarnation; old authorizers cannot borrow a
    // replacement runtime's worker. In-memory composition creates no worker.
    this.transcriptOwnerRead =
      typeof deps.eventStore?.createIsolatedTranscriptReads === 'function'
        ? deps.eventStore.createIsolatedTranscriptReads()
        : undefined;
    this.sessionOwnerCacheMaxEntries =
      deps.sessionOwnerCacheMaxEntries ?? SESSION_OWNER_CACHE_MAX_ENTRIES;
    if (
      !Number.isInteger(this.sessionOwnerCacheMaxEntries) ||
      this.sessionOwnerCacheMaxEntries < 1
    ) {
      throw new Error('sessionOwnerCacheMaxEntries must be a positive integer');
    }
  }

  /** The one raw read handed out (slice-3's `tenantContextFor` closure). */
  tenantContextFor(threadId: string): TenantExecutionContext | undefined {
    return this.tenantContexts.get(threadId);
  }

  /** C7 `trackSession` and C12's start hook bind a validated context. */
  bindTenantContext(threadId: string, context: TenantExecutionContext): void {
    this.readGeneration = {};
    this.tenantContexts.set(threadId, context);
  }

  /** The slice-2 teardown seam's unconditional core delete. */
  forgetTenantContext(threadId: string): void {
    this.readGeneration = {};
    this.tenantContexts.delete(threadId);
  }

  /**
   * Owner-cache invalidation (C17 smoke, the slice-2 `ownerCache` aspect,
   * and C2's session.started/configured publish). Returns `Map.delete`'s
   * boolean — C2's telemetry gates on whether the delete removed anything.
   */
  invalidateSessionOwner(threadId: string): boolean {
    this.readGeneration = {};
    return this.sessionOwnerCache.delete(threadId);
  }

  captureReadCurrentness(): () => boolean {
    const generation = this.readGeneration;
    return () => generation === this.readGeneration;
  }

  stopTranscriptReads(): void {
    this.transcriptReadsClosed = true;
    this.readGeneration = {};
  }

  /** Fixed read-owner constraints use precisely the existing legacy bridge policy. */
  transcriptOwnerConstraint(
    authority: import('@kontourai/station-contracts/tenancy').SessionReadAuthority,
  ): { ownerUserId: string; legacyOwnerUserId?: string } {
    const legacy = this.deps.legacyPersonalOwner;
    return {
      ownerUserId: authority.userId,
      ...(this.deps.requireTenantExecutionContext?.() !== true &&
      isSessionReadAuthority(authority) &&
      legacy &&
      this.canReadLegacyPersonalOwner(legacy, authority)
        ? { legacyOwnerUserId: legacy }
        : {}),
    };
  }

  /** Same policy and positive cache; only a cold durable lookup crosses the async seam. */
  async canReadSessionAsync(
    threadId: string,
    scope: SessionReadScope,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const sameGeneration = this.captureReadCurrentness();
    if (this.transcriptReadsClosed || !current()) return false;
    let needsOwner = false;
    const preflight = this.canReadWithOwner(threadId, scope, () => {
      needsOwner = true;
      return undefined;
    });
    if (!needsOwner) return preflight;
    const cached = this.sessionOwnerCache.get(threadId);
    sessionOwnerCacheOps.add(1, {
      outcome: cached === undefined ? 'miss' : 'hit',
    });
    // A failure rejects, never becoming the policy's ownerless compatibility case.
    const owner = cached ?? (await this.readOwnerAsync(threadId, signal));
    if (!current() || !sameGeneration()) return false;
    const allowed = this.canReadWithOwner(threadId, scope, () => owner);
    if (!current() || !sameGeneration()) return false;
    if (owner !== undefined) this.cacheSessionOwner(threadId, owner);
    return allowed;
  }

  private async readOwnerAsync(threadId: string, signal?: AbortSignal) {
    // Source authority is constructor-bound, exactly like the synchronous path;
    // a per-call caller cannot substitute a function that invents owner facts.
    if (this.transcriptReadsClosed || !this.transcriptOwnerRead)
      throw new Error('Session owner read unavailable');
    return this.transcriptOwnerRead.readOwner(threadId, signal);
  }

  /**
   * archive#1120: this is the `/events` SSE route's per-event,
   * per-connected-client authorization gate (`canUserReadSession` ->
   * `canReadSession` -> here), so it must stay cheap — a full
   * `eventStore.listEvents(threadId)` per call was a 50x N amplification on
   * a streaming burst. Session ownership is established exactly once, by
   * whichever `session.started`/`session.configured` event first carries a
   * `metadata.userId` for a threadId (stamped server-side from the
   * authenticated caller at `startSession` dispatch — see
   * `orchestration.ts`'s `/commands` route), and every later command
   * against that thread already requires `canReadSession` to pass for the
   * SAME owner (`dispatchWithReceipt`'s pre-dispatch check), so no later
   * event can legitimately carry a different owner. `sessionOwnerCache`
   * exploits that: a resolved owner is cached and reused; see
   * `cacheSessionOwner()` for why a stale hit still can't produce a wrong
   * answer, and `projectAndPublishEvent()` for the invalidation that keeps
   * it from ever needing to.
   */
  sessionOwnerUserId(threadId: string): string | undefined {
    const cached = this.sessionOwnerCache.get(threadId);
    if (cached !== undefined) {
      // Refresh LRU recency on access (re-insert moves it to the end of
      // Map iteration order, mirroring attached-session-follow-service.ts's
      // `rememberEvent`).
      this.sessionOwnerCache.delete(threadId);
      this.sessionOwnerCache.set(threadId, cached);
      sessionOwnerCacheOps.add(1, { outcome: 'hit' });
      return cached;
    }
    sessionOwnerCacheOps.add(1, { outcome: 'miss' });
    // archive#3495: the whole predicate lives in SQL and at most ONE row comes
    // back. archive#1867 had already narrowed this from `listEvents(threadId)`
    // to the ownership-shaped methods, but the read stayed unbounded: on the
    // live store's hot thread it returned 517,718 rows (2,146 ms, rss 45 MB ->
    // 893 MB), `JSON.parse`d all 517,718 payloads (+661 ms, rss -> 1,206 MB),
    // read `payload.metadata.userId` off each, found none, and returned
    // `undefined` — per event, per connected client, because the negative
    // below is deliberately never cached. That is the amplification that took
    // the backend from 618 MB to 2.7 GB in ten seconds and timed out the
    // readiness probe (677 supervisor restarts in one day).
    //
    // `findSessionOwnerUserId` keeps the identical `created_at DESC, sequence
    // DESC` ordering and the identical predicate (ownership-shaped method,
    // string `metadata.userId`), so it returns exactly the row this loop would
    // have stopped on. Same answer, no materialization.
    const ownerUserId = this.deps.eventStore?.findSessionOwnerUserId(threadId);
    if (ownerUserId !== undefined) {
      this.cacheSessionOwner(threadId, ownerUserId);
      return ownerUserId;
    }
    // Deliberately NOT cached (archive#1120 safety requirement): an
    // ownerless/unresolved result (unknown thread, or a read-only-attached
    // session that never carries a `metadata.userId`) always falls through
    // to a full store read on the next call. Caching a negative result
    // here could let a thread that later legitimately resolves an owner
    // stay stuck on a stale "no owner" answer — and for the
    // `ownerlessSessionAccess: 'single-user-compat'` branch specifically,
    // an authorization outcome must never be pinned by a cache the way a
    // positive owner safely can be.
    return undefined;
  }

  /**
   * archive#1120 safety argument: this cache can only ever be populated
   * with a POSITIVE owner already read, just now, straight from the event
   * store — never a guess, default, or "no owner" placeholder. Given that,
   * a cache HIT can only return a value that was true at some point after
   * this thread's owner was durably established, and — per the write-path
   * invariant documented on `sessionOwnerUserId()` — that owner cannot
   * change after being set (every further command against the thread is
   * itself gated on already being that same owner). So a hit is always
   * exactly what a fresh full read would return. `projectAndPublishEvent()`
   * additionally invalidates this entry on every subsequent
   * `session.started`/`session.configured` event for the thread, so even
   * if that invariant were ever weakened elsewhere, a stale entry cannot
   * survive past the next ownership-shaped event — the next read recomputes
   * from the fresh store state and only re-caches if it again resolves a
   * concrete owner. There is no code path that stores `undefined`/absent
   * ownership in this map.
   */
  private cacheSessionOwner(threadId: string, ownerUserId: string): void {
    this.sessionOwnerCache.delete(threadId);
    this.sessionOwnerCache.set(threadId, ownerUserId);
    while (this.sessionOwnerCache.size > this.sessionOwnerCacheMaxEntries) {
      const oldest = this.sessionOwnerCache.keys().next().value;
      if (oldest === undefined) break;
      this.sessionOwnerCache.delete(oldest);
      sessionOwnerCacheOps.add(1, { outcome: 'evicted' });
    }
  }

  /**
   * One policy for every session-derived read. In hosted mode both the
   * request and persisted binding must be independently trustworthy: a
   * personal-mode authority, absent request binding, malformed/unknown
   * persisted binding, ownerless row, or exact-tenant mismatch is invisible.
   *
   * The owner cache remains the only owner lookup. Tenant context is read
   * from the private session record and validated through the runtime's
   * registry-backed validator; it never reaches a public projection.
   */
  canReadSession(threadId: string, scope: SessionReadScope): boolean {
    return this.canReadWithOwner(threadId, scope, () =>
      this.sessionOwnerUserId(threadId),
    );
  }

  private canReadWithOwner(
    threadId: string,
    scope: SessionReadScope,
    readOwner: () => string | undefined,
  ): boolean {
    const runtimeScope: unknown = scope;
    if (runtimeScope === INTERNAL_SESSION_READ_SCOPE) return true;

    const hosted = this.deps.requireTenantExecutionContext?.() === true;
    const authority = isSessionReadAuthority(runtimeScope)
      ? runtimeScope
      : undefined;

    if (hosted) {
      // An omitted or forged object is never a hosted authority.
      if (authority?.mode !== 'hosted' || !authority.tenantExecutionContext) {
        return false;
      }
      const persisted = this.validStoredTenantExecutionContext(threadId);
      if (
        !persisted ||
        persisted.tenantId !== authority.tenantExecutionContext.tenantId
      ) {
        return false;
      }
      const ownerUserId = readOwner();
      return ownerUserId !== undefined && ownerUserId === authority.userId;
    }

    // A deployment-mode mismatch is never silently accepted.
    if (authority && authority.mode !== 'personal') return false;
    if (!authority) return false;
    const userId = authority.userId;
    const ownerUserId = readOwner();
    if (ownerUserId === undefined) {
      return this.deps.ownerlessSessionAccess === 'single-user-compat';
    }
    // The released OS alias must never pass the ordinary equality path: any
    // caller can guess a display alias. It is readable only through the
    // narrowly provenance-bound migration bridge below. All other principal
    // owners retain exact-id equality.
    if (ownerUserId === this.deps.legacyPersonalOwner) {
      return this.canReadLegacyPersonalOwner(ownerUserId, authority);
    }
    return userId === ownerUserId;
  }

  /**
   * The released pre-principal rows contain the OS alias as owner.  Only a
   * request that has both the contract-defined local-operator identity and a
   * home-possession fact may read that exact alias.  In particular this never
   * admits paired devices, WhoIs identities, hosted callers, operator-secret
   * callers without home possession, or an arbitrary same-name principal.
   */
  private canReadLegacyPersonalOwner(
    ownerUserId: string,
    authority: import('@kontourai/station-contracts/tenancy').SessionReadAuthority,
  ): boolean {
    return (
      authority.mode === 'personal' &&
      authority.localHomePossession === true &&
      authority.userId === LOCAL_OPERATOR_PRINCIPAL_ID &&
      this.deps.legacyPersonalOwner !== undefined &&
      ownerUserId === this.deps.legacyPersonalOwner
    );
  }

  /** Validate the persisted binding with the runtime's trusted registry seam. */
  private validStoredTenantExecutionContext(
    threadId: string,
  ): TenantExecutionContext | undefined {
    const candidate = this.tenantContexts.get(threadId);
    // A hosted service without this validator is misconfigured. Failing
    // closed here prevents an in-memory or syntactically-shaped binding from
    // bypassing registry membership checks.
    if (!this.deps.validateRecoveredTenantExecutionContext) return undefined;
    return this.deps.validateRecoveredTenantExecutionContext(candidate);
  }

  /**
   * Populate the private tenant binding index while a persistence scan is
   * already in progress. Live SSE authorization then remains O(1), like the
   * owner cache, rather than performing a `readSessions().find()` per event.
   */
  hydratePersistedTenantContexts(sessions: readonly ProviderSession[]): void {
    this.readGeneration = {};
    for (const session of sessions) {
      if (session.tenantExecutionContext) {
        this.tenantContexts.set(
          session.threadId,
          session.tenantExecutionContext,
        );
      } else {
        this.tenantContexts.delete(session.threadId);
      }
    }
  }

  /**
   * Command-side adoption does not mint a public authority. It reuses the
   * exact tenant/owner policy inputs that dispatch already owns.
   */
  canReadSessionForCommand(
    threadId: string,
    userId: string | undefined,
    tenantExecutionContext: TenantExecutionContext | undefined,
  ): boolean {
    if (this.deps.requireTenantExecutionContext?.()) {
      // Command dispatch is not the live SSE hot path. Hydrate the private
      // binding index before its first command-side authorization decision so
      // a freshly constructed service cannot mistake a valid persisted source
      // for an unbound one.
      this.hydratePersistedTenantContexts(
        this.deps.eventStore?.readSessions() ?? [],
      );
      const persisted = this.validStoredTenantExecutionContext(threadId);
      if (
        !tenantExecutionContext ||
        !persisted ||
        persisted.tenantId !== tenantExecutionContext.tenantId
      ) {
        return false;
      }
      const ownerUserId = this.sessionOwnerUserId(threadId);
      return ownerUserId !== undefined && ownerUserId === userId;
    }
    if (userId === undefined) return true;
    const ownerUserId = this.sessionOwnerUserId(threadId);
    if (ownerUserId === undefined) {
      return this.deps.ownerlessSessionAccess === 'single-user-compat';
    }
    return userId === undefined || ownerUserId === userId;
  }

  /**
   * Resolves the private identity that a completion notification may use to
   * check stream presence. Hosted sessions require both a resolved owner and
   * their registry-valid persisted tenant binding; an incomplete binding is
   * never allowed to borrow another tenant's same-user presence. Personal
   * ownerless sessions retain the historic any-connected-user fallback.
   */
  resolveSessionPresenceSubject(
    threadId: string,
  ): OrchestrationStreamPresenceSubject | undefined {
    const ownerUserId = this.sessionOwnerUserId(threadId);
    const hosted = this.deps.requireTenantExecutionContext?.() === true;
    if (!ownerUserId) {
      return hosted
        ? undefined
        : anyPersonalOrchestrationStreamPresenceSubject();
    }
    if (!hosted) {
      return orchestrationStreamPresenceSubjectForSession(ownerUserId);
    }
    const tenantExecutionContext =
      this.validStoredTenantExecutionContext(threadId);
    return tenantExecutionContext
      ? orchestrationStreamPresenceSubjectForSession(
          ownerUserId,
          tenantExecutionContext,
        )
      : undefined;
  }
}
