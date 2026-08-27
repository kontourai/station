import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';

const { createWorkflowSidecarRoutes } = await import('../workflow-sidecars.js');
const { WorkflowSidecarInvalidError } = await import(
  '../../../services/evidence/workflow-sidecar-service.js'
);

const TASK_SUMMARY = {
  taskSlug: 'switch-proof',
  status: 'not_verified',
  phase: 'verification',
  updatedAt: '2026-06-12T00:00:00.000Z',
  nextAction: { status: 'needs_user', summary: 'Verify before delivering' },
  hasHandoff: true,
  path: '.kontourai/flow-agents/switch-proof',
};

const TASK_STATE = {
  schema_version: '1.0',
  task_slug: 'switch-proof',
  status: 'not_verified',
  phase: 'verification',
  updated_at: '2026-06-12T00:00:00.000Z',
  next_action: { status: 'needs_user', summary: 'Verify before delivering' },
};

function createMockSidecarService() {
  return {
    listTasks: vi.fn().mockReturnValue([TASK_SUMMARY]),
    readState: vi.fn().mockReturnValue(TASK_STATE),
    readHandoff: vi.fn().mockReturnValue(null),
  } as any;
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
  service = createMockSidecarService(),
  authority?: ReturnType<typeof hostedAuthority>,
) {
  const app = createWorkflowSidecarRoutes(service, {
    getWorkspacePath: vi.fn().mockReturnValue('/workspace/demo'),
    ...(authority ? { getSessionReadAuthority: () => authority } : {}),
  });
  return { app, service };
}

describe('workflow sidecar routes', () => {
  test('GET /tasks lists the workspace task sidecars', async () => {
    const { app, service } = createApp();
    const response = await app.request('/tasks');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: [TASK_SUMMARY],
    });
    expect(service.listTasks).toHaveBeenCalledWith('/workspace/demo');
  });

  test.each(['alpha', 'bravo'] as const)(
    'hosted %s receives no sidecars and never invokes the local sidecar service',
    async (tenant) => {
      const service = createMockSidecarService();
      const { app } = createApp(service, hostedAuthority(tenant));
      const response = await app.request('/tasks');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, data: [] });
      expect(service.listTasks).not.toHaveBeenCalled();
    },
  );

  test('hosted missing tenant context 404s a task before local sidecar reads', async () => {
    const service = createMockSidecarService();
    const { app } = createApp(service, hostedAuthority());
    const response = await app.request('/tasks/switch-proof');

    expect(response.status).toBe(404);
    expect(service.readState).not.toHaveBeenCalled();
    expect(service.readHandoff).not.toHaveBeenCalled();
  });

  test('GET /tasks/:taskSlug returns state + handoff', async () => {
    const { app, service } = createApp();
    const response = await app.request('/tasks/switch-proof');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        taskSlug: 'switch-proof',
        state: TASK_STATE,
        handoff: null,
        path: '.kontourai/flow-agents/switch-proof',
      },
    });
    expect(service.readState).toHaveBeenCalledWith(
      '/workspace/demo',
      'switch-proof',
    );
  });

  test('GET /tasks/:taskSlug 404s when the sidecar does not exist', async () => {
    const service = createMockSidecarService();
    service.readState.mockReturnValue(null);
    const { app } = createApp(service);
    const response = await app.request('/tasks/missing-task');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false });
  });

  test('invalid sidecar errors map to 400', async () => {
    const service = createMockSidecarService();
    service.readState.mockImplementation(() => {
      throw new WorkflowSidecarInvalidError('Invalid task slug');
    });
    const { app } = createApp(service);
    const response = await app.request('/tasks/%2e%2e%2fescape');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('Invalid task slug'),
    });
  });

  test('unknown project workspace 404s before touching the service', async () => {
    const service = createMockSidecarService();
    const app = createWorkflowSidecarRoutes(service, {
      getWorkspacePath: () => undefined,
    });
    const response = await app.request('/tasks');
    expect(response.status).toBe(404);
    expect(service.listTasks).not.toHaveBeenCalled();
  });
});
