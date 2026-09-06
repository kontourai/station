import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import type {
  AttachedSessionCursor,
  AttachedSessionDescriptor,
  AttachedSessionDiscoveryResult,
  AttachedSessionReadResult,
  AttachedSessionSource,
} from '../../providers/sessions/attached-session-source.js';
import { safeSanitizeUIBlockEventProvenance } from '../../runtime/conversation/ui-block-provenance.js';
import {
  attachedSessionDiscovery,
  attachedSessionEventsImported,
  attachedSessionProjectAttribution,
  attachedSessionScanDuration,
} from '../../telemetry/metrics.js';
import { expandTilde } from '../../utils/paths.js';
import type { AdoptionLedger } from './adoption-ledger.js';
import type { EventBus } from './event-bus.js';
import type { EventStore } from './event-store.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_TRACKED_THREADS = 256;
const MAX_SEEN_EVENT_IDS = 2_048;

interface FollowState {
  ownership: 'attached' | 'collision';
  seen: Map<string, true>;
  cursors: Map<string, AttachedSessionCursorOwner>;
  /**
   * The attribution the PERSISTED log already expresses, read once when this
   * thread is first followed in this process. Without it the fingerprinted
   * envelope id would re-stamp every session ever followed on the first poll
   * after upgrade (their stored ids predate the fingerprint), which is work
   * nobody asked for and, worse, would make an attach fact the newest event
   * on every one of those threads.
   *
   * It is also the PREDECESSOR half of the envelope id (archive#3495): the
   * id addresses the transition `storedAttribution -> fingerprint`, so this
   * field is the only thing the id needs beyond the new value. See
   * {@link envelopeEventId}.
   */
  storedAttribution?: string;
  /**
   * createdAt of the newest event known for this thread. A correction is
   * dated no earlier than this, so `lastEventAt` (which the home list reads
   * as last activity) can never jump BACKWARDS to session-creation time when
   * a re-attribution lands on a session whose transcript has moved on.
   */
  latestEventAt?: string;
}

const ATTACHED_SESSION_CURSOR_KIND = 'station.attached-session-cursor/v1';

interface PersistedAttachedSessionCursor {
  kind: typeof ATTACHED_SESSION_CURSOR_KIND;
  provider: string;
  sourceHandle: string;
  cursor: AttachedSessionCursor;
}

interface AttachedSessionCursorOwner {
  provider: string;
  sourceKind: string;
  sourceHandle: string;
  cursor: AttachedSessionCursor;
}

export interface AttachedProjectRoot {
  slug: string;
  workingDirectory?: string;
}

/**
 * How many project roots {@link resolveAttachedProjectRoots} resolves at once.
 *
 * Four, not "all of them": each resolution can spawn a `git` subprocess, and
 * this runs on a two-second poll. Four keeps the steady-state fan-out well
 * below any plausible process limit while still finishing a 100-project
 * Station's healthy resolution (single-digit ms each) inside one poll tick.
 */
const DEFAULT_ROOT_RESOLUTION_CONCURRENCY = 4;

/**
 * archive#1501, seam S5: the candidate roots for the reverse map,
 * with each project's directory taken from `resolveProjectResource` when that
 * resolver can vouch for it.
 *
 * **It UPGRADES a root; it never REMOVES one.** When the resolver answers
 * anything but `bound`, the raw stored `workingDirectory` is kept as the
 * candidate. That is not a softening of the exact-match-or-honest-unavailable
 * rule — it is archive#1462's finding applied in the direction it points.
 * `canonicalPath`'s docblock below records that DROPPING a root that does not
 * resolve right now (an unmounted volume, a deleted checkout) "hid a real
 * second project on the same directory", turning a genuine ambiguity into a
 * confident, wrong `attributed`. In a REVERSE map, a missing candidate is not
 * a smaller claim than a present one; it is a bigger one, and it is written
 * once into a content-addressed event id that never re-derives.
 *
 * So the candidate set is identical in size and membership to what
 * `listProjects()` produces. Only the path string improves, and only when the
 * resolver could actually verify it.
 *
 * Note that "never removes a root" is a rule at PROJECT granularity: the
 * candidate list keeps one entry per project either way. It is not a promise
 * that a project's path is never *changed* — a manifest binding that points
 * somewhere other than `workingDirectory` deliberately replaces the path, and
 * that replacement is the whole point of the seam. What can never happen is a
 * project dropping out of the candidate set because its path failed to
 * resolve.
 *
 * For a project without a manifest this is observably a no-op today: the
 * resolver's compat branch returns `resolve(expandTilde(workingDirectory))`,
 * which `canonicalPath` already computed before its own `realpath`. It starts
 * mattering once a manifest and a binding exist and the binding points
 * somewhere other than `workingDirectory`.
 *
 * ## Concurrency (archive#1501 review, FIX 3)
 *
 * `resolvePath` is not cheap: for a manifest-bearing project it spawns a
 * `git remote -v` subprocess. This runs once per project per poll, and the
 * poll interval is two seconds. An unbounded `Promise.all` over a Station
 * with N projects therefore spawns N git processes simultaneously, every two
 * seconds, forever — on a large fleet that is a process-table and page-cache
 * problem of its own, independent of any hang.
 *
 * So resolution runs through a fixed-size worker pool. `concurrency` is a
 * parameter with a conservative default rather than a constant, because the
 * right value is a property of the host, not of this function.
 *
 * The pool interacts with `DEFAULT_CHECKOUT_REMOTE_TIMEOUT_MS`
 * (`../projects/checkout-remote-reader.ts`): the
 * per-read timeout is what stops a wedged mount from making this function
 * (and therefore `poll()`) hang forever. Bounding concurrency alone would not
 * — it would only cap how many processes hang at once. With both, the
 * worst-case duration of a fully-pathological resolution is
 * `ceil(N / concurrency) * timeout`, which degrades the discovery *cadence*
 * (`pollNow`'s single-flight guard skips overlapping ticks) instead of
 * stopping discovery permanently, and every root falls back to its stored
 * `workingDirectory` in the meantime.
 *
 * **Residual, disclosed:** a `resolvePath` that hangs for some reason OTHER
 * than the bounded git read — a caller-supplied resolver, a future filesystem
 * probe with no timeout of its own — still stalls this function and with it
 * the poll. There is no deadline here that would catch that; the bound lives
 * at the operation that actually blocks.
 */
