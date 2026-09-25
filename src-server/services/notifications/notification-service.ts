/**
 * NotificationService — multi-provider notification aggregator.
 * Uses JsonFileStore for persistence and EventBus for real-time delivery.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type {
  Notification,
  NotificationEnvelopeV1,
  ScheduleNotificationOpts,
  SurfaceId,
} from '@kontourai/station-contracts/notification';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  acquireFileMutationLockAsync,
  type FileMutationLock,
} from '@kontourai/station-shared/lifecycle-events';
import {
  AGENT_NOTIFICATION_CATEGORY_PREFIX,
  AGENT_NOTIFICATION_DEDUPE_PREFIX,
  isSurfaceId,
  parseNotificationEnvelope,
  parseNotificationEnvelopeForWrite,
} from '@kontourai/station-shared/notification-envelope';
import {
  classifyNotificationCategory,
  NOTIFICATION_TTL_MS,
} from '@kontourai/station-shared/notification-priority';
import type { INotificationProvider } from '../../providers/provider-interfaces.js';
import { notificationOps } from '../../telemetry/metrics.js';
import { isRecord } from '../../utils/is-record.js';
import { createLogger } from '../../utils/logger.js';
import { JsonFileStore } from '../infra/json-store.js';
import type { EventBus } from '../orchestration/event-bus.js';

const logger = createLogger({ name: 'notification-service' });

type NotificationActionLease = {
  id: string;
  actionId: string;
  phase: 'reserved' | 'dispatching';
  revision: number;
  expiresAt: string;
};

type StoredNotification = Notification & {
  /** Monotonic per-record generation for mutation and timer CAS checks. */
  revision: number;
  actionLease?: NotificationActionLease;
};

type NotificationStore = Pick<
  JsonFileStore<StoredNotification[]>,
  'read' | 'write'
>;
type NotificationStoreFactory = (storePath: string) => NotificationStore;
const ACTION_LEASE_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
type NotificationDismissal = 'dismissed' | 'not-found' | 'action-dispatching';
type NotificationDismissalResult =
  | { outcome: 'dismissed'; notification: StoredNotification }
  | { outcome: Exclude<NotificationDismissal, 'dismissed'> };
type NotificationActionOutcome =
  | 'actioned'
  | 'not-found'
  | 'not-actionable'
  | 'action-dispatching';
type NotificationClearOutcome =
  | { outcome: 'cleared'; clearedCount: number; retainedCount: number }
  | { outcome: 'action-dispatching'; dispatchingCount: number };
type NotificationClearMutation =
  | {
      result: { outcome: 'action-dispatching'; dispatchingCount: number };
    }
  | {
      result: {
        outcome: 'cleared';
        cleared: StoredNotification[];
        retainedCount: number;
      };
      next?: StoredNotification[];
    };
type NotificationClearResult = NotificationClearMutation['result'];
/**
 * `read` — this call recorded the first reader. `already-read` — an earlier
 * reader won; nothing changed. `no-envelope` — a legacy (or unreadable
 * envelope) record, which carries no read marker and is left untouched.
 * `not-delivered` — only a delivered record can be read (pending has not
 * reached anyone; dismissed/expired/actioned are already settled).
 */
export type NotificationMarkReadOutcome =
  | 'read'
  | 'already-read'
  | 'no-envelope'
  | 'not-delivered'
  | 'not-found';

/**
 * Result of the trusted enveloped write. `unchanged` — the dedupe tag names a
 * dismissed (final) record or one whose action is in flight; nothing changed.
 */
export type NotificationScheduleOutcome = 'created' | 'updated' | 'unchanged';

export interface NotificationServiceOptions {
  /** Injectable only for deterministic cross-process mutation tests. */
  acquireMutationLock?: FileMutationLock;
  /** Injectable only for durable-write fault-injection tests. */
  storeFactory?: NotificationStoreFactory;
  /** Injectable only to hold a reserved action before provider dispatch. */
  beforeActionDispatch?: (notificationId: string) => Promise<void>;
  /** Observes failures from synchronous adapters without creating rejections. */
  onAsyncDispatchError?: (operation: string, error: unknown) => void;
  /** Injectable only for deterministic bounded-shutdown tests. */
  shutdownTimeoutMs?: number;
}

export class NotificationStoreValidationError extends Error {
  constructor() {
    super('Notification store is invalid');
    this.name = 'NotificationStoreValidationError';
  }
}

export class NotificationEnvelopeValidationError extends Error {
  constructor(detail = 'Notification envelope is invalid') {
    super(detail);
    this.name = 'NotificationEnvelopeValidationError';
  }
}

/**
 * A dedupe tag already names a record written by a DIFFERENT source (#2597).
 * Tags are global, so without this a writer could rewrite another source's
 * record — its title and actions — while `source` (which routes the action
 * to a provider) stayed the victim's. Refused whatever the existing record's
 * status: a dismissed/expired record of another source still owns its tag,
 * and creating a second record under it would shadow it (and fail the
 * store's unique-tag validation).
 */
/**
 * Source of every record created through `POST /notifications`, and the
 * namespace its dedupe tags are stored under (#2597). A request body chooses
 * neither: a caller-chosen source could relabel (and, through a shared tag,
 * rewrite) another producer's record, and an un-namespaced tag could squat an
 * internal producer's tag and block it forever.
 */
export const REST_NOTIFICATION_SOURCE = 'api';
export const REST_NOTIFICATION_DEDUPE_PREFIX = 'api:';

/**
 * Sources Station's own producers write under (every in-process
 * `schedule()`/`scheduleEnveloped()` caller; a test pins this against them).
 * A record under one of these, or under a registered provider's id, owns its
 * dedupe tag; any other source's record under a colliding tag was written by
 * a request before #2597 and is taken over by the tag's rightful writer.
 */
export const INTERNAL_NOTIFICATION_SOURCES: ReadonlySet<string> = new Set([
  'agent',
  'approval-inbox',
  'device-pairing',
  'scheduler',
  'turn-completion',
]);

/** Provider ids a provider may not register under: they name REST/agent writes. */
const RESERVED_NOTIFICATION_PROVIDER_IDS: ReadonlySet<string> = new Set([
  REST_NOTIFICATION_SOURCE,
  'sdk',
  'agent',
]);

export class NotificationProviderIdError extends Error {
  constructor(
    readonly providerId: string,
    readonly reason: 'reserved' | 'internal' | 'duplicate',
  ) {
    super(`Notification provider id "${providerId}" refused: ${reason}`);
    this.name = 'NotificationProviderIdError';
  }
}

export class NotificationDedupeSourceConflictError extends Error {
  constructor() {
    super('Notification dedupe tag belongs to another source');
    this.name = 'NotificationDedupeSourceConflictError';
  }
}

/**
 * The untrusted `schedule()` path (REST `POST /notifications`, providers)
 * tried to write something only `scheduleEnveloped()` may: an envelope, an
 * `agent:` dedupe tag, an `agent-*` category, or an update to an enveloped
 * record.
 */
