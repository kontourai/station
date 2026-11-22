import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  INTERNAL_SESSION_READ_SCOPE,
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type { UsageReceipt } from '@kontourai/station-contracts/usage-rollup';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import type {
  DroppedUsageFigure,
  SessionUsageAggregate,
} from '@kontourai/station-shared/usage-fold';
import {
  foldUsageEvents,
  foldUsageObservationProjection,
  providerCostScope,
  providerReportsContextOccupancyOnly,
  providerUsageScope,
} from '@kontourai/station-shared/usage-fold';
import {
  foldLineageUsageEvents,
  type LineageUsageAggregate,
} from '@kontourai/station-shared/usage-lineage-fold';
import type { OrchestrationSessionUsage } from '../../analytics/usage-aggregator-state.js';
import {
  CatalogUsagePricingSnapshotReader,
  stampUsageReceiptPrice,
} from '../../analytics/usage-pricing-snapshot-reader.js';
import {
  usageProjectionPassDuration,
  usageProjectionRowsScanned,
} from '../../telemetry/metrics.js';
import type {
  EventStore,
  UsageReceiptEventRow,
  UsageReceiptFilter,
} from './event-store.js';
import { createIsolatedSessionTranscriptSearch } from './isolated-session-transcript-search.js';
// Type-only import back into the service module: erased at runtime, so no
// import cycle exists — and it avoids adding ANOTHER copy of the read-scope
// union (session-lifecycle-module.ts already re-declares one privately; the
// durable fix is exporting the union from contracts/tenancy beside its two
// constituents, tracked on the epic).
import type { SessionReadScope } from './orchestration-service.js';
import type { SessionAuthorization } from './session-authorization.js';
import { messageSearchExcerpt } from './transcript-search-queries.js';

/** The documented freshness allowance relative to the requested window end. */
const USAGE_COVERAGE_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const USAGE_COVERAGE_EVIDENCE_CAP = 1_000;
const COVERAGE_CAP_REASON =
  'coverage evidence cap reached (1000 observations); additional provider evidence is missing';
const STALE_OBSERVATION_REASON =
  'provider observations are older than the 24-hour freshness threshold for this window';
/** An engine with no usage totals is a declared gap, never a zero. */
const CONTEXT_OCCUPANCY_ONLY_REASON =
  'engine reports context occupancy only, not token or cost totals';

/**
 * #373: names what a cached thread projection was computed by. Bump it when
 * anything that shapes a cached entry changes: the shared fold
 * (`packages/shared/src/usage-fold.ts`, which a test pins to this value),
 * the rows `EventStore.listUsageEventPayloads` selects, or
 * {@link foldThreadUsage}. A checkpoint under another version rebuilds once.
 */
const USAGE_PROJECTION_VERSION = 'usage-projection-v2';
/** How long one synchronous slice of a pass may hold the event loop. */
const USAGE_PROJECTION_SLICE_MS = 16;
/** Refolded entries are committed in batches of about this many bytes. */
const USAGE_PROJECTION_WRITE_BATCH_BYTES = 4 * 1024 * 1024;

/** What lifetime usage caches per thread: everything derived from its events. */
interface ThreadUsageProjection {
  projection: ReturnType<typeof foldUsageObservationProjection>;
  relayAgentId?: string;
}

/** The orchestration store's durable side of the lifetime usage projection. */
type UsageProjectionStore = Pick<
  EventStore,
  | 'currentGlobalSequence'
  | 'readUsageProjectionCheckpoint'
  | 'advanceUsageProjection'
  | 'readUsageProjection'
  | 'writeUsageProjections'
>;

