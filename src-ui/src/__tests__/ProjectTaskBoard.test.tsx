/** @vitest-environment jsdom */
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type {
  TaskPullRequestFact,
  TaskPullRequestFactsProjection,
} from '@kontourai/station-contracts/task-lane';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  useOrchestrationSessionActivityQuery: vi.fn(),
  useOrchestrationSessionsQuery: vi.fn(),
  useTaskPullRequestFactsQuery: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...sdk,
}));

import { ProjectTaskBoard } from '../components/ProjectTaskBoard';
import { useTaskBoardModel } from '../views/project-page/useTaskBoardModel';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');

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
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

/** The read-model summary shape. */
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
    createdAt: '2026-11-15T10:00:00.000Z',
    updatedAt: '2026-11-15T11:00:00.000Z',
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
    observedAt: '2026-11-15T11:30:00.000Z',
    status: {
      state: 'current',
      pullRequestState: 'OPEN',
      mergeability: 'mergeable',
      ...status,
    },
  };
}

function facts(
  tasks: TaskRecord[],
  byTask: Record<string, TaskPullRequestFact[]>,
): TaskPullRequestFactsProjection {
  return {
    observedAt: '2026-11-15T11:30:00.000Z',
    tasks: Object.fromEntries(
      tasks
        .filter((t) => t.status !== 'done' && t.status !== 'canceled')
        .map((t) => [
          t.id,
          { taskCreatedAt: t.createdAt, pullRequests: byTask[t.id] ?? [] },
        ]),
    ),
  };
}

function Harness({
  tasks,
  onAction = vi.fn(),
  onOpenTask = vi.fn(),
}: {
  tasks: TaskRecord[];
  onAction?: (...args: unknown[]) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const model = useTaskBoardModel({
    projectSlug: 'demo',
    tasks,
    tasksSettled: true,
  });
  if (model.status === 'loading') return <p>loading</p>;
  return (
    <ProjectTaskBoard
      partition={model.partition}
      derivations={model.derivations}
      tasks={new Map(tasks.map((t) => [t.id, t]))}
      sessionsById={model.sessionsById}
      agents={[]}
      onAction={onAction}
      onOpenTask={onOpenTask}
    />
  );
}

function given({
  sessions = [],
  pullRequests = {},
  tasks,
}: {
  sessions?: OrchestrationSessionSummary[];
  pullRequests?: Record<string, TaskPullRequestFact[]>;
  tasks: TaskRecord[];
}) {
  sdk.useOrchestrationSessionsQuery.mockReturnValue({
    data: sessions,
    isError: false,
    refetch: vi.fn(),
  });
  sdk.useTaskPullRequestFactsQuery.mockReturnValue({
    data: facts(tasks, pullRequests),
    isError: false,
    refetch: vi.fn(),
  });
}

const lane = (name: string) =>
  screen.getByRole('region', { name: new RegExp(`^${name}`) });
const cardTitles = (name: string) =>
  within(lane(name))
    .queryAllByRole('article')
    .map((card) => within(card).getByRole('link').textContent);

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sdk.useOrchestrationSessionActivityQuery.mockReset();
  sdk.useOrchestrationSessionActivityQuery.mockReturnValue({ data: undefined });
});

/** One Task per live lane, plus one on each shelf. */
const MIXED = [
  task('approve', { sessionId: 'run-approve' }),
  task('running', { sessionId: 'run-running' }),
  task('review', { sessionId: 'run-review' }),
  task('ready', { sessionId: 'run-ready' }),
  task('fresh', { status: 'ready' }),
  task('backlog', { status: 'todo' }),
  task('shipped', { status: 'done' }),
];
const MIXED_SESSIONS = [
  session('run-approve', {
    lifecycleState: 'review_pending',
    pendingReview: true,
  }),
  session('run-running', { lifecycleState: 'running', hasActiveTurn: true }),
  session('run-review', { lifecycleState: 'completed' }),
  session('run-ready', { lifecycleState: 'completed' }),
];
const MIXED_PRS = {
  review: [pr('41', { readiness: 'checks-failing' })],
  ready: [pr('42', { readiness: 'clean' })],
};

