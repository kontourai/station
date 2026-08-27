import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  workItemProviderListTotal: { add: vi.fn() },
}));

const { WorkItemProviderService } = await import(
  '../work-item-provider-service.js'
);

const context = {
  projectId: 'project-alpha',
  workingDirectory: '/tmp/project-alpha',
};

function fakeProvider(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    identity: { kind: 'local', id: 'local', label: 'Station' },
    capabilities: {
      readOnly: false,
      supportsDispatch: true,
      supportsStatusWrite: false,
    },
    listWorkItems: vi.fn(async () => ({ available: true, items: [] })),
    ...overrides,
  };
}

describe('WorkItemProviderService', () => {
  test('aggregates every registered provider into one response', async () => {
    const local = fakeProvider({
      listWorkItems: vi.fn(async () => ({
        available: true,
        items: [
          {
            id: 'task-1',
            title: 'Local task',
            status: 'todo',
            provider: { kind: 'local', id: 'local', label: 'Station' },
          },
        ],
      })),
    });
    const external = fakeProvider({
      identity: {
        kind: 'flow-agents-github',
        id: 'flow-agents-github',
        label: 'Flow Agents (GitHub)',
      },
      capabilities: {
        readOnly: true,
        supportsDispatch: false,
        supportsStatusWrite: false,
      },
      listWorkItems: vi.fn(async () => ({
        available: false,
        items: [],
        reason: 'no backlog provider settings configured',
      })),
    });
    const service = new WorkItemProviderService([local, external] as any);

    const result = await service.listWorkItems(context);

    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]).toMatchObject({
      identity: { kind: 'local' },
      available: true,
      items: [{ id: 'task-1' }],
    });
    expect(result.providers[1]).toMatchObject({
      identity: { kind: 'flow-agents-github' },
      available: false,
      reason: 'no backlog provider settings configured',
    });
    expect(local.listWorkItems).toHaveBeenCalledWith(context);
    expect(external.listWorkItems).toHaveBeenCalledWith(context);
  });

  test('never throws when a backend throws unexpectedly — reports available: false instead', async () => {
    const broken = fakeProvider({
      listWorkItems: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const service = new WorkItemProviderService([broken] as any);

    const result = await service.listWorkItems(context);

    expect(result.providers).toEqual([
      {
        identity: broken.identity,
        capabilities: broken.capabilities,
        available: false,
        items: [],
        reason: 'boom',
      },
    ]);
  });
});