interface SessionTranscriptReadsDeps {
  canReadSession: (threadId: string, authority: SessionReadScope) => boolean;
  isEphemeralSession: (threadId: string) => boolean;
  sessionAttributionFor: (
    threadId: string,
  ) => { conversationId: string; slug?: string } | null | undefined;
  listEventPayloads: (threadId: string) => CanonicalRuntimeEvent[];
  /**
   * The same payloads with content stored out of line resolved
   * (docs/design/event-content-spill.md). Read only for engine-facing seeds.
   */
  listResolvedEventPayloads: (threadId: string) => CanonicalRuntimeEvent[];
  /**
   * #3112: the durable conversation an execution Session belongs to (the
   * thread itself when it has no lineage). A successor Session is not a
   * conversation of its own.
   */
  conversationIdForThread?: (threadId: string) => string;
  /**
   * #373: where per-thread usage folds persist between passes. Without it
   * every pass folds every thread, as a store-less deployment always has.
   */
  usageProjectionStore?: UsageProjectionStore;
  listUsageEventPayloads: EventStore['listUsageEventPayloads'];
  listUsageReceiptEvents: EventStore['listUsageReceiptEvents'];
  listUsageCoverageEvents: EventStore['listUsageCoverageEvents'];
  // Derived from the store's own method type — no re-declared row shape.
  searchConversationMessages: EventStore['searchConversationMessages'];
  transcriptOwnerConstraint?: SessionAuthorization['transcriptOwnerConstraint'];
  readSessionThreadIds: (
    authority: SessionReadScope,
    stationOwnedOnly?: boolean,
  ) => string[];
  requireTenantExecutionContext: () => boolean;
  /**
   * Receives a token figure the fold refused as unusable while replaying
   * durable history.
   *
   * REQUIRED, deliberately (#910). It was optional, and the production
   * composition simply did not pass it — so every refused figure was
   * swallowed in the running product while the seam's own tests stayed
   * green, because a test that supplies its own reporter cannot see a
   * composition that omits one. An injection proved that gap invisible.
   * Requiring it moves the failure from silent runtime behaviour to a
   * compile error. A caller with genuinely nowhere to report passes an
   * explicit no-op and says why, which is a comment worth having.
   */
  reportDroppedUsageFigure: (dropped: DroppedUsageFigure) => void;
}

/**
 * Transcript read, search, and usage projections (epic archive#4024,
 * archive#4144): the C10 cluster from the seam map — zero owned fields, every
 * external consumer already structurally typed against exactly these
 * methods. The service keeps flat same-named public forwarders (the test
 * Proxy injects read authority by METHOD NAME for `readSessionMessages`,
 * `readSessionUsage`, and `listSessionUsage` — map T3 — and each forwarder
 * keeps its `initialize()` call per T9), so this module owns the logic and
 * none of the surface.
 */
export class SessionTranscriptReads {
  constructor(private readonly deps: SessionTranscriptReadsDeps) {}

  /** Additive async owner seam; synchronous consumers keep their existing API. */
  createIsolatedSearch(
    ...input: Parameters<typeof createIsolatedSessionTranscriptSearch>
  ) {
    return createIsolatedSessionTranscriptSearch(...input);
  }

  readSessionMessages(
    threadId: string,
    authority: SessionReadScope,
  ): ConversationMessage[] {
    if (!this.deps.canReadSession(threadId, authority)) {
      return [];
    }
    return projectRuntimeEventsToMessages(
      this.deps.listEventPayloads(threadId),
    );
  }

  /**
   * {@link readSessionMessages} with content stored out of line resolved, for
   * the transcript seeds an engine receives: a seed carries whole messages
   * under its own budget, so a long reply must count at its real size. The
   * read check runs first; nothing is listed or resolved for a caller that
   * may not read the Session.
   *
   * Ids are the stable, event-derived ones the conversation reader shows, so
   * a fork's branch point and copied rows name the same messages the person
   * picked from; a seed renders text only and never reads them.
   */
  readSessionSeedMessages(
    threadId: string,
    authority: SessionReadScope,
  ): ConversationMessage[] {
    if (!this.deps.canReadSession(threadId, authority)) {
      return [];
    }
    return projectRuntimeEventsToMessages(
      this.deps.listResolvedEventPayloads(threadId),
      { stableIds: true },
    );
  }

