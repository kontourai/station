import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  templateOps: { add: vi.fn() },
}));

const { TemplateService } = await import('../template-service.js');

describe('TemplateService', () => {
  test('listTemplates returns builtins', async () => {
    const svc = new TemplateService();
    const all = await svc.listTemplates();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((t) => t.source === 'built-in')).toBe(true);
  });

  test('listTemplates filters by type', async () => {
    const svc = new TemplateService();
    const agents = await svc.listTemplates('agent');
    const layouts = await svc.listTemplates('layout');
    expect(agents.every((t) => t.type === 'agent')).toBe(true);
    expect(layouts.every((t) => t.type === 'layout')).toBe(true);
    expect(agents.length + layouts.length).toBe(
      (await svc.listTemplates()).length,
    );
  });

  test('addProvider contributes templates', async () => {
    const svc = new TemplateService();
    const before = (await svc.listTemplates()).length;
    svc.addProvider({
      id: 'mock',
      displayName: 'Mock',
      listTemplates: async () => [
        {
          id: 'custom',
          icon: '🎯',
          label: 'Custom',
          description: 'Test',
          type: 'agent' as const,
          form: { name: 'C', slug: 'c', description: '', prompt: '' },
        },
      ],
    });
    const after = await svc.listTemplates();
    expect(after.length).toBe(before + 1);
    expect(after.find((t) => t.id === 'custom')?.source).toBe('mock');
  });

  test('provider failure is non-fatal', async () => {
    const svc = new TemplateService();
    svc.addProvider({
      id: 'bad',
      displayName: 'Bad',
      listTemplates: async () => {
        throw new Error('boom');
      },
    });
    const all = await svc.listTemplates();
    expect(all.length).toBeGreaterThan(0); // builtins still returned
  });
});
