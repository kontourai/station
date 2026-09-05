import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ATTENTION_REQUEST_MAX_BYTES } from '@kontourai/station-contracts/attention';
import type { RequestOpenedEvent } from '@kontourai/station-contracts/runtime-events';
import {
  parseHostedTenantRegistry,
  parseTenantExecutionContext,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness';
import { waitForReceipt } from '../../../services/infra/receipt-bus';
import { EventBus } from '../../../services/orchestration/event-bus';
import { EventStore } from '../../../services/orchestration/event-store';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service';
import {
  createManualSessionTransitionEvent,
  projectSessionLifecycle,
} from '../../../services/orchestration/session-lifecycle-service';
import { createOrchestrationRoutes } from '../orchestration';

const NOW = '2026-09-04T00:00:00.000Z';
const REFERENCE = {
  threadId: 'session-a',
  requestId: 'request-a',
  requestEventId: 'opened-a',
};
function opened(eventId = 'opened-a'): RequestOpenedEvent {
  return {
    eventId,
    threadId: 'session-a',
    provider: 'claude',
    requestId: 'request-a',
    method: 'request.opened',
    requestType: 'permission',
    title: 'Run fixture tool',
    createdAt: NOW,
    payload: {
      toolName: 'fixture',
      toolInput: { apiKey: 'secret-value-must-not-appear', query: 'fixture' },
    },
  };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(hosted = false) {
  const directory = mkdtempSync(join(tmpdir(), 'station-exact-request-'));
  const store = new EventStore(join(directory, 'events.sqlite'));
  const adapter = new GateTestAdapter();
  const respond = vi
    .spyOn(adapter, 'respondToRequest')
    .mockResolvedValue(undefined);
  const hasSession = vi.spyOn(adapter, 'hasSession').mockResolvedValue(true);
  let providerAvailable = true;
  const registry = createGateTestRegistry(adapter);
  const service = new OrchestrationService({
    adapterRegistry: {
      ...registry,
      get: (provider) =>
        providerAvailable ? registry.get(provider) : undefined,
      list: () => (providerAvailable ? [adapter] : []),
    },
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...(hosted
      ? {
          requireTenantExecutionContext: () => true,
          validateRecoveredTenantExecutionContext: (value: unknown) => {
            const parsed = parseTenantExecutionContext(value);
            return parsed && ['alpha', 'bravo'].includes(parsed.tenantId)
              ? parsed
              : undefined;
          },
        }
      : {}),
  });
  const settled = waitForReceipt(
    (receipt) => receipt.kind === 'session.attachment.settled',
  );
  service.initialize();
  await settled;
  store.upsertSession({
    provider: 'claude',
    threadId: 'session-a',
    status: 'ready',
    createdAt: NOW,
    updatedAt: NOW,
    ...(hosted
      ? {
          tenantExecutionContext: {
            tenantId: tenantId('alpha'),
            source: 'session' as const,
          },
        }
      : {}),
  });
  store.appendEvent({
    eventId: 'configured-a',
    provider: 'claude',
    threadId: 'session-a',
    method: 'session.configured',
    sessionId: 'session-a',
    createdAt: NOW,
    metadata: { userId: 'owner' },
  });
  store.appendEvent(opened());
  let user = 'owner';
  let principalCurrent = true;
  const app = createOrchestrationRoutes(service, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn() },
    getUserId: () => user,
    isRequestPrincipalCurrent: () => principalCurrent,
  });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    service,
    adapter,
    respond,
    hasSession,
    app,
    setUser: (value: string) => {
      user = value;
    },
    revoke: () => {
      principalCurrent = false;
    },
    removeProvider: () => {
      providerAvailable = false;
    },
  };
}
function respondRequest(
  app: Awaited<ReturnType<typeof fixture>>['app'],
  expected = 'opened-a',
) {
  return app.request('/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'respondToRequest',
      threadId: 'session-a',
      requestId: 'request-a',
      expectedRequestEventId: expected,
      decision: 'accept',
    }),
  });
}
const READ = '/sessions/session-a/requests/request-a?eventId=opened-a';

