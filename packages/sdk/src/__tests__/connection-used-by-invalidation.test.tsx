/**
 * @vitest-environment jsdom
 *
 * What names each connection (`useConnectionUsedByQuery`) is read from saved
 * Agent and Project bindings, so saving or removing either refetches it, on
 * this Station and on a remote read target, and leaves other connection
 * reads alone.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

vi.mock('../client/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/agents')>()),
  updateAgentRaw: vi.fn().mockResolvedValue({}),
  deleteAgentRaw: vi.fn().mockResolvedValue({}),
}));

vi.mock('../client/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/projects')>()),
  updateProject: vi.fn().mockResolvedValue({}),
  deleteProject: vi.fn().mockResolvedValue({}),
}));

import {
  useDeleteAgentMutation,
  useUpdateAgentMutation,
} from '../query-domains/agentAdmin';
import {
  useDeleteProjectMutation,
  useUpdateProjectMutation,
} from '../query-domains/workspaceProjects';

const LOCAL = ['connections', 'used-by'];
const REMOTE = ['connections', 'https://other.test', 'authority', 'used-by'];
const OTHER = ['connections', 'list'];

function seeded() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  for (const key of [LOCAL, REMOTE, OTHER]) client.setQueryData(key, {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const invalidated = (key: string[]) =>
    client.getQueryState(key)?.isInvalidated;
  return { client, wrapper, invalidated };
}

async function expectRefetchAfter<V>(
  useHook: () => { mutateAsync: (variables: V) => Promise<unknown> },
  variables: V,
) {
  const { wrapper, invalidated } = seeded();
  const { result } = renderHook(useHook, { wrapper });
  await act(async () => {
    await result.current.mutateAsync(variables);
  });
  expect(invalidated(LOCAL)).toBe(true);
  expect(invalidated(REMOTE)).toBe(true);
  expect(invalidated(OTHER)).toBe(false);
}

describe('saving an Agent or a Project refetches what uses each connection', () => {
  test('updating an Agent', () =>
    expectRefetchAfter(useUpdateAgentMutation, {
      slug: 'reviewer',
      agent: { name: 'Reviewer' },
    }));
  test('removing an Agent', () =>
    expectRefetchAfter(useDeleteAgentMutation, 'reviewer'));
  test('updating a Project', () =>
    expectRefetchAfter(useUpdateProjectMutation, {
      slug: 'site',
      defaultModel: 'llama3',
    }));
  test('removing a Project', () =>
    expectRefetchAfter(useDeleteProjectMutation, 'site'));
});
