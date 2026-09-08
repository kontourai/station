import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { createRouteTestApp } from '../../../__test-utils__/route-test-app.js';
import { ReservedAgentIdentityError } from '../../../domain/agent-registry.js';
import {
  WorkflowExistsError,
  WorkflowInvalidError,
  WorkflowNotFoundError,
} from '../../../domain/agent-workflow-errors.js';
import type { LayoutService } from '../../../services/projects/layout-service.js';
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
type Service = ReturnType<typeof createMockLayoutService>;

/**
 * Mounted at the path production mounts it at
 * (`runtime-routes.ts`: `context.app.route('/agents', ...)`), through the
 * runtime HTTP boundary. Without the boundary these handlers throw straight
 * out of `app.request` — they format nothing themselves.
 */
function mount(service: Service) {
  const app = createRouteTestApp();
  app.route(
    '/agents',
    createWorkflowRoutes(service as unknown as LayoutService),
  );
  return app;
}

const CREATE = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename: 'build.ts', content: '// code' }),
} satisfies RequestInit;
const UPDATE = {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: '// updated' }),
} satisfies RequestInit;

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
      await app.request('/agents/agent1/workflows/build.ts'),
    );
    expect(body).toEqual({ success: true, data: { content: '// code' } });
  });

  test('POST /:slug/workflows creates workflow', async () => {
    const app = mount(createMockLayoutService());
    const res = await app.request('/agents/agent1/workflows', CREATE);
    expect(res.status).toBe(201);
  });

  test('PUT /:slug/workflows/:id updates workflow', async () => {
    const app = mount(createMockLayoutService());
    const res = await app.request('/agents/agent1/workflows/build.ts', UPDATE);
    expect(res.status).toBe(200);
  });

  test('DELETE /:slug/workflows/:id deletes workflow', async () => {
    const app = mount(createMockLayoutService());
    const res = await app.request('/agents/agent1/workflows/build.ts', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
  });

  // One row per caller-caused refusal the workflow store can produce, with
  // the status and text this file answered BEFORE the migration. Every row
  // keeps both; `code` and `correlationId` are the additions. The domain
  // classes are what `config-loader-agents.ts` actually throws --
  // `config-loader-agents-project.test.ts` runs the real store against a real
  // directory and asserts these exact classes come out, so these fixtures are
  // not a shape this route will never see.
  const typed: {
    name: string;
    /** What the route answered before the migration. */
    previously: { status: number; message: string };
    status: number;
    code: string;
    failure: Error;
    arrange: (service: Service, failure: Error) => void;
    request: readonly [string, RequestInit | undefined];
  }[] = [
    {
      name: 'read of a workflow that does not exist',
      previously: { status: 404, message: "Workflow 'build.ts' not found" },
      status: 404,
      code: 'workflow_not_found',
      failure: new WorkflowNotFoundError('build.ts'),
      arrange: (s, failure) => s.getWorkflow.mockRejectedValue(failure),
      request: ['/agents/agent1/workflows/build.ts', undefined],
    },
    {
      name: 'delete of a workflow that does not exist',
      previously: { status: 400, message: "Workflow 'build.ts' not found" },
      status: 404,
      code: 'workflow_not_found',
      failure: new WorkflowNotFoundError('build.ts'),
      arrange: (s, failure) => s.deleteWorkflow.mockRejectedValue(failure),
      request: ['/agents/agent1/workflows/build.ts', { method: 'DELETE' }],
    },
    {
      name: 'create of a workflow that already exists',
      previously: {
        status: 400,
        message: "Workflow 'build.ts' already exists",
      },
      status: 409,
      code: 'workflow_exists',
      failure: new WorkflowExistsError('build.ts'),
      arrange: (s, failure) => s.createWorkflow.mockRejectedValue(failure),
      request: ['/agents/agent1/workflows', CREATE],
    },
    {
      name: 'create with an unsupported extension',
      previously: {
        status: 400,
        message: 'Workflow filename must end with .ts, .js, .mjs, or .cjs',
      },
      status: 400,
      code: 'workflow_invalid',
      failure: new WorkflowInvalidError(
        'Workflow filename must end with .ts, .js, .mjs, or .cjs',
      ),
      arrange: (s, failure) => s.createWorkflow.mockRejectedValue(failure),
      request: ['/agents/agent1/workflows', CREATE],
    },
    {
      name: 'update with a workflow id that is a path',
      previously: { status: 400, message: 'Invalid workflow id' },
      status: 400,
      code: 'workflow_invalid',
      failure: new WorkflowInvalidError('Invalid workflow id'),
      arrange: (s, failure) => s.updateWorkflow.mockRejectedValue(failure),
      request: ['/agents/agent1/workflows/build.ts', UPDATE],
    },
    {
      name: 'create under a reserved agent identity',
      previously: {
        status: 400,
        message:
          "Agent 'default' is a retired Station identity and cannot be created or changed. Use the 'station' Agent instead.",
      },
      status: 400,
      code: 'AGENT_ID_RESERVED',
      failure: new ReservedAgentIdentityError('default'),
      arrange: (s, failure) => s.createWorkflow.mockRejectedValue(failure),
      request: ['/agents/default/workflows', CREATE],
    },
  ];

  for (const scenario of typed) {
    test(`${scenario.name}: keeps its message, gains a code`, async () => {
      // The row's `previously.message` is the text this route used to answer.
      // Asserting the fixture still produces it is what makes the response
      // assertion below a claim about continuity rather than about whatever
      // the fixture happens to say today.
      expect(scenario.failure.message).toBe(scenario.previously.message);

      const service = createMockLayoutService();
      scenario.arrange(service, scenario.failure);
      const app = mount(service);
      const [path, init] = scenario.request;

      const response = await app.request(path, init);

      expect(response.status, scenario.name).toBe(scenario.status);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: scenario.previously.message,
        code: scenario.code,
        correlationId: expect.any(String),
      });
    });
  }

  test('a status that changed did so only for a refusal whose old one was wrong', () => {
    // The two rows above whose status moved, pinned so the change is visible
    // in the test file and not only in a commit message. Both were 400 for a
    // condition 400 does not describe.
    expect(
      typed
        .filter((row) => row.previously.status !== row.status)
        .map((row) => `${row.name}: ${row.previously.status} -> ${row.status}`),
    ).toEqual([
      'delete of a workflow that does not exist: 400 -> 404',
      'create of a workflow that already exists: 400 -> 409',
    ]);
  });

  test('an untyped failure is answered as a correlated internal error, not as its message', async () => {
    // A disk error is not the caller's fault and carries no reviewed text.
    // This is the case that used to be labelled 400 by the same catch that
    // handled every row above.
    const service = createMockLayoutService();
    service.createWorkflow.mockRejectedValue(
      new Error('EACCES: permission denied, open /home/agents/build.ts'),
    );
    const app = mount(service);

    const response = await app.request('/agents/agent1/workflows', CREATE);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: 'internal_error', correlationId: expect.any(String) },
    });
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });

  test('an unmapped error from the list route is contained the same way', async () => {
    const service = createMockLayoutService();
    service.listAgentWorkflows.mockRejectedValue(new Error('EACCES: denied'));
    const app = mount(service);

    const response = await app.request('/agents/agent1/workflows/files');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'internal_error', correlationId: expect.any(String) },
    });
  });
});
