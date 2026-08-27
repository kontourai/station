import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  templateOps: { add: vi.fn() },
}));

const { createTemplateRoutes } = await import('../templates.js');

function createMockStorageAdapter() {
  const templates = new Map<string, any>();
  return {
    listTemplates: vi.fn(() => [...templates.values()]),
    getTemplate: vi.fn((id: string) => templates.get(id) || null),
    saveTemplate: vi.fn((t: any) => templates.set(t.id, t)),
    deleteTemplate: vi.fn((id: string) => templates.delete(id)),
  };
}

describe('Template Routes', () => {
  test('GET / returns empty list', async () => {
    const app = createTemplateRoutes(createMockStorageAdapter() as any);
    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test('POST / creates a template', async () => {
    const adapter = createMockStorageAdapter();
    const app = createTemplateRoutes(adapter as any);
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test',
        description: 'A test',
        type: 'agent',
      }),
    });
    const body = await json(res);
    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Test');
    expect(adapter.saveTemplate).toHaveBeenCalled();
  });

  test('GET /:id returns 404 for missing', async () => {
    const app = createTemplateRoutes(createMockStorageAdapter() as any);
    const res = await app.request('/nonexistent');
    expect(res.status).toBe(404);
  });

  test('DELETE /:id removes template', async () => {
    const adapter = createMockStorageAdapter();
    const app = createTemplateRoutes(adapter as any);
    const res = await app.request('/t1', { method: 'DELETE' });
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(adapter.deleteTemplate).toHaveBeenCalledWith('t1');
  });
});
