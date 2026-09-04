import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
describe('runtime search HTTP composition', () => {
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
  test('read-shaped POSTs match Task read scope without authorizing future mutation paths', () => {
    expect(requiredPairingScope('POST', '/api/search')).toBe(
      requiredPairingScope('GET', '/api/tasks'),
    );
    expect(requiredPairingScope('POST', '/api/search/resolve-open')).toBe(
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