export async function resolveAttachedProjectRoots(
  projects: readonly AttachedProjectRoot[],
  resolvePath: (
    slug: string,
  ) => string | undefined | Promise<string | undefined>,
  concurrency = DEFAULT_ROOT_RESOLUTION_CONCURRENCY,
): Promise<AttachedProjectRoot[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const resolved = new Array<AttachedProjectRoot>(projects.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= projects.length) return;
      const project = projects[index];
      resolved[index] = {
        slug: project.slug,
        workingDirectory:
          (await resolvePath(project.slug)) ?? project.workingDirectory,
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, projects.length) }, worker),
  );
  return resolved;
}

export interface AttachedSessionFollowServiceOptions {
  sources: AttachedSessionSource[];
  eventStore: EventStore;
  /** Adoption's composed Interface, used only for durable cursor ownership. */
  adoptionLedger?: AdoptionLedger;
  eventBus: EventBus;
  /**
   * The raw project roots, straight off the project store. Still required:
   * it is the fallback when `resolveProjectRoots` is unwired, and — see that
   * option — the source of a root the resolver declines to vouch for.
   *
   * NOTE: this callback is deliberately NOT shared with `OrchestrationService`,
   * which passes its own `() => storageAdapter.listProjects()` closure and
   * consumes it from the SYNCHRONOUS `resolveStartSessionCwd`. Do not make
   * this one async; flipping that seam is slice 3c's job.
   */
  listProjects: () => AttachedProjectRoot[];
  /**
   * archive#1501, seam S5 (`docs/design/portable-project-identity.md`
   * §2.2.1): where the roots come from. Optional so an unwired host (and every
   * existing test) keeps resolving through `listProjects()` unchanged.
   */
  resolveProjectRoots?: () => Promise<AttachedProjectRoot[]>;
  pollIntervalMs?: number;
  now?: () => Date;
  /** Testable lower bound for the fixed production deduplication cache. */
  maxSeenEventIds?: number;
  /**
   * archive#1399 fix round 2, B1/B4: optional so every existing caller/test
   * keeps constructing this service unchanged. When present, a
   * provenance-sanitizer failure inside `appendAndPublish` is logged
   * through it rather than silently swallowed; absent, sanitization still
   * runs (and still never throws or drops the event) — only the warning is
   * lost.
   */
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

/**
 * Follows provider-neutral, read-only transcript sources. It deliberately
 * never asks an adapter whether an external process is alive: freshness is
 * only the observed file scan time and transcript records are retained after
 * their source disappears.
 */
export class AttachedSessionFollowService {
  private readonly pollIntervalMs: number;
  private readonly maxSeenEventIds: number;
  private readonly followStates = new Map<string, FollowState>();
  private timer: NodeJS.Timeout | undefined;
  private activePoll: Promise<void> | undefined;
  private readonly adoptionLedger: AdoptionLedger;

  constructor(private readonly options: AttachedSessionFollowServiceOptions) {
    this.adoptionLedger =
      options.adoptionLedger ?? options.eventStore.createAdoptionLedger();
    this.pollIntervalMs = boundedPollInterval(
      options.pollIntervalMs ?? resolveAttachedSessionPollInterval(),
    );
    this.maxSeenEventIds =
      Number.isInteger(options.maxSeenEventIds) &&
      (options.maxSeenEventIds ?? 0) > 0
        ? Math.min(options.maxSeenEventIds!, MAX_SEEN_EVENT_IDS)
        : MAX_SEEN_EVENT_IDS;
  }