  searchSessionMessages(
    query: string,
    authority: SessionReadScope,
    limit = 20,
  ): Array<{
    conversationId: string;
    messageId: string;
    role: 'user' | 'assistant';
    excerpt: string;
    projectSlug?: string;
    engine?: string;
    agentSlug?: string;
  }> {
    if (!isSessionReadAuthority(authority)) return [];
    const rows = this.deps.searchConversationMessages({
      query,
      ...(this.deps.transcriptOwnerConstraint?.(authority) ?? {
        ownerUserId: authority.userId,
      }),
      ...(authority.mode === 'hosted' && authority.tenantExecutionContext
        ? { tenantId: authority.tenantExecutionContext.tenantId }
        : {}),
      limit: Math.min(Math.max(limit, 1), 20),
    });
    return rows
      .filter((row) => this.deps.canReadSession(row.threadId, authority))
      .slice(0, Math.min(Math.max(limit, 1), 20))
      .map((row) => ({
        conversationId:
          this.deps.conversationIdForThread?.(row.threadId) ?? row.threadId,
        // The transcript's stable ids are based on turn.started.  A user
        // row is its own anchor; an assistant row uses the turn anchor.
        messageId:
          row.role === 'assistant' && row.turnAnchorId
            ? `${row.turnAnchorId}:assistant`
            : `${row.eventId}:user`,
        role: row.role,
        excerpt: messageSearchExcerpt(row.content, query),
        ...(row.projectSlug ? { projectSlug: row.projectSlug } : {}),
        ...(row.engine ? { engine: row.engine } : {}),
        ...(row.agentSlug ? { agentSlug: row.agentSlug } : {}),
      }));
  }

  readSessionUsage(
    threadId: string,
    authority: SessionReadScope,
  ): SessionUsageAggregate {
    if (!this.deps.canReadSession(threadId, authority)) {
      return foldUsageEvents([]);
    }
    // The fold replays durable history, so it can meet a figure written
    // before its producer's guard existed. Dropping it keeps the read
    // answerable; reporting it keeps the producer defect visible rather
    // than absorbed (packages/shared/src/usage-fold.ts's drop contract).
    return foldUsageEvents(
      this.deps.listUsageEventPayloads(threadId),
      (dropped) => this.deps.reportDroppedUsageFigure(dropped),
    );
  }

  /**
   * #3112: one conversation's usage across its execution Sessions, in
   * lineage order. #5389: kept per engine (`foldLineageUsageEvents`), so an
   * engine that reports a running total cannot replace what an earlier engine
   * counted; "latest" figures (context occupancy, model) still come from the
   * newest turn. A Session the authority cannot read contributes nothing, as
   * in the conversation message read.
   */
  readConversationUsage(
    threadIds: readonly string[],
    authority: SessionReadScope,
  ): LineageUsageAggregate {
    return foldLineageUsageEvents(
      threadIds
        .filter((threadId) => this.deps.canReadSession(threadId, authority))
        .map((threadId) => this.deps.listUsageEventPayloads(threadId)),
      (dropped) => this.deps.reportDroppedUsageFigure(dropped),
    );
  }

  /** Daily Lite counts use the canonical allocation with Station's durable clock. */
  listDailyUsage(day: string, authority: SessionReadScope) {
    if (this.deps.requireTenantExecutionContext()) return [];
    return this.deps
      .readSessionThreadIds(authority, true)
      .flatMap((threadId) => {
        if (
          this.deps.isEphemeralSession(threadId) ||
          !this.deps.canReadSession(threadId, authority)
        )
          return [];
        const events = this.deps
          .listUsageEventPayloads(threadId, 'observation')
          .filter(
            (event) =>
              event.createdAt <= `${day}T23:59:59.999Z` &&
              (event.method !== 'token-usage.updated' ||
                providerUsageScope(event.provider) !== undefined),
          );
        return foldUsageObservationProjection(
          events,
          (dropped) => this.deps.reportDroppedUsageFigure(dropped),
          { withholdResumedCumulativeUsage: true },
        ).observations.filter(
          (observation) => observation.recordedAt?.slice(0, 10) === day,
        );
      });
  }