export class NotificationReservedFieldError extends Error {
  constructor(field: 'envelope' | 'dedupeTag' | 'category') {
    super(`Notification ${field} is reserved to enveloped notifications`);
    this.name = 'NotificationReservedFieldError';
  }
}

export class NotificationDispatchClosedError extends Error {
  constructor(operation: string) {
    super(`Notification async dispatch is closed: ${operation}`);
    this.name = 'NotificationDispatchClosedError';
  }
}

export class NotificationShutdownTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Notification async dispatch did not drain within ${timeoutMs}ms`);
    this.name = 'NotificationShutdownTimeoutError';
  }
}

export class NotificationService {
  private providers = new Map<string, INotificationProvider>();
  private store: NotificationStore;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly storePath: string;
  private readonly acquireMutationLock: FileMutationLock;
  private readonly beforeActionDispatch?: (
    notificationId: string,
  ) => Promise<void>;
  private readonly onAsyncDispatchError?: (
    operation: string,
    error: unknown,
  ) => void;
  private asyncDispatchTail: Promise<void> = Promise.resolve();
  private acceptingAsyncDispatch = true;
  private shutdownPromise: Promise<void> | undefined;
  private readonly shutdownTimeoutMs: number;

  constructor(
    private eventBus: EventBus,
    dataDir: string,
    private pollIntervalMs = 60_000,
    options: NotificationServiceOptions = {},
  ) {
    this.storePath = join(dataDir, 'notifications.json');
    this.acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
    this.store =
      options.storeFactory?.(this.storePath) ??
      new JsonFileStore<StoredNotification[]>(this.storePath, [], {
        // A notification dismissal is a durable operator decision. Reading a
        // damaged primary as [] and then publishing any later transition
        // would silently erase it (and every other notification).
        onCorruption: 'throw',
        durableAtomicWrite: true,
      });
    this.beforeActionDispatch = options.beforeActionDispatch;
    this.onAsyncDispatchError = options.onAsyncDispatchError;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  /**
   * Registers a built-in provider. Action, dismiss and status-sync dispatch
   * is keyed by a record's `source`, so a provider id is an authority over
   * every record under that source. Refused (NotificationProviderIdError):
   * - `reserved` — `api`/`sdk`/`agent`, the REST and agent write sources;
   * - `duplicate` — an id already registered (a Map would silently REPLACE
   *   the earlier provider, e.g. a plugin shadowing `device-pairing`).
   * Built-ins may use an INTERNAL_NOTIFICATION_SOURCES id (that is their
   * own source); plugins go through `addPluginProvider`, which may not.
   */
  addProvider(provider: INotificationProvider): void {
    if (RESERVED_NOTIFICATION_PROVIDER_IDS.has(provider.id))
      throw new NotificationProviderIdError(provider.id, 'reserved');
    if (this.providers.has(provider.id))
      throw new NotificationProviderIdError(provider.id, 'duplicate');
    this.providers.set(provider.id, provider);
  }

  /**
   * Registers a plugin's provider: as `addProvider`, and additionally
   * refuses (`internal`) any INTERNAL_NOTIFICATION_SOURCES id — a plugin
   * named `scheduler` would receive the actions and dismissals of scheduler
   * records.
   */
  addPluginProvider(provider: INotificationProvider): void {
    if (
      INTERNAL_NOTIFICATION_SOURCES.has(provider.id) &&
      !RESERVED_NOTIFICATION_PROVIDER_IDS.has(provider.id)
    )
      throw new NotificationProviderIdError(provider.id, 'internal');
    this.addProvider(provider);
  }

  private ownsDedupeTags(source: string): boolean {
    return (
      INTERNAL_NOTIFICATION_SOURCES.has(source) || this.providers.has(source)
    );
  }

  listProviders(): Array<{
    id: string;
    displayName: string;
    categories: string[];
  }> {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
      categories: [...p.categories],
    }));
  }

  async start(): Promise<void> {
    if (!this.acceptingAsyncDispatch) return;
    // Reschedule any persisted pending notifications
    for (const n of await this.read()) {
      if (!this.acceptingAsyncDispatch) return;
      if (n.status === 'pending' && n.scheduledAt) this.scheduleTimer(n);
      else if (n.status === 'delivered' && !n.actionLease)
        this.scheduleExpiryTimer(n);
    }
    // Start provider polling
    if (this.providers.size > 0) {
      if (!this.acceptingAsyncDispatch) return;
      this.pollTimer = setInterval(
        () => this.dispatch('provider-poll', () => this.poll()),
        this.pollIntervalMs,
      );
      await this.poll();
    }
  }

  private stopProducers(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Untrusted write path: REST `POST /notifications` (caller-supplied body)
   * and notification providers. It can never write an envelope, an `agent:`
   * dedupe tag or an `agent-*` category, and never rewrites an enveloped
   * record — those belong to `scheduleEnveloped`, so a caller cannot forge an
   * agent's provenance or squat (and then dismiss) an agent's dedupe key.
   * Records squatted on an `agent:` tag before this upgrade are not migrated.
   */
  async schedule(
    source: string,
    opts: ScheduleNotificationOpts,
  ): Promise<Notification> {
    return this.scheduleUntrusted(source, opts, false);
  }

  /**
   * `POST /notifications` (#2597): always source `api`, and the caller's
   * dedupe tag is stored as `api:<tag>` (dedupe matches the prefixed form),
   * so a request can never collide with — or squat — an internal, provider
   * or agent tag. A tag smuggled in `metadata.dedupeTag` is refused.
   * In hosted mode the route passes the caller's tenant, and the tag is
   * `api:<tenantId>:<tag>` so two tenants' requests never share a record.
   * Tenant ids cannot contain `:`, so one tenant's tags never alias
   * another's. A personal-mode `api:acme:foo` and tenant acme's `foo` are
   * kept apart because a hosted request always carries a tenant (the route
   * refuses a hosted request without one), so the unscoped form only ever
   * exists in personal mode.
   */
  async scheduleFromRequest(
    opts: ScheduleNotificationOpts,
    scope: { tenantId?: string } = {},
  ): Promise<Notification> {
    if (scope.tenantId !== undefined && !/^[^:\s]+$/.test(scope.tenantId))
      throw new TypeError('scheduleFromRequest tenant id is invalid');
    const namespace = `${REST_NOTIFICATION_DEDUPE_PREFIX}${
      scope.tenantId === undefined ? '' : `${scope.tenantId}:`
    }`;
    if (Object.hasOwn(jsonSafeMetadata(opts.metadata), 'dedupeTag'))
      throw new NotificationReservedFieldError('dedupeTag');
    return this.scheduleUntrusted(
      REST_NOTIFICATION_SOURCE,
      {
        ...opts,
        ...(opts.dedupeTag === undefined
          ? {}
          : {
              dedupeTag: `${namespace}${opts.dedupeTag}`,
            }),
      },
      true,
    );
  }

  private async scheduleUntrusted(
    source: string,
    opts: ScheduleNotificationOpts,
    fromRequest: boolean,
  ): Promise<Notification> {
    const metadata = jsonSafeMetadata(opts.metadata);
    if (Object.hasOwn(metadata, 'envelope'))
      throw new NotificationReservedFieldError('envelope');
    if (
      typeof opts.category === 'string' &&
      opts.category.startsWith(AGENT_NOTIFICATION_CATEGORY_PREFIX)
    )
      throw new NotificationReservedFieldError('category');
    const tag = opts.dedupeTag ?? metadata.dedupeTag;
    if (
      typeof tag === 'string' &&
      (tag.startsWith(AGENT_NOTIFICATION_DEDUPE_PREFIX) ||
        (!fromRequest && tag.startsWith(REST_NOTIFICATION_DEDUPE_PREFIX)))
    )
      throw new NotificationReservedFieldError('dedupeTag');
    return (await this.scheduleRecord(source, opts, metadata, undefined))
      .notification;
  }

  /**
   * Trusted write path (#2583): the only way `metadata.envelope` is written.
   * In-process producers only (the agent notification gate, system
   * producers) — never wire a request body into it. The envelope must pass
   * `parseNotificationEnvelopeForWrite` (exact keys, no read/dismiss markers,
   * no `principal` audience). `metadata.sessionId`/`conversationId` are
   * derived from the envelope so REST read-gating and deep links follow the
   * envelope's session; a conflicting caller value is refused. A dedupe
   * update of an enveloped record emits NOTIFICATION_UPDATED.
   */
  async scheduleEnveloped(
    source: string,
    opts: ScheduleNotificationOpts,
    envelope: NotificationEnvelopeV1,
  ): Promise<{
    notification: Notification;
    outcome: NotificationScheduleOutcome;
  }> {
    const parsed = parseNotificationEnvelopeForWrite(envelope);
    if (!parsed) throw new NotificationEnvelopeValidationError();
    const metadata = jsonSafeMetadata(opts.metadata);
    if (Object.hasOwn(metadata, 'envelope'))
      throw new NotificationReservedFieldError('envelope');
    const sessionId =
      parsed.audience.kind === 'session-readers'
        ? parsed.audience.sessionId
        : parsed.source.kind === 'agent'
          ? parsed.source.sessionId
          : undefined;
    const conversationId =
      parsed.source.kind === 'agent' ? parsed.source.conversationId : undefined;
    for (const [key, derived] of [
      ['sessionId', sessionId],
      ['conversationId', conversationId],
    ] as const) {
      if (derived === undefined) continue;
      if (metadata[key] !== undefined && metadata[key] !== derived) {
        throw new NotificationEnvelopeValidationError(
          `Notification metadata.${key} disagrees with its envelope`,
        );
      }
      metadata[key] = derived;
    }
    metadata.envelope = parsed as unknown as Record<string, unknown>;
    const { notification, created, updated } = await this.scheduleRecord(
      source,
      opts,
      metadata,
      parsed,
    );
    return {
      notification,
      outcome: created ? 'created' : updated ? 'updated' : 'unchanged',
    };
  }

  private async scheduleRecord(
    source: string,
    opts: ScheduleNotificationOpts,
    metadata: Record<string, unknown>,
    envelope: NotificationEnvelopeV1 | undefined,
  ): Promise<{
    notification: Notification;
    created: boolean;
    updated: boolean;
  }> {
    let displaced: string | undefined;
    let remaining = 0;
    const now = new Date().toISOString();
    const { notification, created, updated } = await this.mutate((all) => {
      // Dedupe by tag. The fresh read happens while holding the mutation
      // lock, so a stale schedule cannot restore a concurrent dismissal or
      // publish a second notification for the same provider item.
      if (opts.dedupeTag) {
        let existing = all.find(
          (n) => (n.metadata as any)?.dedupeTag === opts.dedupeTag,
        );
        if (existing && existing.source !== source) {
          // A record under a source that is neither internal nor a
          // registered provider can only have come from a request before
          // #2597 (whose body chose any source: `api`, the SDK's `sdk`, a
          // plugin string). That tag was never its to hold, so the writer
          // takes it over (whatever its status) rather than being blocked
          // forever. An internal/provider record still owns its tag.
          // Ownership is evaluated now: a provider's records lose it while
          // that provider is not registered (a removed or failed plugin) and
          // may then be taken over by a colliding writer. Conversely a
          // pre-#2597 request squat labelled with an internal or provider
          // source name keeps ownership and is not reclaimable.
          if (!this.ownsDedupeTags(existing.source)) {
            all.splice(all.indexOf(existing), 1);
            displaced = existing.id;
            remaining = all.length + 1;
            existing = undefined;
          } else {
            throw new NotificationDedupeSourceConflictError();
          }
        }
        // Only the trusted path may rewrite an enveloped record: an untrusted
        // update would replace metadata wholesale and strip its envelope.
        if (
          existing &&
          !envelope &&
          Object.hasOwn(existing.metadata ?? {}, 'envelope')
        ) {
          throw new NotificationReservedFieldError('dedupeTag');
        }
        if (existing) {
          // archive#1912: a dismissal is a real, terminal user decision.
          if (existing.status === 'dismissed' || existing.actionLease) {
            return {
              result: {
                notification: existing,
                created: false,
                updated: false,
              },
            };
          }
          // archive#3442 round 2 (HIGH-2): a dedupe-update used to leave
          // `category` untouched while freely rewriting `title`/`priority` —
          // so a turn that later fails after an earlier "done" schedule (or
          // vice versa) ended up with a title/category that contradicted
          // each other, and a stale ttl. This update path never emits an
          // event (see below: `created`/`updated` branch, no
          // `NOTIFICATION_DELIVERED`), so the reachable consumers of this
          // stale `category` are the persisted row itself, the REST list, the
          // history facets (pages/notificationHistoryFilters.ts:69,89,92,110),
          // and the ttl default computed below — not the push pipeline. A
          // caller-supplied ttl still always wins; otherwise re-derive the
          // default from the NEW category rather than freezing the ttl the
          // record was created with.
          //
          // The re-derived ttl still measures from the ORIGINAL
          // `deliveredAt`, not this update's `updatedAt` (scheduleExpiryTimer
          // below: `deadline = deliveredAt + ttl`). A row delivered as
          // `turn-failed` well inside its 24h ttl and corrected to
          // `turn-completed` (900_000ms ttl) minutes later can therefore
          // compute a deadline already in the past and expire ~immediately —
          // the corrected "Your agent finished" row can vanish from the inbox
          // right after it's written. Arguably correct by policy (a done
          // notice this stale IS stale); left as documented behavior rather
          // than changed, since it is a product policy call this fix round
          // should not make unilaterally.
          const outcome = classifyNotificationCategory(opts.category);
          const defaultTtl = outcome ? NOTIFICATION_TTL_MS[outcome] : undefined;
          const ttl = opts.ttl ?? defaultTtl ?? existing.ttl;
          if (opts.actions === undefined) delete existing.actions;
          if (opts.body === undefined) delete existing.body;
          Object.assign(existing, {
            ...(opts.actions === undefined ? {} : { actions: opts.actions }),
            ...(opts.body === undefined ? {} : { body: opts.body }),
            metadata: {
              ...metadata,
              ...(opts.dedupeTag === undefined
                ? {}
                : { dedupeTag: opts.dedupeTag }),
            },
            category: opts.category,
            priority: opts.priority ?? existing.priority,
            scheduledAt: opts.scheduledAt ?? existing.scheduledAt,
            ...(ttl === undefined ? {} : { ttl }),
            title: opts.title,
            updatedAt: now,
            revision: existing.revision + 1,
          });
          return {
            result: { notification: existing, created: false, updated: true },
            next: all,
          };
        }
      }

      // archive#1100 AC2: a caller-supplied ttl always wins; otherwise default
      // to the per-outcome TTL for categories this ranking knows about.
      const outcome = classifyNotificationCategory(opts.category);
      const defaultTtl = outcome ? NOTIFICATION_TTL_MS[outcome] : undefined;
      const notification: StoredNotification = {
        id: randomUUID(),
        source,
        category: opts.category,
        title: opts.title,
        ...(opts.body === undefined ? {} : { body: opts.body }),
        priority: opts.priority ?? 'normal',
        status: opts.scheduledAt ? 'pending' : 'delivered',
        scheduledAt: opts.scheduledAt ?? null,
        deliveredAt: opts.scheduledAt ? null : now,
        ...((opts.ttl ?? defaultTtl) === undefined
          ? {}
          : { ttl: opts.ttl ?? defaultTtl }),
        ...(opts.actions === undefined ? {} : { actions: opts.actions }),
        metadata: {
          ...metadata,
          ...(opts.dedupeTag === undefined
            ? {}
            : { dedupeTag: opts.dedupeTag }),
        },
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      return {
        result: { notification, created: true, updated: false },
        next: [...all, notification],
      };
    });

    if (displaced) {
      this.clearTimer(displaced);
      // The displaced record is gone from the store: tell clients to refetch.
      this.eventBus.emit(SERVER_EVENTS.NOTIFICATION_CLEARED, {
        clearedCount: 1,
        retainedCount: remaining,
      });
    }
    if (created) notificationOps.add(1, { op: 'schedule' });

    if (created && notification.status === 'delivered') {
      this.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_DELIVERED,
        toPublicNotification(notification) as unknown as Record<
          string,
          unknown
        >,
      );
      if (notification.ttl && notification.ttl > 0) {
        this.scheduleExpiryTimer(notification);
      }
    } else if (created) {
      this.scheduleTimer(notification);
    } else if (updated) {
      this.clearTimer(notification.id);
      if (notification.status === 'pending') this.scheduleTimer(notification);
      else if (notification.status === 'delivered')
        this.scheduleExpiryTimer(notification);
      // An enveloped record's content change must reach every client (and
      // the delivery router); legacy dedupe updates stay silent as before.
      if (envelope) {
        this.eventBus.emit(
          SERVER_EVENTS.NOTIFICATION_UPDATED,
          toPublicNotification(notification) as unknown as Record<
            string,
            unknown
          >,
        );
      }
    }

    return {
      notification: toPublicNotification(notification),
      created,
      updated,
    };
  }

  /**
   * For an enveloped record, the first dismissal by a known surface is also
   * recorded in `envelope.dismissedAt/dismissedBy`. The surface is the
   * explicit `surfaceId`, else a device caller's `device:<id>`; an operator
   * caller with no client session id has no surface, so only `status`
   * records that dismissal (status stays authoritative).
   */
  async dismiss(
    id: string,
    clientOrigin?: ClientOrigin,
    surfaceId?: SurfaceId,
  ): Promise<NotificationDismissal> {
    const surface =
      surfaceId ??
      (clientOrigin?.actor.kind === 'device'
        ? (`device:${clientOrigin.actor.deviceId}` as const)
        : undefined);
    return this.dismissWithOptions(id, {
      notifyProvider: true,
      clientOrigin,
      surface: isSurfaceId(surface) ? surface : undefined,
    });
  }

  async markStatus(id: string, status: Notification['status']): Promise<void> {
    const notification = await this.updateStatus(id, status);
    this.clearTimer(id);
    if (notification) {
      this.eventBus.emit(
        SERVER_EVENTS.NOTIFICATION_UPDATED,
        toPublicNotification(notification) as unknown as Record<
          string,
          unknown
        >,
      );
    }
  }

  /**
   * Records the first surface to read an enveloped notification in
   * `metadata.envelope.readAt/readBy` and emits NOTIFICATION_UPDATED. First
   * reader wins: a later read never overwrites the marker and emits nothing.
   *
   * `status` is untouched — the store has no read state, and status stays
   * authoritative for delivery/expiry/dismissal. `revision` is deliberately
   * NOT bumped: it is the CAS generation for the expiry/delivery timers and
   * the action lease (whose `revision` must equal the record's), and a read
   * marker changes neither. Bumping it would silently cancel a pending expiry
   * and make a leased record fail store validation.
   *
   * A record without a readable envelope is left untouched (`no-envelope`):
   * synthesising one would invent a source/audience/urgency nothing derived.
   * Only a `delivered` record can be read (`not-delivered` otherwise). The
   * marker is merged into the RAW stored envelope, so fields a newer build
   * wrote survive. A dedupe update replaces metadata wholesale, so it also
   * resets the marker — the content changed, so the record is unread again.
   */
  async markRead(
    id: string,
    surfaceId: SurfaceId,
  ): Promise<NotificationMarkReadOutcome> {
    if (!isSurfaceId(surfaceId)) {
      throw new TypeError('markRead requires a surface id');
    }
    const readAt = new Date().toISOString();
    const result = await this.mutate<
      | { outcome: 'read'; notification: StoredNotification }
      | { outcome: Exclude<NotificationMarkReadOutcome, 'read'> }
    >((all) => {
      const notification = all.find((candidate) => candidate.id === id);
      if (!notification) return { result: { outcome: 'not-found' } };
      const envelope = parseNotificationEnvelope(
        notification.metadata?.envelope,
      );
      if (!envelope) return { result: { outcome: 'no-envelope' } };
      if (notification.status !== 'delivered')
        return { result: { outcome: 'not-delivered' } };
      if (envelope.readAt) return { result: { outcome: 'already-read' } };
      stampEnvelopeMark(notification, 'read', readAt, surfaceId);
      notification.updatedAt = readAt;
      return { result: { outcome: 'read', notification }, next: all };
    });
    if (result.outcome !== 'read') return result.outcome;
    notificationOps.add(1, { op: 'read' });
    this.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_UPDATED,
      toPublicNotification(result.notification) as unknown as Record<
        string,
        unknown
      >,
    );
    return 'read';
  }

  private async dismissWithOptions(
    id: string,
    options: {
      notifyProvider: boolean;
      clientOrigin?: ClientOrigin;
      surface?: SurfaceId;
    },
  ): Promise<NotificationDismissal> {
    const result = await this.mutate<NotificationDismissalResult>((all) => {
      const current = all.find((candidate) => candidate.id === id);
      // Once provider dispatch has begun, the provider operation is not
      // reversible. Refusing this late dismiss is the truthful precedence:
      // a dismiss that wins while the action is merely reserved clears the
      // lease below, so the provider is never invoked.
      if (!current) return { result: { outcome: 'not-found' as const } };
      if (current.actionLease?.phase === 'dispatching') {
        return { result: { outcome: 'action-dispatching' as const } };
      }
      current.status = 'dismissed';
      current.updatedAt = new Date().toISOString();
      current.revision += 1;
      delete current.actionLease;
      if (options.surface) {
        stampEnvelopeMark(
          current,
          'dismissed',
          current.updatedAt,
          options.surface,
        );
      }
      return {
        result: { outcome: 'dismissed' as const, notification: current },
        next: all,
      };
    });
    if (result.outcome !== 'dismissed') return result.outcome;
    notificationOps.add(1, { op: 'dismiss' });
    this.clearTimer(id);
    this.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DISMISSED,
      toPublicNotification(result.notification) as unknown as Record<
        string,
        unknown
      >,
    );
    if (options.notifyProvider) {
      const provider = this.providers.get(result.notification.source);
      if (provider?.handleDismiss) {
        this.dispatch('provider-dismiss', () =>
          provider.handleDismiss!(id, options.clientOrigin),
        );
      }
    }
    return 'dismissed';
  }

  async action(
    id: string,
    actionId: string,
    clientOrigin?: ClientOrigin,
  ): Promise<NotificationActionOutcome> {
    const reservation = await this.reserveAction(id, actionId);
    if (!reservation) return this.actionOutcome(id);
    this.clearTimer(id);

    await this.beforeActionDispatch?.(id);
    const dispatch = await this.beginActionDispatch(id, reservation);
    if (!dispatch) return this.actionOutcome(id);

    const provider = this.providers.get(dispatch.source);
    try {
      await provider?.handleAction?.(id, actionId, clientOrigin);
    } catch (error) {
      const restored = await this.releaseActionLease(id, reservation.id);
      if (restored) this.scheduleExpiryTimer(restored);
      throw error;
    }

    const finalized = await this.finalizeAction(id, reservation.id);
    if (!finalized) return this.actionOutcome(id);
    this.clearTimer(id);
    this.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_UPDATED,
      toPublicNotification(finalized) as unknown as Record<string, unknown>,
    );
    return 'actioned';
  }

  async snooze(id: string, until: string): Promise<void> {
    const n = await this.mutate((all) => {
      const notification = all.find((candidate) => candidate.id === id);
      if (!notification || notification.actionLease?.phase === 'dispatching') {
        return { result: undefined };
      }
      notification.status = 'pending';
      notification.scheduledAt = until;
      notification.deliveredAt = null;
      notification.updatedAt = new Date().toISOString();
      notification.revision += 1;
      delete notification.actionLease;
      return { result: notification, next: all };
    });
    if (!n) return;
    notificationOps.add(1, { op: 'snooze' });
    this.clearTimer(id);
    this.scheduleTimer(n);
    this.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_UPDATED,
      toPublicNotification(n) as unknown as Record<string, unknown>,
    );
  }

  async list(opts?: {
    status?: string[];
    category?: string[];
  }): Promise<Notification[]> {
    let results = await this.read();
    if (opts?.status?.length)
      results = results.filter((n) => opts.status!.includes(n.status));
    if (opts?.category?.length)
      results = results.filter((n) => opts.category!.includes(n.category));
    return results.map(toPublicNotification);
  }

  async clearAll(
    canClear?: (notification: Notification) => boolean,
  ): Promise<NotificationClearOutcome> {
    const result = await this.mutate<NotificationClearResult>((all) =>
      this.partitionClear(all, canClear ?? (() => true), false),
    );
    if (result.outcome === 'action-dispatching') return result;
    this.notifyCleared(result.cleared);
    this.eventBus.emit(SERVER_EVENTS.NOTIFICATION_CLEARED, {
      clearedCount: result.cleared.length,
      retainedCount: result.retainedCount,
    });
    return {
      outcome: 'cleared',
      clearedCount: result.cleared.length,
      retainedCount: result.retainedCount,
    };
  }

  async clearActivity(
    canClear: (notification: Notification) => boolean = () => true,
  ): Promise<number> {
    const result = await this.clearActivityWithOutcome(canClear);
    return result.outcome === 'cleared' ? result.clearedCount : 0;
  }

  async clearActivityWithOutcome(
    canClear: (notification: Notification) => boolean = () => true,
  ): Promise<NotificationClearOutcome> {
    const result = await this.mutate<NotificationClearResult>((all) =>
      this.partitionClear(all, canClear, true),
    );
    if (result.outcome === 'action-dispatching') return result;
    this.notifyCleared(result.cleared);
    this.eventBus.emit(SERVER_EVENTS.NOTIFICATION_CLEARED, {
      clearedCount: result.cleared.length,
      retainedCount: result.retainedCount,
    });
    return {
      outcome: 'cleared',
      clearedCount: result.cleared.length,
      retainedCount: result.retainedCount,
    };
  }

  private scheduleTimer(n: StoredNotification): void {
    if (!this.acceptingAsyncDispatch || !n.scheduledAt) return;
    const delay = Math.max(0, new Date(n.scheduledAt).getTime() - Date.now());
    this.timers.set(
      n.id,
      setTimeout(
        () =>
          this.dispatch('scheduled-delivery', () =>
            this.deliver(n.id, n.revision, n.scheduledAt!),
          ),
        delay,
      ),
    );
  }

  private scheduleExpiryTimer(n: StoredNotification): void {
    if (!this.acceptingAsyncDispatch || !n.ttl || n.ttl <= 0 || !n.deliveredAt)
      return;
    // Deadline is measured from the ORIGINAL `deliveredAt`, never
    // `updatedAt` — see the dedupe-update ttl re-derivation comment above
    // (`schedule()`) for the documented consequence when a category-changing
    // update shortens the ttl after delivery.
    const deadline = new Date(n.deliveredAt).getTime() + n.ttl;
    const delay = Math.max(0, deadline - Date.now());
    this.timers.set(
      n.id,
      setTimeout(
        () =>
          this.dispatch('notification-expiry', () =>
            this.expire(n.id, n.revision, deadline),
          ),
        delay,
      ),
    );
  }

  private async deliver(
    id: string,
    revision: number,
    scheduledAt: string,
  ): Promise<void> {
    this.clearTimer(id);
    const n = await this.mutate((all) => {
      const notification = all.find((candidate) => candidate.id === id);
      if (
        notification?.status !== 'pending' ||
        notification.revision !== revision ||
        notification.scheduledAt !== scheduledAt ||
        Date.now() < new Date(scheduledAt).getTime()
      ) {
        return { result: undefined };
      }
      notification.status = 'delivered';
      notification.deliveredAt = new Date().toISOString();
      notification.updatedAt = notification.deliveredAt;
      notification.revision += 1;
      return { result: notification, next: all };
    });
    if (!n) return;
    notificationOps.add(1, { op: 'deliver' });
    this.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_DELIVERED,
      toPublicNotification(n) as unknown as Record<string, unknown>,
    );
    this.scheduleExpiryTimer(n);
  }

  private async expire(
    id: string,
    revision: number,
    deadline: number,
  ): Promise<void> {
    const expired = await this.mutate((all) => {
      const notification = all.find((candidate) => candidate.id === id);
      if (
        notification?.status !== 'delivered' ||
        notification.revision !== revision ||
        !notification.deliveredAt ||
        !notification.ttl ||
        new Date(notification.deliveredAt).getTime() + notification.ttl !==
          deadline ||
        Date.now() < deadline
      ) {
        return { result: undefined };
      }
      notification.status = 'expired';
      notification.updatedAt = new Date().toISOString();
      notification.revision += 1;
      return { result: notification, next: all };
    });
    if (!expired) return;
    this.clearTimer(id);
    this.eventBus.emit(
      SERVER_EVENTS.NOTIFICATION_UPDATED,
      toPublicNotification(expired) as unknown as Record<string, unknown>,
    );
  }

  private partitionClear(
    all: StoredNotification[],
    canClear: (notification: Notification) => boolean,
    preserveActiveApprovals: boolean,
  ): NotificationClearMutation {
    const cleared: StoredNotification[] = [];
    const retained: StoredNotification[] = [];
    let dispatchingCount = 0;
    for (const notification of all) {
      const eligible = canClear(notification);
      if (eligible && notification.actionLease?.phase === 'dispatching') {
        dispatchingCount += 1;
        retained.push(notification);
      } else if (
        !eligible ||
        (preserveActiveApprovals && isActiveApprovalNotification(notification))
      ) {
        retained.push(notification);
      } else {
        cleared.push(notification);
      }
    }
    if (dispatchingCount > 0) {
      return { result: { outcome: 'action-dispatching', dispatchingCount } };
    }
    return {
      result: {
        outcome: 'cleared',
        cleared,
        retainedCount: retained.length,
      },
      ...(cleared.length > 0 ? { next: retained } : {}),
    };
  }

  private notifyCleared(notifications: StoredNotification[]): void {
    const providerDismissals: Array<() => Promise<void>> = [];
    for (const notification of notifications) {
      this.clearTimer(notification.id);
      const provider = this.providers.get(notification.source);
      if (provider?.handleDismiss) {
        providerDismissals.push(() => provider.handleDismiss!(notification.id));
      }
    }
    if (providerDismissals.length > 0) {
      this.dispatch('provider-clear', async () => {
        for (const dismiss of providerDismissals) await dismiss();
      });
    }
  }

  private async actionOutcome(id: string): Promise<NotificationActionOutcome> {
    const notification = (await this.read()).find(
      (candidate) => candidate.id === id,
    );
    if (!notification) return 'not-found';
    if (notification.actionLease?.phase === 'dispatching')
      return 'action-dispatching';
    return 'not-actionable';
  }

  private async reserveAction(
    id: string,
    actionId: string,
  ): Promise<{ id: string; revision: number } | undefined> {
    return this.mutate((all) => {
      const notification = all.find((candidate) => candidate.id === id);
      if (notification?.status !== 'delivered') {
        return { result: undefined };
      }
      if (notification.actionLease?.phase === 'dispatching')
        return { result: undefined };
      if (
        notification.actionLease?.phase === 'reserved' &&
        notification.actionLease.expiresAt >= new Date().toISOString()
      )
        return { result: undefined };
      if (notification.actionLease) {
        delete notification.actionLease;
        notification.revision += 1;
      }
      const revision = notification.revision + 1;
      const lease: NotificationActionLease = {
        id: randomUUID(),
        actionId,
        phase: 'reserved',
        revision,
        expiresAt: new Date(Date.now() + ACTION_LEASE_MS).toISOString(),
      };
      notification.revision = revision;
      notification.updatedAt = new Date().toISOString();
      notification.actionLease = lease;
      return { result: { id: lease.id, revision }, next: all };
    });
  }

  /**
   * The final state check is immediately adjacent to provider dispatch. A
   * dismiss that committed while the action waited at the boundary removes
   * the reserved lease, so this returns undefined and no provider call is
   * made. Once persisted as dispatching, the external operation has begun and
   * a later dismiss is refused rather than being falsely reported as applied.
   */
  private async beginActionDispatch(
    id: string,
    reservation: { id: string; revision: number },
  ): Promise<StoredNotification | undefined> {
    return this.mutate((all) => {
      const notification = all.find((candidate) => candidate.id === id);
      const lease = notification?.actionLease;
      if (
        notification?.status !== 'delivered' ||
        !lease ||
        lease.id !== reservation.id ||
        lease.revision !== reservation.revision ||
        lease.phase !== 'reserved' ||
        lease.expiresAt < new Date().toISOString()
      ) {
        return { result: undefined };
      }
      lease.phase = 'dispatching';
      notification.revision += 1;
      lease.revision = notification.revision;
      notification.updatedAt = new Date().toISOString();
      return { result: notification, next: all };
    });
  }

  private async finalizeAction(
    id: string,
    leaseId: string,
  ): Promise<StoredNotification | undefined> {
    return this.mutate((all) => {
      const notification = all.find((candidate) => candidate.id === id);
      if (
        notification?.status !== 'delivered' ||
        notification.actionLease?.id !== leaseId ||
        notification.actionLease?.phase !== 'dispatching'
      ) {
        return { result: undefined };
      }
      notification.status = 'actioned';
      notification.updatedAt = new Date().toISOString();
      notification.revision += 1;
      delete notification.actionLease;
      return { result: notification, next: all };
    });
  }

  private async releaseActionLease(
    id: string,
    leaseId: string,
  ): Promise<StoredNotification | undefined> {
    return this.mutate((all) => {
      const notification = all.find((candidate) => candidate.id === id);
      if (
        notification?.status !== 'delivered' ||
        notification.actionLease?.id !== leaseId
      ) {
        return { result: undefined };
      }
      notification.updatedAt = new Date().toISOString();
      notification.revision += 1;
      delete notification.actionLease;
      return { result: notification, next: all };
    });
  }

  private async updateStatus(
    id: string,
    status: Notification['status'],
  ): Promise<StoredNotification | undefined> {
    return this.mutate((all) => {
      const n = all.find((notification) => notification.id === id);
      if (
        !n ||
        n.status === 'dismissed' ||
        n.actionLease?.phase === 'dispatching'
      ) {
        return { result: undefined };
      }
      n.status = status;
      n.updatedAt = new Date().toISOString();
      n.revision += 1;
      delete n.actionLease;
      return { result: n, next: all };
    });
  }

  /**
   * Serialize every read/transition/write across Station processes. In
   * particular, the transition reads only after the lock is held: retaining
   * a prior array from before a concurrent dismiss, clear, timer delivery, or
   * provider update would otherwise publish that stale array back to disk.
   */
  private async mutate<T>(
    mutation: (notifications: StoredNotification[]) => {
      result: T;
      next?: StoredNotification[];
    },
  ): Promise<T> {
    const release = await this.acquireMutationLock(
      `${this.storePath}.mutation`,
    );
    try {
      const outcome = mutation(this.readUnderMutationLock());
      if (outcome.next)
        this.store.write(validateNotificationDocument(outcome.next));
      return outcome.result;
    } finally {
      await release();
    }
  }

  private async read(): Promise<StoredNotification[]> {
    const snapshot = this.store.read();
    try {
      return validateNotificationDocument(snapshot);
    } catch (error) {
      if (!(error instanceof NotificationStoreValidationError)) throw error;
    }

    const release = await this.acquireMutationLock(
      `${this.storePath}.mutation`,
    );
    try {
      return this.readUnderMutationLock();
    } finally {
      await release();
    }
  }

  /**
   * archive#2259: revision was added after durable notification documents already
   * existed. The one supported legacy shape is an otherwise-valid whole
   * document whose records all lack both revision and action leases. Holding
   * the same mutation lock as normal transitions, and doing this at the one
   * storage-read seam, ensures pre-start consumers see migrated state without
   * allowing a stale pre-lock read to overwrite a concurrent current write.
   */
  private readUnderMutationLock(): StoredNotification[] {
    const document = this.store.read();
    try {
      return validateNotificationDocument(document);
    } catch (error) {
      if (!(error instanceof NotificationStoreValidationError)) throw error;
    }
    const migrated = migrateLegacyNotificationDocument(document);
    this.store.write(migrated);
    return migrated;
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  /**
   * One rejection-safe bridge for EventBus, timers, and other synchronous
   * adapters. Operations stay ordered, failures remain observable, and the
   * queue itself is never left rejected (which would strand later work).
   */
  dispatch(operation: string, task: () => Promise<unknown>): boolean {
    if (!this.acceptingAsyncDispatch) {
      this.observeAsyncDispatchError(
        operation,
        new NotificationDispatchClosedError(operation),
      );
      return false;
    }
    const run = this.asyncDispatchTail.then(task);
    this.asyncDispatchTail = run.then(
      () => undefined,
      (error) => this.observeAsyncDispatchError(operation, error),
    );
    return true;
  }

  private observeAsyncDispatchError(operation: string, error: unknown): void {
    try {
      this.onAsyncDispatchError?.(operation, error);
    } catch (observerError) {
      logger.warn('Notification async adapter error observer failed', {
        operation,
        error: observerError,
      });
    }
  }

  /**
   * The single public lifecycle boundary. Closing admissions first gives the
   * tail a stable meaning; producers are cancelled before and after draining
   * so already-admitted start/poll work cannot re-arm them. A timeout rejects
   * shutdown while the queue retains its rejection handler, avoiding orphaned
   * promise rejections if a hung task eventually settles.
   */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    this.acceptingAsyncDispatch = false;
    this.stopProducers();
    const admittedTail = this.asyncDispatchTail;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        admittedTail,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new NotificationShutdownTimeoutError(this.shutdownTimeoutMs),
              ),
            this.shutdownTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.stopProducers();
    }
  }

  /** Deterministic lifecycle/test seam for all queued synchronous adapters. */
  async drainAsyncDispatch(): Promise<void> {
    await this.asyncDispatchTail;
  }

  /**
   * Public (not just interval-driven) so a caller/test can trigger exactly
   * one poll cycle deterministically — see archive#1912's dismissed-provider
   * regression test — rather than awaiting an unobservable fire-and-forget
   * call inside `start()`.
   */
  async poll(): Promise<void> {
    for (const provider of this.providers.values()) {
      if (provider.poll) {
        try {
          const items = await provider.poll();
          for (const opts of items) {
            try {
              await this.schedule(provider.id, opts);
            } catch (e) {
              // One refused item (a tag another source owns, a reserved
              // field) must not drop the rest of this provider's poll.
              if (
                !(e instanceof NotificationDedupeSourceConflictError) &&
                !(e instanceof NotificationReservedFieldError)
              )
                throw e;
              logger.warn('Notification provider item refused', {
                provider: provider.id,
                reason: e.name,
              });
            }
          }
        } catch (e) {
          logger.debug('Failed to poll notification provider', {
            provider: provider.id,
            error: e,
          });
        }
      }
      if (provider.syncStatus) {
        try {
          const updates = await provider.syncStatus();
          for (const update of updates) {
            // A provider syncs only its OWN records, and never an enveloped
            // or `agent:` one: an unscoped tag lookup let any provider
            // dismiss (permanently suppressing) or action an agent record.
            if (
              typeof update.dedupeTag !== 'string' ||
              update.dedupeTag.startsWith(AGENT_NOTIFICATION_DEDUPE_PREFIX)
            )
              continue;
            const all = await this.read();
            const notification = all.find(
              (n) =>
                n.source === provider.id &&
                (n.metadata as any)?.dedupeTag === update.dedupeTag &&
                !Object.hasOwn(n.metadata ?? {}, 'envelope'),
            );
            if (!notification) continue;
            if (update.status === 'actioned') {
              await this.action(notification.id, update.actionId ?? 'default');
            } else {
              await this.markStatus(notification.id, update.status);
            }
          }
        } catch (e) {
          logger.debug('Failed to sync status for notification provider', {
            provider: provider.id,
            error: e,
          });
        }
      }
    }
  }
}

function isActiveApprovalNotification(notification: Notification): boolean {
  return (
    notification.category === 'approval-request' &&
    (notification.status === 'delivered' || notification.status === 'pending')
  );
}

function toPublicNotification(notification: StoredNotification): Notification {
  const {
    actionLease: _actionLease,
    revision: _revision,
    ...publicNotification
  } = notification;
  return structuredClone(publicNotification);
}

const NOTIFICATION_FIELDS = new Set([
  'id',
  'source',
  'category',
  'title',
  'body',
  'priority',
  'status',
  'scheduledAt',
  'deliveredAt',
  'ttl',
  'actions',
  'metadata',
  'createdAt',
  'updatedAt',
  'revision',
  'actionLease',
]);
const REQUIRED_NOTIFICATION_FIELDS = [
  'id',
  'source',
  'category',
  'title',
  'priority',
  'status',
  'scheduledAt',
  'deliveredAt',
  'metadata',
  'createdAt',
  'updatedAt',
  'revision',
];
const NOTIFICATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validateNotificationDocument(value: unknown): StoredNotification[] {
  if (!Array.isArray(value)) throw new NotificationStoreValidationError();
  const notifications = value.map(validateStoredNotification);
  const ids = new Set<string>();
  const dedupeTags = new Set<string>();
  for (const notification of notifications) {
    if (ids.has(notification.id)) throw new NotificationStoreValidationError();
    ids.add(notification.id);
    const dedupeTag = notification.metadata?.dedupeTag;
    if (dedupeTag !== undefined) {
      if (!isCanonicalText(dedupeTag) || dedupeTags.has(dedupeTag)) {
        throw new NotificationStoreValidationError();
      }
      dedupeTags.add(dedupeTag);
    }
  }
  return notifications;
}

function migrateLegacyNotificationDocument(
  value: unknown,
): StoredNotification[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (notification) =>
        !isRecord(notification) ||
        Object.hasOwn(notification, 'revision') ||
        Object.hasOwn(notification, 'actionLease'),
    )
  ) {
    throw new NotificationStoreValidationError();
  }
  return validateNotificationDocument(
    value.map((notification) => ({ ...notification, revision: 1 })),
  );
}

function validateStoredNotification(value: unknown): StoredNotification {
  if (!isRecord(value)) throw new NotificationStoreValidationError();
  if (
    REQUIRED_NOTIFICATION_FIELDS.some(
      (field) => !Object.hasOwn(value, field),
    ) ||
    Object.keys(value).some((field) => !NOTIFICATION_FIELDS.has(field)) ||
    !isNotificationId(value.id) ||
    !isCanonicalText(value.source) ||
    !isCanonicalText(value.category) ||
    !isCanonicalText(value.title) ||
    (Object.hasOwn(value, 'body') && !isCanonicalOptionalText(value.body)) ||
    !isNotificationPriority(value.priority) ||
    !isNotificationStatus(value.status) ||
    !isTimestampOrNull(value.scheduledAt) ||
    !isTimestampOrNull(value.deliveredAt) ||
    (Object.hasOwn(value, 'ttl') && !isPositiveOrZeroInteger(value.ttl)) ||
    (Object.hasOwn(value, 'actions') &&
      !isNotificationActions(value.actions)) ||
    !isJsonRecord(value.metadata) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    !isPositiveInteger(value.revision) ||
    (Object.hasOwn(value, 'actionLease') &&
      !isActionLease(value.actionLease, value.revision)) ||
    !hasConsistentNotificationState(value)
  ) {
    throw new NotificationStoreValidationError();
  }
  return value as unknown as StoredNotification;
}

function hasConsistentNotificationState(
  value: Record<string, unknown>,
): boolean {
  const status = value.status;
  const scheduledAt = value.scheduledAt;
  const deliveredAt = value.deliveredAt;
  if (Object.hasOwn(value, 'actionLease') && status !== 'delivered')
    return false;
  if (status === 'pending')
    return typeof scheduledAt === 'string' && deliveredAt === null;
  if (status === 'delivered' || status === 'actioned' || status === 'expired') {
    return (
      typeof deliveredAt === 'string' &&
      (scheduledAt === null ||
        (typeof scheduledAt === 'string' &&
          Date.parse(scheduledAt) <= Date.parse(deliveredAt)))
    );
  }
  return status === 'dismissed';
}

function isActionLease(value: unknown, revision: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 5 &&
    Object.hasOwn(value, 'id') &&
    Object.hasOwn(value, 'actionId') &&
    Object.hasOwn(value, 'phase') &&
    Object.hasOwn(value, 'revision') &&
    Object.hasOwn(value, 'expiresAt') &&
    isNotificationId(value.id) &&
    isCanonicalText(value.actionId) &&
    (value.phase === 'reserved' || value.phase === 'dispatching') &&
    value.revision === revision &&
    isCanonicalTimestamp(value.expiresAt)
  );
}

function isNotificationActions(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((action) => {
    if (
      !isRecord(action) ||
      Object.keys(action).some(
        (field) => !['id', 'label', 'variant'].includes(field),
      ) ||
      !Object.hasOwn(action, 'id') ||
      !Object.hasOwn(action, 'label') ||
      !isCanonicalText(action.id) ||
      !isCanonicalText(action.label) ||
      (Object.hasOwn(action, 'variant') &&
        action.variant !== 'primary' &&
        action.variant !== 'secondary' &&
        action.variant !== 'danger') ||
      ids.has(action.id)
    ) {
      return false;
    }
    ids.add(action.id);
    return true;
  });
}

function isNotificationPriority(value: unknown): boolean {
  return (
    value === 'low' ||
    value === 'normal' ||
    value === 'high' ||
    value === 'urgent'
  );
}

function isNotificationStatus(value: unknown): boolean {
  return (
    value === 'pending' ||
    value === 'delivered' ||
    value === 'dismissed' ||
    value === 'expired' ||
    value === 'actioned'
  );
}

function isTimestampOrNull(value: unknown): boolean {
  return value === null || isCanonicalTimestamp(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isNotificationId(value: unknown): value is string {
  return typeof value === 'string' && NOTIFICATION_ID_PATTERN.test(value);
}

function isCanonicalText(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isCanonicalOptionalText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPositiveOrZeroInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Drops `undefined`-valued keys from caller-supplied metadata.
 *
 * `isJsonRecord` (correctly) rejects `undefined`, but callers assemble
 * metadata from optional fields — `approval-inbox.ts` builds a dozen entries
 * out of `message.data?.x`, so one absent field made the WHOLE store document
 * invalid and every approval notification vanished. Persisting the same object
 * would have dropped those keys anyway (`JSON.stringify` omits `undefined`),
 * so the document being rejected is one that could never exist on disk.
 * Normalize on write rather than weaken the validator.
 */
function jsonSafeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

/**
 * Records the first read/dismiss of an enveloped record by merging into the
 * RAW stored envelope (a newer build's unknown fields survive). No-op for a
 * record whose envelope does not read, or whose mark is already set.
 */
function stampEnvelopeMark(
  notification: StoredNotification,
  mark: 'read' | 'dismissed',
  at: string,
  by: SurfaceId,
): void {
  const raw = notification.metadata?.envelope;
  const envelope = parseNotificationEnvelope(raw);
  if (!envelope || !isRecord(raw)) return;
  if (mark === 'read' ? envelope.readAt : envelope.dismissedAt) return;
  notification.metadata = {
    ...notification.metadata,
    envelope:
      mark === 'read'
        ? { ...raw, readAt: at, readBy: by }
        : { ...raw, dismissedAt: at, dismissedBy: by },
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}
