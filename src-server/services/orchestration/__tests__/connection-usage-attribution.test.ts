import { join } from 'node:path';
import {
  MODEL_LAUNCH_PLAN_METADATA_KEY,
  MODEL_SELECTION_RECEIPT_METADATA_KEY,
} from '@kontourai/station-contracts/provider';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { parseUsageExportPage } from '@kontourai/station-contracts/usage-export';
import type { UsageRollup } from '@kontourai/station-contracts/usage-rollup';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { UsageAggregator } from '../../../analytics/usage-aggregator.js';
import { readAuthorizedUsageExport } from '../../../analytics/usage-export-reader.js';
import { createAnalyticsRoutes } from '../../../routes/operations/analytics.js';
import { EventStore, usageReceiptEventsSql } from '../event-store.js';
import { SessionTranscriptReads } from '../session-transcript-reads.js';

const makeTempDir = trackTempDirs();
const OWNER = 'reader';

function usageReads(store: EventStore): SessionTranscriptReads {
  return new SessionTranscriptReads({
    canReadSession: () => true,
    isEphemeralSession: () => false,
    sessionAttributionFor: () => null,
    listEventPayloads: () => [],
    listResolvedEventPayloads: () => [],
    readUsageRevision: () => 'fixture',
    listUsageEventPayloads: () => [],
    listUsageReceiptEvents: (options) => store.listUsageReceiptEvents(options),
    listUsageCoverageEvents: (options) =>
      store.listUsageCoverageEvents(options),
    searchConversationMessages: () => [],
    readSessionThreadIds: () => [],
    requireTenantExecutionContext: () => false,
    reportDroppedUsageFigure: () => {},
  });
}

function usageRoute(store: EventStore, home: string) {
  const reads = usageReads(store);
  const aggregator = new UsageAggregator(home, {
    get: () => ({
      listSessionUsage: () => [],
      listUsageReceipts: (authority, stationId, request) =>
        reads.listUsageReceipts(authority, stationId, request),
    }),
  });
  return createAnalyticsRoutes(aggregator, undefined, () =>
    sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
  );
}

function rollupPath(extra: Record<string, string> = {}): string {
  return `/usage-rollup?${new URLSearchParams({
    from: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
    localOnly: '1',
    groupBy: 'provider',
    pageSize: '100',
    ...extra,
  })}`;
}

/**
 * The events a Station-resolved Bedrock start persists: `session.started`
 * carries the start input metadata (its pending plan and the engine
 * connection), and `session.configured` restates it with the plan the
 * adapter accepted (bedrock-adapter.ts `startSession`).
 */
function startAttributedSession(
  store: EventStore,
  threadId: string,
  attribution: { connectionId: string; modelConnectionId: string },
) {
  const createdAt = new Date().toISOString();
  const inputMetadata = {
    userId: OWNER,
    connectionId: attribution.connectionId,
    [MODEL_LAUNCH_PLAN_METADATA_KEY]: {
      kind: 'station-resolved',
      modelConnectionId: attribution.modelConnectionId,
      modelId: 'model-a',
      evidence: 'catalog-pending',
    },
  };
  store.appendEvent({
    eventId: `${threadId}-started`,
    provider: 'bedrock',
    threadId,
    sessionId: threadId,
    createdAt,
    method: 'session.started',
    initialState: 'created',
    metadata: { ...inputMetadata, cwd: '/work' },
  });
  store.appendEvent({
    eventId: `${threadId}-configured`,
    provider: 'bedrock',
    threadId,
    sessionId: threadId,
    createdAt,
    method: 'session.configured',
    model: 'model-a',
    cwd: '/work',
    metadata: {
      ...inputMetadata,
      [MODEL_LAUNCH_PLAN_METADATA_KEY]: {
        kind: 'station-resolved',
        modelConnectionId: attribution.modelConnectionId,
        modelId: 'model-a',
        evidence: 'catalog-accepted',
      },
      [MODEL_SELECTION_RECEIPT_METADATA_KEY]: {
        requested: 'model-a',
        applied: 'model-a',
      },
    },
  });
}

/** A pre-attribution session: no connection and no launch plan recorded. */
function startLegacySession(
  store: EventStore,
  threadId: string,
  provider = 'bedrock',
) {
  store.appendEvent({
    eventId: `${threadId}-started`,
    provider,
    threadId,
    sessionId: threadId,
    createdAt: new Date().toISOString(),
    method: 'session.started',
    initialState: 'created',
    metadata: { userId: OWNER },
  });
}

