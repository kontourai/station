import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
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
