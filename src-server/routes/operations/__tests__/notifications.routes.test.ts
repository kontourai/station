import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import {
  ApprovalInboxNotificationProvider,
  wireApprovalInboxNotifications,
} from '../../../services/approvals/approval-inbox.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  notificationOps: { add: vi.fn() },
  approvalDuration: { record: vi.fn() },
  approvalInboxOps: { add: vi.fn() },
  approvalOps: { add: vi.fn() },
}));

const { createNotificationRoutes } = await import('../notifications.js');
const { NotificationService } = await import(
  '../../../services/notifications/notification-service.js'
);
const { EventBus } = await import(
  '../../../services/orchestration/event-bus.js'
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [
    { id: 'alpha', authority: 'alpha.example.test' },
    { id: 'bravo', authority: 'bravo.example.test' },
  ],
});

function hostedAuthority(tenant: 'alpha' | 'bravo') {
  return sessionReadAuthorityFromRequest(
    `${tenant}-user`,
    { tenantId: tenantId(tenant) },
    hostedRegistry,
  );
}

describe('Notification Routes', () => {
  let dir: string;
  let svc: InstanceType<typeof NotificationService>;
  let app: ReturnType<typeof createNotificationRoutes>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'notif-routes-test-'));
    svc = new NotificationService(new EventBus(), dir, 999_999);
    app = createNotificationRoutes(svc);
  });

  afterEach(async () => {
    await svc.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('GET / returns empty list', async () => {
    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test('POST / schedules a notification', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', body: 'Hello', category: 'test' }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data.title).toBe('Test');
  });

  test('POST /:id/action/:actionId carries the authenticated request origin through the approval inbox into the registry resolution event (#3830)', async () => {
    const eventBus = new EventBus();
    await svc.shutdown();
    svc = new NotificationService(eventBus, dir, 999_999);
    const approvalRegistry = new ApprovalRegistry(
      {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      { eventBus },
    );
    const provider = new ApprovalInboxNotificationProvider({
      approvalRegistry,
      orchestrationService: {
        dispatch: vi.fn(),
        readRequestOutcome: vi.fn(() => ({ state: 'undetermined' })),
        resolveSessionProjectSlug: vi.fn(() => undefined),
      } as any,
    });
    svc.addProvider(provider);
    wireApprovalInboxNotifications(eventBus, provider, svc, {
      debug: vi.fn(),
      warn: vi.fn(),
    });
    await svc.start();

    const resolutions: Array<Record<string, unknown> | undefined> = [];
    eventBus.subscribe((event) => {
      if (event.event === 'approval:resolved') resolutions.push(event.data);
    });
    const pending = approvalRegistry.register('approval-route-origin', {
      metadata: {
        agentName: 'Workspace Agent',
        conversationId: 'conversation:approval-origin',
        source: 'runtime',
        title: 'fs.read',
        toolName: 'fs.read',
      },
    });
    await svc.drainAsyncDispatch();
    const [notification] = await svc.list();

    const inner = createNotificationRoutes(svc);
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'device-credential',
        authority: 'device-credential',
        deviceId: 'authenticated-device-42',
        source: 'bearer',
      });
      await next();
    });
    app.route('/', inner);

    const response = await app.request(`/${notification.id}/action/accept`, {
      method: 'POST',
      headers: { 'X-Station-Client-Origin': '1;mobile;1.2.3' },
    });

    expect(response.status).toBe(200);
    await expect(pending).resolves.toBe(true);
    expect(resolutions).toEqual([
      expect.objectContaining({
        approvalId: 'approval-route-origin',
        clientOrigin: {
          version: 1,
          actor: { kind: 'device', deviceId: 'authenticated-device-42' },
          reported: { version: 1, surface: 'mobile', build: '1.2.3' },
        },
      }),
    ]);
  });

  test.each([
    [
      'schedule',
      (_id: string): string => '/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Awaited', category: 'test' }),
      },
    ],
    [
      'activity deletion',
      (_id: string): string => '/activity',
      { method: 'DELETE' },
    ],
    [
      'notification deletion',
      (id: string): string => `/${id}`,
      { method: 'DELETE' },
    ],
    [
      'action',
      (id: string): string => `/${id}/action/default`,
      { method: 'POST' },
    ],
    [
      'snooze',
      (id: string): string => `/${id}/snooze`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          until: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
    ],
    ['clear all', (_id: string): string => '/', { method: 'DELETE' }],
  ] as const)(
    'request %s awaits the durable mutation before responding',
    async (_name, pathFor, request) => {
      const existing = await svc.schedule('test', {
        title: 'Existing',
        category: 'test',
      });
      const entered = deferred();
      const release = deferred();
      const contended = new NotificationService(new EventBus(), dir, 999_999, {
        acquireMutationLock: async () => {
          entered.resolve();
          await release.promise;
          return () => {};
        },
      });
      const contendedApp = createNotificationRoutes(contended);

      let settled = false;
      const response = Promise.resolve(
        contendedApp.request(pathFor(existing.id), request),
      ).then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      release.resolve();
      expect((await response).status).toBeLessThan(400);
    },
  );

  test('DELETE /:id dismisses a notification', async () => {
    const n = await svc.schedule('test', {
      title: 'X',
      body: '',
      category: 'c',
    });
    const body = await json(
      await app.request(`/${n.id}`, { method: 'DELETE' }),
    );
    expect(body.success).toBe(true);
  });

  test('action and dismissal routes report a dispatching provider operation truthfully', async () => {
    const enteredProvider = deferred();
    const releaseProvider = deferred();
    const handleDismiss = vi.fn();
    svc.addProvider({
      id: 'provider',
      displayName: 'Provider',
      categories: ['test'],
      handleAction: async () => {
        enteredProvider.resolve();
        await releaseProvider.promise;
      },
      handleDismiss,
    } as any);
    const notification = await svc.schedule('provider', {
      title: 'Action in flight',
      body: '',
      category: 'test',
    });

    const firstAction = app.request(`/${notification.id}/action/allow`, {
      method: 'POST',
    });
    await enteredProvider.promise;

    const ordinary = await svc.schedule('provider', {
      title: 'Ordinary activity',
      body: '',
      category: 'test',
    });
    const clearActivity = await app.request('/activity', { method: 'DELETE' });
    expect(clearActivity.status).toBe(409);
    const clearAll = await app.request('/', { method: 'DELETE' });
    expect(clearAll.status).toBe(409);
    expect(handleDismiss).not.toHaveBeenCalled();
    expect((await svc.list()).map((candidate) => candidate.id)).toEqual([
      notification.id,
      ordinary.id,
    ]);

    const dismiss = await app.request(`/${notification.id}`, {
      method: 'DELETE',
    });
    expect(dismiss.status).toBe(409);
    expect(await json(dismiss)).toEqual({
      success: false,
      error: 'Notification action is in progress',
    });
    const secondAction = await app.request(`/${notification.id}/action/again`, {
      method: 'POST',
    });
    expect(secondAction.status).toBe(409);

    releaseProvider.resolve();
    expect((await firstAction).status).toBe(200);
  });

  test('action route reports a lost reservation after a dismissal wins before dispatch', async () => {
    const enteredDispatch = deferred();
    const releaseDispatch = deferred();
    const handleAction = vi.fn();
    svc = new NotificationService(new EventBus(), dir, 999_999, {
      beforeActionDispatch: async () => {
        enteredDispatch.resolve();
        await releaseDispatch.promise;
      },
    });
    app = createNotificationRoutes(svc);
    svc.addProvider({
      id: 'provider',
      displayName: 'Provider',
      categories: ['test'],
      handleAction,
    } as any);
    const notification = await svc.schedule('provider', {
      title: 'Dismiss wins',
      body: '',
      category: 'test',
    });

    const action = app.request(`/${notification.id}/action/allow`, {
      method: 'POST',
    });
    await enteredDispatch.promise;

    expect(
      (await app.request(`/${notification.id}`, { method: 'DELETE' })).status,
    ).toBe(200);
    releaseDispatch.resolve();
    expect((await action).status).toBe(409);
    expect(handleAction).not.toHaveBeenCalled();
    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: notification.id, status: 'dismissed' }),
    ]);
  });

  test('action route reports not found when clear-all removes a reserved action', async () => {
    const enteredDispatch = deferred();
    const releaseDispatch = deferred();
    const handleAction = vi.fn();
    svc = new NotificationService(new EventBus(), dir, 999_999, {
      beforeActionDispatch: async () => {
        enteredDispatch.resolve();
        await releaseDispatch.promise;
      },
    });
    app = createNotificationRoutes(svc);
    svc.addProvider({
      id: 'provider',
      displayName: 'Provider',
      categories: ['test'],
      handleAction,
    } as any);
    const notification = await svc.schedule('provider', {
      title: 'Removal wins',
      body: '',
      category: 'test',
    });

    const action = app.request(`/${notification.id}/action/allow`, {
      method: 'POST',
    });
    await enteredDispatch.promise;

    expect((await app.request('/', { method: 'DELETE' })).status).toBe(200);
    releaseDispatch.resolve();
    expect((await action).status).toBe(404);
    expect(handleAction).not.toHaveBeenCalled();
    expect(await svc.list()).toEqual([]);
  });

  test('DELETE /activity clears activity while preserving active approvals', async () => {
    const approval = await svc.schedule('approval-inbox', {
      title: 'Approval needed',
      body: '',
      category: 'approval-request',
    });
    await svc.schedule('test', { title: 'A', body: '', category: 'c' });
    const body = await json(
      await app.request('/activity', { method: 'DELETE' }),
    );
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ clearedCount: 1 });
    expect(await svc.list()).toEqual([
      expect.objectContaining({ id: approval.id }),
    ]);
  });

  test('DELETE / retains the public clear-all behavior', async () => {
    await svc.schedule('approval-inbox', {
      title: 'Approval needed',
      body: '',
      category: 'approval-request',
    });
    await svc.schedule('test', { title: 'A', body: '', category: 'c' });

    const body = await json(await app.request('/', { method: 'DELETE' }));

    expect(body.success).toBe(true);
    expect(await svc.list()).toHaveLength(0);
  });

  test('GET /providers returns provider list', async () => {
    const body = await json(await app.request('/providers'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test('POST /:id/snooze snoozes a notification', async () => {
    const n = await svc.schedule('test', {
      title: 'X',
      body: '',
      category: 'c',
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    const body = await json(
      await app.request(`/${n.id}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: future }),
      }),
    );
    expect(body.success).toBe(true);
  });

  test('hosted list and mutations retain bravo and unbound scheduler/API rows while allowing only alpha', async () => {
    const alpha = await svc.schedule('orchestration', {
      title: 'Alpha only',
      body: '',
      category: 'job',
      metadata: { sessionId: 'alpha-session' },
    });
    const bravo = await svc.schedule('orchestration', {
      title: 'Bravo only',
      body: '',
      category: 'job',
      metadata: { threadId: 'bravo-session' },
    });
    const generic = await svc.schedule('scheduler', {
      title: 'Generic',
      body: '',
      category: 'job',
    });
    const hostedApp = createNotificationRoutes(svc, {
      readAuthorityForRequest: (request) =>
        hostedAuthority(
          request.headers.get('x-test-tenant') as 'alpha' | 'bravo',
        ),
      canReadSession: (sessionId, authority) =>
        sessionId === `${authority.tenantExecutionContext?.tenantId}-session`,
    });

    const alphaList = await json(
      await hostedApp.request('/', { headers: { 'x-test-tenant': 'alpha' } }),
    );
    expect(
      alphaList.data.map((notification: { id: string }) => notification.id),
    ).toEqual([alpha.id]);
    expect(
      alphaList.data.map((notification: { id: string }) => notification.id),
    ).not.toContain(bravo.id);
    expect(
      alphaList.data.map((notification: { id: string }) => notification.id),
    ).not.toContain(generic.id);

    const unboundMutation = await hostedApp.request(`/${generic.id}`, {
      method: 'DELETE',
      headers: { 'x-test-tenant': 'alpha' },
    });
    expect(unboundMutation.status).toBe(404);
    expect(
      (await svc.list()).find((notification) => notification.id === generic.id)
        ?.status,
    ).toBe('delivered');

    const beforeApiSchedule = (await svc.list()).length;
    const apiSchedule = await hostedApp.request('/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-tenant': 'alpha',
      },
      body: JSON.stringify({
        title: 'Unbound API notification',
        body: 'must not persist',
        category: 'job',
      }),
    });
    expect(apiSchedule.status).toBe(404);
    expect(await svc.list()).toHaveLength(beforeApiSchedule);

    const rejected = await hostedApp.request(`/${alpha.id}`, {
      method: 'DELETE',
      headers: { 'x-test-tenant': 'bravo' },
    });
    expect(rejected.status).toBe(404);
    expect(
      (await svc.list()).find((notification) => notification.id === alpha.id)
        ?.status,
    ).toBe('delivered');
    expect(
      (
        await hostedApp.request(`/${alpha.id}/action/default`, {
          method: 'POST',
          headers: { 'x-test-tenant': 'bravo' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await hostedApp.request(`/${alpha.id}/snooze`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-test-tenant': 'bravo',
          },
          body: JSON.stringify({
            until: new Date(Date.now() + 60_000).toISOString(),
          }),
        })
      ).status,
    ).toBe(404);

    const cleared = await json(
      await hostedApp.request('/activity', {
        method: 'DELETE',
        headers: { 'x-test-tenant': 'alpha' },
      }),
    );
    expect(cleared.data).toEqual({ clearedCount: 1 });
    expect(await svc.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: bravo.id }),
        expect.objectContaining({ id: generic.id }),
      ]),
    );

    const clearAll = await hostedApp.request('/', {
      method: 'DELETE',
      headers: { 'x-test-tenant': 'alpha' },
    });
    expect(clearAll.status).toBe(200);
    expect(await svc.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: bravo.id }),
        expect.objectContaining({ id: generic.id }),
      ]),
    );

    const personalApp = createNotificationRoutes(svc, {
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('personal', undefined, undefined),
      canReadSession: () => true,
    });
    const personalList = await json(await personalApp.request('/'));
    expect(personalList.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: bravo.id }),
        expect.objectContaining({ id: generic.id }),
      ]),
    );
  });
});
