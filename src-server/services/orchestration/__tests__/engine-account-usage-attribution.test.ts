import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type { UsageRollup } from '@kontourai/station-contracts/usage-rollup';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { UsageAggregator } from '../../../analytics/usage-aggregator.js';
import { usageCredentialAccountKey } from '../../../providers/app-home/app-home-profiles.js';
import { createAnalyticsRoutes } from '../../../routes/operations/analytics.js';
import { EventStore } from '../event-store.js';
import { SessionTranscriptReads } from '../session-transcript-reads.js';

const makeTempDir = trackTempDirs();

test('persisted receipt attribution follows the applied profile within its process epoch and stays owner scoped', () => {
  const dir = makeTempDir('usage-account-attribution-');
  const store = new EventStore(join(dir, 'events.sqlite'));
  const owner = 'usage-reader';
  const day = new Date().toISOString().slice(0, 10);
  let ordinal = 0;
  const started = (threadId: string, userId: string, ref?: string | null) =>
    store.appendEvent({
      eventId: `started-${++ordinal}`,
      provider: 'claude',
      threadId,
      sessionId: threadId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      initialState: 'created',
      metadata: {
        userId,
        ...(ref !== undefined
          ? { usageAccountKey: usageCredentialAccountKey('claude', ref) }
          : {}),
      },
    });
  const usage = (threadId: string, turnId: string) =>
    store.appendEvent({
      eventId: `usage-${++ordinal}`,
      provider: 'claude',
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
      method: 'token-usage.updated',
      promptTokens: 10,
      completionTokens: 2,
      reportedCostUsd: 1,
    });
  try {
    started('session', owner, 'work');
    usage('session', 'work-turn');
    // Sparse reconfiguration must retain the applied account for this process.
    store.appendEvent({
      eventId: `config-${++ordinal}`,
      provider: 'claude',
      threadId: 'session',
      sessionId: 'session',
      createdAt: new Date().toISOString(),
      method: 'session.configured',
      model: 'test',
    });
    usage('session', 'sparse-turn');
    started('session', owner, null);
    usage('session', 'default-turn');
    started('session', owner);
    usage('session', 'unknown-turn');
    started('other-owner', 'private-reader', 'work');
    usage('other-owner', 'private-turn');
    const reads = usageReads(store);
    const result = reads.listUsageReceipts(
      sessionReadAuthorityFromRequest(owner, undefined, undefined),
      'local',
      { from: day, to: day },
    );
    const accounts = new Map(
      result.receipts.map((receipt) => [receipt.turnId, receipt.accountKey]),
    );
    expect(accounts.size).toBe(4);
    expect(accounts.get('work-turn')).toBe(
      usageCredentialAccountKey('claude', 'work'),
    );
    expect(accounts.get('sparse-turn')).toBe(
      usageCredentialAccountKey('claude', 'work'),
    );
    expect(accounts.get('default-turn')).toBe(
      usageCredentialAccountKey('claude', null),
    );
    expect(accounts.get('unknown-turn')).toBeUndefined();
    expect(accounts.has('private-turn')).toBe(false);
    expect(
      result.receipts.filter((receipt) => receipt.turnId === 'work-turn'),
    ).toHaveLength(2);
  } finally {
    store.close();
  }
});

function usageReads(store: EventStore): SessionTranscriptReads {
  return new SessionTranscriptReads({
    canReadSession: () => true,
    isEphemeralSession: () => false,
    sessionAttributionFor: () => null,
    listEventPayloads: () => [],
    listUsageEventRecords: () => [],
    listUsageReceiptEvents: (options) => store.listUsageReceiptEvents(options),
    listUsageCoverageEvents: (options) =>
      store.listUsageCoverageEvents(options),
    searchConversationMessages: () => [],
    readSessionThreadIds: () => [],
    requireTenantExecutionContext: () => false,
    reportDroppedUsageFigure: () => {},
  });
}

function usageRoute(store: EventStore, home: string, owner: string) {
  const reads = usageReads(store);
  const aggregator = new UsageAggregator(home, {
    get: () => ({
      listSessionUsage: () => [],
      listUsageReceipts: (authority, stationId, request) =>
        reads.listUsageReceipts(authority, stationId, request),
    }),
  });
  return createAnalyticsRoutes(aggregator, undefined, () =>
    sessionReadAuthorityFromRequest(owner, undefined, undefined),
  );
}

function windowQuery() {
  return new URLSearchParams({
    from: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
    localOnly: '1',
    groupBy: 'provider',
    pageSize: '10',
  });
}

function startSession(
  store: EventStore,
  provider: 'claude' | 'codex' | 'acp' | 'muse',
  threadId: string,
  owner: string,
  epoch = 1,
) {
  store.appendEvent({
    eventId: `start-${threadId}-${epoch}`,
    provider,
    threadId,
    sessionId: threadId,
    createdAt: new Date().toISOString(),
    method: 'session.started',
    initialState: 'created',
    metadata: { userId: owner },
  });
}