  start(): void {
    if (this.timer) return;
    void this.pollNow();
    this.timer = setInterval(() => void this.pollNow(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  pollNow(): Promise<void> {
    if (this.activePoll) return this.activePoll;
    const poll = this.poll().finally(() => {
      if (this.activePoll === poll) this.activePoll = undefined;
    });
    this.activePoll = poll;
    return poll;
  }

  /**
   * The candidate roots for one poll.
   *
   * Resolved ONCE per poll rather than once per discovered session: the
   * resolver performs live filesystem checks, and the previous per-session
   * `listProjects()` call was a cheap in-memory read. Every session in one
   * poll now sees one consistent snapshot of the project set, which is
   * strictly better for attribution than re-reading between sessions.
   */
  private async projectRoots(): Promise<AttachedProjectRoot[]> {
    if (this.options.resolveProjectRoots) {
      return await this.options.resolveProjectRoots();
    }
    return this.options.listProjects();
  }

  private async poll(): Promise<void> {
    const projectRoots = await this.projectRoots();
    for (const source of this.options.sources) {
      const startedAt = performance.now();
      let discovered: AttachedSessionDiscoveryResult;
      try {
        discovered = await source.discover();
      } catch {
        attachedSessionDiscovery.add(1, {
          source: sourceLabel(source),
          outcome: 'unknown_source',
        });
        attachedSessionScanDuration.record(performance.now() - startedAt, {
          source: sourceLabel(source),
          outcome: 'unknown_source',
        });
        continue;
      }
      attachedSessionDiscovery.add(1, {
        source: sourceLabel(source),
        outcome: discovered.outcome,
      });
      attachedSessionScanDuration.record(performance.now() - startedAt, {
        source: sourceLabel(source),
        outcome: discovered.outcome,
      });
      let followedSessions = 0;
      for (const session of discovered.sessions) {
        const attribution = resolveAttachedProjectRoot(
          session.cwd,
          projectRoots,
        );
        attachedSessionProjectAttribution.add(1, {
          source: sourceLabel(source),
          state: attribution.state,
        });
        // An ambiguous attribution is still followed: the session is real and
        // dropping it would hide a live external session entirely. What it
        // does NOT get is a slug it hasn't earned (archive#1462).
        if (attribution.state === 'unattributed') continue;
        await this.follow(source, session, attribution);
        followedSessions += 1;
        // `follow()` performs synchronous EventStore reads and writes. Its
        // source calls can resolve immediately, which otherwise chains every
        // following session through Promise microtasks and prevents HTTP/timer
        // work from running on a large persisted attached-session set.
        if (followedSessions % FOLLOW_YIELD_EVERY === 0) {
          await yieldEventLoop();
        }
      }
    }
  }

  private async follow(
    source: AttachedSessionSource,
    descriptor: AttachedSessionDescriptor,
    attribution: Exclude<AttachedProjectAttribution, { state: 'unattributed' }>,
  ): Promise<void> {
    const state = this.followState(source, descriptor);
    // archive#1997: one persisted-sessions snapshot for both the ownership
    // check and the alias lookup — this ran up to four separate full
    // `readSessions()` scans per followed session per 2s tick (two here, up
    // to two more inside `followState` above), and every scan is synchronous
    // sqlite + JSON parsing on the main thread. The two reads it replaces
    // happened microseconds apart, so one snapshot is strictly consistent.
    const persistedSessions = this.options.eventStore.readSessions();
    if (this.isStationOwnedProviderCursor(descriptor, persistedSessions)) {
      const alias = persistedSessions.find(
        (session) => session.threadId === descriptor.threadId,
      );
      if (alias?.controlMode === 'read-only-attached') {
        this.options.eventStore.deleteThread(descriptor.threadId);
      }
      state.ownership = 'collision';
    }
    if (state.ownership === 'collision') return;
    const fingerprint = attributionFingerprint(attribution);
    if (state.storedAttribution !== fingerprint) {
      let envelopeWrites = 0;
      for (const event of attachedSessionEnvelope(
        descriptor,
        attribution,
        fingerprint,
        state.latestEventAt,
        state.storedAttribution,
      )) {
        if (!state.seen.has(event.eventId)) {
          this.appendAndPublish(event);
          rememberEvent(state.seen, event.eventId, this.maxSeenEventIds);
          envelopeWrites += 1;
          if (envelopeWrites % APPEND_YIELD_EVERY === 0) {
            await yieldEventLoop();
          }
        }
      }
      state.storedAttribution = fingerprint;
    }

    const priorCursor = state.cursors.get(sourceCursorKey(source));
    const reusableCursor = cursorMatchesSource(priorCursor, source, descriptor)
      ? priorCursor.cursor
      : undefined;
    let read: AttachedSessionReadResult;
    try {
      read = await source.read(descriptor, reusableCursor);
    } catch {
      // Preserve an already durable cursor even when this observation fails.
      // A later successful poll can continue without replaying the source.
      this.persistAttachedSession(source, descriptor, reusableCursor);
      attachedSessionDiscovery.add(1, {
        source: sourceLabel(source),
        outcome: 'unknown_source',
      });
      return;
    }
    state.cursors.set(sourceCursorKey(source), {
      provider: source.provider,
      sourceKind: source.kind,
      sourceHandle: descriptor.sourceHandle,
      cursor: read.cursor,
    });
    // The source cursor used to be process-local. A cold restart therefore
    // reparsed every bounded transcript page from every attached session,
    // repeatedly issuing indexed duplicate lookups until it caught up. Persist
    // the opaque offset together with the discovery snapshot's opaque handle;
    // a moved/replaced source gets a different handle and safely restarts from
    // its bounded recent window (archive#1997).
    this.persistAttachedSession(source, descriptor, read.cursor);
    // Legacy rows and a source whose opaque handle changed still replay one
    // bounded transcript window. Discard durable ids with one indexed read per
    // batch instead of making each duplicate enter appendEventIfAbsent's
    // synchronous write/sequence path (archive#1997).
    const persistedEventIds = this.options.eventStore.existingEventIds(
      read.events.map((event) => event.eventId),
    );
    let imported = 0;
    for (const event of read.events) {
      if (
        event.threadId !== descriptor.threadId ||
        state.seen.has(event.eventId) ||
        persistedEventIds.has(event.eventId)
      ) {
        continue;
      }
      this.appendAndPublish(event);
      rememberEvent(state.seen, event.eventId, this.maxSeenEventIds);
      if (!state.latestEventAt || event.createdAt > state.latestEventAt) {
        state.latestEventAt = event.createdAt;
      }
      attachedSessionEventsImported.add(1, {
        source: sourceLabel(source),
        method: event.method,
      });
      imported += 1;
      // Keep identity/readiness probes responsive during Claude transcript
      // backfill (dogfood hang: 20k+ sync INSERT OR IGNORE starved the loop).
      if (imported % APPEND_YIELD_EVERY === 0) {
        await yieldEventLoop();
      }
    }
  }

  private followState(
    source: AttachedSessionSource,
    descriptor: AttachedSessionDescriptor,
  ): FollowState {
    const cached = this.followStates.get(descriptor.threadId);
    if (cached) {
      const persistedSessions = this.options.eventStore.readSessions();
      if (this.isStationOwnedProviderCursor(descriptor, persistedSessions)) {
        const alias = persistedSessions.find(
          (session) => session.threadId === descriptor.threadId,
        );
        if (alias?.controlMode === 'read-only-attached') {
          this.options.eventStore.deleteThread(descriptor.threadId);
        }
        cached.ownership = 'collision';
      }
      this.followStates.delete(descriptor.threadId);
      this.followStates.set(descriptor.threadId, cached);
      return cached;
    }

    const persistedSessions = this.options.eventStore.readSessions();
    const persisted = persistedSessions.find(
      (session) => session.threadId === descriptor.threadId,
    );
    const isStationOwnedProviderCursor = this.isStationOwnedProviderCursor(
      descriptor,
      persistedSessions,
    );
    if (
      isStationOwnedProviderCursor &&
      persisted?.controlMode === 'read-only-attached'
    ) {
      this.options.eventStore.deleteThread(descriptor.threadId);
    }
    // archive#1867 class: never materialize the full thread via listEvents on
    // the cold path — large Claude-import threads (10k–20k events) held the
    // event loop inside sqlite3_step and made identity probes time out while
    // the port stayed bound.
    //
    // archive#3495: "ownership rows" was still an UNBOUNDED read. On a thread
    // this service had itself grown to 259,286 `session.started` rows it cost
    // ~1.2 GB of parsed payloads at boot with no client connected. Only ONE
    // fact is wanted — the attribution the newest `session.configured`
    // expresses — so a bounded newest-first window is enough, and the id no
    // longer depends on a COUNT of the log (see `envelopeEventId`), which is
    // what previously made "read every row" the only correct read.
    const configuredEvents =
      this.options.eventStore.listRecentConfiguredEventsByThread(
        descriptor.threadId,
        ATTRIBUTION_LOOKBACK_EVENTS,
      );
    const state: FollowState = {
      ownership:
        isStationOwnedProviderCursor ||
        (persisted && persisted.controlMode !== 'read-only-attached')
          ? 'collision'
          : 'attached',
      seen: new Map(),
      cursors: restoredAttachedSessionCursors(persisted, source, descriptor),
      ...persistedEnvelopeFacts(configuredEvents, {
        latestEventAt: this.options.eventStore.latestEventCreatedAtByThread(
          descriptor.threadId,
        ),
      }),
    };
    // Persistence is the authoritative idempotence boundary. The bounded
    // in-memory set only avoids repeated database work during steady-state
    // polling; restart and LRU eviction safely replay through INSERT IGNORE.
    this.followStates.set(descriptor.threadId, state);
    while (this.followStates.size > MAX_TRACKED_THREADS) {
      const oldest = this.followStates.keys().next().value;
      if (oldest === undefined) break;
      this.followStates.delete(oldest);
    }
    return state;
  }

  private isStationOwnedProviderCursor(
    descriptor: AttachedSessionDescriptor,
    sessions = this.options.eventStore.readSessions(),
  ): boolean {
    return (
      this.adoptionLedger.reservesProviderCursor(
        descriptor.provider,
        descriptor.sessionId,
      ) ||
      sessions.some(
        (session) =>
          session.controlMode !== 'read-only-attached' &&
          session.provider === descriptor.provider &&
          session.resumeCursor === descriptor.sessionId,
      )
    );
  }

  private persistAttachedSession(
    source: AttachedSessionSource,
    descriptor: AttachedSessionDescriptor,
    cursor?: AttachedSessionCursor,
  ): void {
    const attached = {
      kind: source.kind,
      externalSessionId: descriptor.sessionId,
    };
    const session = {
      provider: descriptor.provider,
      threadId: descriptor.threadId,
      status: 'ready',
      cwd: descriptor.cwd,
      createdAt: descriptor.createdAt,
      updatedAt: this.options.now?.().toISOString() ?? new Date().toISOString(),
      controlMode: 'read-only-attached',
      attachedSource: attached,
      ...(cursor === undefined
        ? {}
        : {
            resumeCursor: {
              kind: ATTACHED_SESSION_CURSOR_KIND,
              provider: descriptor.provider,
              sourceHandle: descriptor.sourceHandle,
              cursor,
            } satisfies PersistedAttachedSessionCursor,
          }),
    } as ProviderSession;
    this.options.eventStore.upsertSession(session);
  }

  /**
   * archive#1399 fix round 2, B1 (independent review) — a SECOND
   * provenance-sanitizing writer, sibling to
   * `OrchestrationService#publishCanonicalEvent`. This service imports
   * source events straight off an attached transcript
   * (`claude-transcript-session-source.ts`'s `mapToolResult` builds a
   * `tool.completed` event with `output: raw.content` — unvalidated
   * transcript content) and appends+publishes them directly, entirely
   * outside `OrchestrationService`'s call graph. Sanitizing HERE,
   * immediately before `appendEventIfAbsent` and the event-bus emit — same
   * one-writer discipline, same order (sanitize before persist, before
   * publish) — is what closes that bypass rather than trusting whatever a
   * transcript file happened to contain. The safe wrapper (B4) means a
   * sanitizer exception here can never drop an imported event or crash the
   * poll loop.
   */
  private appendAndPublish(event: CanonicalRuntimeEvent): void {
    event = safeSanitizeUIBlockEventProvenance(event, (message, meta) =>
      this.options.logger?.warn(message, meta),
    );
    const sequence = this.options.eventStore.appendEventIfAbsent(event);
    if (sequence === undefined) return;
    this.options.eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event });
  }
}

function restoredAttachedSessionCursors(
  persisted: ProviderSession | undefined,
  source: AttachedSessionSource,
  descriptor: AttachedSessionDescriptor,
): FollowState['cursors'] {
  const cursors: FollowState['cursors'] = new Map();
  const value = persisted?.resumeCursor;
  if (
    persisted?.controlMode !== 'read-only-attached' ||
    !value ||
    typeof value !== 'object'
  ) {
    return cursors;
  }
  const record = value as Partial<PersistedAttachedSessionCursor>;
  if (
    record.kind !== ATTACHED_SESSION_CURSOR_KIND ||
    record.provider !== descriptor.provider ||
    persisted.attachedSource?.kind !== source.kind ||
    record.sourceHandle !== descriptor.sourceHandle ||
    !validAttachedSessionCursor(record.cursor)
  ) {
    return cursors;
  }
  cursors.set(sourceCursorKey(source), {
    provider: source.provider,
    sourceKind: source.kind,
    sourceHandle: descriptor.sourceHandle,
    cursor: record.cursor,
  });
  return cursors;
}

function sourceCursorKey(source: AttachedSessionSource): string {
  return `${source.provider}\u0000${source.kind}`;
}

function cursorMatchesSource(
  cursor: AttachedSessionCursorOwner | undefined,
  source: AttachedSessionSource,
  descriptor: AttachedSessionDescriptor,
): cursor is AttachedSessionCursorOwner {
  return (
    cursor?.provider === source.provider &&
    cursor.sourceKind === source.kind &&
    cursor.sourceHandle === descriptor.sourceHandle
  );
}

function validAttachedSessionCursor(
  cursor: unknown,
): cursor is AttachedSessionCursor {
  if (typeof cursor === 'number') {
    return Number.isSafeInteger(cursor) && cursor >= 0;
  }
  if (!cursor || typeof cursor !== 'object') return false;
  const value = cursor as Record<string, unknown>;
  return (
    Number.isSafeInteger(value.offset) &&
    (value.offset as number) >= 0 &&
    (value.eventIndex === undefined ||
      (Number.isSafeInteger(value.eventIndex) &&
        (value.eventIndex as number) >= 0)) &&
    (value.turnId === undefined ||
      (typeof value.turnId === 'string' && value.turnId.length <= 512)) &&
    (value.usageAggregationVersion === undefined ||
      value.usageAggregationVersion === 1) &&
    (value.usageDeferred === undefined ||
      typeof value.usageDeferred === 'boolean') &&
    validUsageAccumulator(value.usage) &&
    (value.turnId === undefined ||
      value.usage === undefined ||
      (value.usage as { turnId: string }).turnId === value.turnId)
  );
}

function validUsageAccumulator(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.turnId !== 'string' || record.turnId.length > 512)
    return false;
  return (
    [
      'promptTokens',
      'completionTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'cacheWriteTokens5m',
      'cacheWriteTokens1h',
    ].every(
      (key) =>
        record[key] === undefined ||
        (typeof record[key] === 'number' &&
          Number.isSafeInteger(record[key]) &&
          record[key] >= 0),
    ) &&
    (record.serviceTier === undefined ||
      (typeof record.serviceTier === 'string' &&
        record.serviceTier.length <= 512)) &&
    (record.serviceTierConflict === undefined ||
      typeof record.serviceTierConflict === 'boolean')
  );
}

export function resolveAttachedSessionPollInterval(
  value = process.env.STATION_ATTACHED_SESSION_POLL_INTERVAL_MS,
): number {
  if (!value) return DEFAULT_POLL_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return boundedPollInterval(parsed);
}

/**
 * archive#1462: the reverse map is deterministic and honest, never an
 * arbitrary winner.
 *
 * - `attributed` — exactly one project owns the longest canonical root that
 *   contains this cwd. An exact-path match always wins, because no containing
 *   root can be longer than the cwd itself.
 * - `ambiguous` — more than one project is configured at that same root.
 *   (Two containing roots of equal length are necessarily the *same* string,
 *   so a tie is always literally "N projects on one directory" rather than
 *   two neighbouring trees.) The candidates are named; no slug is invented.
 * - `unattributed` — no configured project contains this cwd (or the session
 *   reports no cwd at all). A cwd that no longer resolves on disk is NOT
 *   unattributed by itself: like a configured root, it falls back to its
 *   lexically-absolute form so a project on an unmounted volume still
 *   matches — see `canonicalPath`.
 *
 * Why an explicit ambiguous state rather than a tie-break: the resolved slug
 * is stamped into `session.started`/`session.configured` under a
 * content-addressed event id, so a wrong attribution is written once and
 * never re-derived on a later poll or a restart. A `readdir`-ordered winner
 * is therefore a permanent, silent lie about which project a session belongs
 * to. "Exact match, or an honest unavailable" is the same idiom archive#189
 * slice 4 settled on.
 */
export type AttachedProjectAttribution =
  | {
      state: 'attributed';
      slug: string;
      cwd: string;
      workingDirectory: string;
    }
  | {
      state: 'ambiguous';
      cwd: string;
      workingDirectory: string;
      /** Every project configured at `workingDirectory`, sorted by slug. */
      candidates: string[];
    }
  | { state: 'unattributed' };

export function resolveAttachedProjectRoot(
  cwd: string,
  projects: AttachedProjectRoot[],
): AttachedProjectAttribution {
  const canonicalCwd = canonicalPath(cwd);
  if (!canonicalCwd) return { state: 'unattributed' };
  let workingDirectory: string | undefined;
  let candidates: string[] = [];
  for (const project of projects) {
    if (!project.workingDirectory) continue;
    const root = canonicalPath(project.workingDirectory);
    if (!root || !isContainedBy(canonicalCwd, root)) continue;
    if (
      workingDirectory === undefined ||
      root.length > workingDirectory.length
    ) {
      workingDirectory = root;
      candidates = [project.slug];
      continue;
    }
    if (root === workingDirectory && !candidates.includes(project.slug)) {
      candidates.push(project.slug);
    }
  }
  if (workingDirectory === undefined || candidates.length === 0) {
    return { state: 'unattributed' };
  }
  if (candidates.length === 1) {
    return {
      state: 'attributed',
      slug: candidates[0]!,
      cwd: canonicalCwd,
      workingDirectory,
    };
  }
  return {
    state: 'ambiguous',
    cwd: canonicalCwd,
    workingDirectory,
    candidates: [...candidates].sort(),
  };
}

// archive#1120 cross-reference: this envelope's `session.started`/
// `session.configured` pair is published via `appendAndPublish()` below,
// NOT via OrchestrationService.projectAndPublishEvent — it bypasses the
// `sessionOwnerCache` invalidation (SessionAuthorization since epic archive#4024
// slice 6) entirely. That's safe only
// because neither event below ever sets `metadata.userId`, so
// SessionAuthorization.sessionOwnerUserId() never resolves (and therefore
// never caches) an owner from a read-only-attached thread. If this
// envelope is ever changed to carry `metadata.userId`, the owner cache's
// invalidation must be extended to cover this path too, or a cached owner
// for an attached thread could go stale.
function attachedSessionEnvelope(
  session: AttachedSessionDescriptor,
  attribution: Exclude<AttachedProjectAttribution, { state: 'unattributed' }>,
  fingerprint: string,
  latestEventAt: string | undefined,
  /** The attribution the persisted log already expresses — see {@link envelopeEventId}. */
  previousFingerprint: string | undefined,
): CanonicalRuntimeEvent[] {
  const base = {
    provider: session.provider,
    threadId: session.threadId,
    // The session's own creation time for the FIRST envelope; for a later
    // correction, the newest event already on the thread. Never `now`: a
    // re-derived attribution is not fresh session activity and must not
    // bubble a dormant session up a recency-sorted list.
    createdAt:
      latestEventAt && latestEventAt > session.createdAt
        ? latestEventAt
        : session.createdAt,
  } as const;
  // archive#1462: an ambiguous attribution carries the named candidates and
  // deliberately no `projectSlug` — every consumer that reads a slug off this
  // metadata would otherwise read an unproven one.
  const projectMetadata =
    attribution.state === 'attributed'
      ? { projectSlug: attribution.slug }
      : {
          projectAttribution: 'ambiguous' as const,
          projectCandidates: attribution.candidates,
        };
  return [
    {
      ...base,
      eventId: envelopeEventId(
        session.sessionId,
        'started',
        previousFingerprint,
        fingerprint,
      ),
      method: 'session.started',
      sessionId: session.threadId,
      initialState: 'created',
      metadata: {
        controlMode: 'read-only-attached',
        ...projectMetadata,
        attachedProvider: session.provider,
      },
    },
    {
      ...base,
      eventId: envelopeEventId(
        session.sessionId,
        'configured',
        previousFingerprint,
        fingerprint,
      ),
      method: 'session.configured',
      sessionId: session.threadId,
      cwd: session.cwd,
      metadata: {
        controlMode: 'read-only-attached',
        ...projectMetadata,
        attachedProvider: session.provider,
      },
    },
  ] as CanonicalRuntimeEvent[];
}

/**
 * What the persisted log already says about this thread, read once per thread
 * per process. `storedAttribution` mirrors the read side's precedence
 * (`orchestration-session-state.ts`): the newest `session.configured`
 * expressing ANY attribution wins, and a slug on that event outranks an
 * ambiguity marker on the same event.
 *
 * archive#3495: it used to also COUNT every attributed configured event on the
 * thread, which is why it needed every one of them. The count is gone (see
 * {@link envelopeEventId}), so this stops at the first match and its input is
 * a bounded window.
 */
function persistedEnvelopeFacts(
  /**
   * `session.configured` events only, newest-first and BOUNDED — matching
   * {@link EventStore.listRecentConfiguredEventsByThread}.
   */
  configuredEventsNewestFirst: { payload: unknown }[],
  extras: { latestEventAt?: string } = {},
): {
  storedAttribution?: string;
  latestEventAt?: string;
} {
  let storedAttribution: string | undefined;
  // Newest-first: the first configured event expressing an attribution is the
  // live one.
  for (const item of configuredEventsNewestFirst) {
    const payload = item?.payload as CanonicalRuntimeEvent | undefined;
    if (payload?.method !== 'session.configured') continue;
    const stored = metadataAttributionFingerprint(payload.metadata);
    if (!stored) continue;
    storedAttribution = stored;
    break;
  }
  return {
    ...(storedAttribution ? { storedAttribution } : {}),
    ...(extras.latestEventAt ? { latestEventAt: extras.latestEventAt } : {}),
  };
}

/**
 * How many of the thread's newest `session.configured` events the cold path
 * reads to find the attribution the log expresses (archive#3495).
 *
 * Only the newest one that expresses an attribution is used, so this is
 * headroom for configured events that express none (a Station-owned
 * `session.configured`, say) sitting on top of the one that does — not a
 * window that has to hold a history. The old read was the whole thread.
 */
const ATTRIBUTION_LOOKBACK_EVENTS = 64;

const APPEND_YIELD_EVERY = 32;
const FOLLOW_YIELD_EVERY = 32;

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Mirrors what `attributionFingerprint` WRITES, deliberately without the
 * `ATTACHED_SESSION_PROJECT_SLUG_MAX_LENGTH` bound the READ side applies
 * (delta review, LOW — considered and declined).
 *
 * The bound belongs to display: `extractAttachedSessionAttribution` refuses
 * to surface an over-long slug. Applying it here instead would make this
 * disagree with the writer, so a session carrying such a slug would report
 * "nothing stored", differ from the freshly computed fingerprint on every
 * COLD START, and write another envelope pair — once per restart, forever
 * under the `generation` id this predates. archive#3495's transition-addressed
 * id bounds that particular leak at ONE pair (`undefined -> fingerprint` is a
 * fixed id), but agreeing with the writer is still the right rule: it keeps
 * the write suppressed rather than merely deduped. The residual
 * is that the read side then shows an older attribution or none, which is the
 * safe direction and predates this branch.
 */
function metadataAttributionFingerprint(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const slug = metadata?.projectSlug;
  if (typeof slug === 'string' && slug) return `attributed\u0000${slug}`;
  if (metadata?.projectAttribution !== 'ambiguous') return undefined;
  const raw = metadata?.projectCandidates;
  if (!Array.isArray(raw)) return undefined;
  const candidates = raw.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return candidates.length > 0
    ? `ambiguous\u0000${candidates.join('\u0000')}`
    : undefined;
}

/**
 * archive#1462 fix round: the attribution is part of the envelope's identity,
 * not just its payload.
 *
 * `appendEventIfAbsent` is an `INSERT OR IGNORE` keyed on `eventId`, so an id
 * derived from `sessionId + kind` alone froze whichever attribution was
 * written FIRST. Adding a second project to a directory then produced a
 * session the resolver and the metric both called ambiguous while the stored
 * envelope - and every surface reading it - still named the pre-existing
 * winner, permanently; removing the duplicate never cleared the ambiguity
 * either. That is archive#1462's actual harm surviving the fix meant to end it, and
 * it is why the error message's own remediation ("remove the duplicate
 * project") changed nothing.
 *
 * Folding the attribution into the id makes a corrected envelope a NEW event
 * that lands behind the stale one; `orchestration-session-state.ts` then
 * reads the NEWEST `session.configured` expressing any attribution, so the
 * correction wins. Both halves are required - a new id nobody reads, or a
 * newest-wins read with no new event to find, each leaves the stale value in
 * place.
 *
 * Deliberate consequence: sessions stamped BEFORE this branch are repaired
 * too - archive#1462 is about the arbitrary winners already written, not only the
 * ones this branch prevents. But ONLY those that need it. A pre-branch id was
 * derived without a fingerprint, so it never collides with a fingerprinted
 * one and `appendEventIfAbsent`'s INSERT OR IGNORE cannot protect that case;
 * left alone, the first poll after upgrade would re-stamp every followed
 * session whether or not its attribution changed. `follow()` therefore
 * compares against what the persisted log already expresses
 * (`persistedEnvelopeFacts`) and writes nothing when they agree.
 *
 * That mattered more than it looks. The extra pair is inert in the lifecycle
 * fold - `session.started` with `initialState: 'created'` and
 * `session.configured` are both transition-neutral attach facts
 * (`session-lifecycle-service.ts`, archive#1073) - but NOT in the read model: it
 * becomes `events.at(-1)`, and the envelope is dated `descriptor.createdAt`,
 * which for a Claude transcript is the FIRST record's timestamp. Every
 * attached session's `lastEventAt` - read as last activity by
 * `home-view-model.ts` - would have jumped back to its creation time, and
 * stayed there for any session whose transcript had stopped growing. Dating
 * the envelope `now` instead would have been the same lie pointing forwards:
 * re-deriving an attribution is not session activity. So a correction is
 * dated no earlier than the newest event already on the thread, and no later.
 */
function attributionFingerprint(
  attribution: Exclude<AttachedProjectAttribution, { state: 'unattributed' }>,
): string {
  return attribution.state === 'attributed'
    ? `attributed\u0000${attribution.slug}`
    : // `candidates` is already sorted, so the fingerprint is stable across
      // polls and independent of `listProjects()` ordering.
      `ambiguous\u0000${attribution.candidates.join('\u0000')}`;
}

/**
 * Delta-review H3: the id addresses the TRANSITION, not the attribution
 * value.
 *
 * Hashing `sessionId + kind + fingerprint` alone was content-addressed on the
 * value, so re-entering an attribution this thread had ever carried hashed
 * straight back to the existing row, `INSERT OR IGNORE` dropped the write,
 * and the newest-wins read stayed pinned to the intermediate state forever:
 *
 *   beta -> ambiguous[alpha,beta] -> beta      reads "ambiguous", permanently
 *
 * That third step is the remediation archive#1462's own error message prescribes,
 * applied to the realistic starting state (a session already attributed
 * before the duplicate appeared), so the branch fixed the harm only for
 * sessions whose destination attribution happened to be a first-time write.
 * It survived restart too — a fresh service recomputes the same colliding id.
 *
 * So the id addresses the TRANSITION — the attribution the log already
 * expresses, plus the one being written. Both halves are pure functions of the
 * persisted log, so two processes folding the same log derive the same id and
 * the write stays idempotent across restarts.
 *
 * ## archive#3495: what the transition must NOT be addressed by
 *
 * The predecessor used to be a `generation` COUNTER — how many attributions
 * the thread's log had recorded. That is a count the emit itself increments,
 * so every write changed the input to the next write's id, and
 * `appendEventIfAbsent`'s `INSERT OR IGNORE` could never suppress anything.
 * The "row growth stays bounded" this comment used to claim was a label
 * nothing derived, and the live store falsified it: ONE thread held 259,286
 * `session.started` rows across just 4 distinct `created_at` values, arriving
 * in bursts of ~4,000 events/sec while 4 `cwd` values cycled onto that single
 * threadId. That table reached 694 MB, and reading it is what wedged the
 * backend.
 *
 * Naming the PREVIOUS ATTRIBUTION instead makes the id a pure function of
 * (session, kind, from, to) — a finite set. At most one row pair per distinct
 * transition, so a cycle over k attributions costs at most k² pairs however
 * long it runs, and a steady attribution still costs nothing (that one is
 * `follow()`'s guard, not this id).
 *
 * **Deliberately traded away, and the trade is PERMANENT for a flapping
 * thread, not a delay:** a transition this thread has already made — same
 * `from`, same `to` — re-derives its existing id, so `INSERT OR IGNORE` drops
 * it and the newest-wins read keeps showing the previous destination.
 *
 * An earlier revision of this comment said that lasts "until the attribution
 * moves somewhere it has not been from here before". That is true only while
 * unvisited transitions remain. For a BOUNDED flapping set — which is exactly
 * the population that caused archive#3495's outage, 4 `cwd` values cycling
 * onto one threadId — the transitions are exhausted within seconds, and from
 * then on EVERY write is a repeat and every one is dropped. Measured by "a
 * cycle of attributions saturates instead of growing without bound": a
 * 3-attribution cycle closes at 7 pairs / 14 events, and at that point the
 * read reports `beta` while the live source says `alpha`. Thirty further laps
 * — ninety more attribution changes — do not move it. It never
 * self-corrects, however long the flapping runs or however many times the
 * process restarts. The saturation bound above is the accurate half of that
 * sentence; the temporariness was not, and the test now pins both halves.
 *
 * Every FIRST-TIME transition still lands, which covers archive#1462's remediation
 * (`beta -> ambiguous -> beta` is three distinct transitions) and every
 * ordinary operator correction; what no longer lands is a repeat lap of a
 * cycle.
 *
 * The counter was not the better alternative — it did not keep the read
 * correct either, and it grew the table until the process that serves the read
 * could no longer start. But a bounded-AND-newest-correct shape does exist
 * outside an append-only log, and was not chosen rather than not available:
 * `orchestration_session_projection_facts` already holds an `attribution` key
 * as a mutable last-write-wins pointer (`orchestration-session-state.ts`'s
 * `projectionFactKeysForEvent`, upserted by
 * `EventStore.projectSessionProjectionFacts`, folded into the read model by
 * `listSessionProjectionEvents`). Re-sequencing the suppressed row, or
 * re-pointing that fact at it, would both keep the newest read correct under
 * saturation. Neither is done here: archive#3495 is an outage fix, and
 * changing what the log means is a design change that belongs in its own
 * decision. What this branch chose is an IMMUTABLE LOG over a correct newest
 * read for a saturated flap — stated so the next reader can revisit the
 * choice rather than re-derive that no choice existed.
 */
function envelopeEventId(
  sessionId: string,
  kind: string,
  previousFingerprint: string | undefined,
  fingerprint: string,
): string {
  return `attached:session:${createHash('sha256')
    .update(
      `${sessionId}\u0000${kind}\u0000${previousFingerprint ?? ''}\u0000${fingerprint}`,
    )
    .digest('hex')}`;
}

function boundedPollInterval(value: number): number {
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, value));
}