function completeTurn(
  store: EventStore,
  threadId: string,
  turnId: string,
  promptTokens: number,
  provider = 'bedrock',
) {
  store.appendEvent({
    eventId: `${turnId}-usage`,
    provider,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
    method: 'token-usage.updated',
    promptTokens,
    completionTokens: 1,
  });
  store.appendEvent({
    eventId: `${turnId}-completed`,
    provider,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
    method: 'turn.completed',
    finishReason: 'stop',
  });
}

describe('usage attribution to connections', () => {
  let home: string;
  let store: EventStore;
  beforeEach(() => {
    home = makeTempDir('usage-connection-');
    store = new EventStore(join(home, 'events.sqlite'));
  });
  afterEach(() => store.close());
  const readReceipts = () => {
    const day = new Date().toISOString().slice(0, 10);
    return usageReads(store).listUsageReceipts(
      sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
      'local',
      { from: day, to: day },
    ).receipts;
  };

  test('receipts carry the recorded engine and model connection; legacy sessions stay unattributed', () => {
    startAttributedSession(store, 'attributed', {
      connectionId: 'bedrock-work',
      modelConnectionId: 'model-conn-1',
    });
    completeTurn(store, 'attributed', 'attributed-turn', 10);
    startLegacySession(store, 'legacy');
    completeTurn(store, 'legacy', 'legacy-turn', 20);
    const day = new Date().toISOString().slice(0, 10);
    const { receipts } = usageReads(store).listUsageReceipts(
      sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
      'local',
      { from: day, to: day },
    );
    const byTurn = new Map(
      receipts.map((receipt) => [receipt.turnId, receipt]),
    );
    expect(byTurn.get('attributed-turn')).toMatchObject({
      provider: 'bedrock',
      connectionId: 'bedrock-work',
      modelConnectionId: 'model-conn-1',
    });
    const legacy = byTurn.get('legacy-turn');
    expect(legacy).toBeDefined();
    expect(legacy).not.toHaveProperty('connectionId');
    expect(legacy).not.toHaveProperty('modelConnectionId');
  });

  test('the launch plan in effect at each usage event names its model connection', () => {
    startAttributedSession(store, 'switching', {
      connectionId: 'bedrock-work',
      modelConnectionId: 'model-conn-a',
    });
    completeTurn(store, 'switching', 'turn-a', 1);
    // A mid-thread model change: the adapter records a new accepted plan
    // (bedrock-adapter.ts, model application), then a declared engine choice.
    for (const [index, plan] of [
      {
        kind: 'station-resolved',
        modelConnectionId: 'model-conn-b',
        modelId: 'model-b',
        evidence: 'catalog-accepted',
      },
      // A plan the adapter has not accepted does not take effect.
      {
        kind: 'station-resolved',
        modelConnectionId: 'model-conn-pending',
        modelId: 'model-c',
        evidence: 'catalog-pending',
      },
      { kind: 'engine-selected', evidence: 'adapter-declared' },
    ].entries()) {
      store.appendEvent({
        eventId: `switching-configured-${index}`,
        provider: 'bedrock',
        threadId: 'switching',
        sessionId: 'switching',
        createdAt: new Date().toISOString(),
        method: 'session.configured',
        model: 'model-b',
        metadata: { [MODEL_LAUNCH_PLAN_METADATA_KEY]: plan },
      });
      completeTurn(store, 'switching', `turn-plan-${index}`, 1);
    }
    const plans = Object.fromEntries(
      readReceipts().map((receipt) => [
        receipt.turnId,
        receipt.modelConnectionId ?? null,
      ]),
    );
    expect(plans).toEqual({
      'turn-a': 'model-conn-a',
      'turn-plan-0': 'model-conn-b',
      'turn-plan-1': 'model-conn-b',
      'turn-plan-2': null,
    });
  });

  test('attribution belongs to the process epoch: a restart that records none or another connection replaces it', () => {
    startAttributedSession(store, 'restarted', {
      connectionId: 'bedrock-work',
      modelConnectionId: 'model-conn-1',
    });
    completeTurn(store, 'restarted', 'first-epoch', 1);
    // A restart whose start recorded no connection and no plan.
    store.appendEvent({
      eventId: 'restarted-started-2',
      provider: 'bedrock',
      threadId: 'restarted',
      sessionId: 'restarted',
      createdAt: new Date().toISOString(),
      method: 'session.started',
      initialState: 'created',
      metadata: { userId: OWNER, cwd: '/work' },
    });
    completeTurn(store, 'restarted', 'bare-epoch', 1);
    // A restart on another connection, without a reconfiguration.
    store.appendEvent({
      eventId: 'restarted-started-3',
      provider: 'bedrock',
      threadId: 'restarted',
      sessionId: 'restarted',
      createdAt: new Date().toISOString(),
      method: 'session.started',
      initialState: 'created',
      metadata: { userId: OWNER, cwd: '/work', connectionId: 'bedrock-home' },
    });
    completeTurn(store, 'restarted', 'home-epoch', 1);
    const byTurn = new Map(
      readReceipts().map((receipt) => [receipt.turnId, receipt]),
    );
    expect(byTurn.get('first-epoch')).toMatchObject({
      connectionId: 'bedrock-work',
      modelConnectionId: 'model-conn-1',
    });
    expect(byTurn.get('bare-epoch')).toBeDefined();
    expect(byTurn.get('bare-epoch')).not.toHaveProperty('connectionId');
    expect(byTurn.get('bare-epoch')).not.toHaveProperty('modelConnectionId');
    expect(byTurn.get('home-epoch')?.connectionId).toBe('bedrock-home');
    expect(byTurn.get('home-epoch')).not.toHaveProperty('modelConnectionId');
  });

  test('a connection filter selects its threads by index, never projecting other threads', () => {
    const db = (
      store as unknown as {
        db: { prepare(sql: string): { all(...values: unknown[]): unknown[] } };
      }
    ).db;
    const plan = (filter: Parameters<typeof usageReceiptEventsSql>[1]) =>
      (
        db
          .prepare(`EXPLAIN QUERY PLAN ${usageReceiptEventsSql(1, filter)}`)
          .all() as { detail: string }[]
      ).map((row) => row.detail);
    for (const filter of [
      { connectionId: 'bedrock-work' },
      { modelConnectionId: 'model-conn-1' },
    ]) {
      const steps = plan(filter);
      // Candidate threads come from an indexed lookup of configuration rows.
      expect(steps, JSON.stringify(filter)).toContain(
        'SEARCH candidate USING INDEX idx_events_method (method=?)',
      );
      // Every attribution lookup is an equality on (thread, method), not a
      // walk of the thread's history through its sequence index.
      const lookups = steps.filter((step) =>
        /^SEARCH (attribution|started) /.test(step),
      );
      expect(lookups.length, JSON.stringify(filter)).toBeGreaterThanOrEqual(3);
      for (const step of lookups)
        expect(step).toMatch(
          /USING INDEX idx_events_history_projection \(thread_id=\? AND method=\? AND sequence/,
        );
    }
  });

  test('the export wire stays the closed schema-1 shape for attributed sessions', () => {
    startAttributedSession(store, 'exported', {
      connectionId: 'bedrock-work',
      modelConnectionId: 'model-conn-1',
    });
    completeTurn(store, 'exported', 'exported-turn', 10);
    const day = new Date().toISOString().slice(0, 10);
    const request = {
      from: day,
      to: day,
      scope: 'individual' as const,
      pageSize: 100,
    };
    const { page } = readAuthorizedUsageExport({
      store,
      authority: sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
      stationId: 'local',
      request,
      personalOwnerIds: () => undefined,
    });
    // The receiver decodes the serialized page with the shared strict decoder.
    const parsed = parseUsageExportPage(JSON.parse(JSON.stringify(page)), {
      ...request,
      expectedStationId: 'local',
    });
    expect(
      parsed.observations.flatMap((observation) => observation.receipts),
    ).toHaveLength(1);
  });

  test('the route filters by connection, accepts any engine id, and refuses malformed filters', async () => {
    startAttributedSession(store, 'work', {
      connectionId: 'bedrock-work',
      modelConnectionId: 'model-conn-1',
    });
    completeTurn(store, 'work', 'work-turn', 10);
    startAttributedSession(store, 'home', {
      connectionId: 'bedrock-home',
      modelConnectionId: 'model-conn-2',
    });
    completeTurn(store, 'home', 'home-turn', 30);
    startLegacySession(store, 'legacy');
    completeTurn(store, 'legacy', 'legacy-turn', 100);
    // A real connection may be called `unattributed`.
    startAttributedSession(store, 'literal', {
      connectionId: 'unattributed',
      modelConnectionId: 'model-conn-3',
    });
    completeTurn(store, 'literal', 'literal-turn', 1000);
    const app = usageRoute(store, home);

    const all = await app.request(rollupPath({ provider: 'bedrock' }));
    expect(all.status).toBe(200);
    expect((await readJson<{ data: UsageRollup }>(all)).data.rows).toEqual([
      expect.objectContaining({ provider: 'bedrock', inputTokens: 1140 }),
    ]);

    const work = await app.request(
      rollupPath({ connectionId: 'bedrock-work' }),
    );
    expect(work.status).toBe(200);
    const workBody = await readJson<{ data: UsageRollup }>(work);
    expect(workBody.data.rows).toEqual([
      expect.objectContaining({ provider: 'bedrock', inputTokens: 10 }),
    ]);
    expect(workBody.data.receipts.map((receipt) => receipt.turnId)).toEqual([
      'work-turn',
    ]);
    // Capture counts are per engine, so a connection total is never complete.
    expect(workBody.data.coverage[0]).toMatchObject({ state: 'partial' });
    expect(workBody.data.coverage[0].reason).toContain(
      'without recorded connection attribution',
    );

    const byModel = await app.request(
      rollupPath({ modelConnectionId: 'model-conn-2' }),
    );
    expect((await readJson<{ data: UsageRollup }>(byModel)).data.rows).toEqual([
      expect.objectContaining({ inputTokens: 30 }),
    ]);

    const grouped = await app.request(rollupPath({ groupBy: 'connection' }));
    expect(grouped.status).toBe(200);
    const rows = (await readJson<{ data: UsageRollup }>(grouped)).data.rows;
    expect(
      Object.fromEntries(rows.map((row) => [row.key, row.inputTokens])),
    ).toEqual({
      'connection:"bedrock-work"': 10,
      'connection:"bedrock-home"': 30,
      'connection:"unattributed"': 1000,
      'connection:null': 100,
    });
    expect(
      rows.find((row) => row.key === 'connection:"unattributed"')?.connectionId,
    ).toBe('unattributed');
    expect(
      rows.find((row) => row.key === 'connection:null'),
    ).not.toHaveProperty('connectionId');

    for (const query of <Record<string, string>[]>[
      { provider: 'Not An Engine' },
      { provider: 'bedrock;drop' },
      // A typo, a connection id, or an engine that reports no usage.
      { provider: 'claud' },
      { provider: 'bedrock-work' },
      { provider: 'station-agent' },
      { connectionId: 'Bad Id' },
      { modelConnectionId: 'has space' },
      { groupBy: 'account' },
      // Connection ids are this Station's; they never combine with peers.
      { connectionId: 'bedrock-work', localOnly: '0' },
      { modelConnectionId: 'model-conn-1', localOnly: '0' },
      { groupBy: 'connection', localOnly: '0' },
    ]) {
      const refused = await app.request(rollupPath(query));
      expect(refused.status, JSON.stringify(query)).toBe(400);
    }
    // Account usage still needs its engine filter.
    expect(
      (await app.request(rollupPath({ credentialProfileRef: 'work' }))).status,
    ).toBe(400);
  });

  test('an engine or connection with no receipts answers an empty rollup with unknown coverage', async () => {
    startLegacySession(store, 'claude-thread', 'claude');
    completeTurn(store, 'claude-thread', 'claude-turn', 10, 'claude');
    const app = usageRoute(store, home);
    // Without a filter the Station's own coverage is complete.
    const unfiltered = await readJson<{ data: UsageRollup }>(
      await app.request(rollupPath()),
    );
    expect(unfiltered.data.coverage[0].state).toBe('complete');
    for (const filter of <Record<string, string>[]>[
      { provider: 'opencode' },
      { provider: 'acp' },
      { connectionId: 'never-used' },
    ]) {
      const response = await app.request(rollupPath(filter));
      expect(response.status, JSON.stringify(filter)).toBe(200);
      const body = await readJson<{ data: UsageRollup }>(response);
      expect(body.data.rows).toEqual([]);
      expect(body.data.receipts).toEqual([]);
      expect(body.data.coverage[0]).toMatchObject({
        state: 'unknown',
        reason: 'no usage observations match this filter in this window',
      });
    }
  });

  test('ACP coverage says it reports context occupancy, not totals', async () => {
    store.appendEvent({
      eventId: 'acp-started',
      provider: 'acp',
      threadId: 'acp-thread',
      sessionId: 'acp-thread',
      createdAt: new Date().toISOString(),
      method: 'session.started',
      initialState: 'created',
      metadata: { userId: OWNER, cwd: '/work', connectionId: 'kiro' },
    });
    store.appendEvent({
      eventId: 'acp-context',
      provider: 'acp',
      threadId: 'acp-thread',
      turnId: 'acp-turn',
      createdAt: new Date().toISOString(),
      method: 'token-usage.updated',
      contextTokens: 400,
      contextWindowTokens: 1000,
    });
    store.appendEvent({
      eventId: 'acp-completed',
      provider: 'acp',
      threadId: 'acp-thread',
      turnId: 'acp-turn',
      createdAt: new Date().toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    const response = await usageRoute(store, home).request(
      rollupPath({ connectionId: 'kiro' }),
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ data: UsageRollup }>(response);
    // Context occupancy is not a receipt, so nothing is attributed.
    expect(body.data.rows).toEqual([]);
    expect(body.data.coverage[0].state).toBe('unknown');
    expect(body.data.coverage[0].providers).toEqual([
      expect.objectContaining({
        provider: 'acp',
        state: 'partial',
        reason:
          'engine reports context occupancy only, not token or cost totals',
      }),
    ]);
  });
  test('a busy engine or connection cannot crowd a quiet one out of the bounded window', async () => {
    startAttributedSession(store, 'busy', {
      connectionId: 'bedrock-busy',
      modelConnectionId: 'model-conn-busy',
    });
    for (let index = 0; index < 501; index += 1)
      store.appendEvent({
        eventId: `busy-usage-${index}`,
        provider: 'bedrock',
        threadId: 'busy',
        turnId: 'busy-turn',
        createdAt: new Date().toISOString(),
        method: 'token-usage.updated',
        promptTokens: 1,
        completionTokens: 0,
      });
    // Observed after the busy window filled the 500-observation bound.
    startAttributedSession(store, 'quiet', {
      connectionId: 'bedrock-quiet',
      modelConnectionId: 'model-conn-quiet',
    });
    completeTurn(store, 'quiet', 'quiet-turn', 7);
    startLegacySession(store, 'quiet-claude', 'claude');
    completeTurn(store, 'quiet-claude', 'quiet-claude-turn', 9, 'claude');
    const app = usageRoute(store, home);
    for (const [filter, inputTokens] of [
      [{ connectionId: 'bedrock-quiet' }, 7],
      [{ modelConnectionId: 'model-conn-quiet' }, 7],
      [{ provider: 'claude' }, 9],
    ] as const) {
      const response = await app.request(rollupPath(filter));
      expect(response.status, JSON.stringify(filter)).toBe(200);
      const body = await readJson<{ data: UsageRollup }>(response);
      expect(body.data.rows, JSON.stringify(filter)).toEqual([
        expect.objectContaining({ inputTokens }),
      ]);
      expect(body.data.coverage[0].state, JSON.stringify(filter)).not.toBe(
        'unknown',
      );
    }
  });

  test('peer transfer keeps its receipt shape without connection attribution', async () => {
    startAttributedSession(store, 'transfer', {
      connectionId: 'bedrock-work',
      modelConnectionId: 'model-conn-1',
    });
    completeTurn(store, 'transfer', 'transfer-turn', 10);
    const app = usageRoute(store, home);
    const local = await readJson<{ data: UsageRollup }>(
      await app.request(rollupPath()),
    );
    expect(local.data.receipts[0]).toMatchObject({
      connectionId: 'bedrock-work',
    });
    const transfer = await readJson<{ data: UsageRollup }>(
      await app.request(rollupPath({ includeAggregate: '1' })),
    );
    expect(transfer.data.aggregateReceipts).toHaveLength(1);
    for (const receipt of [
      ...transfer.data.receipts,
      ...(transfer.data.aggregateReceipts ?? []),
    ]) {
      expect(receipt).not.toHaveProperty('connectionId');
      expect(receipt).not.toHaveProperty('modelConnectionId');
    }
  });
});
