import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type { UsageReceipt } from '@kontourai/station-contracts/usage-rollup';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import type { SessionUsageAggregate } from '@kontourai/station-shared/usage-fold';
import {
  foldUsageEvents,
  providerCostScope,
  providerUsageScope,
} from '@kontourai/station-shared/usage-fold';
import type { OrchestrationSessionUsage } from '../../analytics/usage-aggregator-state.js';
import {
  CatalogUsagePricingSnapshotReader,
  stampUsageReceiptPrice,
} from '../../analytics/usage-pricing-snapshot-reader.js';
import type { EventStore } from './event-store.js';
// Type-only import back into the service module: erased at runtime, so no
// import cycle exists — and it avoids adding ANOTHER copy of the read-scope
// union (session-lifecycle-module.ts already re-declares one privately; the
// durable fix is exporting the union from contracts/tenancy beside its two
// constituents, tracked on the epic).
import type { SessionReadScope } from './orchestration-service.js';

/** The documented freshness allowance relative to the requested window end. */
export const USAGE_COVERAGE_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
export const USAGE_COVERAGE_EVIDENCE_CAP = 1_000;
const COVERAGE_CAP_REASON =
  'coverage evidence cap reached (1000 observations); additional provider evidence is missing';
const STALE_OBSERVATION_REASON =
  'provider observations are older than the 24-hour freshness threshold for this window';

export interface SessionTranscriptReadsDeps {
  canReadSession: (threadId: string, authority: SessionReadScope) => boolean;
  isEphemeralSession: (threadId: string) => boolean;
  sessionAttributionFor: (
    threadId: string,
  ) => { conversationId: string; slug?: string } | null | undefined;
  listEventPayloads: (threadId: string) => CanonicalRuntimeEvent[];
  listUsageEventRecords: (
    threadId: string,
  ) => ReturnType<EventStore['listEvents']>;
  listUsageReceiptEvents: EventStore['listUsageReceiptEvents'];
  listUsageCoverageEvents: EventStore['listUsageCoverageEvents'];
  // Derived from the store's own method type — no re-declared row shape.
  searchConversationMessages: EventStore['searchConversationMessages'];
  readSessionThreadIds: (authority: SessionReadScope) => string[];
  requireTenantExecutionContext: () => boolean;
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
      ownerUserId: authority.userId,
      ...(authority.mode === 'hosted' && authority.tenantExecutionContext
        ? { tenantId: authority.tenantExecutionContext.tenantId }
        : {}),
      limit: Math.min(Math.max(limit, 1), 20),
    });
    return rows
      .filter((row) => this.deps.canReadSession(row.threadId, authority))
      .slice(0, Math.min(Math.max(limit, 1), 20))
      .map((row) => ({
        conversationId: row.threadId,
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
    return foldUsageEvents(this.deps.listEventPayloads(threadId));
  }

  listSessionUsage(authority: SessionReadScope): OrchestrationSessionUsage[] {
    // Its one consumer is `analytics/stats.json`, a home-global lifetime
    // store with no per-user partition, served by a route that applies no
    // tenant scope. In a hosted deployment "home-global" would mean "across
    // tenants", so there is no correct total to give and none is given —
    // matching the memory substrate this supplements, which hosted mode does
    // not use either (`isHostedSessionReadAuthority` in `conversations.ts`).
    if (this.deps.requireTenantExecutionContext() === true) return [];
    const sessions: OrchestrationSessionUsage[] = [];
    for (const threadId of this.deps.readSessionThreadIds(authority)) {
      if (this.deps.isEphemeralSession(threadId)) continue;
      if (!this.deps.canReadSession(threadId, authority)) continue;
      const attribution = this.deps.sessionAttributionFor(threadId);
      if (!attribution) continue;
      sessions.push({
        threadId,
        conversationId: attribution.conversationId,
        ...(attribution.slug ? { agentSlug: attribution.slug } : {}),
        usage: this.readSessionUsage(threadId, authority),
      });
    }
    return sessions;
  }

  listUsageReceipts(
    authority: SessionReadAuthority,
    stationId: string,
    request: { from: string; to: string; cursor?: string; pageSize?: number },
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
    const pageSize = Math.min(Math.max(request.pageSize ?? 50, 1), 100);
    const after = decodeUsageCursor(request.cursor);
    const rows = this.deps.listUsageReceiptEvents({
      ownerUserId: authority.userId,
      ...(authority.mode === 'hosted' && authority.tenantExecutionContext
        ? { tenantId: authority.tenantExecutionContext.tenantId }
        : {}),
      from: request.from,
      to: request.to,
      ...(after ? { after } : {}),
      limit: pageSize,
    });
    const page = rows.slice(0, pageSize);
    const receipts = page.flatMap(
      ({ event, conversationId, taskId, model, processEpoch }) => {
        if (event.payload.method !== 'token-usage.updated' || !event.observedAt)
          return [];
        const usage = event.payload;
        const common = {
          sourceEventId: event.id,
          stationId,
          provider: event.provider,
          threadId: event.threadId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          conversationId,
          ...(taskId ? { taskId } : {}),
          ...(model ? { model } : {}),
          occurredAt: event.createdAt,
          observedAt: event.observedAt,
        };
        const tokenId =
          providerUsageScope(event.provider) === 'session-cumulative'
            ? `usage:${event.threadId}:${event.provider}:tokens:${processEpoch}`
            : `usage:${event.id}:tokens`;
        const unpricedTokenReceipt: UsageReceipt = {
          id: tokenId,
          ...common,
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
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
        if (typeof usage.reportedCostUsd !== 'number') return [tokenReceipt];
        const costId =
          providerCostScope(event.provider) === 'engine-process-cumulative'
            ? `usage:${event.threadId}:${event.provider}:cost:${processEpoch}`
            : `usage:${event.id}:cost`;
        return [
          tokenReceipt,
          {
            id: costId,
            ...common,
            reportedCost: { amount: usage.reportedCostUsd, currency: 'USD' },
            pricing: { status: 'unpriced' },
          } satisfies UsageReceipt,
        ];
      },
    );
    const last = page.at(-1)?.event;
    const coverageEvidence = this.deps.listUsageCoverageEvents({
      ownerUserId: authority.userId,
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
        observedThrough?: string;
        providerObservedThrough?: string;
      } = {
        terminalTurns: new Set<string>(),
        usageTurns: new Set<string>(),
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
      if (event.payload.method === 'token-usage.updated') {
        provider.usageTurns.add(
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
                  ? 'bounded receipt material truncated'
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
export function messageSearchExcerpt(content: string, query: string): string {
  const normalized = query.trim();
  const matchAt = content
    .toLocaleLowerCase()
    .indexOf(normalized.toLocaleLowerCase());
  if (matchAt < 0 || content.length <= 240) return content.slice(0, 240);
  const start = Math.max(0, matchAt - 80);
  const end = Math.min(content.length, start + 240);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}
