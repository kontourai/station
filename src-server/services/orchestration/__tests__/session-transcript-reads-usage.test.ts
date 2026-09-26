import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import {
  SessionTranscriptReads,
  USAGE_COVERAGE_EVIDENCE_CAP,
} from '../session-transcript-reads.js';

const authority = sessionReadAuthorityFromRequest(
  'usage-reader',
  undefined,
  undefined,
);
const request = { from: '2026-08-01', to: '2026-08-07' };

function event(input: {
  id: string;
  provider: string;
  method: 'turn.completed' | 'token-usage.updated';
  turnId: string;
  createdAt: string;
  observedAt?: string;
}) {
  return {
    id: input.id,
    provider: input.provider,
    threadId: `${input.provider}-thread`,
    turnId: input.turnId,
    createdAt: input.createdAt,
    observedAt: input.observedAt ?? '2026-08-07T12:00:00.000Z',
    sequence: 1,
    globalSequence: 1,
    method: input.method,
    payload: { method: input.method },
  } as any;
}

function reads(coverageEvents: any[]) {
  return new SessionTranscriptReads({
    canReadSession: () => true,
    isEphemeralSession: () => false,
    sessionAttributionFor: () => null,
    listEventPayloads: () => [],
    listUsageEventRecords: () => [],
    listUsageReceiptEvents: () => [],
    listUsageCoverageEvents: () => coverageEvents,
    searchConversationMessages: () => [],
    readSessionThreadIds: () => [],
    requireTenantExecutionContext: () => false,
    // These cases assert coverage/receipt projections, not the drop
    // contract; an explicit no-op is what #910 asks a caller with nowhere
    // to report to say out loud.
    reportDroppedUsageFigure: () => {},
  });
}

describe('SessionTranscriptReads usage coverage (station#4135)', () => {
  test('treats the 1001st coverage observation as an evidence-cap sentinel, never complete usage', () => {
    const coverageEvents = Array.from(
      { length: USAGE_COVERAGE_EVIDENCE_CAP + 1 },
      (_, index) =>
        event({
          id: `reported-${index}`,
          provider: 'claude',
          method: 'token-usage.updated',
          turnId: `turn-${index}`,
          createdAt: '2026-08-07T23:00:00.000Z',
        }),
    );
    const result = reads(coverageEvents).listUsageReceipts(
      authority,
      'local',
      request,
    );
    expect(result.coverage).toMatchObject({
      state: 'partial',
      reason: expect.stringContaining('coverage evidence cap reached'),
    });
    expect(result.coverage.providers?.[0]).toMatchObject({
      state: 'partial',
      reason: expect.stringContaining('coverage evidence cap reached'),
    });
  });

  test('keeps fresh and stale provider clocks distinct and makes their source partial', () => {
    const coverageEvents = [
      event({
        id: 'fresh-terminal',
        provider: 'fresh-provider',
        method: 'turn.completed',
        turnId: 'fresh-turn',
        createdAt: '2026-08-07T23:30:00.000Z',
      }),
      event({
        id: 'fresh-usage',
        provider: 'fresh-provider',
        method: 'token-usage.updated',
        turnId: 'fresh-turn',
        createdAt: '2026-08-07T23:30:01.000Z',
      }),
      event({
        id: 'stale-terminal',
        provider: 'stale-provider',
        method: 'turn.completed',
        turnId: 'stale-turn',
        createdAt: '2026-08-01T00:00:00.000Z',
      }),
      event({
        id: 'stale-usage',
        provider: 'stale-provider',
        method: 'token-usage.updated',
        turnId: 'stale-turn',
        createdAt: '2026-08-01T00:00:01.000Z',
      }),
    ];
    const result = reads(coverageEvents).listUsageReceipts(
      authority,
      'local',
      request,
    );
    expect(result.coverage).toMatchObject({
      state: 'partial',
      freshness: 'stale',
    });
    expect(result.coverage.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'fresh-provider',
          freshness: 'fresh',
        }),
        expect.objectContaining({
          provider: 'stale-provider',
          freshness: 'stale',
        }),
      ]),
    );
  });
});