describe('ProjectTaskBoard', () => {
  test('files each Task in its derived lane, with all five lanes shown', () => {
    given({ tasks: MIXED, sessions: MIXED_SESSIONS, pullRequests: MIXED_PRS });
    render(<Harness tasks={MIXED} />);

    expect(cardTitles('Needs you')).toEqual(['Work approve']);
    expect(cardTitles('Running')).toEqual(['Work running']);
    expect(cardTitles('In review')).toEqual(['Work review']);
    expect(cardTitles('Ready to merge')).toEqual(['Work ready']);
    expect(cardTitles('Idle')).toEqual(['Work fresh']);
    // The shelves hold intent, not lanes.
    const shelves = [
      ...document.querySelectorAll<HTMLDetailsElement>('details[data-shelf]'),
    ].map((shelf) => [
      shelf.dataset.shelf,
      within(shelf).queryAllByRole('article').length,
    ]);
    expect(shelves).toEqual([
      ['backlog', 1],
      ['done', 1],
    ]);
  });

  test('an empty lane says so, and still counts', () => {
    const tasks = [task('fresh', { status: 'ready' })];
    given({ tasks });
    render(<Harness tasks={tasks} />);
    const ready = lane('Ready to merge');
    expect(within(ready).getByText('Nothing here')).toBeTruthy();
    expect(within(ready).getByText('0')).toBeTruthy();
  });

  test('each card has one status slot, one status line and exactly one action, worded by its rung', () => {
    given({ tasks: MIXED, sessions: MIXED_SESSIONS, pullRequests: MIXED_PRS });
    render(<Harness tasks={MIXED} />);
    const expected: Record<string, [line: string, action: string]> = {
      'Work approve': ['Needs approval', 'Approve…'],
      'Work running': ['Running', 'Open run'],
      'Work review': ['Some checks failing · #41', 'Open PR'],
      'Work ready': ['Ready to merge · #42', 'Merge…'],
      'Work fresh': ['Not started', 'Start'],
    };
    for (const card of screen.getAllByRole('article')) {
      const title = within(card).getByRole('link').textContent ?? '';
      if (!(title in expected)) continue;
      const [line, action] = expected[title] as [string, string];
      expect(card.querySelectorAll('.task-card__status')).toHaveLength(1);
      expect(card.querySelectorAll('.task-card__status-line')).toHaveLength(1);
      expect(card.querySelector('.task-card__status-line')?.textContent).toBe(
        line,
      );
      const buttons = within(card).getAllByRole('button');
      expect(buttons.map((button) => button.textContent)).toEqual([action]);
    }
  });

  test('the title is a link to the Task, and the action is its sibling', () => {
    const onOpenTask = vi.fn();
    const onAction = vi.fn();
    given({ tasks: MIXED, sessions: MIXED_SESSIONS, pullRequests: MIXED_PRS });
    render(
      <Harness tasks={MIXED} onOpenTask={onOpenTask} onAction={onAction} />,
    );
    const title = screen.getByRole('link', { name: 'Work ready' });
    expect(title.getAttribute('href')).toBe('/tasks/ready');
    expect(title.querySelector('button')).toBeNull();
    fireEvent.click(title);
    expect(onOpenTask).toHaveBeenCalledWith('ready');
    fireEvent.click(screen.getByRole('button', { name: 'Merge Work ready' }));
    expect(onAction).toHaveBeenCalledWith(
      'ready',
      expect.objectContaining({ kind: 'open-pull-request', label: 'Merge…' }),
    );
  });

  test('a card keeps its place when live data updates it; an arrival goes on top', () => {
    const first = [
      task('a', { status: 'ready', updatedAt: '2026-11-10T00:00:00.000Z' }),
      task('b', { status: 'ready', updatedAt: '2026-11-09T00:00:00.000Z' }),
    ];
    given({ tasks: first });
    const { rerender } = render(<Harness tasks={first} />);
    expect(cardTitles('Idle')).toEqual(['Work a', 'Work b']);

    const next = [
      first[0] as TaskRecord,
      task('b', { status: 'ready', updatedAt: '2026-11-15T00:00:00.000Z' }),
      task('c', { status: 'ready', updatedAt: '2026-11-01T00:00:00.000Z' }),
    ];
    given({ tasks: next });
    rerender(<Harness tasks={next} />);
    expect(cardTitles('Idle')).toEqual(['Work c', 'Work a', 'Work b']);
  });

  test('focus follows a card that moves to another lane', () => {
    const tasks = [task('moving', { sessionId: 'run-m' })];
    given({
      tasks,
      sessions: [
        session('run-m', { lifecycleState: 'running', hasActiveTurn: true }),
      ],
    });
    const { rerender } = render(<Harness tasks={tasks} />);
    const before = screen.getByRole('link', { name: 'Work moving' });
    act(() => before.focus());
    expect(cardTitles('Running')).toEqual(['Work moving']);

    given({
      tasks,
      sessions: [
        session('run-m', {
          lifecycleState: 'review_pending',
          pendingReview: true,
        }),
      ],
    });
    rerender(<Harness tasks={tasks} />);
    expect(cardTitles('Needs you')).toEqual(['Work moving']);
    const after = screen.getByRole('link', { name: 'Work moving' });
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
  });

  test('a continued run reads its conversation’s current execution, not the first one’s outcome', () => {
    const tasks = [task('resumed', { sessionId: 'run-first' })];
    given({
      tasks,
      sessions: [
        // The first execution failed; the conversation then continued in a
        // new child, which every summary of it names as current.
        session('run-first', {
          lifecycleState: 'failed',
          currentSessionId: 'run-first:session:2',
        }),
        session('run-first:session:2', {
          lifecycleState: 'running',
          hasActiveTurn: true,
          currentSessionId: 'run-first:session:2',
        }),
      ],
    });
    const onAction = vi.fn();
    render(<Harness tasks={tasks} onAction={onAction} />);
    expect(cardTitles('Running')).toEqual(['Work resumed']);
    expect(cardTitles('Needs you')).toEqual([]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Open run Work resumed' }),
    );
    expect(onAction).toHaveBeenCalledWith('resumed', {
      kind: 'open-session',
      sessionId: 'run-first:session:2',
      label: 'Open run',
    });
  });

  test('a run that cannot be read is "Run status unavailable", never Stopped', () => {
    const tasks = [task('lost', { sessionId: 'run-gone' })];
    given({ tasks, sessions: [] });
    render(<Harness tasks={tasks} />);
    const card = within(lane('Idle')).getByRole('article');
    expect(card.querySelector('.task-card__status-line')?.textContent).toBe(
      'Run status unavailable',
    );
  });
});