  /**
   * Every persisted session's usage, for lifetime analytics. The answer is
   * the shared fold over each thread's usage rows, exactly as folding them
   * all again would give; what changes with #373 is how much is read.
   *
   * A pass first catches up in one transaction: threads with rows past the
   * stored watermark lose their cached fold, and the watermark moves to the
   * store's current high-water (`full` mode forgets every thread instead,
   * when there is no checkpoint under this version, the checkpoint is ahead
   * of the store, or the caller asks for a rebuild). It then walks the
   * sessions, refolding only threads with no cached fold, in slices that
   * yield the event loop. The fold reads a thread's whole history (it
   * resolves turn models and principals before allocating), so a changed
   * thread is refolded whole, never patched.
   *
   * Deletions and rewrites need no watermark: the store's triggers drop the
   * affected thread's cached fold in the same transaction.
   */
  async listSessionUsage(
    authority: SessionReadScope,
    options: { rebuild?: boolean } = {},
  ): Promise<OrchestrationSessionUsage[]> {
    // Its one consumer is `analytics/stats.json`, a home-global lifetime
    // store with no per-user partition, served by a route that applies no
    // tenant scope. In a hosted deployment "home-global" would mean "across
    // tenants", so there is no correct total to give and none is given —
    // matching the memory substrate this supplements, which hosted mode does
    // not use either (`isHostedSessionReadAuthority` in `conversations.ts`).
    if (this.deps.requireTenantExecutionContext() === true) return [];
    const startedAt = performance.now();
    const store = this.deps.usageProjectionStore;
    const mode = this.catchUpUsageProjection(store, options.rebuild === true);
    const threadIds = this.deps.readSessionThreadIds(authority);
    const sessions: OrchestrationSessionUsage[] = [];
    const refolds = new UsageRefoldBatch();
    let sliceStartedAt = performance.now();
    for (const threadId of threadIds) {
      if (performance.now() - sliceStartedAt >= USAGE_PROJECTION_SLICE_MS) {
        refolds.flushIfLarge(store);
        await yieldToEventLoop();
        sliceStartedAt = performance.now();
      }
      if (this.deps.isEphemeralSession(threadId)) continue;
      if (!this.deps.canReadSession(threadId, authority)) continue;
      const session = sessionUsageFrom(
        threadId,
        this.deps.sessionAttributionFor(threadId),
        this.threadUsage(threadId, store, refolds),
      );
      if (session) sessions.push(session);
    }
    // Only a caller that sees every session can say which cached folds
    // belong to no session any more.
    refolds.flush(
      store,
      authority === INTERNAL_SESSION_READ_SCOPE
        ? new Set(threadIds)
        : undefined,
    );
    usageProjectionRowsScanned.record(refolds.rows, {
      mode: mode === 'full' ? 'full' : 'rebuild',
    });
    usageProjectionPassDuration.record(performance.now() - startedAt, {
      mode,
    });
    return sessions;
  }

  /**
   * The pass's one-transaction catch-up. `incremental` when a checkpoint
   * under this version is at or behind the store's high-water; otherwise
   * (none, another version, ahead of the store, or a requested rebuild)
   * `full`, which forgets every cached fold.
   */
  private catchUpUsageProjection(
    store: UsageProjectionStore | undefined,
    rebuild: boolean,
  ): 'full' | 'incremental' {
    const highWater = store?.currentGlobalSequence() ?? 0;
    const checkpoint = rebuild
      ? undefined
      : store?.readUsageProjectionCheckpoint();
    const since =
      checkpoint?.version === USAGE_PROJECTION_VERSION &&
      checkpoint.watermark <= highWater
        ? checkpoint.watermark
        : undefined;
    const caughtUp = store?.advanceUsageProjection({
      version: USAGE_PROJECTION_VERSION,
      ...(since === undefined ? {} : { since }),
      through: highWater,
    });
    if (since === undefined) return 'full';
    usageProjectionRowsScanned.record(caughtUp?.rows ?? 0, {
      mode: 'incremental',
    });
    return 'incremental';
  }

  /** A thread's cached fold, or a fresh one queued for the store. */
  private threadUsage(
    threadId: string,
    store: UsageProjectionStore | undefined,
    refolds: UsageRefoldBatch,
  ): ThreadUsageProjection {
    const cached = parseThreadUsageProjection(
      store?.readUsageProjection(threadId),
    );
    if (cached) return cached;
    const events = this.deps.listUsageEventPayloads(threadId);
    const entry = this.foldThreadUsage(events);
    refolds.add(threadId, entry, events.length);
    return entry;
  }

  /** Everything a thread's cached usage entry holds, from its usage rows. */
  private foldThreadUsage(
    events: CanonicalRuntimeEvent[],
  ): ThreadUsageProjection {
    const projection = foldUsageObservationProjection(events, (dropped) =>
      this.deps.reportDroppedUsageFigure(dropped),
    );
    const relayAgentIds = new Set(
      events.flatMap((event) =>
        event.method === 'session.configured' &&
        event.provider === 'station-agent' &&
        typeof event.metadata?.agentId === 'string' &&
        event.metadata.agentId
          ? [event.metadata.agentId]
          : [],
      ),
    );
    const relayAgentId =
      relayAgentIds.size === 1 &&
      events.every((event) => event.provider === 'station-agent')
        ? [...relayAgentIds][0]
        : undefined;
    return { projection, ...(relayAgentId ? { relayAgentId } : {}) };
  }