describe('SessionTranscriptReads: the fold drop reaches the composition (#464)', () => {
  // The fold refuses an unusable persisted figure and reports it. That report
  // is only worth anything if the read actually wires a sink — an optional dep
  // that no composition supplies is silence with extra steps, which is what
  // usage-fold's own drop contract forbids.
  //
  // SCOPE, stated because an injection proved it: this pins the SEAM, not the
  // COMPOSITION. Deleting `reportDroppedUsageFigure` from
  // `orchestration-service.ts`'s deps leaves this test green, because the test
  // supplies its own reporter. Catching that needs a test over the real
  // service construction — tracked as its own gap rather than implied here.
  test('readSessionUsage forwards a refused durable figure to the reporter', () => {
    const dropped: Array<{ field: string; value: unknown }> = [];
    const reads = new SessionTranscriptReads({
      canReadSession: () => true,
      isEphemeralSession: () => false,
      sessionAttributionFor: () => null,
      listEventPayloads: () =>
        [
          {
            eventId: 'e1',
            method: 'token-usage.updated',
            provider: 'claude',
            threadId: 'thread-1',
            createdAt: '2026-08-30T00:00:00.000Z',
            // What JSON.stringify writes for a non-finite figure.
            promptTokens: null,
            completionTokens: 40,
          },
        ] as never,
      listUsageEventRecords: () => [],
      listUsageReceiptEvents: () => [],
      listUsageCoverageEvents: () => [],
      searchConversationMessages: () => [],
      readSessionThreadIds: () => [],
      requireTenantExecutionContext: () => false,
      reportDroppedUsageFigure: (d) => dropped.push(d),
    });

    const usage = reads.readSessionUsage('thread-1', authority);

    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBe(40);
    expect(dropped).toEqual([
      expect.objectContaining({ field: 'promptTokens', value: null }),
    ]);
  });
});

describe('SessionTranscriptReads usage owner set (#2568)', () => {
  function recordingReads() {
    const receiptQueries: unknown[] = [];
    const coverageQueries: unknown[] = [];
    const reads = new SessionTranscriptReads({
      canReadSession: () => true,
      isEphemeralSession: () => false,
      sessionAttributionFor: () => null,
      listEventPayloads: () => [],
      listUsageEventRecords: () => [],
      listUsageReceiptEvents: (options) => {
        receiptQueries.push(options);
        return [];
      },
      listUsageCoverageEvents: (options) => {
        coverageQueries.push(options);
        return [];
      },
      searchConversationMessages: () => [],
      // The personal conversation account: a paired device reads the
      // operator's and its own rows.
      transcriptOwnerConstraint: (reader) => ({
        ownerUserId: reader.userId,
        ...(reader.mode === 'personal' && reader.userId === 'human:device:phone'
          ? {
              ownerUserIds: ['human:device:phone', 'human:local:operator'],
            }
          : {}),
      }),
      readSessionThreadIds: () => [],
      requireTenantExecutionContext: () => false,
      reportDroppedUsageFigure: () => {},
    });
    return { reads, receiptQueries, coverageQueries };
  }

  test('a personal caller reads its personal account’s owners, receipts and coverage alike', () => {
    const { reads, receiptQueries, coverageQueries } = recordingReads();
    reads.listUsageReceipts(
      sessionReadAuthorityFromRequest(
        'human:device:phone',
        undefined,
        undefined,
      ),
      'local',
      request,
    );
    for (const query of [receiptQueries[0], coverageQueries[0]]) {
      expect(query).toMatchObject({
        ownerUserIds: ['human:device:phone', 'human:local:operator'],
      });
      expect(query).not.toHaveProperty('tenantId');
    }
  });

  test('a hosted caller reads its exact owner within its tenant, never an account', () => {
    const { reads, receiptQueries, coverageQueries } = recordingReads();
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: tenantId('alpha'), authority: 'alpha.example.test' }],
    });
    reads.listUsageReceipts(
      sessionReadAuthorityFromRequest(
        'human:device:phone',
        { tenantId: tenantId('alpha') },
        registry,
      ),
      'local',
      request,
    );
    for (const query of [receiptQueries[0], coverageQueries[0]]) {
      expect(query).toMatchObject({
        ownerUserIds: ['human:device:phone'],
        tenantId: 'alpha',
      });
    }
  });

  test('a caller outside any account reads only its own rows', () => {
    const { reads, receiptQueries } = recordingReads();
    reads.listUsageReceipts(authority, 'local', request);
    expect(receiptQueries[0]).toMatchObject({
      ownerUserIds: ['usage-reader'],
    });
  });
});
