/** @vitest-environment jsdom */
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type {
  TaskPullRequestFact,
  TaskPullRequestFactsProjection,
} from '@kontourai/station-contracts/task-lane';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  useTasksQuery: vi.fn(),
  useOrchestrationSessionsQuery: vi.fn(),
  useTaskPullRequestFactsQuery: vi.fn(),
  useReopenTaskOnOverviewMutation: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...sdk,
}));
const flags = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags.current,
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'claude', name: 'Claude' }],
}));
vi.mock('../contexts/useOpenInRegion', () => ({
  useOpenPullRequestInRegion: () => undefined,
}));

import { ProjectOverviewSection } from '../views/project-page/ProjectOverviewSection';

const DAY = 86_400_000;
const RECENT = new Date(Date.now() - DAY).toISOString();
const STALE = new Date(Date.now() - 30 * DAY).toISOString();

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    projectId: 'demo',
    title: `Work ${id}`,
    description: '',
    status: 'in_progress',
    priority: 'normal',
    createdBy: 'user',
    agentId: 'claude',
    sessionId: `run-${id}`,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: RECENT,
    ...overrides,
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
    createdAt: RECENT,
    updatedAt: RECENT,
    ...overrides,
  };
}

function pr(
  ref: string,
  status: Partial<
    Extract<TaskPullRequestFact['status'], { state: 'current' }>
  > = {},
): TaskPullRequestFact {
  return {
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'acme', name: 'app' },
    ref,
    url: `https://github.com/acme/app/pull/${ref}`,
    observedAt: RECENT,
    status: {
      state: 'current',
      pullRequestState: 'OPEN',
      mergeability: 'mergeable',
      ...status,
    },
  };
}

const reopen = { mutateAsync: vi.fn(async () => ({})), isPending: false };

function seed(
  tasks: (TaskRecord & { latestReport?: { text: string; at: string } })[],
  sessions: OrchestrationSessionSummary[],
  byTask: Record<string, TaskPullRequestFact[]>,
) {
  sdk.useTasksQuery.mockReturnValue({
    data: tasks,
    isSuccess: true,
    error: null,
    refetch: vi.fn(),
  });
  sdk.useOrchestrationSessionsQuery.mockReturnValue({
    data: sessions,
    isError: false,
    refetch: vi.fn(),
  });
  const facts: TaskPullRequestFactsProjection = {
    observedAt: RECENT,
    tasks: Object.fromEntries(
      tasks.map((t) => [
        t.id,
        { taskCreatedAt: t.createdAt, pullRequests: byTask[t.id] ?? [] },
      ]),
    ),
  };
  sdk.useTaskPullRequestFactsQuery.mockReturnValue({
    data: facts,
    isError: false,
    refetch: vi.fn(),
  });
  sdk.useReopenTaskOnOverviewMutation.mockReturnValue(reopen);
}

/** The group heading whose list holds `title`. */
function groupOf(title: string): string | null {
  const row = screen.getByText(title).closest('li');
  const list = row?.closest('ul');
  const labelId = list?.getAttribute('aria-labelledby');
  const heading = labelId ? document.getElementById(labelId) : null;
  // A plain heading reads "Label<count>"; the Resolved disclosure reads
  // "Label · count" in its label span.
  const label =
    heading?.querySelector('.disclosure-toggle__label')?.textContent ??
    heading?.firstChild?.textContent ??
    null;
  return label?.split(' · ')[0] ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.current = new Set(['project-overview']);
});

describe('ProjectOverviewSection', () => {
  test('with the Project Overview preview off it renders and reads nothing', () => {
    flags.current = new Set();
    seed([task('a')], [session('run-a')], {});
    const { container } = render(<ProjectOverviewSection slug="demo" />);
    expect(container.textContent).toBe('');
    expect(sdk.useTasksQuery).not.toHaveBeenCalled();
  });

  test('files seeded Tasks under the group for their next action', () => {
    seed(
      [
        task('ask'),
        task('fail'),
        task('run'),
        task('review'),
        task('stall'),
        task('queued'),
        task('done-turn', {
          latestReport: { text: 'Fixed the login test', at: RECENT },
        } as Partial<TaskRecord>),
        task('merged'),
      ],
      [
        session('run-ask', {
          lifecycleState: 'needs_input',
          transitionReason: 'input_requested',
        }),
        session('run-fail', { lifecycleState: 'failed' }),
        session('run-run', { lifecycleState: 'running', hasActiveTurn: true }),
        session('run-review'),
        session('run-stall'),
        session('run-queued'),
        session('run-done-turn'),
        session('run-merged'),
      ],
      {
        review: [
          pr('1', { readiness: 'blocked', reviewDecision: 'review_required' }),
        ],
        stall: [pr('2', { readiness: 'clean', landing: 'not-queued' })],
        queued: [pr('3', { readiness: 'clean', landing: 'merge-queue' })],
        merged: [pr('4', { pullRequestState: 'MERGED' })],
      },
    );
    render(<ProjectOverviewSection slug="demo" />);
    expect(groupOf('Work ask')).toBe('Waiting on you');
    expect(groupOf('Work fail')).toBe('Waiting on you');
    expect(groupOf('Work run')).toBe('Working');
    expect(groupOf('Work review')).toBe('Ready for review');
    expect(groupOf('Work stall')).toBe('Ready for review');
    expect(groupOf('Work queued')).toBe('Landing');
    expect(groupOf('Work done-turn')).toBe('Idle');
    // The green PR nobody armed says so.
    const stall = screen.getByText('Work stall').closest('li')!;
    expect(within(stall).getByText(/Not queued/)).toBeTruthy();
    expect(within(stall).getByRole('button', { name: /#2 · Checks passed/ }));
    // The latest report line and the agent chip.
    const idle = screen.getByText('Work done-turn').closest('li')!;
    expect(within(idle).getByText('Fixed the login test')).toBeTruthy();
    expect(within(idle).getByText('Claude')).toBeTruthy();
    // Resolved is folded until opened.
    expect(screen.queryByText('Work merged')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Resolved · 1/ }));
    expect(groupOf('Work merged')).toBe('Resolved');
  });

  test('a row opens its Task; an auto-resolved row offers Reopen', async () => {
    seed(
      [task('quiet', { updatedAt: STALE })],
      [session('run-quiet', { createdAt: STALE, updatedAt: STALE })],
      {},
    );
    render(<ProjectOverviewSection slug="demo" />);
    fireEvent.click(screen.getByRole('button', { name: /Resolved · 1/ }));
    const row = screen.getByText('Work quiet').closest('li')!;
    expect(within(row).getByText('Auto-resolved')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: /^Work quiet/ }));
    expect(navigate).toHaveBeenCalledWith('/tasks/quiet');
    fireEvent.click(
      within(row).getByRole('button', { name: 'More actions for Work quiet' }),
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reopen' }));
    expect(reopen.mutateAsync).toHaveBeenCalledWith({ taskId: 'quiet' });
  });
});