  /**
   * Owners whose usage `authority` may read. Hosted is the exact owner (its
   * tenant is applied by the query); personal adds the caller's personal
   * conversation account, exactly as `transcriptOwnerConstraint` does for
   * transcript search.
   */
  private usageOwnerIds(authority: SessionReadAuthority): string[] {
    if (authority.mode === 'hosted') return [authority.userId];
    const constraint = this.deps.transcriptOwnerConstraint?.(authority);
    return [
      ...new Set([authority.userId, ...(constraint?.ownerUserIds ?? [])]),
    ];
  }

  listUsageReceipts(
    authority: SessionReadAuthority,
    stationId: string,
    request: {
      from: string;
      to: string;
      cursor?: string;
      pageSize?: number;
      aggregate?: boolean;
      filter?: UsageReceiptFilter;
    },
  ): {
    receipts: UsageReceipt[];
    nextCursor?: string;
    coverage: import('@kontourai/station-contracts/usage-rollup').UsageCoverage;
  } {
    // A hosted authority without its concrete execution tenant must never
    // degrade to an owner-only query. The caller normally cannot mint one,
    // but this second guard is essential for direct/internal invocation.
    if (
      !isSessionReadAuthority(authority) ||
      (authority.mode === 'hosted' && !authority.tenantExecutionContext)
    ) {
      return {
        receipts: [],
        coverage: {
          stationId,
          state: 'unknown',
          reason: 'hosted tenant context missing',
          window: { from: request.from, to: request.to },
          freshness: 'unknown',
        },
      };
    }
    const pageSize = Math.min(
      Math.max(request.pageSize ?? 50, 1),
      request.aggregate ? 500 : 100,
    );
    const after = decodeUsageCursor(request.cursor);
    // The same owner set transcript reads bind: the caller's own principal,
    // plus (personal mode) the owners of the personal conversation account
    // it belongs to. Hosted narrows to the exact owner below, with its
    // tenant.
    const ownerUserIds = this.usageOwnerIds(authority);
    const rows = this.deps.listUsageReceiptEvents({
      ownerUserIds,
      ...(authority.mode === 'hosted' && authority.tenantExecutionContext
        ? { tenantId: authority.tenantExecutionContext.tenantId }
        : {}),
      from: request.from,
      to: request.to,
      ...(after ? { after } : {}),
      limit: pageSize,
      ...(request.filter ? { filter: request.filter } : {}),
    });
    const page = rows.slice(0, pageSize);
    // The windowed rollup counts only Station-observed receipts; a legacy row
    // with no observation time has no place in an observation window.
    const receipts = page.flatMap((row) =>
      row.event.observedAt ? usageReceiptsForEventRow(row, stationId) : [],
    );
    const last = page.at(-1)?.event;
    const coverageEvidence = this.deps.listUsageCoverageEvents({
      ownerUserIds,
      ...(authority.mode === 'hosted'
        ? { tenantId: authority.tenantExecutionContext!.tenantId }
        : {}),
      from: request.from,
      to: request.to,
    });
    const coverageEvidenceCapped =
      coverageEvidence.length > USAGE_COVERAGE_EVIDENCE_CAP;
    const coverageEvents = coverageEvidence.slice(
      0,
      USAGE_COVERAGE_EVIDENCE_CAP,
    );
    const providers = new Map<
      string,
      {
        terminalTurns: Set<string>;
        usageTurns: Set<string>;
        contextOnlyTurns: Set<string>;
        observedThrough?: string;
        providerObservedThrough?: string;
      }
    >();
    const providerFor = (name: string) => {
      const existing = providers.get(name);
      if (existing) return existing;
      const created: {
        terminalTurns: Set<string>;
        usageTurns: Set<string>;
        contextOnlyTurns: Set<string>;
        observedThrough?: string;
        providerObservedThrough?: string;
      } = {
        terminalTurns: new Set<string>(),
        usageTurns: new Set<string>(),
        contextOnlyTurns: new Set<string>(),
      };
      providers.set(name, created);
      return created;
    };
    let observedThrough: string | undefined;
    for (const event of coverageEvents) {
      if (
        event.observedAt &&
        (!observedThrough || event.observedAt > observedThrough)
      )
        observedThrough = event.observedAt;
      const provider = providerFor(event.provider);
      if (
        !provider.providerObservedThrough ||
        event.createdAt > provider.providerObservedThrough
      ) {
        provider.providerObservedThrough = event.createdAt;
      }
      if (
        event.observedAt &&
        (!provider.observedThrough ||
          event.observedAt > provider.observedThrough)
      ) {
        provider.observedThrough = event.observedAt;
      }
      if (
        event.payload.method === 'turn.completed' ||
        event.payload.method === 'turn.aborted'
      ) {
        const key = `${event.threadId}:${event.turnId ?? event.id}`;
        provider.terminalTurns.add(key);
      }
      if (
        event.payload.method === 'token-usage.updated' &&
        (hasTokenMeasurements(event.payload) ||
          isReportedAmount(event.payload.reportedCostUsd))
      ) {
        provider.usageTurns.add(
          `${event.threadId}:${event.turnId ?? event.id}`,
        );
      } else if (
        event.payload.method === 'token-usage.updated' &&
        (isReportedAmount(event.payload.contextTokens) ||
          isReportedAmount(event.payload.contextWindowTokens) ||
          isReportedAmount(event.payload.contextPercent) ||
          isReportedAmount(event.payload.reportedCost?.amount))
      ) {
        // Context (the token pair or an engine's percent) or an engine's own
        // cost (Kiro credits, Grok USD, scoped by its unit), with no token
        // totals: what the occupancy reason describes.
        provider.contextOnlyTurns.add(
          `${event.threadId}:${event.turnId ?? event.id}`,
        );
      }
    }
    const requestedEnd = Date.parse(`${request.to}T23:59:59.999Z`);
    const providerCoverage = [...providers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([providerName, provider]) => {
        const observedTurnCount = provider.terminalTurns.size;
        const usageReportedTurnCount = [...provider.terminalTurns].filter(
          (key) => provider.usageTurns.has(key),
        ).length;
        // Usage scope is declared per provider, but within one provider an
        // engine may report only its context (ACP: every engine but those in
        // `ACP_PER_TURN_PROMPT_USAGE_ENGINES`). So the reason is read from
        // what the unreported turns did carry, not only from the declaration.
        const unreportedTurns = [...provider.terminalTurns].filter(
          (key) => !provider.usageTurns.has(key),
        );
        const unreportedReportContextOnly =
          unreportedTurns.length > 0 &&
          unreportedTurns.every((key) => provider.contextOnlyTurns.has(key));
        const reportsComplete =
          observedTurnCount > 0 && usageReportedTurnCount === observedTurnCount;
        const freshness = provider.providerObservedThrough
          ? requestedEnd - Date.parse(provider.providerObservedThrough) >
            USAGE_COVERAGE_STALE_AFTER_MS
            ? ('stale' as const)
            : ('fresh' as const)
          : ('unknown' as const);
        const complete = reportsComplete && !coverageEvidenceCapped;
        return {
          provider: providerName,
          state: complete ? ('complete' as const) : ('partial' as const),
          window: { from: request.from, to: request.to },
          observedTurnCount,
          usageReportedTurnCount,
          ...(provider.observedThrough
            ? { observedThrough: provider.observedThrough }
            : {}),
          freshness,
          ...(!complete
            ? {
                reason: coverageEvidenceCapped
                  ? COVERAGE_CAP_REASON
                  : observedTurnCount === 0
                    ? 'provider declared but no terminal turns observed'
                    : providerReportsContextOccupancyOnly(providerName) ||
                        unreportedReportContextOnly
                      ? CONTEXT_OCCUPANCY_ONLY_REASON
                      : 'terminal turns missing usage reports',
              }
            : {}),
        };
      });
    const observedTurnCount = providerCoverage.reduce(
      (total, provider) => total + (provider.observedTurnCount ?? 0),
      0,
    );
    const usageReportedTurnCount = providerCoverage.reduce(
      (total, provider) => total + (provider.usageReportedTurnCount ?? 0),
      0,
    );
    const hasStaleProvider = providerCoverage.some(
      (provider) => provider.freshness === 'stale',
    );
    const complete =
      observedTurnCount > 0 &&
      usageReportedTurnCount === observedTurnCount &&
      rows.length <= pageSize &&
      !coverageEvidenceCapped &&
      !hasStaleProvider;
    const coverage = {
      stationId,
      state: complete
        ? ('complete' as const)
        : coverageEvents.length === 0
          ? ('unknown' as const)
          : ('partial' as const),
      ...(!complete
        ? {
            reason: coverageEvidenceCapped
              ? COVERAGE_CAP_REASON
              : hasStaleProvider
                ? STALE_OBSERVATION_REASON
                : rows.length > pageSize
                  ? request.aggregate
                    ? 'aggregate observation limit reached (500); additional window material is missing'
                    : 'bounded receipt material truncated'
                  : observedTurnCount === 0
                    ? 'no terminal turns observed in this window'
                    : 'terminal turns missing usage reports',
          }
        : {}),
      window: { from: request.from, to: request.to },
      observedTurnCount,
      usageReportedTurnCount,
      ...(observedThrough
        ? {
            observedThrough,
            freshness: hasStaleProvider
              ? ('stale' as const)
              : ('fresh' as const),
          }
        : { freshness: 'unknown' as const }),
      ...(providerCoverage.length ? { providers: providerCoverage } : {}),
    };
    return {
      receipts,
      coverage,
      ...(rows.length > pageSize && last?.observedAt
        ? {
            nextCursor: encodeUsageCursor({
              observedAt: last.observedAt,
              eventId: last.id,
            }),
          }
        : {}),
    };
  }
}