describe('exact attention request route and immediate response guard', () => {
  test('reads one exact authorized request, redacts values, and accepts one receipt-backed decision', async () => {
    const f = await fixture();
    const response = await f.app.request(READ);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.data).toMatchObject({
      state: 'open',
      reference: REFERENCE,
      canRespond: true,
      requestType: 'permission',
    });
    expect(JSON.stringify(body)).not.toContain('secret-value-must-not-appear');
    const decision = await respondRequest(f.app);
    expect(decision.status).toBe(200);
    const result = await decision.json();
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(f.store.readCommandReceipt(result.receipt.commandId)?.status).toBe(
      'accepted',
    );
  });
  test('denies a different user and an expired request principal without revealing content', async () => {
    const f = await fixture();
    f.setUser('other');
    expect((await f.app.request(READ)).status).toBe(404);
    f.setUser('owner');
    f.revoke();
    const response = await f.app.request(READ);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('fixture');
  });
  test('same user in another tenant cannot inspect the request', async () => {
    const f = await fixture(true);
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.test' },
        { id: 'bravo', authority: 'bravo.test' },
      ],
    });
    const alpha = sessionReadAuthorityFromRequest(
      'owner',
      { tenantId: tenantId('alpha') },
      registry,
    );
    const bravo = sessionReadAuthorityFromRequest(
      'owner',
      { tenantId: tenantId('bravo') },
      registry,
    );
    expect(f.service.inspectAttentionRequest(REFERENCE, alpha)?.state).toBe(
      'open',
    );
    expect(f.service.inspectAttentionRequest(REFERENCE, bravo)).toBeNull();
  });
  test.each(['before dispatch', 'while adapter resolves'] as const)(
    'rejects same-ID reopening %s',
    async (timing) => {
      const f = await fixture();
      const reopen = () => {
        f.store.appendEvent({
          eventId: 'resolved-a',
          provider: 'claude',
          threadId: 'session-a',
          requestId: 'request-a',
          method: 'request.resolved',
          status: 'approved',
          createdAt: NOW,
        });
        f.store.appendEvent(opened('opened-b'));
      };
      if (timing === 'before dispatch') reopen();
      else
        f.hasSession.mockImplementationOnce(async () => {
          reopen();
          return true;
        });
      const response = await respondRequest(f.app);
      expect(response.status).toBe(409);
      const result = await response.json();
      expect(result.code).toBe('request_event_changed');
      expect(f.respond).not.toHaveBeenCalled();
      expect(f.store.readCommandReceipt(result.receipt.commandId)?.status).toBe(
        'rejected',
      );
    },
  );
  test('rechecks request principal after the adapter await', async () => {
    const f = await fixture();
    f.hasSession.mockImplementationOnce(async () => {
      f.revoke();
      return true;
    });
    const response = await respondRequest(f.app);
    expect(response.status).toBe(409);
    expect(f.respond).not.toHaveBeenCalled();
  });
  test('an unreadable or oversized current event is not actionable', async () => {
    const f = await fixture();
    f.store.appendEvent(opened('opened-large'));
    // Legacy/corrupt persisted content can predate the current ingress cap.
    // Inject it only in this owned test DB; the read must withhold its bytes.
    (f.store as unknown as { db: DatabaseSync }).db
      .prepare('UPDATE orchestration_events SET payload = ? WHERE id = ?')
      .run(
        JSON.stringify({
          ...opened('opened-large'),
          payload: { data: 'x'.repeat(ATTENTION_REQUEST_MAX_BYTES) },
        }),
        'opened-large',
      );
    expect(
      (
        await (
          await f.app.request(
            '/sessions/session-a/requests/request-a?eventId=opened-large',
          )
        ).json()
      ).data.state,
    ).toBe('unavailable');
    expect((await respondRequest(f.app, 'opened-large')).status).toBe(409);
    expect(f.respond).not.toHaveBeenCalled();
    vi.spyOn(f.store, 'readCurrentRequestEvent').mockImplementation(() => {
      throw new Error('database locked');
    });
    expect((await (await f.app.request(READ)).json()).data.state).toBe(
      'unavailable',
    );
  });
  test('reads one mapped event regardless of unrelated history and reopenings', async () => {
    const f = await fixture();
    const mapped = vi.spyOn(f.store as any, 'mapEventRow');
    await f.app.request(READ);
    const baselineMapped = mapped.mock.calls.length;
    mapped.mockClear();
    for (let index = 0; index < 1000; index++) {
      f.store.appendEvent({
        ...opened(`old-${index}`),
        requestId: `unrelated-${index}`,
      });
    }
    for (let index = 0; index < 100; index++)
      f.store.appendEvent(opened(`reopen-${index}`));
    f.store.appendEvent(opened('current-final'));
    vi.spyOn(f.store, 'listEvents').mockImplementation(() => {
      throw new Error('full history forbidden');
    });
    vi.spyOn(f.store, 'listEventsForRequest').mockImplementation(() => {
      throw new Error('request replay forbidden');
    });
    const response = await f.app.request(
      '/sessions/session-a/requests/request-a?eventId=current-final',
    );
    expect((await response.json()).data.state).toBe('open');
    expect(mapped).toHaveBeenCalledTimes(baselineMapped);
  });
  test('provider absence preserves inspectability without response affordance', async () => {
    const f = await fixture();
    await Promise.resolve();
    f.removeProvider();
    const result = await (await f.app.request(READ)).json();
    expect(result.data.state).toBe('open');
    expect(result.data.canRespond).toBe(false);
  });
});

