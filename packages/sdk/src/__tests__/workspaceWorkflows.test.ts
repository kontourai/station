import type { WorkflowMetadata } from '@kontourai/station-contracts/runtime';
import { beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  getApiBase: vi.fn(),
  useApiMutation: vi.fn(),
  useApiQuery: vi.fn(),
}));

vi.mock('../api', () => ({ _getApiBase: mocks.getApiBase }));
vi.mock('../client/http', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));
vi.mock('../query-core', () => ({
  useApiMutation: mocks.useApiMutation,
  useApiQuery: mocks.useApiQuery,
}));

import { useAgentWorkflowsQuery } from '../query-domains/workspaceWorkflows';

describe('workspace workflow query contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiBase.mockResolvedValue('https://station.example.test');
  });

  test('publishes the server WorkflowMetadata shape without a file-system projection', () => {
    expectTypeOf<
      ReturnType<typeof useAgentWorkflowsQuery>['data']
    >().toEqualTypeOf<WorkflowMetadata[] | undefined>();
  });

  test('returns the server WorkflowMetadata response unchanged', async () => {
    const metadata: WorkflowMetadata[] = [
      {
        id: 'daily-brief',
        label: 'Daily Brief',
        filename: 'daily-brief.ts',
        lastModified: '2026-07-07T12:00:00.000Z',
      },
    ];
    mocks.authenticatedFetch.mockResolvedValue({
      json: async () => ({ success: true, data: metadata }),
    });
    mocks.useApiQuery.mockImplementation((_key, queryFn) => ({ queryFn }));

    useAgentWorkflowsQuery('agent one');
    const queryFn = mocks.useApiQuery.mock.calls[0]?.[1];
    if (!queryFn) throw new Error('Expected workflow query function.');
    const workflows = await queryFn();

    expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      'https://station.example.test/agents/agent%20one/workflows/files',
    );
    expect(workflows).toEqual(metadata);
  });
});
