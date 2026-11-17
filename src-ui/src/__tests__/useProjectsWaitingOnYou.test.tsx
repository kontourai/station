/** @vitest-environment jsdom */
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { render, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  useTasksQuery: vi.fn(),
  useOrchestrationSessionsQuery: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...sdk,
}));
const flags = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags.current,
}));

import { ProjectWaitingOnYouSource } from '../views/project-page/ProjectWaitingOnYouSource';
import { useProjectsWaitingOnYou } from '../views/project-page/useProjectsWaitingOnYou';
import { useWaitingOnYouCounts } from '../views/project-page/waitingOnYouStore';

function task(id: string, projectId: string): TaskRecord {
  return {
    id,
    projectId,
    title: id,
    description: '',
    status: 'in_progress',
    priority: 'normal',
    createdBy: 'user',
    agentId: 'claude',
    sessionId: `run-${id}`,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  };
}

function session(
  threadId: string,
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    threadId,
    provider: 'claude',
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 4,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.useTasksQuery.mockReturnValue({
    data: [task('ask', 'alpha'), task('done-turn', 'alpha'), task('b', 'beta')],
  });
  sdk.useOrchestrationSessionsQuery.mockReturnValue({
    data: [
      session('run-ask', {
        lifecycleState: 'needs_input',
        transitionReason: 'input_requested',
      }),
      session('run-done-turn'),
      session('run-b', { lifecycleState: 'failed' }),
    ],
    isError: false,
  });
});

describe('useProjectsWaitingOnYou', () => {
  test('with the preview off it reads no Tasks and counts nothing', () => {
    flags.current = new Set();
    const { result } = renderHook(() => useProjectsWaitingOnYou());
    expect(result.current.size).toBe(0);
    expect(sdk.useTasksQuery).toHaveBeenCalledWith(undefined, {
      enabled: false,
    });
  });

  test('with the preview on it loads the Overview rule and counts Waiting on you per Project', async () => {
    flags.current = new Set(['project-overview']);
    const { result } = renderHook(() => useProjectsWaitingOnYou());
    await waitFor(() => expect(result.current.size).toBeGreaterThan(0));
    expect(Object.fromEntries(result.current)).toEqual({ alpha: 1, beta: 1 });
    expect(sdk.useTasksQuery).toHaveBeenCalledWith(undefined, {
      enabled: true,
    });
  });

  test('the lazy source publishes the counts the sidebar rows read, and clears them when it unmounts', async () => {
    flags.current = new Set(['project-overview']);
    const reader = renderHook(() => useWaitingOnYouCounts());
    const source = render(<ProjectWaitingOnYouSource />);
    await waitFor(() =>
      expect(Object.fromEntries(reader.result.current)).toEqual({
        alpha: 1,
        beta: 1,
      }),
    );
    source.unmount();
    await waitFor(() => expect(reader.result.current.size).toBe(0));
  });
});
