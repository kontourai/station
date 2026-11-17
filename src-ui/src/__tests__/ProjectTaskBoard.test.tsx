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
  readPullRequests = true,
  pendingTaskIds,
}: {
  tasks: TaskRecord[];
  readPullRequests?: boolean;
  pendingTaskIds?: ReadonlySet<string>;
  onAction?: (...args: unknown[]) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const model = useTaskBoardModel({
    projectSlug: 'demo',
    tasks,
    tasksSettled: true,
    agents: [],
    readPullRequests,
  });
  if (model.status === 'loading') return <p>loading</p>;
  return (
    <ProjectTaskBoard
      partition={model.partition}
      derivations={model.derivations}
      presentations={model.presentations}
      tasks={new Map(tasks.map((t) => [t.id, t]))}
      settled={model.pullRequests.settled}
      pendingTaskIds={pendingTaskIds}
      onAction={onAction}
      onOpenTask={onOpenTask}
    />
  );
}

function given({
  sessions = [],
  pullRequests = {},
  tasks,
  factsPending = false,
}: {
  sessions?: OrchestrationSessionSummary[];
  pullRequests?: Record<string, TaskPullRequestFact[]>;
  tasks: TaskRecord[];
  /** The facts read has not answered yet. */
  factsPending?: boolean;
}) {
  sdk.useOrchestrationSessionsQuery.mockReturnValue({
    data: sessions,
    isError: false,
    refetch: vi.fn(),
  });
  sdk.useTaskPullRequestFactsQuery.mockReturnValue({
    data: factsPending ? undefined : facts(tasks, pullRequests),
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
  review: [pr('41', { readiness: 'checks-not-passing' })],
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
    // The shelves hold intent, not lanes; each opens to its cards.
    for (const name of [/^Backlog/, /^Done/])
      fireEvent.click(screen.getByRole('button', { name }));
    const shelves = [
      ...document.querySelectorAll<HTMLElement>('[data-shelf]'),
    ].map((shelf) => [
      shelf.dataset.shelf,
      within(shelf).queryAllByRole('article').length,
    ]);
    expect(shelves).toEqual([
      ['backlog', 1],
      ['done', 1],
    ]);
  });

  test('agent feedback adds a note to the card, never moves it', () => {
    const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const fed = (
      feedback: TaskPullRequestFact['feedback'],
      ref = '41',
    ): TaskPullRequestFact => ({
      ...pr(ref, { readiness: 'checks-not-passing', headSha: HEAD }),
      feedback,
    });
    const tasks = [
      task('review', { sessionId: 'run-review' }),
      task('running', { sessionId: 'run-running' }),
    ];
    given({
      tasks,
      sessions: [
        session('run-review', { lifecycleState: 'completed' }),
        session('run-running', {
          lifecycleState: 'running',
          hasActiveTurn: true,
        }),
      ],
      pullRequests: {
        review: [
          fed({
            state: 'sent',
            headSha: HEAD,
            at: new Date(NOW - 3 * 60_000).toISOString(),
          }),
        ],
        running: [fed({ state: 'fixing', headSha: HEAD }, '42')],
      },
    });
    render(<Harness tasks={tasks} />);
    expect(cardTitles('In review')).toEqual(['Work review']);
    expect(cardTitles('Running')).toEqual(['Work running']);
    const line = (name: string) =>
      within(lane(name))
        .getByRole('article')
        .querySelector('.task-card__status-line')?.textContent;
    expect(line('In review')).toBe('Checks not passing · #41 · sent 3m');
    expect(line('Running')).toBe('Running · fixing checks on #42');
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
      'Work review': ['Checks not passing · #41', 'Open PR'],
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

  const movingTask = [task('moving', { sessionId: 'run-m' })];
  const runningRun = [
    session('run-m', { lifecycleState: 'running', hasActiveTurn: true }),
  ];
  const owedRun = [
    session('run-m', { lifecycleState: 'review_pending', pendingReview: true }),
  ];

  test('focus the reader took off the board stays off it, even after that control is gone', async () => {
    given({ tasks: movingTask, sessions: runningRun });
    const outside = document.createElement('button');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    const { rerender } = render(<Harness tasks={movingTask} />);
    act(() => screen.getByRole('link', { name: 'Work moving' }).focus());
    act(() => outside.focus());
    // The control the reader went to disappears: focus falls to the body.
    act(() => outside.remove());
    await act(async () => {});
    expect(document.activeElement).toBe(document.body);
    given({ tasks: movingTask, sessions: owedRun });
    rerender(<Harness tasks={movingTask} />);
    expect(cardTitles('Needs you')).toEqual(['Work moving']);
    expect(document.activeElement).toBe(document.body);
  });

  test('blurring a card to blank space is a choice: moving the card later does not pull focus back', async () => {
    given({ tasks: movingTask, sessions: runningRun });
    const { rerender } = render(<Harness tasks={movingTask} />);
    const title = screen.getByRole('link', { name: 'Work moving' });
    act(() => title.focus());
    // A click on blank space: focus goes to the body with no relatedTarget.
    act(() => title.blur());
    await act(async () => {});
    given({ tasks: movingTask, sessions: owedRun });
    rerender(<Harness tasks={movingTask} />);
    expect(cardTitles('Needs you')).toEqual(['Work moving']);
    expect(document.activeElement).toBe(document.body);
  });

  test('focus on a moved card’s action returns to its action, not its title', () => {
    const tasks = [task('moving', { sessionId: 'run-m' })];
    given({
      tasks,
      sessions: [
        session('run-m', { lifecycleState: 'running', hasActiveTurn: true }),
      ],
    });
    const { rerender } = render(<Harness tasks={tasks} />);
    act(() =>
      screen.getByRole('button', { name: 'Open run Work moving' }).focus(),
    );
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
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Approve Work moving' }),
    );
  });

  test('an action that goes busy keeps focus remembered: the moved card gets it back', async () => {
    given({ tasks: movingTask, sessions: runningRun });
    const { rerender } = render(<Harness tasks={movingTask} />);
    const action = screen.getByRole('button', { name: 'Open run Work moving' });
    act(() => action.focus());
    rerender(
      <Harness tasks={movingTask} pendingTaskIds={new Set(['moving'])} />,
    );
    expect(action.matches(':disabled')).toBe(true);
    // Browsers blur a control when it becomes disabled, with no
    // relatedTarget, while it is still in the page; jsdom does not.
    fireEvent.focusOut(action);
    await act(async () => {});
    given({ tasks: movingTask, sessions: owedRun });
    rerender(<Harness tasks={movingTask} />);
    expect(cardTitles('Needs you')).toEqual(['Work moving']);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Approve Work moving' }),
    );
  });

  test('pull request facts arriving late are not arrivals: no announcement, no jump to the top', () => {
    // Needs you already holds a newer failed Task when the facts arrive and
    // move an older merged Task into it. Seeded order puts the newer first;
    // treating the facts as an arrival would put the merged Task on top.
    const tasks = [
      task('broke', {
        sessionId: 'run-broke',
        updatedAt: '2026-11-10T00:00:00.000Z',
      }),
      task('merged', {
        sessionId: 'run-merged',
        updatedAt: '2026-11-01T00:00:00.000Z',
      }),
    ];
    const runs = [
      session('run-broke', { lifecycleState: 'failed' }),
      session('run-merged', { lifecycleState: 'completed' }),
    ];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      given({ tasks, sessions: runs, factsPending: true });
      const { rerender } = render(<Harness tasks={tasks} />);
      // The board renders without facts once its short wait is over.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(cardTitles('Needs you')).toEqual(['Work broke']);
      given({
        tasks,
        sessions: runs,
        pullRequests: { merged: [pr('7', { pullRequestState: 'MERGED' })] },
      });
      rerender(<Harness tasks={tasks} />);
    } finally {
      vi.useRealTimers();
    }
    expect(cardTitles('Needs you')).toEqual(['Work broke', 'Work merged']);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      '',
    );
  });

  test('opening the board after the list still waits for its first facts', () => {
    const tasks = [task('pr', { sessionId: 'run-pr' })];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      given({
        tasks,
        sessions: [session('run-pr', { lifecycleState: 'completed' })],
        factsPending: true,
      });
      const { rerender } = render(
        <Harness tasks={tasks} readPullRequests={false} />,
      );
      // The list has no wait: it does not read pull requests.
      expect(screen.queryByText('loading')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      rerender(<Harness tasks={tasks} readPullRequests />);
      expect(screen.getByText('loading')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.queryByText('loading')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a later move into Ready to merge is announced once', () => {
    const tasks = [task('pr', { sessionId: 'run-pr' })];
    const finished = [session('run-pr', { lifecycleState: 'completed' })];
    given({
      tasks,
      sessions: finished,
      pullRequests: { pr: [pr('7', { readiness: 'behind' })] },
    });
    const { rerender } = render(<Harness tasks={tasks} />);
    given({
      tasks,
      sessions: finished,
      pullRequests: { pr: [pr('7', { readiness: 'clean' })] },
    });
    rerender(<Harness tasks={tasks} />);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'Work pr: Ready to merge',
    );
  });

  test('the why behind a status is real text the title link points at', () => {
    const tasks = [task('pr', { sessionId: 'run-pr' })];
    given({
      tasks,
      sessions: [session('run-pr', { lifecycleState: 'completed' })],
      pullRequests: {
        pr: [pr('7', { readiness: 'behind', title: 'Tighten CSP' })],
      },
    });
    render(<Harness tasks={tasks} />);
    const link = screen.getByRole('link', { name: 'Work pr' });
    const reasonId = link.getAttribute('aria-describedby');
    expect(reasonId && document.getElementById(reasonId)?.textContent).toBe(
      'Tighten CSP',
    );
  });

  test('only a running card reads its run’s plan, at the run the derivation read', () => {
    const tasks = [
      task('runs', { sessionId: 'run-first' }),
      task('idle', { sessionId: 'run-idle' }),
    ];
    given({
      tasks,
      sessions: [
        session('run-first', {
          lifecycleState: 'failed',
          currentSessionId: 'run-now',
        }),
        session('run-now', {
          lifecycleState: 'running',
          hasActiveTurn: true,
          currentSessionId: 'run-now',
        }),
        session('run-idle', { lifecycleState: 'completed' }),
      ],
    });
    render(<Harness tasks={tasks} />);
    const enabledReads = sdk.useOrchestrationSessionActivityQuery.mock.calls
      .filter(([, , config]) => config?.enabled)
      .map(([sessionId]) => sessionId);
    expect([...new Set(enabledReads)]).toEqual(['run-now']);
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
