import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { cacheInclusivePromptTokens } from '@kontourai/station-shared/usage-fold';
import { expect, test, vi } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import { OllamaAdapter } from '../../providers/adapters/ollama-adapter.js';
import { OllamaLLMProvider } from '../../providers/llm/ollama-provider.js';
import { createAnalyticsRoutes } from '../../routes/operations/analytics.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { SessionTranscriptReads } from '../../services/orchestration/session-transcript-reads.js';
import { UsageTelemetryService } from '../../services/usage-telemetry-service.js';
import { UsageAggregator } from '../usage-aggregator.js';
import type { UsageStats } from '../usage-aggregator-state.js';

const makeHome = trackTempDirs();
const day1 = '2026-08-01T12:00:00.000Z';
const day2 = '2026-08-02T12:00:00.000Z';
const principal = humanPrincipal('fixture', 'reader', 'Fixture reader');

test('an empty real source cannot claim a zero cost-per-message milestone', async () => {
  const f = fixture();
  try {
    const body = await readJson<{
      data: Array<{
        id: string;
        progress?: number;
        progressPercent?: number;
        measurementUnavailableReason?: string;
      }>;
    }>(await f.app.request('/achievements'));
    const cost = body.data.find((item) => item.id === 'cost-conscious');
    expect(cost?.measurementUnavailableReason).toContain(
      'No recorded messages',
    );
    expect(cost?.progress).toBeUndefined();
    expect(cost?.progressPercent).toBeUndefined();
  } finally {
    f.store.close();
  }
});

test('cache-only engine observations count as reported token measurements', async () => {
  const f = fixture();
  try {
    f.start('cache-only', 'claude');
    f.turn('cache-only', 'claude', 'cache-turn', day1, { cacheReadTokens: 25 });
    const stats = await f.current();
    expect(stats.lifetime.engineUsageCoverage?.sessionsReportingTokens).toBe(1);
    expect(stats.byModel['model-a'].cacheReadTokens).toBe(25);
  } finally {
    f.store.close();
  }
});

function fixture() {
  const home = makeHome('usage-source-projection-');
  const store = new EventStore(join(home, 'events.sqlite'));
  const authority = sessionReadAuthorityFromRequest(
    'reader',
    undefined,
    undefined,
  );
  const reads = new SessionTranscriptReads({
    canReadSession: () => true,
    isEphemeralSession: () => false,
    sessionAttributionFor: (threadId) => {
      const configured = store
        .listEvents(threadId)
        .map((row) => row.payload)
        .find((event) => event.method === 'session.configured');
      return configured?.method === 'session.configured'
        ? {
            conversationId:
              typeof configured.metadata?.conversationId === 'string'
                ? configured.metadata.conversationId
                : threadId,
            slug:
              typeof configured.metadata?.agentSlug === 'string'
                ? configured.metadata.agentSlug
                : undefined,
          }
        : undefined;
    },
    listEventPayloads: (threadId) =>
      store.listEvents(threadId).map((row) => row.payload),
    listResolvedEventPayloads: (threadId) =>
      store
        .resolveEventContent(store.listEvents(threadId))
        .map((row) => row.payload),
    readUsageRevision: (threadId) => store.readUsageRevision(threadId),
    listUsageEventPayloads: (threadId, clock) =>
      store.listUsageEventPayloads(threadId, clock),
    listUsageReceiptEvents: (options) => store.listUsageReceiptEvents(options),
    listUsageCoverageEvents: (options) =>
      store.listUsageCoverageEvents(options),
    searchConversationMessages: (options) =>
      store.searchConversationMessages(options),
    readSessionThreadIds: () =>
      store.readSessions().map((session) => session.threadId),
    requireTenantExecutionContext: () => false,
    reportDroppedUsageFigure: () => {},
  });
  const aggregator = new UsageAggregator(home, {
    get: () => ({ listSessionUsage: () => reads.listSessionUsage(authority) }),
  });
  const app = createAnalyticsRoutes(aggregator);
  let ordinal = 0;
  function event(
    threadId: string,
    provider: CanonicalRuntimeEvent['provider'],
    createdAt: string,
  ) {
    return { threadId, provider, createdAt };
  }
  function start(
    threadId: string,
    provider: CanonicalRuntimeEvent['provider'],
    createdAt = day1,
    model = 'model-a',
    metadata: Record<string, unknown> = {},
    resumed = false,
  ) {
    store.upsertSession({
      provider,
      threadId,
      status: 'ready',
      model,
      createdAt,
      updatedAt: createdAt,
    });
    store.appendEvent({
      ...event(threadId, provider, createdAt),
      eventId: `event-${++ordinal}`,
      method: 'session.started',
      sessionId: threadId,
      initialState: 'created',
      metadata: {
        userId: 'reader',
        ...(resumed ? { nativeSessionResumed: true } : {}),
      },
    });
    store.appendEvent({
      ...event(threadId, provider, createdAt),
      eventId: `event-${++ordinal}`,
      method: 'session.configured',
      sessionId: threadId,
      model,
      metadata,
    });
  }
  function turn(
    threadId: string,
    provider: CanonicalRuntimeEvent['provider'],
    turnId: string,
    createdAt: string,
    usage: Partial<
      Extract<CanonicalRuntimeEvent, { method: 'token-usage.updated' }>
    > = {},
  ) {
    const base = event(threadId, provider, createdAt);
    store.appendEvent({
      ...base,
      eventId: `event-${++ordinal}`,
      method: 'turn.started',
      turnId,
      principal,
    });
    store.appendEvent({
      ...base,
      eventId: `event-${++ordinal}`,
      method: 'token-usage.updated',
      turnId,
      ...usage,
    });
    store.appendEvent({
      ...base,
      eventId: `event-${++ordinal}`,
      method: 'turn.completed',
      turnId,
      finishReason: 'stop',
    });
  }
  async function current() {
    const response = await app.request('/usage');
    expect(response.status).toBe(200);
    const body = await readJson<{ data: UsageStats }>(response);
    return body.data;
  }
  return {
    home,
    store,
    aggregator,
    app,
    start,
    turn,
    current,
    event,
    reads,
    authority,
  };
}