test('the real analytics route aggregates beyond its drilldown page without including another owner', async () => {
  const home = makeTempDir('usage-route-aggregate-');
  const store = new EventStore(join(home, 'events.sqlite'));
  try {
    for (const owner of ['reader', 'other-reader']) {
      startSession(store, 'claude', owner, owner);
      for (let index = 0; index < 120; index += 1) {
        const turnId = `${owner}-${index}`;
        store.appendEvent({
          eventId: `usage-${turnId}`,
          provider: 'claude',
          threadId: owner,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'token-usage.updated',
          promptTokens: 1,
          completionTokens: 0,
        });
        store.appendEvent({
          eventId: `completed-${turnId}`,
          provider: 'claude',
          threadId: owner,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
        });
      }
    }
    const app = usageRoute(store, home, 'reader');
    const query = windowQuery();
    const firstResponse = await app.request(`/usage-rollup?${query}`);
    expect(firstResponse.status).toBe(200);
    const first: { data: UsageRollup } = await firstResponse.json();
    expect(first.data.rows).toEqual([
      expect.objectContaining({
        provider: 'claude',
        inputTokens: 120,
        outputTokens: 0,
      }),
    ]);
    expect(first.data.receipts).toHaveLength(10);
    expect(
      first.data.receipts.every((receipt) => receipt.threadId === 'reader'),
    ).toBe(true);
    expect(first.data.nextCursor).toBeDefined();
    query.set('cursor', first.data.nextCursor!);
    const secondResponse = await app.request(`/usage-rollup?${query}`);
    expect(secondResponse.status).toBe(200);
    const second: { data: UsageRollup } = await secondResponse.json();
    expect(second.data.rows).toEqual(first.data.rows);
    expect(
      second.data.receipts.map((receipt) => receipt.sourceEventId),
    ).not.toEqual(first.data.receipts.map((receipt) => receipt.sourceEventId));
  } finally {
    store.close();
  }
});

test('context-only ACP observations do not claim consumed-usage coverage or produce empty token receipts', async () => {
  const home = makeTempDir('usage-route-context-');
  const store = new EventStore(join(home, 'events.sqlite'));
  try {
    startSession(store, 'acp', 'context-thread', 'reader');
    store.appendEvent({
      eventId: 'context-observation',
      provider: 'acp',
      threadId: 'context-thread',
      turnId: 'turn-1',
      createdAt: new Date().toISOString(),
      method: 'token-usage.updated',
      contextTokens: 400,
      contextWindowTokens: 1000,
    });
    store.appendEvent({
      eventId: 'context-completed',
      provider: 'acp',
      threadId: 'context-thread',
      turnId: 'turn-1',
      createdAt: new Date().toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    const app = usageRoute(store, home, 'reader');
    const response = await app.request(`/usage-rollup?${windowQuery()}`);
    expect(response.status).toBe(200);
    const result: { data: UsageRollup } = await response.json();
    expect(result.data.receipts).toEqual([]);
    expect(result.data.rows).toEqual([]);
    expect(result.data.coverage[0].providers).toEqual([
      expect.objectContaining({
        provider: 'acp',
        state: 'partial',
        observedTurnCount: 1,
        usageReportedTurnCount: 0,
      }),
    ]);
  } finally {
    store.close();
  }
});

test('Codex token replacement survives a process restart while Claude cost epochs stay separate', async () => {
  const home = makeTempDir('usage-route-epochs-');
  const store = new EventStore(join(home, 'events.sqlite'));
  try {
    for (const provider of ['codex', 'claude'] as const) {
      for (const epoch of [1, 2]) {
        startSession(store, provider, provider, 'reader', epoch);
        store.appendEvent({
          eventId: `${provider}-usage-${epoch}`,
          provider,
          threadId: provider,
          turnId: `${provider}-turn-${epoch}`,
          createdAt: new Date().toISOString(),
          method: 'token-usage.updated',
          promptTokens: epoch === 1 ? 200 : 250,
          completionTokens: 0,
          ...(provider === 'claude'
            ? { reportedCostUsd: epoch === 1 ? 3 : 2 }
            : {}),
        });
        store.appendEvent({
          eventId: `${provider}-completed-${epoch}`,
          provider,
          threadId: provider,
          turnId: `${provider}-turn-${epoch}`,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
        });
      }
    }
    const response = await usageRoute(store, home, 'reader').request(
      `/usage-rollup?${windowQuery()}`,
    );
    expect(response.status).toBe(200);
    const result: { data: UsageRollup } = await response.json();
    expect(
      result.data.rows.find((row) => row.provider === 'codex'),
    ).toMatchObject({ inputTokens: 250 });
    expect(
      result.data.rows.find((row) => row.provider === 'claude'),
    ).toMatchObject({
      inputTokens: 450,
      reportedCost: { amount: 5, currency: 'USD' },
    });
  } finally {
    store.close();
  }
});

test.each([500, 501])(
  'the aggregate observation boundary discloses truncation (%s observations)',
  async (count) => {
    const home = makeTempDir('usage-route-cap-');
    const store = new EventStore(join(home, 'events.sqlite'));
    try {
      startSession(store, 'muse', 'model-calls', 'reader');
      for (let index = 0; index < count; index += 1) {
        store.appendEvent({
          eventId: `model-call-${index}`,
          provider: 'muse',
          threadId: 'model-calls',
          turnId: 'turn-1',
          createdAt: new Date().toISOString(),
          method: 'token-usage.updated',
          promptTokens: 1,
          completionTokens: 0,
        });
      }
      store.appendEvent({
        eventId: 'model-calls-completed',
        provider: 'muse',
        threadId: 'model-calls',
        turnId: 'turn-1',
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        finishReason: 'stop',
      });
      const response = await usageRoute(store, home, 'reader').request(
        `/usage-rollup?${windowQuery()}`,
      );
      expect(response.status).toBe(200);
      const result: { data: UsageRollup } = await response.json();
      expect(result.data.rows[0].inputTokens).toBe(500);
      expect(result.data.coverage[0].state).toBe(
        count === 500 ? 'complete' : 'partial',
      );
      expect(result.data.coverage[0].reason ?? '').toBe(
        count === 500
          ? ''
          : 'aggregate observation limit reached (500); additional window material is missing',
      );
    } finally {
      store.close();
    }
  },
);
