import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

const { createWorkflowRoutes } = await import('../layouts.js');

function createMockLayoutService() {
  return {
    listAgentWorkflows: vi.fn().mockResolvedValue([]),
    getWorkflow: vi.fn().mockResolvedValue('// code'),
    createWorkflow: vi.fn().mockResolvedValue(undefined),
    updateWorkflow: vi.fn().mockResolvedValue(undefined),
    deleteWorkflow: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Workflow Routes', () => {
  test('GET /:slug/workflows/files lists workflows', async () => {
    const app = createWorkflowRoutes(createMockLayoutService() as any);
    const body = await json(await app.request('/agent1/workflows/files'));
    expect(body.success).toBe(true);
  });

  test('POST /:slug/workflows creates workflow', async () => {
    const app = createWorkflowRoutes(createMockLayoutService() as any);
    const res = await app.request('/agent1/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.ts', content: '// code' }),
    });
    expect(res.status).toBe(201);
  });

  test('DELETE /:slug/workflows/:id deletes workflow', async () => {
    const app = createWorkflowRoutes(createMockLayoutService() as any);
    const res = await app.request('/agent1/workflows/wf1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
  });
});
