import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchMessagePageOutcome,
} from '@kontourai/station-contracts/unified-search';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { createSearchRoutes } from '../../../routes/search.js';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import { waitForReceipt } from '../../infra/receipt-bus.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import { TaskGraphService } from '../../projects/task-graph-service.js';
import { createRuntimeSearch } from '../runtime-search.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(hosted = false) {
  const home = mkdtempSync(join(tmpdir(), 'station-search-routes-'));
  const store = new EventStore(join(home, 'events.sqlite'));
  const graph = new TaskGraphService(home, {
    resolveProjectWorkspace: async () => '',
  });
  const orchestration = new OrchestrationService({
    requireTenantExecutionContext: () => hosted,
    validateRecoveredTenantExecutionContext: (context) =>
      context && ['alpha', 'beta'].includes(context.tenantId)
        ? context
        : undefined,
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    eventBus: new EventBus(),
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {} },
  });
  if (hosted) {
    message('allowed', 'alpha', 'alpha');
    message('hidden', 'alpha', 'beta');
  }
  const settled = waitForReceipt(
    (receipt) => receipt.kind === 'session.attachment.settled',
  );
  orchestration.initialize();
  await settled;
  const createTasks = vi.spyOn(graph, 'createPersonalSearchReader');
  const createTranscripts = vi.spyOn(
    orchestration,
    'createIsolatedTranscriptSearch',
  );
  const search = createRuntimeSearch({
    stationId: 'environment-a',
    tasks: graph,
    transcripts: orchestration,
  });
  const tasks = createTasks.mock.results[0].value;
  let authority = sessionReadAuthorityFromRequest('user', undefined, undefined);
  let current = true;
  const app = new Hono().route(
    '/api/search',
    createSearchRoutes(search, {
      readAuthorityForRequest: () => authority,
      isRequestPrincipalCurrent: () => current,
    }),
  );
  cleanup.push(async () => {
    await search.close();
    await orchestration.shutdown();
    await expect.poll(() => store.close().kind).toBe('closed');
    rmSync(home, { recursive: true, force: true });
  });
  const request = (body: unknown, path = '') =>
    app.request(`/api/search${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  function message(threadId: string, projectSlug: string, tenant?: string) {
    if (tenant)
      store.upsertSession({
        controlMode: 'read-only-attached',
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: '2026-09-03T00:00:00Z',
        updatedAt: '2026-09-03T00:00:00Z',
        tenantExecutionContext: {
          tenantId: tenantId(tenant),
          source: 'session',
        },
      });
    store.appendEvent({
      eventId: `${threadId}:start`,
      provider: 'claude',
      threadId,
      sessionId: threadId,
      createdAt: '2026-09-03T00:00:00Z',
      method: 'session.started',
      metadata: { userId: 'user', projectSlug },
    });
    store.appendEvent({
      eventId: `${threadId}:exact`,
      provider: 'claude',
      threadId,
      turnId: `${threadId}:turn`,
      createdAt: '2026-09-03T00:00:01Z',
      method: 'turn.started',
      prompt: 'cobalt evidence',
    });
  }
  return {
    databasePath: join(home, 'events.sqlite'),
    orchestration,
    graph,
    store,
    search,
    tasks,
    createTasks,
    createTranscripts,
    request,
    message,
    setCurrent(value: boolean) {
      current = value;
    },
    hosted(tenant: string) {
      authority = sessionReadAuthorityFromRequest(
        'user',
        { tenantId: tenantId(tenant) },
        parseHostedTenantRegistry({
          schemaVersion: 1,
          tenants: [{ id: tenantId(tenant), authority: `${tenant}.test` }],
        }),
      );
    },
  };
}
const query = { version: UNIFIED_SEARCH_V1, query: 'cobalt' };
const pageReply = async (response: Response) =>
  (await readJson<{ data: UnifiedSearchMessagePageOutcome }>(response)).data;
describe('runtime search HTTP composition', () => {
  test('reads canonical exact message pages, never index text, and fences content changes', async () => {
    const f = await fixture();
    f.store.upsertSession({
      provider: 'claude',
      threadId: 'historical-a',
      status: 'ready',
      controlMode: 'read-only-attached',
      createdAt: '2026-09-03T00:00:00Z',
      updatedAt: '2026-09-03T00:00:00Z',
    });
    f.message('historical-a', 'alpha');
    f.store.reserveNextConversationSession({
      conversationId: 'historical-a',
      predecessorSessionId: 'historical-a',
      proposedSessionId: 'current-b',
      createdAt: '2026-09-04T00:00:00Z',
    });
    f.store.upsertSession({
      provider: 'claude',
      threadId: 'current-b',
      status: 'ready',
      controlMode: 'read-only-attached',
      createdAt: '2026-09-04T00:00:00Z',
      updatedAt: '2026-09-04T00:00:00Z',
    });
    f.message('current-b', 'alpha');
    expect(f.store.conversationSessions('historical-a').at(-1)?.sessionId).toBe(
      'current-b',
    );
    for (let index = 0; index < 30; index++)
      f.store.appendEvent({
        eventId: `later-${index}`,
        provider: 'claude',
        threadId: 'historical-a',
        turnId: `later-turn-${index}`,
        createdAt: new Date(Date.UTC(2026, 8, 4, 0, index)).toISOString(),
        method: 'turn.started',
        prompt: `Later message ${index}`,
      });
    expect(
      f.store
        .listEventWindowByTurn('historical-a', { turnLimit: 10 })
        .events.some((event) => event.payload.eventId === 'historical-a:exact'),
    ).toBe(false);
    const db = new DatabaseSync(f.databasePath);
    try {
      const text = `canonical A ${'cobalt '.repeat(1500)}`;
      db.prepare(
        "UPDATE orchestration_events SET payload = json_set(payload, '$.prompt', ?) WHERE id = ?",
      ).run(text, 'historical-a:exact');
      db.prepare(
        'UPDATE orchestration_message_search_v3 SET content = ? WHERE event_id = ?',
      ).run('POISONED INDEX TEXT', 'historical-a:exact');
      const locator = {
        sessionId: 'historical-a',
        matchedEventId: 'historical-a:exact',
      };
      const response = await f.request(locator, '/read-message');
      expect(response.status).toBe(200);
      const first = await pageReply(response);
      expect(first.state).toBe('available');
      if (first.state !== 'available')
        throw new Error('Expected an available message');
      expect(first.page.text).toBe(text.slice(0, 4096));
      expect(first.page.sessionId).toBe('historical-a');
      expect(first.page.matchedEventId).toBe('historical-a:exact');
      expect(first.page.assignedAgentId).toBeUndefined();
      expect(first.page.nextContinuation).toBeTypeOf('string');
      const next = await f.request(
        { ...locator, continuation: first.page.nextContinuation },
        '/read-message',
      );
      expect(await pageReply(next)).toMatchObject({
        page: { text: text.slice(4096, 8192) },
      });
      const foreign = await f.request(
        {
          sessionId: 'current-b',
          matchedEventId: 'current-b:exact',
          continuation: first.page.nextContinuation,
        },
        '/read-message',
      );
      expect((await pageReply(foreign)).state).toBe('unavailable');
      db.prepare(
        "UPDATE orchestration_events SET payload = json_set(payload, '$.prompt', ?) WHERE id = ?",
      ).run('changed canonical content', 'historical-a:exact');
      const changed = await f.request(
        { ...locator, continuation: first.page.nextContinuation },
        '/read-message',
      );
      expect((await pageReply(changed)).state).toBe('unavailable');
      f.setCurrent(false);
      expect((await f.request(locator, '/read-message')).status).toBe(503);
    } finally {
      db.close();
    }
  });

  test('exact message pages preserve tenant denial and bounded canonical reads', async () => {
    const f = await fixture(true);
    f.hosted('alpha');
    const request = (sessionId: string) =>
      f.request(
        { sessionId, matchedEventId: `${sessionId}:exact` },
        '/read-message',
      );
    expect(await pageReply(await request('hidden'))).toEqual({
      state: 'not-found',
    });
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare(
        "UPDATE orchestration_events SET payload = json_set(payload, '$.prompt', ?) WHERE id = ?",
      ).run('x'.repeat(131073), 'allowed:exact');
      expect(await pageReply(await request('allowed'))).toEqual({
        state: 'unavailable',
      });
      db.prepare('DELETE FROM orchestration_events WHERE id = ?').run(
        'allowed:exact',
      );
      expect(await pageReply(await request('allowed'))).toEqual({
        state: 'not-found',
      });
    } finally {
      db.close();
    }
  });

  test('exact message pages project only genuine assigned Agent identity and canonical assistant output', async () => {
    const f = await fixture();
    f.message('owned', 'alpha');
    f.store.appendEvent({
      eventId: 'owned:output',
      provider: 'claude',
      threadId: 'owned',
      turnId: 'owned:turn',
      createdAt: '2026-09-03T00:00:02Z',
      method: 'turn.completed',
      outputText: 'Canonical assistant output',
    });
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare(
        'UPDATE orchestration_conversation_history SET agent_slug = ? WHERE thread_id = ?',
      ).run('default', 'owned');
      const response = await f.request(
        { sessionId: 'owned', matchedEventId: 'owned:output' },
        '/read-message',
      );
      expect(await pageReply(response)).toMatchObject({
        state: 'available',
        page: {
          role: 'assistant',
          text: 'Canonical assistant output',
          assignedAgentId: 'station',
        },
      });
      db.prepare(
        'UPDATE orchestration_conversation_history SET agent_slug = NULL WHERE thread_id = ?',
      ).run('owned');
      const absent = await f.request(
        { sessionId: 'owned', matchedEventId: 'owned:output' },
        '/read-message',
      );
      const unassigned = await pageReply(absent);
      expect(unassigned.state).toBe('available');
      if (unassigned.state !== 'available')
        throw new Error('Expected an available message');
      expect(unassigned.page.assignedAgentId).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('reuses owner readers, filters project before limit, and resolves exact open points', async () => {
    const f = await fixture();
    const task = await f.graph.createTask({
      projectId: 'alpha',
      title: 'cobalt task',
      createdBy: 'user',
    });
    for (let index = 0; index < 12; index++)
      f.message(`other-${index}`, 'other');
    f.message('wanted', 'alpha');
    const response = await f.request({
      ...query,
      filters: { projectId: 'alpha' },
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as any;
    expect(body.data.state).toBe('complete');
    expect(body.data.results).toHaveLength(2);
    expect(
      body.data.results.every((row: any) => row.scope.projectId === 'alpha'),
    ).toBe(true);
    const opened = await f.request(
      {
        kind: 'session-message',
        sessionId: 'wanted',
        matchedEventId: 'wanted:exact',
      },
      '/resolve-open',
    );
    expect(await opened.json()).toMatchObject({
      data: {
        state: 'resolved',
        target: { sessionId: 'wanted', matchedEventId: 'wanted:exact' },
      },
    });
    const missing = await f.request(
      {
        kind: 'session-message',
        sessionId: 'wanted',
        matchedEventId: 'wanted:turn:user',
      },
      '/resolve-open',
    );
    expect(await missing.json()).toMatchObject({
      data: { state: 'not-found' },
    });
    expect(
      await (
        await f.request(
          { kind: 'task', projectId: 'wrong', taskId: task.id },
          '/resolve-open',
        )
      ).json(),
    ).toMatchObject({ data: { state: 'not-found' } });
    expect(f.createTasks).toHaveBeenCalledTimes(1);
    expect(f.createTranscripts).toHaveBeenCalledTimes(1);
  });
  test('hosted composition never invokes Task search and excludes wrong tenant messages', async () => {
    const f = await fixture(true);
    f.hosted('alpha');
    const read = vi.spyOn(f.tasks.provider, 'search');
    const body = (await (await f.request(query)).json()) as any;
    expect(body.data.results.map((row: any) => row.scope.sessionId)).toEqual([
      'allowed',
    ]);
    expect(body.data.sources).toContainEqual(
      expect.objectContaining({
        providerId: 'station.tasks',
        state: 'restricted',
      }),
    );
    expect(read).not.toHaveBeenCalled();
    expect(
      await (
        await f.request(
          {
            kind: 'session-message',
            sessionId: 'hidden',
            matchedEventId: 'hidden:exact',
          },
          '/resolve-open',
        )
      ).json(),
    ).toMatchObject({ data: { state: 'not-found' } });
  });
  test('principal loss during worker read suppresses the entire response', async () => {
    const f = await fixture();
    f.message('wanted', 'alpha');
    const original = f.tasks.provider.search;
    const started = vi
      .spyOn(f.tasks.provider, 'search')
      .mockImplementation((request, signal) => {
        const pending = original(request, signal);
        f.setCurrent(false);
        return pending;
      });
    expect((await f.request(query)).status).toBe(503);
    expect(started).toHaveBeenCalledOnce();
  });
  test('closed schemas reject caller authority, owner, legacy anchors and oversized bodies', async () => {
    const f = await fixture();
    for (const extra of [
      { owner: 'anything' },
      { authority: { mode: 'personal' } },
      { filters: { tenantId: 'alpha' } },
    ])
      expect((await f.request({ ...query, ...extra })).status).toBe(400);
    expect(
      (
        await f.request(
          { kind: 'session-message', sessionId: 's', messageId: 'anchor' },
          '/resolve-open',
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.request({ ...query, query: 'x'.repeat(13 * 1024) })).status,
    ).toBe(413);
  });
  test('shutdown fences future admission and retains pending Task closure for retry', async () => {
    const f = await fixture();
    const close = vi
      .spyOn(f.tasks, 'close')
      .mockResolvedValueOnce({ state: 'winding-down' });
    expect(await f.search.close()).toEqual({ state: 'winding-down' });
    expect(await (await f.request(query)).json()).toMatchObject({
      data: { state: 'unavailable', results: [] },
    });
    expect(await f.search.close()).toEqual({ state: 'closed' });
    expect(close).toHaveBeenCalledTimes(2);
  });
  test('failed-init retirement captures its exact Orchestration and remembers closed transcript custody while Tasks wait', async () => {
    const f = await fixture();
    const substituted = vi
      .spyOn(
        f.orchestration,
        'retireIsolatedTranscriptSearchAfterFailedInitialization',
      )
      .mockResolvedValue({ state: 'closed' });
    vi.spyOn(f.tasks, 'close').mockResolvedValueOnce({ state: 'winding-down' });
    expect(await f.search.retireAfterFailedInitialization()).toEqual({
      state: 'winding-down',
    });
    expect(substituted).not.toHaveBeenCalled();
    const successor = f.store.createIsolatedTranscriptReads();
    expect(await f.search.retireAfterFailedInitialization()).toEqual({
      state: 'closed',
    });
    expect(f.store.createIsolatedTranscriptReads()).toBe(successor);
    expect(successor.inspect().phase).toBe('idle');
  });

  test('read-shaped POSTs match Task read scope without authorizing future mutation paths', () => {
    expect(requiredPairingScope('POST', '/api/search')).toBe(
      requiredPairingScope('GET', '/api/tasks'),
    );
    expect(requiredPairingScope('POST', '/api/search/resolve-open')).toBe(
      'orchestration:read',
    );
    expect(requiredPairingScope('POST', '/api/search/read-message')).toBe(
      'orchestration:read',
    );
    expect(requiredPairingScope('DELETE', '/api/search')).toBe(
      'orchestration:operate',
    );
    expect(requiredPairingScope('POST', '/api/search/new-mutation')).toBe(
      'orchestration:operate',
    );
  });
});