function encodeUsageCursor(value: {
  observedAt: string;
  eventId: string;
}): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeUsageCursor(
  cursor: string | undefined,
): { observedAt: string; eventId: string } | undefined {
  if (!cursor || cursor.length > 512) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    return typeof value.observedAt === 'string' &&
      typeof value.eventId === 'string'
      ? { observedAt: value.observedAt, eventId: value.eventId }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep a returned term visible without turning model output into markup. The
 * response remains the same ordinary React string child as every other
 * palette label.
 */
export { messageSearchExcerpt } from './transcript-search-queries.js';

/**
 * The usage receipts one `token-usage.updated` row stands for: a token
 * receipt when the engine reported any token figure (priced only from the
 * snapshot captured with the event, never a current catalog), plus a
 * reported-cost receipt when it reported a cost. A cumulative reporter's
 * receipts share one id, so a later restatement is reconciled with the
 * earlier one (`reconcileUsageReceiptObservations`) instead of adding to it.
 * Shared by the windowed rollup and the conversation usage tree.
 */
export function usageReceiptsForEventRow(
  {
    event,
    conversationId,
    taskId,
    projectSlug,
    model,
    costSegment,
    accountKey,
    connectionId,
    modelConnectionId,
  }: UsageReceiptEventRow,
  stationId: string,
): UsageReceipt[] {
  if (event.payload.method !== 'token-usage.updated') return [];
  const usage = event.payload;
  const common = {
    ...(usage.servedModelObservation
      ? { servedModelObservation: usage.servedModelObservation }
      : {}),
    ...(accountKey !== undefined ? { accountKey } : {}),
    ...(connectionId !== undefined ? { connectionId } : {}),
    ...(modelConnectionId !== undefined ? { modelConnectionId } : {}),
    sourceEventId: event.id,
    sourceSequence: event.sequence,
    stationId,
    provider: event.provider,
    threadId: event.threadId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    conversationId,
    ...(taskId ? { taskId } : {}),
    ...(projectSlug ? { projectSlug } : {}),
    ...(model ? { model } : {}),
    occurredAt: event.createdAt,
    ...(event.observedAt ? { observedAt: event.observedAt } : {}),
  };
  const tokenId =
    providerUsageScope(event.provider) === 'session-cumulative'
      ? `usage:${event.threadId}:${event.provider}:tokens`
      : `usage:${event.id}:tokens`;
  const unpricedTokenReceipt: UsageReceipt = {
    id: tokenId,
    ...common,
    ...(usage.servingRoute
      ? {
          route: {
            ...usage.servingRoute,
            provenance: { ...usage.servingRoute.provenance },
          },
        }
      : {}),
    reasoningTokens: isReportedAmount(usage.reasoningTokens)
      ? usage.reasoningTokens
      : undefined,
    inputTokens: isReportedAmount(usage.promptTokens)
      ? usage.promptTokens
      : undefined,
    outputTokens: isReportedAmount(usage.completionTokens)
      ? usage.completionTokens
      : undefined,
    cacheReadTokens: isReportedAmount(usage.cacheReadTokens)
      ? usage.cacheReadTokens
      : undefined,
    cacheWriteTokens: isReportedAmount(usage.cacheWriteTokens)
      ? usage.cacheWriteTokens
      : undefined,
    // Pricing is deliberately stamped onto the receipt. This read path
    // never asks a catalog or provider for a current price: doing so
    // would rewrite history when a catalog changes.
    pricing: { status: 'unpriced' },
  };
  const tokenReceipt =
    usage.pricingSnapshot && model
      ? stampUsageReceiptPrice(
          unpricedTokenReceipt,
          new CatalogUsagePricingSnapshotReader([usage.pricingSnapshot]),
        )
      : unpricedTokenReceipt;
  const tokenReceipts = hasTokenMeasurements(usage) ? [tokenReceipt] : [];
  if (!isReportedAmount(usage.reportedCostUsd)) return tokenReceipts;
  // Figures in one cumulative cost segment restate one running total, so
  // they share an identity and reconciliation keeps the latest; a resumed
  // process continues its predecessor's segment (station#3320). A
  // cumulative figure without a segment (not reachable from the store
  // today) still shares one thread-wide identity, so it can never be summed.
  const costId =
    providerCostScope(event.provider) === 'engine-process-cumulative'
      ? `usage:${event.threadId}:${event.provider}:cost:${costSegment ?? 'unsegmented'}`
      : `usage:${event.id}:cost`;
  return [
    ...tokenReceipts,
    {
      id: costId,
      ...common,
      reportedCost: { amount: usage.reportedCostUsd, currency: 'USD' },
      pricing: { status: 'unpriced' },
    } satisfies UsageReceipt,
  ];
}

function isReportedAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasTokenMeasurements(
  event: Extract<CanonicalRuntimeEvent, { method: 'token-usage.updated' }>,
): boolean {
  return [
    event.promptTokens,
    event.completionTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.reasoningTokens,
  ].some(isReportedAmount);
}

/**
 * A cached entry, or `undefined` for one that cannot be used: refolding the
 * thread is always the correct answer, so a damaged row costs a refold rather
 * than the pass.
 */
function parseThreadUsageProjection(
  value: string | undefined,
): ThreadUsageProjection | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'projection' in parsed &&
      parsed.projection &&
      typeof parsed.projection === 'object' &&
      Array.isArray(
        (parsed.projection as { observations?: unknown }).observations,
      )
    )
      return parsed as ThreadUsageProjection;
  } catch {
    // Fall through: an unreadable row is a missing row.
  }
  return undefined;
}

