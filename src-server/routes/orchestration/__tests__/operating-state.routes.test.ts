import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../capabilities/station-intent-bindings.js', () => ({
  createStationHostIntentBindings: vi.fn(),
}));
vi.mock('../../../capabilities/station-board-intent.js', () => ({
  resolveAndExecuteStationBoardIntent: vi.fn(),
}));

const { createOperatingStateRoutes } = await import('../operating-state.js');
const { createStationHostIntentBindings } = await import(
  '../../../capabilities/station-intent-bindings.js'
);
const { resolveAndExecuteStationBoardIntent } = await import(
  '../../../capabilities/station-board-intent.js'
);

const SAMPLE_STATE = { processes: [{ id: 'p1', status: 'running' }] };

function createMockService(state: unknown = SAMPLE_STATE) {
  return { deriveOperatingState: vi.fn().mockReturnValue(state) } as any;
}

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [
    { id: 'alpha', authority: 'alpha.station.test' },
    { id: 'bravo', authority: 'bravo.station.test' },
  ],
});

function hostedAuthority(tenant?: 'alpha' | 'bravo') {
  return sessionReadAuthorityFromRequest(
    'shared-user',
    tenant ? { tenantId: tenantId(tenant) } : undefined,
    hostedRegistry,
  );
}

function createApp(
  service = createMockService(),
  authority?: ReturnType<typeof hostedAuthority>,
  readSession = vi.fn().mockResolvedValue({
    session: {
      threadId: 'alpha-session',
      provider: 'codex',
    },
  }),
) {
  const getWorkspacePath = vi.fn().mockReturnValue('/workspace/demo');
  const parent = new Hono();
  parent.route(
    '/api/projects/:slug/operating-state',
    createOperatingStateRoutes(service, {
      getWorkspacePath,
      intentBindingDeps: {
        orchestrationService: { readSession },
      } as any,
      ...(authority ? { getSessionReadAuthority: () => authority } : {}),
    }),
  );
  return { app: parent, service, getWorkspacePath, readSession };
}