/**
 * archive#1462 fix round: canonicalisation must never SILENTLY DROP a
 * configured project, because a dropped candidate removes one side of a tie
 * — turning a genuine ambiguity into a confident, wrong `attributed`. Three
 * ways the first cut did exactly that:
 *
 * - **A literal `~`.** `ProjectConfig.workingDirectory` is stored unexpanded
 *   by `project-service.ts`, and that is the norm for a project created
 *   through the UI. `realpathSync('~/dev/x')` throws `ENOENT`, so a
 *   tilde-stored project never reached the comparison at all. Every sibling
 *   consumer expands first (`orchestration-service.ts`'s
 *   `resolveStartSessionCwd`, `runtime-routes.ts`, `terminal-service.ts`);
 *   this one now matches them.
 * - **Case-variant spellings on a case-insensitive volume.** The JS
 *   `realpathSync` echoes back whatever case the operator typed, so
 *   `/Users/x/DEV/app` and `/Users/x/dev/app` stayed two distinct strings of
 *   EQUAL length — neither longer, neither equal — and the second was
 *   discarded by the tie-break. `realpathSync.native` asks the OS for the
 *   on-disk spelling, so both collapse to one root and the tie forms
 *   (verified on darwin: `.native` normalises, the JS implementation does
 *   not). On case-sensitive volumes it is an identity.
 * - **A root that does not resolve right now** — an unmounted volume, a
 *   deleted checkout. Dropping it hid a real second project on the same
 *   directory. It now falls back to the lexically-absolute path so it still
 *   participates as a candidate. Two residuals, and they point in OPPOSITE
 *   directions — the earlier claim here that the fallback only ever errs
 *   safely was wrong (delta review):
 *   - Usually safe: an unresolvable path cannot be case-normalised or
 *     symlink-resolved, so a stale root spelled in a different case than the
 *     live one still will not join the tie. That direction costs a candidate
 *     and renders `unattributed`, never a fabricated match.
 *   - NOT always safe: `resolve()` collapses `..` LEXICALLY, which a real
 *     `realpath` would not. A stored root `/a/b/../c` whose `/a/b` is a
 *     symlink to `/z` falls back to `/a/c`, while the directory it actually
 *     names is `/c`. Against a shorter competing root, that longer wrong
 *     path wins the tie-break and produces a confident `attributed` for a
 *     project that does not contain the cwd. It needs a `..` traversing a
 *     symlink inside a path that does not currently resolve, which is why
 *     this is documented rather than defended against: the alternative
 *     (refusing to resolve `..` at all) reintroduces the dropped-candidate
 *     bug this fallback exists to fix, for a strictly commoner input.
 */
function canonicalPath(path: string): string | undefined {
  if (!path) return undefined;
  const absolute = resolve(expandTilde(path));
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isContainedBy(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sourceLabel(source: AttachedSessionSource): string {
  return source.kind;
}

function rememberEvent(
  seen: Map<string, true>,
  eventId: string,
  limit: number,
): void {
  seen.delete(eventId);
  seen.set(eventId, true);
  while (seen.size > limit) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}