/** Refolded threads awaiting a commit, and the event rows they cost. */
class UsageRefoldBatch {
  rows = 0;
  private entries: Array<readonly [string, string]> = [];
  private bytes = 0;

  add(threadId: string, entry: ThreadUsageProjection, rows: number): void {
    const serialized = JSON.stringify(entry);
    this.entries.push([threadId, serialized]);
    this.bytes += serialized.length;
    this.rows += rows;
  }

  /** A commit per slice would make a full build mostly fsyncs. */
  flushIfLarge(store: UsageProjectionStore | undefined): void {
    if (this.bytes >= USAGE_PROJECTION_WRITE_BATCH_BYTES) this.flush(store);
  }

  flush(
    store: UsageProjectionStore | undefined,
    retainOnly?: ReadonlySet<string>,
  ): void {
    if (!this.entries.length && !retainOnly) return;
    store?.writeUsageProjections({
      upserts: this.entries,
      ...(retainOnly ? { retainOnly } : {}),
    });
    this.entries = [];
    this.bytes = 0;
  }
}

/**
 * The session as lifetime analytics consumes it, or `undefined` for a thread
 * that was never configured and measured nothing.
 */
function sessionUsageFrom(
  threadId: string,
  attribution: { conversationId: string; slug?: string } | null | undefined,
  { projection, relayAgentId }: ThreadUsageProjection,
): OrchestrationSessionUsage | undefined {
  if (
    !attribution &&
    projection.observations.length === 0 &&
    projection.usage.contextTokens === undefined
  )
    return undefined;
  return {
    threadId,
    conversationId: attribution?.conversationId ?? threadId,
    ...(attribution?.slug ? { agentSlug: attribution.slug } : {}),
    ...(relayAgentId
      ? { memoryMirror: { agentSlug: relayAgentId, conversationId: threadId } }
      : {}),
    ...projection,
  };
}