test('agent cost fields preserve reported and estimated zero separately from missing cost', async () => {
  const f = fixture();
  try {
    f.start('measured', 'claude', day1, 'model-a', { agentSlug: 'measured' });
    f.turn('measured', 'claude', 'measured-turn', day1, { reportedCostUsd: 0 });
    f.start('unknown', 'codex', day1, 'model-a', { agentSlug: 'unknown' });
    f.turn('unknown', 'codex', 'unknown-turn', day1);
    await memory(
      f.home,
      'saved-zero',
      { timestamp: day1, usage: { estimatedCost: 0 } },
      'estimated',
    );
    const stats = await f.current();
    expect(stats.byAgent.measured).toMatchObject({
      cost: 0,
      reportedCostUsd: 0,
    });
    expect(stats.byAgent.estimated).toMatchObject({
      cost: 0,
      estimatedCostUsd: 0,
    });
    expect(stats.byAgent.unknown.cost).toBe(0);
    expect(stats.byAgent.unknown.reportedCostUsd).toBeUndefined();
    expect(stats.byAgent.unknown.estimatedCostUsd).toBeUndefined();
  } finally {
    f.store.close();
  }
});

async function memory(
  home: string,
  conversationId: string,
  metadata: Record<string, unknown>,
  agent = 'station',
) {
  const dir = join(home, 'agents', agent, 'memory', 'sessions');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${conversationId}.ndjson`);
  await writeFile(
    path,
    `${JSON.stringify({ id: 'assistant', role: 'assistant', parts: [], metadata })}\n`,
  );
  return path;
}

test.each([
  {
    name: 'resumed continuation',
    restart: 'resumed',
    nextCost: 2,
    expected: 2,
  },
  { name: 'fresh process', restart: 'fresh', nextCost: 2, expected: 3 },
  {
    name: 'lower figure in the same process',
    restart: 'none',
    nextCost: 0.25,
    expected: 1.25,
  },
  { name: 'resumed reset', restart: 'resumed', nextCost: 0.25, expected: 1.25 },
])(
  'Claude $name keeps retained breakdowns aligned with the canonical cost',
  async ({ restart, nextCost, expected }) => {
    const f = fixture();
    try {
      f.start('cost-segments', 'claude');
      f.turn('cost-segments', 'claude', 'first', day1, { reportedCostUsd: 1 });
      if (restart !== 'none') {
        f.start(
          'cost-segments',
          'claude',
          day2,
          'model-a',
          {},
          restart === 'resumed',
        );
      }
      f.turn('cost-segments', 'claude', 'next', day2, {
        reportedCostUsd: nextCost,
      });
      const stats = await f.current();
      expect(stats.lifetime.reportedCostUsd).toBeCloseTo(expected);
      expect(stats.byProvider?.claude.reportedCostUsd).toBeCloseTo(expected);
      expect(
        Object.values(stats.byModel).reduce((sum, row) => sum + row.cost, 0) +
          (stats.unallocated?.model.cost ?? 0),
      ).toBeCloseTo(expected);
      expect(
        Object.values(stats.byDate).reduce((sum, row) => sum + row.cost, 0) +
          (stats.unallocated?.date.cost ?? 0),
      ).toBeCloseTo(expected);
    } finally {
      f.store.close();
    }
  },
);

test.each([null, true, false, [], [day1], {}])(
  'invalid persisted timestamp %j stays undated',
  async (timestamp) => {
    const f = fixture();
    try {
      await memory(f.home, 'invalid-date', {
        timestamp,
        usage: { inputTokens: 7 },
      });
      const stats = await f.current();
      expect(stats.byDate).toEqual({});
      expect(stats.lifetime.firstMessageDate).toBeUndefined();
      expect(stats.unallocated?.date).toMatchObject({
        messages: 1,
        inputTokens: 7,
      });
    } finally {
      f.store.close();
    }
  },
);

test('real usage GET allocates retained per-call facts across UTC days, models and recorded principals without inventing missing attribution', async () => {
  const f = fixture();
  try {
    f.start('muse', 'muse');
    f.turn('muse', 'muse', 'one', day1, {
      promptTokens: 135,
      completionTokens: 600,
      cacheReadTokens: 18400,
      cacheWriteTokens: 10100,
      reportedCostUsd: 0.2,
      principal: humanPrincipal(
        'fixture',
        'untrusted-event',
        'Untrusted usage actor',
      ),
    });
    f.start('muse', 'muse', day2, 'model-b');
    f.turn('muse', 'muse', 'two', day2, {
      promptTokens: 20,
      completionTokens: 2,
    });
    await memory(f.home, 'undated', {
      usage: { inputTokens: 7, estimatedCost: 0 },
      principal,
    });
    await mkdir(join(f.home, 'config'), { recursive: true });
    await writeFile(
      join(f.home, 'config', 'app.json'),
      JSON.stringify({ defaultModel: 'today-model' }),
    );
    const stats = await f.current();
    expect(stats.lifetime).toMatchObject({
      totalMessages: 3,
      totalInputTokens: 162,
      totalOutputTokens: 602,
      totalCost: 0.2,
    });
    expect(stats.byDate['2026-08-01']).toMatchObject({
      messages: 1,
      inputTokens: 135,
      cost: 0.2,
    });
    expect(stats.byDate['2026-08-02']).toMatchObject({
      messages: 1,
      inputTokens: 20,
      cost: 0,
    });
    expect(Object.keys(stats.byDate)).toEqual(['2026-08-01', '2026-08-02']);
    expect(stats.lifetime).toMatchObject({
      reportedCostUsd: 0.2,
      estimatedCostUsd: 0,
    });
    expect(stats.byModel['model-a']).toMatchObject({
      messages: 1,
      inputTokens: 135,
      cacheReadTokens: 18400,
    });
    expect(
      cacheInclusivePromptTokens(
        stats.byModel['model-a'].cacheProvider,
        stats.byModel['model-a'],
      ),
    ).toBeUndefined();
    expect(stats.byModel['model-b']).toMatchObject({
      messages: 1,
      inputTokens: 20,
    });
    expect(stats.byModel['today-model']).toBeUndefined();
    expect(stats.unallocated?.date).toMatchObject({
      messages: 1,
      inputTokens: 7,
    });
    expect(stats.unallocated?.model).toMatchObject({
      messages: 1,
      inputTokens: 7,
    });
    const internalStats = await f.aggregator.readStats();
    expect(internalStats.byPrincipal?.[principal.id].usage).toMatchObject({
      messages: 2,
      inputTokens: 155,
    });
    expect(stats.unallocated?.principal.inputTokens).toBe(7);
    expect(stats.byProvider?.muse.inputTokens).toBe(155);
    expect(stats.byProvider?.muse.tokenReports).toMatchObject({
      input: 2,
      output: 2,
      cacheRead: 1,
      cacheWrite: 1,
    });
    expect(stats.unallocated?.provider.inputTokens).toBe(7);
    expect(stats.snapshot).toMatchObject({
      dayScope: 'recorded-observations-utc',
      missingEngineTurnCosts: 1,
    });
    const response = await f.app.request(
      '/usage?from=2026-08-02&to=2026-08-02',
    );
    const ranged = await readJson<{
      data: UsageStats & { rangeSummary: { totalMessages: number } };
    }>(response);
    expect(Object.keys(ranged.data.byDate)).toEqual(['2026-08-02']);
    expect(ranged.data.rangeSummary.totalMessages).toBe(1);
  } finally {
    f.store.close();
  }
});

test('cumulative restatements survive restarts and corrections without inventing model or date splits, while Claude cost segments remain distinct', async () => {
  const f = fixture();
  try {
    f.start('codex', 'codex');
    f.turn('codex', 'codex', 'one', day1, {
      promptTokens: 200,
      completionTokens: 20,
    });
    f.start('codex', 'codex', day2);
    f.turn('codex', 'codex', 'two', day2, {
      promptTokens: 250,
      completionTokens: 40,
    });
    let stats = await f.current();
    expect(stats.lifetime.totalInputTokens).toBe(250);
    expect(stats.byModel['model-a'].inputTokens).toBe(50);
    expect(stats.unallocated?.model.inputTokens).toBe(200);
    f.start('codex', 'codex', day2, 'model-b');
    f.turn('codex', 'codex', 'three', day2, { promptTokens: 300 });
    f.turn('codex', 'codex', 'corrected', day2, { promptTokens: 280 });
    f.start('claude', 'claude');
    f.turn('claude', 'claude', 'cost-one', day1, {
      promptTokens: 10,
      reportedCostUsd: 0.3,
    });
    f.turn('claude', 'claude', 'cost-two', day1, {
      promptTokens: 20,
      reportedCostUsd: 0.5,
    });
    f.start('claude', 'claude', day2, 'model-b');
    f.turn('claude', 'claude', 'cost-three', day2, {
      promptTokens: 30,
      reportedCostUsd: 0.2,
    });
    f.turn('claude', 'claude', 'cost-corrected', day2, {
      reportedCostUsd: 0.1,
    });
    await f.aggregator.fullRescan();
    stats = await f.current();
    expect(stats.lifetime).toMatchObject({
      totalInputTokens: 340,
      totalOutputTokens: 40,
    });
    expect(stats.lifetime.totalCost).toBeCloseTo(0.8);
    expect(stats.byModel['model-a'].inputTokens).toBe(30);
    expect(stats.byModel['model-b'].inputTokens).toBe(30);
    expect(stats.unallocated?.model.inputTokens).toBe(280);
    expect(stats.unallocated?.date).toMatchObject({
      inputTokens: 280,
      cost: 0,
    });
    expect(stats.byDate['2026-08-01'].cost).toBe(0.5);
    expect(stats.byDate['2026-08-02'].cost).toBeCloseTo(0.3);
  } finally {
    f.store.close();
  }
});

test('corrections, moved models and deleted transcripts remove stale current buckets while preserving old summary only as unverified evidence', async () => {
  const f = fixture();
  try {
    const path = await memory(f.home, 'saved', {
      timestamp: day1,
      model: 'old',
      usage: { inputTokens: 100, estimatedCost: 10 },
    });
    await mkdir(join(f.home, 'analytics'), { recursive: true });
    await writeFile(
      join(f.home, 'analytics', 'stats.json'),
      JSON.stringify({
        lifetime: {
          totalMessages: 999,
          totalConversations: 999,
          totalInputTokens: 999,
          totalOutputTokens: 999,
          totalCost: 999,
          uniqueAgents: ['ghost'],
        },
        byAgent: {},
        byModel: {
          ghost: {
            messages: 999,
            inputTokens: 999,
            outputTokens: 999,
            cost: 999,
          },
        },
        byDate: {},
      }),
    );
    await f.current();
    await memory(f.home, 'saved', {
      timestamp: day2,
      model: 'new',
      usage: { inputTokens: 5, estimatedCost: 0 },
    });
    for (let index = 0; index < 2; index++)
      await f.aggregator.applyEnrichmentUsage({}, 'station', 'saved');
    let stats = await f.current();
    expect(stats.lifetime).toMatchObject({
      totalMessages: 1,
      totalInputTokens: 5,
      totalCost: 0,
    });
    expect(Object.keys(stats.byModel)).toEqual(['new']);
    expect(Object.keys(stats.byDate)).toEqual(['2026-08-02']);
    expect(stats.legacySummary).toMatchObject({
      evidence: 'unverified',
      lifetime: { totalMessages: 999 },
    });
    await rm(path);
    await f.aggregator.fullRescan();
    stats = await f.current();
    expect(stats.lifetime.totalMessages).toBe(0);
    expect(stats.byModel).toEqual({});
    expect(stats.byDate).toEqual({});
    expect(stats.legacySummary?.lifetime.totalMessages).toBe(999);
  } finally {
    f.store.close();
  }
});

test('only canonical relay provenance selects a memory primary ledger; same-ID foreign engines remain counted and ambiguous relay activity is held separately', async () => {
  const f = fixture();
  try {
    for (const id of ['relay', 'foreign', 'ambiguous', 'missing'])
      await memory(f.home, id, {
        timestamp: day1,
        model: 'saved',
        usage: { inputTokens: 10, estimatedCost: 0 },
      });
    f.start('relay', 'station-agent', day1, 'saved', {
      agentId: 'station',
      agentSlug: 'station',
    });
    for (const id of ['one', 'two', 'three'])
      f.turn('relay', 'station-agent', id, day1);
    f.start('foreign', 'muse', day1, 'external', {
      conversationId: 'foreign',
      agentSlug: 'station',
    });
    f.turn('foreign', 'muse', 'foreign-turn', day1, { promptTokens: 20 });
    f.start('ambiguous', 'station-agent', day1, 'external', {
      agentId: 'station',
      agentSlug: 'station',
    });
    f.start('ambiguous', 'station-agent', day1, 'external', {
      agentId: 'different',
    });
    f.turn('ambiguous', 'station-agent', 'ambiguous-turn', day1);
    f.start('missing', 'station-agent', day1, 'external', {
      agentSlug: 'station',
    });
    f.turn('missing', 'station-agent', 'missing-turn', day1);
    const stats = await f.current();
    expect(stats.lifetime).toMatchObject({
      totalMessages: 5,
      totalInputTokens: 60,
      totalConversations: 5,
    });
    expect(stats.snapshot?.mirroredEngineActivity).toMatchObject({
      sessions: 1,
      completedTurns: 3,
      coverage: 'partial',
    });
    expect(stats.snapshot?.ambiguousRelayActivity).toMatchObject({
      sessions: 2,
      completedTurns: 2,
      coverage: 'unknown',
    });
    expect(stats.lifetime.engineUsageCoverage?.sessions).toBe(1);
    expect(stats.snapshot?.missingEngineTurnCosts).toBe(1);
  } finally {
    f.store.close();
  }
});

test.each([day1, undefined, null])(
  'file-memory enrichment preserves recorded or unknown dates and repeated notifications rebuild one corrected usage fact (%s)',
  async (timestamp) => {
    const f = fixture();
    const adapter = new FileMemoryAdapter({
      projectHomeDir: f.home,
      usageAggregator: f.aggregator,
    });
    try {
      await adapter.createConversation({
        id: 'one',
        resourceId: 'station',
        userId: 'reader',
        title: 'one',
        metadata: {},
      });
      await adapter.addMessage(
        {
          id: 'assistant',
          role: 'assistant',
          parts: [],
          metadata: { timestamp },
        },
        'reader',
        'one',
        { model: 'old', usage: { inputTokens: 100, estimatedCost: 10 } },
      );
      if (timestamp === undefined || timestamp === null) {
        await memory(f.home, 'one', {
          timestamp,
          model: 'old',
          usage: { inputTokens: 100, estimatedCost: 10 },
        });
      }
      await f.current();
      const stored = (await adapter.getMessages('reader', 'one'))[0];
      expect(stored).toBeDefined();
      await adapter.removeLastMessage('reader', 'one');
      await adapter.addMessage(stored, 'reader', 'one', {
        model: 'new',
        usage: { inputTokens: 5, estimatedCost: 0 },
        suppressUsageAggregation: true,
      });
      for (let index = 0; index < 2; index++)
        await adapter.applyEnrichmentUsage('reader', 'one', stored, 'old');
      const stats = await f.current();
      expect(stats.lifetime).toMatchObject({
        totalMessages: 1,
        totalInputTokens: 5,
        totalCost: 0,
      });
      expect(Object.keys(stats.byDate)).toEqual(
        timestamp === day1 ? ['2026-08-01'] : [],
      );
      if (timestamp !== day1)
        expect(stats.unallocated?.date).toMatchObject({
          messages: 1,
          inputTokens: 5,
        });
      expect(Object.keys(stats.byModel)).toEqual(['new']);
      const rows = await readFile(
        join(f.home, 'agents', 'station', 'memory', 'sessions', 'one.ndjson'),
        'utf8',
      );
      expect(JSON.parse(rows.trim()).metadata.timestamp).toBe(timestamp);
    } finally {
      f.store.close();
    }
  },
);

test.each([false, true])(
  'model cache inclusivity follows every contributing retained source (mixed memory: %s)',
  async (mixed) => {
    const f = fixture();
    try {
      f.start('cache', 'claude', day1, 'cache-model');
      f.turn('cache', 'claude', 'cache-turn', day1, {
        promptTokens: 135,
        completionTokens: 600,
        cacheReadTokens: 18400,
        cacheWriteTokens: 10100,
      });
      f.start('zero', 'claude', day1, 'zero-model');
      f.turn('zero', 'claude', 'zero-turn', day1, {
        promptTokens: 0,
        cacheReadTokens: 0,
      });
      f.start('absent', 'acp', day1, 'absent-model');
      f.turn('absent', 'acp', 'absent-turn', day1, {
        contextTokens: 500,
        contextWindowTokens: 1000,
      });
      if (mixed)
        await memory(f.home, 'legacy-cache', {
          timestamp: day1,
          model: 'cache-model',
          usage: { inputTokens: 10 },
        });
      const stats = await f.current();
      const model = stats.byModel['cache-model'];
      expect(model.cacheReadTokens).toBe(18400);
      expect(model.cacheProviderAttribution).toBe(
        mixed ? 'indeterminate' : 'single',
      );
      expect(cacheInclusivePromptTokens(model.cacheProvider, model)).toBe(
        mixed ? undefined : 28635,
      );
      expect(stats.byModel['zero-model']).toMatchObject({
        inputTokens: 0,
        cacheReadTokens: 0,
        tokenReports: { input: 1, cacheRead: 1 },
      });
      expect(stats.byModel['absent-model'].tokenReports).toBeUndefined();
      expect(stats.byProvider?.acp.tokenReports).toBeUndefined();
    } finally {
      f.store.close();
    }
  },
);

test.each([false, true])(
  'cost milestones require complete source coverage even when primary saved costs are zero (relay: %s)',
  async (relay) => {
    const f = fixture();
    try {
      const path = await memory(f.home, 'ledger', {
        timestamp: day1,
        usage: { inputTokens: 0, estimatedCost: 0 },
      });
      const row = await readFile(path, 'utf8');
      await writeFile(path, row.repeat(60));
      if (relay) {
        f.start('ledger', 'station-agent', day1, 'model-a', {
          agentId: 'station',
        });
        f.turn('ledger', 'station-agent', 'overlap', day1);
      }
      const response = await f.app.request('/achievements');
      expect(response.status).toBe(200);
      const body = await readJson<{
        data: Array<{
          id: string;
          unlocked: boolean;
          progress?: number;
          measurementUnavailableReason?: string;
        }>;
      }>(response);
      const milestone = body.data.find(
        (achievement) => achievement.id === 'cost-conscious',
      );
      expect(milestone).toBeDefined();
      expect(milestone?.unlocked).toBe(!relay);
      if (relay) {
        expect(milestone?.measurementUnavailableReason).toMatch(
          /complete cost coverage cannot be established/,
        );
        expect(milestone?.progress).toBeUndefined();
      }
    } finally {
      f.store.close();
    }
  },
);

test('multiple model calls in one turn retain each recorded model and an ambiguous steering principal remains unallocated', async () => {
  const f = fixture();
  try {
    f.start('calls', 'muse');
    const base = {
      provider: 'muse' as const,
      threadId: 'calls',
      createdAt: day1,
      turnId: 'turn',
    };
    f.store.appendEvent({
      ...base,
      eventId: 'start-call',
      method: 'turn.started',
      principal,
    });
    f.store.appendEvent({
      ...base,
      eventId: 'first-call',
      method: 'token-usage.updated',
      promptTokens: 10,
    });
    f.store.appendEvent({
      ...base,
      eventId: 'model-change',
      method: 'session.configured',
      sessionId: 'calls',
      model: 'model-b',
    });
    f.store.appendEvent({
      ...base,
      eventId: 'steer',
      method: 'turn.started',
      inputKind: 'steer',
      principal: humanPrincipal('fixture', 'other-reader', 'Other reader'),
    });
    f.store.appendEvent({
      ...base,
      eventId: 'second-call',
      method: 'token-usage.updated',
      promptTokens: 20,
    });
    f.store.appendEvent({
      ...base,
      eventId: 'finished-call',
      method: 'turn.completed',
      metadata: { reportedModel: 'model-b' },
    });
    const stats = await f.current();
    expect(stats.lifetime.totalInputTokens).toBe(30);
    expect(stats.byModel['model-a'].inputTokens).toBe(10);
    expect(stats.byModel['model-b'].inputTokens).toBe(20);
    expect((await f.aggregator.readStats()).byPrincipal).toBeUndefined();
    expect(stats.unallocated?.principal).toMatchObject({
      messages: 1,
      inputTokens: 30,
    });
  } finally {
    f.store.close();
  }
});

test('retained usage and terminal facts without session configuration remain visible with unknown model and agent', async () => {
  const f = fixture();
  try {
    f.store.upsertSession({
      threadId: 'unconfigured',
      provider: 'muse',
      status: 'ready',
      createdAt: day1,
      updatedAt: day1,
    });
    f.store.appendEvent({
      eventId: 'unconfigured-start',
      threadId: 'unconfigured',
      sessionId: 'unconfigured',
      provider: 'muse',
      createdAt: day1,
      method: 'session.started',
    });
    f.turn('unconfigured', 'muse', 'unconfigured-turn', day1, {
      promptTokens: 5,
    });
    const stats = await f.current();
    expect(stats.lifetime).toMatchObject({
      totalMessages: 1,
      totalInputTokens: 5,
      totalConversations: 1,
    });
    expect(stats.byDate['2026-08-01']).toMatchObject({
      messages: 1,
      inputTokens: 5,
    });
    expect(stats.byModel).toEqual({});
    expect(stats.byAgent['(unnamed)'].messages).toBe(1);
    expect(stats.unallocated?.model).toMatchObject({
      messages: 1,
      inputTokens: 5,
    });
  } finally {
    f.store.close();
  }
});

test('opaque model and agent keys remain data and arbitrary saved provider metadata cannot claim a harness', async () => {
  const f = fixture();
  const modelKey = '__proto__';
  const agentKey = 'constructor';
  const targets = [Object.prototype, Object];
  const before = targets.map((target) =>
    Object.getOwnPropertyDescriptors(target),
  );
  try {
    await memory(f.home, 'opaque-memory', {
      timestamp: day1,
      provider: '__proto__',
      model: '__proto__',
      usage: { inputTokens: 1, estimatedCost: 0 },
    });
    f.start('opaque-engine', 'muse', day1, '__proto__', {
      agentSlug: 'constructor',
    });
    f.turn('opaque-engine', 'muse', 'opaque-turn', day1, { promptTokens: 5 });
    const stats = await f.current();
    expect(stats.lifetime.totalInputTokens).toBe(6);
    expect(Object.hasOwn(stats.byModel, '__proto__')).toBe(true);
    expect(stats.byModel[modelKey]).toMatchObject({
      messages: 2,
      inputTokens: 6,
    });
    expect(Object.hasOwn(stats.byAgent, 'constructor')).toBe(true);
    expect(stats.byAgent[agentKey]).toMatchObject({
      messages: 1,
      conversations: 1,
    });
    expect(stats.byDate['2026-08-01'].byAgent[agentKey]).toBe(1);
    expect(stats.byProvider?.muse.inputTokens).toBe(5);
    expect(stats.unallocated?.provider.inputTokens).toBe(1);
  } finally {
    for (const [index, target] of targets.entries()) {
      const descriptors = before[index];
      for (const key of Reflect.ownKeys(target))
        if (!Object.hasOwn(descriptors, key))
          Reflect.deleteProperty(target, key);
      Object.defineProperties(target, descriptors);
    }
    f.store.close();
  }
});

test('canonical engine usage reaches the next-day Lite ping without cumulative, replay or cross-day double counting', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-08-01T12:00:00Z');
  const f = fixture();
  const orchestration = new OrchestrationService({
    eventStore: f.store,
    eventBus: new EventBus(),
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {} },
  });
  const bodies: unknown[] = [];
  const options = {
    homeDir: f.home,
    appConfig: {
      defaultModel: '',
      invokeModel: '',
      structureModel: '',
      productTelemetryEndpoint: 'https://receiver.test/lite',
    },
    version: '1.2.3',
    env: {},
    logger: { warn: () => {} },
    dailyUsage: (day: string) =>
      orchestration.listDailyUsage(day, INTERNAL_SESSION_READ_SCOPE),
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('{}');
    }) as typeof fetch,
  };
  let telemetry = new UsageTelemetryService(options);
  try {
    await telemetry.stationStarted();
    f.start('cumulative', 'codex');
    f.turn('cumulative', 'codex', 'baseline', day1, {
      promptTokens: 1_000_000,
      completionTokens: 100_000,
    });
    vi.setSystemTime('2026-08-02T12:00:00Z');
    await telemetry.track('engine_turn', {
      engine: 'codex',
      outcome: 'completed',
    });
    // Provider clock skew cannot pull a locally observed receipt into day 1.
    f.turn('cumulative', 'codex', 'next', day1, {
      promptTokens: 1_050_000,
      completionTokens: 110_000,
    });
    const replay = f.store
      .listEvents('cumulative')
      .find(
        (row) => row.method === 'token-usage.updated' && row.turnId === 'next',
      )!;
    expect(() => f.store.appendEvent(replay.payload)).toThrow(
      'UNIQUE constraint',
    );
    f.turn('cumulative', 'codex', 'restatement', day1, {
      promptTokens: 1_050_000,
      completionTokens: 110_000,
    });
    f.start('per-turn', 'claude');
    f.turn('per-turn', 'claude', 'first', day1, {
      promptTokens: 4_000,
      completionTokens: 3_000,
      cacheReadTokens: 10_000_000,
    });
    f.turn('per-turn', 'claude', 'second', day1, {
      promptTokens: 2_000,
      completionTokens: 1_000,
    });
    f.store.appendEvent({
      eventId: 'child-summary',
      provider: 'claude',
      threadId: 'per-turn',
      createdAt: day1,
      method: 'child-work.updated',
      delta: {
        kind: 'settle',
        producer: 'engine-subagent',
        reporterThreadId: 'per-turn',
        childId: 'child',
        status: 'completed',
        usage: { totalTokens: 10_000_000 },
      },
    });
    f.start('zero', 'ollama');
    f.turn('zero', 'ollama', 'zero-turn', day1, {
      promptTokens: 0,
      completionTokens: 0,
    });
    // Drive a real adapter turn from its reported finish chunk into durable accounting.
    const llm = new OllamaLLMProvider({ baseUrl: 'http://ollama.test' });
    vi.spyOn(llm, 'listModelCatalog').mockResolvedValue({
      source: 'live',
      models: [{ id: 'model-a', name: 'Model A' }],
    });
    vi.spyOn(llm, 'createStream').mockImplementation(async function* () {
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: 10_000,
          outputTokens: 1,
          raw: { prompt_tokens: 10_000, completion_tokens: 1 },
        },
      };
    });
    const adapter = new OllamaAdapter('http://ollama.test', { llm });
    const adapterEvents = adapter.streamEvents();
    const adapterSession = await adapter.startSession({
      provider: 'ollama',
      threadId: 'adapter-turn',
      modelId: 'model-a',
      metadata: { userId: 'reader' },
    });
    f.store.upsertSession(adapterSession);
    try {
      await adapter.sendTurn({
        threadId: adapterSession.threadId,
        input: 'Report throughput',
      });
    } finally {
      await adapter.stopAll();
    }
    for await (const event of adapterEvents) f.store.appendEvent(event);
    await telemetry.flushDaily();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      engine_tokens_today: [{ engine: 'codex', bucket: '1M-10M' }],
    });
    await telemetry.shutdown();
    telemetry = new UsageTelemetryService(options);
    await telemetry.stationStarted();
    vi.setSystemTime('2026-08-03T12:00:00Z');
    f.turn('cumulative', 'codex', 'today', day1, {
      promptTokens: 5_000_000,
      completionTokens: 1_000_000,
    });
    await telemetry.flushDaily();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      engine_tokens_today: [
        { engine: 'codex', bucket: '10k-100k' },
        { engine: 'claude', bucket: '10M+' },
        { engine: 'ollama', bucket: '10k-100k' },
      ],
    });
    await telemetry.flushDaily();
    expect(bodies).toHaveLength(2);
  } finally {
    await telemetry.shutdown();
    await orchestration.shutdown();
    f.store.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

test('daily Lite usage excludes followed Claude, Codex and OpenCode histories while retaining Station-run sessions', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-08-02T12:00:00Z');
  const f = fixture();
  const service = new OrchestrationService({
    eventStore: f.store,
    eventBus: new EventBus(),
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {} },
  });
  try {
    for (const provider of ['claude', 'codex', 'opencode'] as const) {
      const thread = `followed-${provider}`;
      f.start(thread, provider, day1);
      f.store.upsertSession({
        ...f.store.readSessionByThread(thread)!,
        controlMode: 'read-only-attached',
      });
      f.turn(thread, provider, 'imported-history', day1, {
        promptTokens: provider === 'codex' ? 42_000_000 : 500_000,
      });
    }
    f.start('station-run', 'claude', day1);
    f.turn('station-run', 'claude', 'owned-turn', day1, { promptTokens: 123 });
    const usage = service.listDailyUsage(
      '2026-08-02',
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(usage.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)).toBe(
      123,
    );
  } finally {
    await service.shutdown();
    f.store.close();
    vi.useRealTimers();
  }
});

test('a cumulative decrease leaves earlier dates unallocated and counts only later daily increases', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-08-02T12:00:00Z');
  const f = fixture();
  try {
    f.start('reset', 'codex');
    for (const [index, promptTokens] of [500_000, 20_000, 40_000].entries())
      f.turn('reset', 'codex', `reset-${index}`, day1, { promptTokens });
    expect(
      f.reads
        .listDailyUsage('2026-08-02', f.authority)
        .reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    ).toBe(20_000);
  } finally {
    f.store.close();
    vi.useRealTimers();
  }
});

test('daily cumulative throughput excludes outside jumps on each Station resume and reattach', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-08-01T12:00:00Z');
  const f = fixture();
  try {
    f.start('resumed-codex', 'codex');
    f.turn('resumed-codex', 'codex', 'station-day-one', day1, {
      promptTokens: 100_000,
    });
    vi.setSystemTime('2026-08-02T12:00:00Z');
    f.start('resumed-codex', 'codex', day2, 'model-a', {
      nativeResumeIdentity: 'matched',
    });
    f.turn('resumed-codex', 'codex', 'first-after-terminal', day2, {
      promptTokens: 5_150_000,
    });
    f.turn('resumed-codex', 'codex', 'station-day-two', day2, {
      promptTokens: 5_200_000,
    });
    f.start('resumed-codex', 'codex', day2);
    f.turn('resumed-codex', 'codex', 'first-after-reattach', day2, {
      promptTokens: 9_200_000,
      completionTokens: 40_000,
    });
    f.turn('resumed-codex', 'codex', 'station-after-reattach', day2, {
      promptTokens: 9_220_000,
      completionTokens: 45_000,
    });
    const inputFor = (day: string) =>
      f.reads
        .listDailyUsage(day, f.authority)
        .reduce((total, row) => total + (row.inputTokens ?? 0), 0);
    expect(inputFor('2026-08-01')).toBe(100_000);
    expect(inputFor('2026-08-02')).toBe(70_000);
    expect(
      f.reads
        .listDailyUsage('2026-08-02', f.authority)
        .reduce((total, row) => total + (row.outputTokens ?? 0), 0),
    ).toBe(5_000);
    // A non-daily caller still receives canonical lifetime accounting.
    expect(f.reads.listSessionUsage(f.authority)[0].usage.inputTokens).toBe(
      9_220_000,
    );
  } finally {
    f.store.close();
    vi.useRealTimers();
  }
});

test('first observed native resume baselines cumulative components while per-turn engines keep their first turn', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-08-02T12:00:00Z');
  const f = fixture();
  try {
    f.start('initial-resume', 'codex', day2, 'model-a', {
      nativeResumeIdentity: 'matched',
    });
    f.turn('initial-resume', 'codex', 'inherited', day2, {
      promptTokens: 42_000_000,
      cacheReadTokens: 20_000_000,
    });
    f.turn('initial-resume', 'codex', 'after-inherited', day2, {
      promptTokens: 42_050_000,
      cacheReadTokens: 20_020_000,
    });
    f.start('per-turn', 'claude', day2, 'model-a', {}, true);
    f.turn('per-turn', 'claude', 'claude-first', day2, { promptTokens: 1_000 });
    const daily = f.reads.listDailyUsage('2026-08-02', f.authority);
    expect(
      daily
        .filter((row) => row.provider === 'codex')
        .reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    ).toBe(50_000);
    expect(
      daily
        .filter((row) => row.provider === 'codex')
        .reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0),
    ).toBe(20_000);
    expect(
      daily
        .filter((row) => row.provider === 'claude')
        .reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    ).toBe(1_000);
  } finally {
    f.store.close();
    vi.useRealTimers();
  }
});

test.each([
  {
    name: 'native adoption with both adapter lifecycle events',
    started: {
      continuation: 'native-fork',
      continuationBoundaryTurnId: 'outside-turn',
      continuationBoundaryObservedEventId: 'outside-observation',
      usageAvailability: 'unavailable',
      usageUnavailableReason:
        'inherited-cumulative-counter-without-durable-baseline',
    },
    configured: {
      usageAvailability: 'unavailable',
      usageUnavailableReason:
        'inherited-cumulative-counter-without-durable-baseline',
    },
  },
  {
    name: 'source-affinity start without a fork marker',
    started: {
      usageAvailability: 'unavailable',
      usageUnavailableReason:
        'inherited-cumulative-counter-without-durable-baseline',
    },
    configured: {},
  },
  {
    name: 'source-affinity configuration without a start marker',
    started: {},
    configured: {
      usageAvailability: 'unavailable',
      usageUnavailableReason:
        'inherited-cumulative-counter-without-durable-baseline',
    },
  },
  {
    name: 'native fork without availability metadata',
    started: { continuation: 'native-fork' },
    configured: {},
  },
])(
  'daily Codex usage baselines inherited counters for $name',
  ({ started, configured }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(day2);
    const f = fixture();
    const threadId = 'adopted-codex';
    try {
      f.store.upsertSession({
        provider: 'codex',
        threadId,
        status: 'ready',
        controlMode: 'station-owned',
        model: 'model-a',
        createdAt: day2,
        updatedAt: day2,
      });
      f.store.appendEvent({
        ...f.event(threadId, 'codex', day2),
        eventId: 'adoption-start',
        method: 'session.started',
        sessionId: threadId,
        initialState: 'created',
        metadata: {
          userId: 'reader',
          codexThreadId: 'native-child',
          ...started,
        },
      });
      f.store.appendEvent({
        ...f.event(threadId, 'codex', day2),
        eventId: 'adoption-configured',
        method: 'session.configured',
        sessionId: threadId,
        model: 'model-a',
        metadata: { codexThreadId: 'native-child', ...configured },
      });
      const dailyInput = () =>
        f.reads
          .listDailyUsage('2026-08-02', f.authority)
          .reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
      f.turn(threadId, 'codex', 'first-station-report', day2, {
        promptTokens: 42_050_000,
      });
      expect(dailyInput()).toBe(0);
      f.turn(threadId, 'codex', 'later-station-report', day2, {
        promptTokens: 42_100_000,
      });
      expect(dailyInput()).toBe(50_000);
      expect(f.reads.listSessionUsage(f.authority)[0].usage.inputTokens).toBe(
        42_100_000,
      );
    } finally {
      f.store.close();
      vi.useRealTimers();
    }
  },
);
