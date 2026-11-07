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
import { EventStore } from '../event-store.js';
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
    const byTurn = new Map(receipts.map((receipt) => [receipt.turnId, receipt]));
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

  test('an engine-selected first plan names no model connection, even after a later Station-resolved one', () => {
    startLegacySession(store, 'engine-chose');
    for (const [index, plan] of [
      { kind: 'engine-selected', evidence: 'adapter-declared' },
      {
        kind: 'station-resolved',
        modelConnectionId: 'model-conn-later',
        modelId: 'model-b',
        evidence: 'catalog-accepted',
      },
    ].entries())
      store.appendEvent({
        eventId: `engine-chose-configured-${index}`,
        provider: 'bedrock',
        threadId: 'engine-chose',
        sessionId: 'engine-chose',
        createdAt: new Date().toISOString(),
        method: 'session.configured',
        model: 'model-b',
        metadata: { [MODEL_LAUNCH_PLAN_METADATA_KEY]: plan },
      });
    completeTurn(store, 'engine-chose', 'engine-chose-turn', 5);
    const day = new Date().toISOString().slice(0, 10);
    const [receipt] = usageReads(store).listUsageReceipts(
      sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
      'local',
      { from: day, to: day },
    ).receipts;
    expect(receipt?.turnId).toBe('engine-chose-turn');
    expect(receipt).not.toHaveProperty('modelConnectionId');
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
    const app = usageRoute(store, home);

    const all = await app.request(rollupPath({ provider: 'bedrock' }));
    expect(all.status).toBe(200);
    expect(
      (await readJson<{ data: UsageRollup }>(all)).data.rows,
    ).toEqual([
      expect.objectContaining({ provider: 'bedrock', inputTokens: 140 }),
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
    expect(
      (await readJson<{ data: UsageRollup }>(byModel)).data.rows,
    ).toEqual([expect.objectContaining({ inputTokens: 30 })]);

    const grouped = await app.request(rollupPath({ groupBy: 'connection' }));
    expect(grouped.status).toBe(200);
    const rows = (await readJson<{ data: UsageRollup }>(grouped)).data.rows;
    expect(
      Object.fromEntries(rows.map((row) => [row.key, row.inputTokens])),
    ).toEqual({
      'connection:bedrock-work': 10,
      'connection:bedrock-home': 30,
      'connection:unattributed': 100,
    });
    expect(
      rows.find((row) => row.key === 'connection:bedrock-work')?.connectionId,
    ).toBe('bedrock-work');

    for (const query of [
      { provider: 'Not An Engine' },
      { provider: 'bedrock;drop' },
      { connectionId: 'Bad Id' },
      { modelConnectionId: 'has space' },
      { groupBy: 'account' },
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
    for (const filter of [
      { provider: 'opencode' },
      { provider: 'station-agent' },
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
});
