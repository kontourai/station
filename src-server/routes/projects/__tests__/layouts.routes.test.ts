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
    // boundary's generic envelope. The `previousStatus` column is the
    // behaviour change this test records.
    type Service = ReturnType<typeof createMockLayoutService>;
    const cases: {
      name: string;
      previousStatus: number;
      /** The service's real text for this failure. */
      message: string;
      /** A phrase of `message` that must not survive to the client. */
      withheld: string;
      arrange: (service: Service, failure: Error) => void;
      request: readonly [string, RequestInit | undefined];
    }[] = [
      {
        name: 'list',
        previousStatus: 500,
        message: 'EACCES: permission denied',
        withheld: 'permission denied',
        arrange: (s, failure) =>
          s.listAgentWorkflows.mockRejectedValue(failure),
        request: ['/agents/agent1/workflows/files', undefined],
      },
      {
        name: 'read',
        previousStatus: 404,
        message: "Workflow 'wf1.ts' not found",
        withheld: "'wf1.ts' not found",
        arrange: (s, failure) => s.getWorkflow.mockRejectedValue(failure),
        request: ['/agents/agent1/workflows/wf1.ts', undefined],
      },
      {
        name: 'create',
        previousStatus: 400,
        message: 'Workflow filename must end with .ts, .js, .mjs, or .cjs',
        withheld: 'must end with',
        arrange: (s, failure) => s.createWorkflow.mockRejectedValue(failure),
        request: [
          '/agents/agent1/workflows',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'test.txt', content: '// c' }),
          },
        ],
      },
      {
        name: 'update',
        previousStatus: 400,
        message: 'Invalid workflow id',
        withheld: 'Invalid workflow id',
        arrange: (s, failure) => s.updateWorkflow.mockRejectedValue(failure),
        request: [
          '/agents/agent1/workflows/wf1.ts',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '// updated' }),
          },
        ],
      },
      {
        name: 'delete',
        previousStatus: 400,
        message: "Workflow 'wf1.ts' not found",
        withheld: "'wf1.ts' not found",
        arrange: (s, failure) => s.deleteWorkflow.mockRejectedValue(failure),
        request: ['/agents/agent1/workflows/wf1.ts', { method: 'DELETE' }],
      },
    ];

    for (const scenario of cases) {
      // The phrase really is in the text this case throws, so the
      // non-disclosure assertion below is live for every case. A single
      // shared token would be vacuous for whichever message lacks it.
      expect(scenario.message, scenario.name).toContain(scenario.withheld);

      const service = createMockLayoutService();
      scenario.arrange(service, new Error(scenario.message));
      const app = mount(service);
      const [path, init] = scenario.request;

      const response = await app.request(path, init);
      const body = (await response.json()) as Record<string, unknown>;

      expect(
        response.status,
        `${scenario.name}: was ${scenario.previousStatus}`,
      ).toBe(500);
      expect(body, scenario.name).toEqual({
        success: false,
        error: { code: 'internal_error', correlationId: expect.any(String) },
      });
      // The half of the change a status assertion cannot see.
      expect(JSON.stringify(body), scenario.name).not.toContain(
        scenario.withheld,
      );
    }
  });
});
