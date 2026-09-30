/**
 * @vitest-environment jsdom
 *
 * Keep invalidation, driven through the real mutation hook on a real
 * QueryClient. The cache is seeded from the production query factories, so a
 * factory whose key shape drifts away from what Keep invalidates turns this
 * red instead of leaving the kept output invisible to its readers.
 */
import type { TaskDeclaredOutputKeepResult } from '@kontourai/station-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  keepDeclaredTaskOutput: vi.fn(),
}));

vi.mock('../client/task-outputs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  keepDeclaredTaskOutput: transport.keepDeclaredTaskOutput,
}));

import { sessionInventoryQueries } from '../session-inventory';
import { useKeepSessionOutputMutation } from '../session-output-actions';
import { taskBasisQueries } from '../task-basis';
import { taskOutputQueries } from '../task-outputs';
import { taskToolResultQueries } from '../task-tool-results';

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

const scope = { apiBase: 'http://station.test', authorityKey: 'epoch-a' };
const otherAuthority = { ...scope, authorityKey: 'other-authority' };
const wholeSession = { kind: 'whole-session', sessionId: 'session-a' } as const;

describe('Session output Keep invalidation', () => {
  test('invalidates the kept Task families and only the matching authority inventory', async () => {
    transport.keepDeclaredTaskOutput.mockResolvedValue(keepResult);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const invalidated = {
      outputs: taskOutputQueries.outputs('task-a').queryKey,
      wholeTaskBasis: taskBasisQueries.task('task-a', undefined, scope),
      answerBasis: taskBasisQueries.task('task-a', 'answer-1', scope),
      toolResultReferences: taskToolResultQueries.references('task-a', scope)
        .queryKey,
      sessionInventory: sessionInventoryQueries.projection(wholeSession, scope)
        .queryKey,
      keptInTaskPage: sessionInventoryQueries.page(
        { kind: 'kept-in-task', sessionId: 'session-a', taskId: 'task-a' },
        'outputs',
        'next',
        scope,
      ).queryKey,
    };
    const untouched = {
      otherTaskOutputs: taskOutputQueries.outputs('task-b').queryKey,
      otherTaskBasis: taskBasisQueries.task('task-b', undefined, scope),
      otherAuthorityBasis: taskBasisQueries.task(
        'task-a',
        'answer-1',
        otherAuthority,
      ),
      otherAuthorityToolResults: taskToolResultQueries.references(
        'task-a',
        otherAuthority,
      ).queryKey,
      otherAuthorityInventory: sessionInventoryQueries.projection(
        wholeSession,
        otherAuthority,
      ).queryKey,
      otherSessionInventory: sessionInventoryQueries.projection(
        { kind: 'whole-session', sessionId: 'session-b' },
        scope,
      ).queryKey,
    };
    for (const key of [
      ...Object.values(invalidated),
      ...Object.values(untouched),
    ])
      client.setQueryData(key, { seeded: true });

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useKeepSessionOutputMutation(), {
      wrapper,
    });
    await act(() =>
      result.current.mutateAsync({
        taskId: 'task-a',
        sessionId: 'session-a',
        eventId: 'event-a',
        operationId: 'operation-a',
        requestScope: scope,
      }),
    );

    expect(transport.keepDeclaredTaskOutput).toHaveBeenCalledOnce();
    const isInvalidated = (key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated;
    for (const [name, key] of Object.entries(invalidated))
      expect({ name, invalidated: isInvalidated(key) }).toEqual({
        name,
        invalidated: true,
      });
    for (const [name, key] of Object.entries(untouched))
      expect({ name, invalidated: isInvalidated(key) }).toEqual({
        name,
        invalidated: false,
      });
  });
});
