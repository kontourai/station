import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

const { createWorkItemRoutes } = await import('../work-items.js');

const LOCAL_RESULT = {
  identity: { kind: 'local', id: 'local', label: 'Station' },
  capabilities: {
    readOnly: false,
    supportsDispatch: true,
    supportsStatusWrite: false,
  },
  available: true,
  items: [
    {
      id: 'task-1',
      title: 'Existing task',
      status: 'todo',
      provider: { kind: 'local', id: 'local', label: 'Station' },
    },
  ],
};

function createMockService(response = { providers: [LOCAL_RESULT] }) {
  return { listWorkItems: vi.fn().mockResolvedValue(response) } as any;
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
) {
  const getWorkspacePath = vi.fn().mockReturnValue('/workspace/demo');
  // Mount under the real parent path so `:slug` resolves the same way it
  // does when runtime-routes.ts mounts this at /api/projects/:slug/work-items.
  const parent = new Hono();
  parent.route(
    '/api/projects/:slug/work-items',
    createWorkItemRoutes(service, {
      getWorkspacePath,
      ...(authority ? { getSessionReadAuthority: () => authority } : {}),
    }),
  );
  return { app: parent, service, getWorkspacePath };
}

describe('work item provider routes', () => {
  test('GET / aggregates provider results for the resolved workspace', async () => {
    const { app, service, getWorkspacePath } = createApp();
    const response = await app.request('/api/projects/demo/work-items');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { providers: [LOCAL_RESULT] },
    });
    expect(getWorkspacePath).toHaveBeenCalledWith('demo');
    expect(service.listWorkItems).toHaveBeenCalledWith({
      projectId: 'demo',
      workingDirectory: '/workspace/demo',
    });
  });

  test.each(['alpha', 'bravo'] as const)(
    'hosted %s receives an empty work-item aggregate before local providers run',
    async (tenant) => {
      const service = createMockService();
      const { app } = createApp(service, hostedAuthority(tenant));
      const response = await app.request('/api/projects/demo/work-items');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        data: { providers: [] },
      });
      expect(service.listWorkItems).not.toHaveBeenCalled();
    },
  );

  test('unknown project workspace 404s before touching the service', async () => {
    const service = createMockService();
    const parent = new Hono();
    parent.route(
      '/api/projects/:slug/work-items',
      createWorkItemRoutes(service, { getWorkspacePath: () => undefined }),
    );
    const response = await parent.request('/api/projects/demo/work-items');
    expect(response.status).toBe(404);
    expect(service.listWorkItems).not.toHaveBeenCalled();
  });

  test('service failure maps to 500', async () => {
    const service = createMockService();
    service.listWorkItems.mockRejectedValue(new Error('boom'));
    const { app } = createApp(service);
    const response = await app.request('/api/projects/demo/work-items');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'boom',
    });
  });

  // Roadmap archive#584, part of epic archive#580, S4.
  describe('GET /claim', () => {
    function createClaimApp(assignmentClaimService?: any) {
      const getWorkspacePath = vi.fn().mockReturnValue('/workspace/demo');
      const parent = new Hono();
      parent.route(
        '/api/projects/:slug/work-items',
        createWorkItemRoutes(createMockService(), {
          getWorkspacePath,
          assignmentClaimService,
        }),
      );
      return parent;
    }

    test('requires subjectId', async () => {
      const app = createClaimApp({ status: vi.fn() });
      const response = await app.request('/api/projects/demo/work-items/claim');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: 'subjectId is required',
      });
    });

    test('reports unavailable when no assignmentClaimService is wired', async () => {
      const app = createClaimApp(undefined);
      const response = await app.request(
        '/api/projects/demo/work-items/claim?subjectId=github:kontourai/station%23584',
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        data: {
          subjectId: 'github:kontourai/station#584',
          state: 'unavailable',
          reason: 'assignment claim service not configured',
        },
      });
    });

    test('reports free when the service reports no active claim', async () => {
      const status = vi.fn().mockResolvedValue({ outcome: 'free' });
      const app = createClaimApp({ status });
      const response = await app.request(
        '/api/projects/demo/work-items/claim?subjectId=github:kontourai/station%23584',
      );
      expect(await response.json()).toEqual({
        success: true,
        data: { subjectId: 'github:kontourai/station#584', state: 'free' },
      });
      expect(status).toHaveBeenCalledWith({
        artifactRoot: '/workspace/demo/.kontourai/flow-agents',
        subjectId: 'github:kontourai/station#584',
      });
    });

    test('reports claimed with the actor when the service reports an active claim', async () => {
      const status = vi.fn().mockResolvedValue({
        outcome: 'claimed',
        actor: {
          runtime: 'station',
          session_id: 'task-alpha-1',
          host: 'test-host',
          human: null,
        },
      });
      const app = createClaimApp({ status });
      const response = await app.request(
        '/api/projects/demo/work-items/claim?subjectId=github:kontourai/station%23584',
      );
      expect(await response.json()).toEqual({
        success: true,
        data: {
          subjectId: 'github:kontourai/station#584',
          state: 'claimed',
          actor: {
            runtime: 'station',
            sessionId: 'task-alpha-1',
            host: 'test-host',
            human: null,
          },
        },
      });
    });
  });

  test('a hosted request with missing tenant context denies claim lookup before the sidecar store', async () => {
    const status = vi.fn();
    const parent = new Hono();
    parent.route(
      '/api/projects/:slug/work-items',
      createWorkItemRoutes(createMockService(), {
        getWorkspacePath: () => '/workspace/demo',
        assignmentClaimService: { status } as any,
        getSessionReadAuthority: () => hostedAuthority(),
      }),
    );

    const response = await parent.request(
      '/api/projects/demo/work-items/claim?subjectId=local-task',
    );
    expect(response.status).toBe(404);
    expect(status).not.toHaveBeenCalled();
  });
});
