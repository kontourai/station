import type { TaskDeclaredOutputKeepResult } from '@kontourai/station-contracts';
import type {
  MutationFunctionContext,
  UseMutationOptions,
} from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { KeepSessionOutputInput } from '../session-output-actions';

type KeepMutationOptions = UseMutationOptions<
  TaskDeclaredOutputKeepResult,
  Error,
  KeepSessionOutputInput
>;

const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));
const reactQuery = vi.hoisted(() => ({
  useMutation: vi.fn(),
}));
const successContext: MutationFunctionContext = {
  client: queryClient as never,
  meta: undefined,
};

const keepResult: TaskDeclaredOutputKeepResult = {
  version: 'task-declared-output-keep/v1',
  status: 'kept',
  kind: 'workspace-file',
  outcome: 'kept',
  output: {
    schemaVersion: 1,
    id: 'output-a',
    taskId: 'task-a',
    projectId: 'project-a',
    title: 'Output A',
    source: { kind: 'workspace-file', relativePath: 'report.txt' },
    materialization: {
      kind: 'snapshot',
      fileName: 'report.txt',
      mediaType: 'text/plain',
      byteLength: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      contentAvailable: true,
    },
    createdAt: '2026-08-27T00:00:00.000Z',
  },
};

vi.mock('@tanstack/react-query', () => ({
  useMutation: reactQuery.useMutation,
  useQueryClient: () => queryClient,
}));

import { useKeepSessionOutputMutation } from '../session-output-actions';

describe('Session output Keep invalidation', () => {
  beforeEach(() => vi.clearAllMocks());

  test('invalidates the exact Task families and only the matching authority inventory', async () => {
    reactQuery.useMutation.mockImplementation(
      (options: KeepMutationOptions) => options,
    );
    useKeepSessionOutputMutation();
    const input = {
      taskId: 'task-a',
      sessionId: 'session-a',
      eventId: 'event-a',
      operationId: 'operation-a',
      requestScope: {
        apiBase: 'http://station.test',
        authorityKey: 'epoch-a',
      },
    };
    const options = reactQuery.useMutation.mock.calls[0]?.[0] as
      | KeepMutationOptions
      | undefined;
    await options?.onSuccess?.(keepResult, input, undefined, successContext);

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['task-outputs', 'task-a'],
      exact: true,
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['task-basis', 'task-a', 'http://station.test', 'epoch-a'],
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: [
        'task-tool-result-references',
        'task-a',
        'http://station.test',
        'epoch-a',
      ],
      exact: true,
    });
    const inventoryCall = queryClient.invalidateQueries.mock.calls.find(
      ([options]) => typeof options.predicate === 'function',
    );
    const matches = inventoryCall?.[0].predicate as (query: {
      queryKey: readonly unknown[];
    }) => boolean;
    expect(
      matches({
        queryKey: [
          'session-inventory',
          { kind: 'whole-session', sessionId: 'session-a' },
          'http://station.test',
          'epoch-a',
        ],
      }),
    ).toBe(true);
    expect(
      matches({
        queryKey: [
          'session-inventory-page',
          { kind: 'kept-in-task', sessionId: 'session-a', taskId: 'task-a' },
          'outputs',
          'next',
          'http://station.test',
          'epoch-a',
        ],
      }),
    ).toBe(true);
    expect(
      matches({
        queryKey: [
          'session-inventory',
          { kind: 'whole-session', sessionId: 'session-a' },
          'http://station.test',
          'other-authority',
        ],
      }),
    ).toBe(false);
  });
});
