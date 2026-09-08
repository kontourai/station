import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { createRouteTestApp } from '../../../__test-utils__/route-test-app.js';
import type { LayoutService } from '../../../services/projects/layout-service.js';
import { RouteError } from '../../../utils/route-error.js';
import { createWorkflowRoutes } from '../layouts.js';

function createMockLayoutService() {
  return {
    listAgentWorkflows: vi.fn().mockResolvedValue([]),
    getWorkflow: vi.fn().mockResolvedValue('// code'),
    createWorkflow: vi.fn().mockResolvedValue(undefined),
    updateWorkflow: vi.fn().mockResolvedValue(undefined),
    deleteWorkflow: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Mounted at the path production mounts it at
 * (`runtime-routes.ts`: `context.app.route('/agents', ...)`), through the
 * runtime HTTP boundary. Without the boundary these handlers throw straight
 * out of `app.request` -- they no longer catch anything themselves.
 */
function mount(service: ReturnType<typeof createMockLayoutService>) {
  const app = createRouteTestApp();
  app.route(
    '/agents',
    createWorkflowRoutes(service as unknown as LayoutService),
  );
  return app;
}

describe('Workflow Routes', () => {
  test('GET /:slug/workflows/files lists workflows', async () => {
    const app = mount(createMockLayoutService());
    const body = await json(
      await app.request('/agents/agent1/workflows/files'),
    );
    expect(body.success).toBe(true);
  });

  test('GET /:slug/workflows/:workflowId returns content', async () => {
    const app = mount(createMockLayoutService());
    const body = await json(
      await app.request('/agents/agent1/workflows/wf1.ts'),
    );
    expect(body).toEqual({ success: true, data: { content: '// code' } });
  });

  test('POST /:slug/workflows creates workflow', async () => {
    const app = mount(createMockLayoutService());
    const res = await app.request('/agents/agent1/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.ts', content: '// code' }),
    });
    expect(res.status).toBe(201);
  });

  test('PUT /:slug/workflows/:id updates workflow', async () => {
    const app = mount(createMockLayoutService());
    const res = await app.request('/agents/agent1/workflows/wf1.ts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '// updated' }),
    });
    expect(res.status).toBe(200);
  });

  test('DELETE /:slug/workflows/:id deletes workflow', async () => {
    const app = mount(createMockLayoutService());
    const res = await app.request('/agents/agent1/workflows/wf1.ts', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
  });

  test('a typed service refusal keeps its status, message and code', async () => {
    // The shape a typed layout service will throw. This is the assertion
    // that fails if a `catch (error) { return c.json(..., 400) }` is ever
    // put back: the hand-rolled envelope has no `code` and no
    // `correlationId`, and it answers the catch's hard-coded status rather
    // than the one the error named.
    const service = createMockLayoutService();
    service.createWorkflow.mockRejectedValue(
      new RouteError(409, "Workflow 'test.ts' already exists", {
        code: 'workflow_exists',
      }),
    );
    const app = mount(service);

    const response = await app.request('/agents/agent1/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.ts', content: '// code' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Workflow 'test.ts' already exists",
      code: 'workflow_exists',
      correlationId: expect.any(String),
    });
  });

  test('an untyped service failure is answered as a correlated internal error, not as its message', async () => {
    // Every one of these used to be caught in this file and answered with
    // the raw (sanitized) message under a hard-coded status: 500 for the
    // list, 404 for the read, 400 for the three mutations. `LayoutService`
    // throws only bare `Error`s, so after the migration all five reach the
    // boundary's generic envelope. The status column is the behaviour
    // change this test records.
    const cases = [
      {
        name: 'list',
        previousStatus: 500,
        arrange: (s: ReturnType<typeof createMockLayoutService>) =>
          s.listAgentWorkflows.mockRejectedValue(
            new Error('EACCES: permission denied'),
          ),
        request: () => ['/agents/agent1/workflows/files', undefined] as const,
      },
      {
        name: 'read',
        previousStatus: 404,
        arrange: (s: ReturnType<typeof createMockLayoutService>) =>
          s.getWorkflow.mockRejectedValue(
            new Error("Workflow 'wf1.ts' not found"),
          ),
        request: () => ['/agents/agent1/workflows/wf1.ts', undefined] as const,
      },
      {
        name: 'create',
        previousStatus: 400,
        arrange: (s: ReturnType<typeof createMockLayoutService>) =>
          s.createWorkflow.mockRejectedValue(
            new Error(
              'Workflow filename must end with .ts, .js, .mjs, or .cjs',
            ),
          ),
        request: () =>
          [
            '/agents/agent1/workflows',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: 'test.txt', content: '// c' }),
            },
          ] as const,
      },
      {
        name: 'update',
        previousStatus: 400,
        arrange: (s: ReturnType<typeof createMockLayoutService>) =>
          s.updateWorkflow.mockRejectedValue(new Error('Invalid workflow id')),
        request: () =>
          [
            '/agents/agent1/workflows/wf1.ts',
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: '// updated' }),
            },
          ] as const,
      },
      {
        name: 'delete',
        previousStatus: 400,
        arrange: (s: ReturnType<typeof createMockLayoutService>) =>
          s.deleteWorkflow.mockRejectedValue(
            new Error("Workflow 'wf1.ts' not found"),
          ),
        request: () =>
          ['/agents/agent1/workflows/wf1.ts', { method: 'DELETE' }] as const,
      },
    ];

    for (const scenario of cases) {
      const service = createMockLayoutService();
      scenario.arrange(service);
      const app = mount(service);
      const [path, init] = scenario.request();

      const response = await app.request(path, init as RequestInit | undefined);
      const body = (await response.json()) as Record<string, unknown>;

      expect(
        response.status,
        `${scenario.name}: was ${scenario.previousStatus}`,
      ).toBe(500);
      expect(body, scenario.name).toEqual({
        success: false,
        error: { code: 'internal_error', correlationId: expect.any(String) },
      });
      // The underlying text is no longer disclosed. Asserted per case
      // because each one's message is different, and this is the half of
      // the change a status assertion cannot see.
      expect(JSON.stringify(body), scenario.name).not.toContain('Workflow');
      expect(JSON.stringify(body), scenario.name).not.toContain('EACCES');
    }
  });
});