describe('operating-state routes', () => {
  test('GET / returns the derived OperatingState for the resolved workspace', async () => {
    const { app, service, getWorkspacePath } = createApp();
    const response = await app.request('/api/projects/demo/operating-state');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: SAMPLE_STATE,
    });
    expect(getWorkspacePath).toHaveBeenCalledWith('demo');
    expect(service.deriveOperatingState).toHaveBeenCalledWith(
      '/workspace/demo',
      'demo',
    );
  });

  test.each(['alpha', 'bravo'] as const)(
    'hosted %s cannot derive global operating state',
    async (tenant) => {
      const service = createMockService();
      const { app } = createApp(service, hostedAuthority(tenant));
      const response = await app.request('/api/projects/demo/operating-state');

      expect(response.status).toBe(404);
      expect(service.deriveOperatingState).not.toHaveBeenCalled();
    },
  );

  test('unknown project workspace 404s before touching the service', async () => {
    const service = createMockService();
    const parent = new Hono();
    parent.route(
      '/api/projects/:slug/operating-state',
      createOperatingStateRoutes(service, {
        getWorkspacePath: () => undefined,
        intentBindingDeps: {} as any,
      }),
    );
    const response = await parent.request('/api/projects/demo/operating-state');
    expect(response.status).toBe(404);
    expect(service.deriveOperatingState).not.toHaveBeenCalled();
  });

  test('service failure maps to 500', async () => {
    const service = createMockService();
    service.deriveOperatingState.mockImplementation(() => {
      throw new Error('boom');
    });
    const { app } = createApp(service);
    const response = await app.request('/api/projects/demo/operating-state');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'boom',
    });
  });

  test('POST /intent rejects a malformed body before resolving bindings', async () => {
    const { app } = createApp();
    const response = await app.request(
      '/api/projects/demo/operating-state/intent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: { notAnIntent: true } }),
      },
    );
    expect(response.status).toBe(400);
    expect(createStationHostIntentBindings).not.toHaveBeenCalled();
  });

  test('hosted missing tenant context denies board intent before parsing or resolving it', async () => {
    const service = createMockService();
    const { app } = createApp(service, hostedAuthority());
    const response = await app.request(
      '/api/projects/demo/operating-state/intent',
      { method: 'POST', body: '{not-json' },
    );

    expect(response.status).toBe(404);
    expect(createStationHostIntentBindings).not.toHaveBeenCalled();
    expect(resolveAndExecuteStationBoardIntent).not.toHaveBeenCalled();
    expect(service.deriveOperatingState).not.toHaveBeenCalled();
  });

  test('hosted POST /intent admits only the exact session-resume authority shape', async () => {
    const bindings = [{ product: 'station', command: 'session resume' }];
    vi.mocked(createStationHostIntentBindings).mockReturnValue(bindings as any);
    vi.mocked(resolveAndExecuteStationBoardIntent).mockResolvedValue({
      bound: true,
      executed: true,
    });
    const { app, service } = createApp(
      createMockService(),
      hostedAuthority('alpha'),
    );
    const intent = {
      id: 'resume-alpha',
      kind: 'session resume',
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [
        { product: 'station', kind: 'session', id: 'alpha-session' },
      ],
    };

    const response = await app.request(
      '/api/projects/demo/operating-state/intent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent, consent: true }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { bound: true, executed: true },
    });
    expect(resolveAndExecuteStationBoardIntent).toHaveBeenCalledWith(
      intent,
      true,
      bindings,
    );
    expect(service.deriveOperatingState).not.toHaveBeenCalled();
  });

  test.each([
    undefined,
    {
      id: 'task',
      kind: 'task dispatch',
      authority: { product: 'station', command: 'task dispatch' },
    },
    {
      id: 'other',
      kind: 'session resume',
      authority: { product: 'other', command: 'session resume' },
    },
    {
      id: 'mismatch',
      kind: 'session resume',
      authority: { product: 'station', command: 'session start' },
    },
    {
      id: 'missing-subject',
      kind: 'session resume',
      authority: { product: 'station', command: 'session resume' },
    },
    {
      id: 'task-subject',
      kind: 'session resume',
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [{ product: 'station', kind: 'task', id: 'alpha-session' }],
    },
  ])(
    'hosted POST /intent denies missing, task, foreign, and mismatched intents without side effects',
    async (intent) => {
      vi.clearAllMocks();
      const service = createMockService();
      const { app } = createApp(service, hostedAuthority('alpha'));
      const response = await app.request(
        '/api/projects/demo/operating-state/intent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intent }),
        },
      );

      expect(response.status).toBe(404);
      expect(createStationHostIntentBindings).not.toHaveBeenCalled();
      expect(resolveAndExecuteStationBoardIntent).not.toHaveBeenCalled();
      expect(service.deriveOperatingState).not.toHaveBeenCalled();
    },
  );

  test('hosted POST /intent denies an unreadable session before resolving bindings', async () => {
    const readSession = vi.fn().mockResolvedValue(undefined);
    const { app } = createApp(
      createMockService(),
      hostedAuthority('alpha'),
      readSession,
    );
    const response = await app.request(
      '/api/projects/demo/operating-state/intent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: {
            id: 'resume-bravo',
            kind: 'session resume',
            authority: { product: 'station', command: 'session resume' },
            subjectRefs: [
              { product: 'station', kind: 'session', id: 'bravo-session' },
            ],
          },
          consent: true,
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(readSession).toHaveBeenCalledWith(
      'bravo-session',
      hostedAuthority('alpha'),
    );
    expect(createStationHostIntentBindings).not.toHaveBeenCalled();
    expect(resolveAndExecuteStationBoardIntent).not.toHaveBeenCalled();
  });

  test('POST /intent resolves bindings and delegates to resolveAndExecuteStationBoardIntent', async () => {
    const bindings = [{ product: 'station', command: 'task status' }];
    vi.mocked(createStationHostIntentBindings).mockReturnValue(bindings as any);
    vi.mocked(resolveAndExecuteStationBoardIntent).mockResolvedValue({
      bound: true,
      executed: true,
    });

    const { app } = createApp();
    const intent = {
      id: 'i1',
      kind: 'task status',
      authority: { product: 'station', command: 'task status' },
    };
    const response = await app.request(
      '/api/projects/demo/operating-state/intent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent, consent: true }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { bound: true, executed: true },
    });
    expect(resolveAndExecuteStationBoardIntent).toHaveBeenCalledWith(
      intent,
      true,
      bindings,
    );
  });

  test('POST /intent never forwards a truthy-but-not-true consent as true', async () => {
    vi.mocked(createStationHostIntentBindings).mockReturnValue([] as any);
    vi.mocked(resolveAndExecuteStationBoardIntent).mockResolvedValue({
      bound: false,
      executed: false,
      reason: 'no-matching-binding',
    });

    const { app } = createApp();
    const intent = { id: 'i1', kind: 'task status' };
    await app.request('/api/projects/demo/operating-state/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent, consent: 'yes' }),
    });

    expect(resolveAndExecuteStationBoardIntent).toHaveBeenCalledWith(
      intent,
      undefined,
      [],
    );
  });
});