test.each([
  'index',
  'thread',
  'request',
  'event',
  'method',
  'provider',
] as const)(
  'misbound %s identity is unavailable and cannot cause an effect',
  async (kind) => {
    const f = await fixture();
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    if (kind === 'index') {
      f.store.appendEvent({
        ...opened('foreign-event'),
        threadId: 'foreign-thread',
        requestId: 'foreign-request',
        title: 'CROSS_SCOPE_CANARY',
      });
      db.prepare(
        'UPDATE orchestration_request_state SET event_id = ? WHERE thread_id = ? AND request_id = ?',
      ).run('foreign-event', 'session-a', 'request-a');
    } else {
      const bad: Record<string, unknown> = {
        ...opened(),
        title: 'CROSS_SCOPE_CANARY',
      };
      if (kind === 'thread') bad.threadId = 'foreign-thread';
      if (kind === 'request') bad.requestId = 'foreign-request';
      if (kind === 'event') bad.eventId = 'foreign-event';
      if (kind === 'method') bad.method = 'request.resolved';
      if (kind === 'provider') bad.provider = 'codex';
      db.prepare(
        'UPDATE orchestration_events SET payload = ? WHERE id = ?',
      ).run(JSON.stringify(bad), 'opened-a');
    }
    const read = await f.app.request(READ);
    const text = await read.text();
    expect(JSON.parse(text).data.state).toBe('unavailable');
    expect(text).not.toContain('CROSS_SCOPE_CANARY');
    const write = await respondRequest(f.app);
    expect(write.status).toBe(409);
    expect((await write.json()).code).toBe('request_verification_unavailable');
    expect(f.respond).not.toHaveBeenCalled();
  },
);

test.each([
  ['completed', false],
  ['canceled', false],
  ['failed', true],
] as const)(
  'canonical %s lifecycle controls answerability without hiding request history',
  async (state, canRespond) => {
    const f = await fixture();
    f.store.appendEvent(
      createManualSessionTransitionEvent({
        provider: 'claude',
        threadId: 'session-a',
        from: 'review_pending',
        to: state,
        reason: 'manual_update',
        source: 'system_recovery',
        message: 'fixture lifecycle',
      }),
    );
    const response = await f.app.request(READ);
    const result = await response.json();
    expect(result.data.state).toBe('open');
    expect(result.data.canRespond).toBe(canRespond);
    if (!canRespond) {
      expect((await respondRequest(f.app)).status).toBe(409);
      expect(f.respond).not.toHaveBeenCalled();
    }
  },
);

test('another oversized lifecycle fact fails closed before payload mapping', async () => {
  const f = await fixture();
  f.store.appendEvent({ ...opened('other-open'), requestId: 'other-request' });
  (f.store as unknown as { db: DatabaseSync }).db
    .prepare('UPDATE orchestration_events SET payload = ? WHERE id = ?')
    .run(
      JSON.stringify({
        ...opened('other-open'),
        requestId: 'other-request',
        payload: { data: 'x'.repeat(ATTENTION_REQUEST_MAX_BYTES) },
      }),
      'other-open',
    );
  const mapper = vi.spyOn(f.store as any, 'mapEventRow');
  expect((await (await f.app.request(READ)).json()).data.state).toBe(
    'unavailable',
  );
  expect(
    mapper.mock.calls.every(
      ([row]) =>
        row.payload === null ||
        Buffer.byteLength(row.payload) <= ATTENTION_REQUEST_MAX_BYTES,
    ),
  ).toBe(true);
  expect((await respondRequest(f.app)).status).toBe(409);
  expect(f.respond).not.toHaveBeenCalled();
});

test('selected pending request survives another request opening and resolving', async () => {
  const f = await fixture();
  f.store.appendEvent({ ...opened('other-open'), requestId: 'other-request' });
  f.store.appendEvent({
    eventId: 'other-resolved',
    threadId: 'session-a',
    provider: 'claude',
    method: 'request.resolved',
    requestId: 'other-request',
    decision: 'accept',
    createdAt: NOW,
  });
  const session = f.store.readSessionByThread('session-a')!;
  const canonical = projectSessionLifecycle({
    session,
    events: f.store
      .listSessionProjectionEvents('session-a')
      .map((event) => event.payload),
  });
  const bounded = projectSessionLifecycle({
    session,
    events: f.store
      .listSessionProjectionEvents('session-a', { requestId: 'request-a' })
      .map((event) => event.payload),
  });
  expect(canonical.lifecycleState).toBe('review_pending');
  expect(bounded.lifecycleState).toBe(canonical.lifecycleState);
  expect((await (await f.app.request(READ)).json()).data.canRespond).toBe(true);
});
