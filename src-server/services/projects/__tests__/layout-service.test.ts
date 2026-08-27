import { describe, expect, test, vi } from 'vitest';

const { LayoutService } = await import('../layout-service.js');

function createMockConfigLoader() {
  return {
    listAgentWorkflows: vi.fn().mockResolvedValue([]),
    readWorkflow: vi.fn().mockResolvedValue('// code'),
    createWorkflow: vi.fn().mockResolvedValue(undefined),
    updateWorkflow: vi.fn().mockResolvedValue(undefined),
    deleteWorkflow: vi.fn().mockResolvedValue(undefined),
  };
}

describe('LayoutService', () => {
  test('workflow CRUD delegates', async () => {
    const loader = createMockConfigLoader();
    const svc = new LayoutService(loader as any, {});
    await svc.listAgentWorkflows('agent1');
    expect(loader.listAgentWorkflows).toHaveBeenCalledWith('agent1');
    await svc.getWorkflow('agent1', 'wf1');
    expect(loader.readWorkflow).toHaveBeenCalledWith('agent1', 'wf1');
    await svc.createWorkflow('agent1', 'wf.ts', '// code');
    expect(loader.createWorkflow).toHaveBeenCalledWith(
      'agent1',
      'wf.ts',
      '// code',
    );
    await svc.deleteWorkflow('agent1', 'wf1');
    expect(loader.deleteWorkflow).toHaveBeenCalledWith('agent1', 'wf1');
  });
});
