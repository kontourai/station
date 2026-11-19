import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import type { ProjectRoomCoordinatorSettings } from '@kontourai/station-contracts/project-room-coordinator';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  CoordinatorResultWithheld,
  ProjectRoomCoordinator,
  type ProjectRoomCoordinatorPorts,
} from '../project-room-coordinator.js';
import { ProjectRoomCoordinatorStore } from '../project-room-coordinator-store.js';
import type { DispatchOutcome } from '../task-dispatcher.js';

const scope: ProjectMembershipScope = {
  stationId: 'station-1',
  localProjectId: 'project-1',
  localProjectSlug: 'alpha',
  portableProjectId: 'portable-1',
};
const ROOM = 'room-general';
const PERSON = { id: 'person-1', displayName: 'Ada' };
const makeTempDir = trackTempDirs();

/**
 * A world shared across "restarts": the Task graph, the dispatcher, the
 * inbox and the room keep their state; only the coordinator and its store
 * handle are rebuilt on the same database file.
 */
class World {
  dir = makeTempDir('coordinator-');
  settings: ProjectRoomCoordinatorSettings = {
    startWithoutAsking: false,
    maxConcurrentTasks: 2,
    pullRequests: 'when-asked',
  };
  enabled = true;
  tasks = new Map<
    string,
    {
      id: string;
      key: string;
      title: string;
      status: 'in_progress' | 'done' | 'canceled';
      sessionId?: string;
    }
  >();
  creates = 0;
  dispatches = 0;
  /** Dispatches that started a Session, per Task. */
  dispatchedTasks: string[] = [];
  submitted = new Map<string, { conversationId: string; message: string }>();
  entries = new Map<
    string,
    { state: string; sessionId?: string; turnId?: string }
  >();
  terminals = new Map<string, 'completed' | 'failed'>();
  answers = new Map<string, string>();
  room = new Map<string, string>();
  publishCalls = 0;
  /** Throw on dispatch of these Tasks' titles (a crash mid-Start-all). */
  crashOnDispatch = new Set<string>();
  /** Die right after creating a Task with this title. */
  crashAfterCreate = new Set<string>();
  mayStart = true;
  dieAfterPublish = false;
  failPublication = false;

  open(overrides: Partial<ProjectRoomCoordinatorPorts> = {}): {
    coordinator: ProjectRoomCoordinator;
    db: DatabaseSync;
  } {
    const db = new DatabaseSync(join(this.dir, 'coordinator.sqlite'));
    const store = new ProjectRoomCoordinatorStore(db);
    const ports: ProjectRoomCoordinatorPorts = {
      enabled: () => this.enabled,
      settings: () => this.settings,
      placement: () => 'worktree',
      agentLabel: async (id) => (id === 'reviewer' ? 'Reviewer' : undefined),
      currentScope: () => scope,
      mayStart: () => this.mayStart,
      createTask: async (input, key, authorize) => {
        expect(input.projectId).toBe(scope.localProjectSlug);
        expect(authorize()).toBe(true);
        const existing = [...this.tasks.values()].find((t) => t.key === key);
        if (existing) return { id: existing.id, createdAt: 't0' };
        this.creates += 1;
        const id = `task-${this.tasks.size + 1}`;
        this.tasks.set(id, {
          id,
          key,
          title: input.title,
          status: 'in_progress',
        });
        // The Task is written and the process dies before the call returns.
        if (this.crashAfterCreate.delete(input.title))
          return new Promise<never>(() => {});
        return { id, createdAt: 't0' };
      },
      dispatchTask: async ({ taskId }): Promise<DispatchOutcome> => {
        this.dispatches += 1;
        const task = this.tasks.get(taskId)!;
        // The real dispatcher reserves a Task once: a second dispatch is
        // refused, never a second Session.
        if (task.sessionId) return { kind: 'terminal', reason: 'dispatched' };
        task.sessionId = `session-${taskId}`;
        this.dispatchedTasks.push(taskId);
        if (this.crashOnDispatch.has(task.title))
          throw new Error('crash after the start');
        return {
          kind: 'dispatched',
          result: { session: { threadId: task.sessionId } },
        } as unknown as DispatchOutcome;
      },
      readTask: (taskId) => {
        const task = this.tasks.get(taskId);
        return task
          ? {
              status: task.status,
              ...(task.sessionId ? { sessionId: task.sessionId } : {}),
            }
          : undefined;
      },
      conversationForSession: (sessionId) => `conversation-${sessionId}`,
      submitTurn: ({ conversationId, clientTurnId, message }) => {
        const key = `${conversationId}|${clientTurnId}`;
        if (!this.submitted.has(key)) {
          this.submitted.set(key, { conversationId, message });
          this.entries.set(key, { state: 'queued' });
        }
        return 'queued';
      },
      turnEntry: (conversationId, clientTurnId) =>
        this.entries.get(`${conversationId}|${clientTurnId}`),
      turnTerminal: (sessionId, turnId) => {
        const terminal = this.terminals.get(`${sessionId}|${turnId}`);
        return terminal === 'completed'
          ? { kind: 'completed' }
          : terminal === 'failed'
            ? { kind: 'failed', reason: 'the engine stopped' }
            : undefined;
      },
      assistantText: async ({ sessionId }) => this.answers.get(sessionId),
      publishForStarter: ({ intentId, text }) => {
        this.publishCalls += 1;
        if (!this.mayStart)
          throw new CoordinatorResultWithheld('The starter lost access.');
        if (this.failPublication) throw new Error('temporary SQLite failure');
        // The room store accepts one message per intent.
        if (!this.room.has(intentId)) this.room.set(intentId, text);
        // The process dies once the room has the message and before the
        // coordinator records it: its own database goes away mid-step.
        if (this.dieAfterPublish) {
          this.dieAfterPublish = false;
          db.close();
        }
        return `message-${intentId}`;
      },
      ...overrides,
    };
    return { coordinator: new ProjectRoomCoordinator(store, ports), db };
  }

  /** The Task's first turn ran and ended. */
  finish(taskId: string, result: 'completed' | 'failed', answer?: string) {
    const task = this.tasks.get(taskId)!;
    const entryKey = [...this.entries.keys()].find((key) =>
      key.startsWith(`conversation-${task.sessionId}|`),
    )!;
    this.entries.set(entryKey, {
      state: 'sent',
      sessionId: task.sessionId!,
      turnId: `turn-${taskId}`,
    });
    this.terminals.set(`${task.sessionId}|turn-${taskId}`, result);
    if (answer) this.answers.set(task.sessionId!, answer);
  }
}

const routing = (value: unknown) =>
  `Here is my plan.\n<station_routing>${JSON.stringify(value)}</station_routing>`;

const THREE = routing({
  route: 'tasks',
  tasks: [
    { title: 'Fix login', prompt: 'Fix the login redirect.' },
    { title: 'Update docs', prompt: 'Document the new flag.' },
    { title: 'Bump deps', prompt: 'Bump the lint packages.' },
  ],
});

async function propose(
  coordinator: ProjectRoomCoordinator,
  answerText: string,
  requestId = 'request-1',
  requestText = 'Fix login, update the docs and bump deps',
) {
  const publication = await coordinator.prepare({
    scope,
    roomId: ROOM,
    requestId,
    requester: PERSON,
    askedAgentId: 'builder',
    askedAgentLabel: 'Builder',
    requestText,
    answerText,
  });
  publication.published(`message-for-${requestId}`);
  await publication.after();
  return publication;
}

describe('ProjectRoomCoordinator', () => {
  it('answers a quick question in place without creating a Task', async () => {
    const w = new World();
    const { coordinator } = w.open();
    const publication = await propose(
      coordinator,
      'The build runs on Node 24.\n<station_routing>{"route":"answer"}</station_routing>',
    );
    expect(publication.text).toBe(
      'The build runs on Node 24.\n\n_Answered here; no Task started._',
    );
    expect(publication.text).not.toContain('station_routing');
    expect(coordinator.view(scope, ROOM).proposals).toEqual([]);
    expect(w.creates).toBe(0);
  });

  it('turns three requests in one message into three proposed Tasks, and Start all dispatches exactly three', async () => {
    const w = new World();
    w.settings.maxConcurrentTasks = 5;
    const { coordinator } = w.open();
    const publication = await propose(coordinator, THREE);
    expect(publication.text).toContain(
      '_Proposed 3 new Tasks. Start them from the card below._',
    );
    const [card] = coordinator.view(scope, ROOM).proposals;
    expect(card!.messageId).toBe('message-for-request-1');
    expect(card!.tasks.map((t) => [t.title, t.state, t.placement])).toEqual([
      ['Fix login', 'proposed', 'worktree'],
      ['Update docs', 'proposed', 'worktree'],
      ['Bump deps', 'proposed', 'worktree'],
    ]);
    // Propose before start: nothing exists until a person presses Start.
    expect(w.creates).toBe(0);

    await coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      starter: PERSON,
    });
    // Start all again (a double click, a second device): nothing more.
    await coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      starter: PERSON,
    });
    expect(w.creates).toBe(3);
    expect(w.dispatchedTasks).toHaveLength(3);
    expect(new Set(w.dispatchedTasks).size).toBe(3);
    expect(w.submitted.size).toBe(3);
    expect(
      coordinator.view(scope, ROOM).proposals[0]!.tasks.map((t) => t.state),
    ).toEqual(['working', 'working', 'working']);
  });

  it('a restart in the middle of Start all creates and starts no Task twice', async () => {
    const w = new World();
    w.settings.maxConcurrentTasks = 5;
    const first = w.open();
    await propose(first.coordinator, THREE);
    const [card] = first.coordinator.view(scope, ROOM).proposals;
    // The process dies twice over: after the second Task was created but
    // before its row recorded it, and after the third Task's engine started
    // but before its row recorded the Session or sent its first message.
    w.crashAfterCreate.add('Update docs');
    w.crashOnDispatch.add('Bump deps');
    // Start all never returns: the process dies inside it.
    void first.coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      starter: PERSON,
    });
    await vi.waitFor(() =>
      expect(
        first.coordinator
          .view(scope, ROOM)
          .proposals[0]!.tasks.map((t) => t.state),
      ).toEqual(['working', 'starting', 'starting']),
    );
    expect(w.creates).toBe(3);
    first.db.close();

    // Restart: a new coordinator on the same store reconciles.
    w.crashOnDispatch.clear();
    const second = w.open();
    await second.coordinator.reconcile();
    await second.coordinator.reconcile();
    expect(w.creates).toBe(3);
    expect([...w.dispatchedTasks].sort()).toEqual([
      'task-1',
      'task-2',
      'task-3',
    ]);
    expect(w.submitted.size).toBe(3);
    expect(
      second.coordinator
        .view(scope, ROOM)
        .proposals[0]!.tasks.map((t) => t.state),
    ).toEqual(['working', 'working', 'working']);
  });

  it('with a limit of 2 a third Task waits visibly and starts when a slot frees', async () => {
    const w = new World();
    w.settings.maxConcurrentTasks = 2;
    const { coordinator } = w.open();
    await propose(coordinator, THREE);
    const [card] = coordinator.view(scope, ROOM).proposals;
    await coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      starter: PERSON,
    });
    let view = coordinator.view(scope, ROOM);
    expect(view.proposals[0]!.tasks.map((t) => t.state)).toEqual([
      'working',
      'working',
      'waiting',
    ]);
    expect([view.working, view.waiting]).toEqual([2, 1]);
    expect(w.dispatchedTasks).toHaveLength(2);

    // Another pass (the periodic fallback) still respects the limit.
    await coordinator.reconcile();
    expect(w.dispatchedTasks).toHaveLength(2);

    w.finish('task-1', 'completed', 'Initial investigation finished.');
    coordinator.observe('session-task-1');
    await coordinator.reconcile();
    expect(w.dispatchedTasks).toHaveLength(2);
    expect(w.room.size).toBe(0);

    w.tasks.get('task-1')!.status = 'done';
    w.answers.set('session-task-1', 'Fixed the redirect.');
    await coordinator.reconcile();
    view = coordinator.view(scope, ROOM);
    expect(view.proposals[0]!.tasks.map((t) => t.state)).toEqual([
      'done',
      'working',
      'working',
    ]);
    expect(w.dispatchedTasks).toHaveLength(3);
  });

  it('posts exactly one result per settled Task, including after a restart', async () => {
    const w = new World();
    const first = w.open();
    await propose(first.coordinator, THREE);
    const [card] = first.coordinator.view(scope, ROOM).proposals;
    await first.coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      rowIds: [card!.tasks[0]!.rowId],
      starter: PERSON,
    });
    // The Task finishes while Station is down: no event reaches anyone.
    w.finish('task-1', 'completed', 'Fixed the redirect and added a test.');
    w.tasks.get('task-1')!.status = 'done';
    first.db.close();

    // Boot reconciliation alone posts it: no turn event will ever arrive.
    const second = w.open();
    await second.coordinator.reconcile();
    expect(w.room.size).toBe(1);
    // A late event and further passes (another restart) post nothing more.
    second.coordinator.observe('session-task-1');
    await second.coordinator.reconcile();
    const third = w.open();
    await third.coordinator.reconcile();

    expect(w.room.size).toBe(1);
    const [text] = [...w.room.values()];
    expect(text).toContain('**Task finished:** [Fix login](/tasks/task-1)');
    expect(text).not.toContain('Fixed the redirect and added a test.');
    const row = third.coordinator.view(scope, ROOM).proposals[0]!.tasks[0]!;
    expect(row.state).toBe('done');
    expect(row.resultMessageId).toMatch(/^message-/);
  });

  it('a restart between posting a result and recording it still leaves one result', async () => {
    const w = new World();
    const first = w.open();
    await propose(first.coordinator, THREE);
    const [card] = first.coordinator.view(scope, ROOM).proposals;
    await first.coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      rowIds: [card!.tasks[0]!.rowId],
      starter: PERSON,
    });
    w.finish('task-1', 'completed', 'Fixed the redirect.');
    w.tasks.get('task-1')!.status = 'done';
    w.dieAfterPublish = true;
    // The dying process's own pass ends with its database gone.
    await first.coordinator.reconcile().catch(() => undefined);
    // The room has the result; the row was never marked settled.
    expect(w.room.size).toBe(1);
    expect(w.publishCalls).toBe(1);

    const second = w.open();
    await second.coordinator.reconcile();
    // The restarted coordinator posts again, under the same intent.
    expect(w.publishCalls).toBe(2);
    expect(w.room.size).toBe(1);
    expect(
      second.coordinator.view(scope, ROOM).proposals[0]!.tasks[0]!.state,
    ).toBe('done');
  });

  it('retries a transient room write after restart with the original result text', async () => {
    const w = new World();
    const first = w.open();
    await propose(first.coordinator, THREE);
    const [card] = first.coordinator.view(scope, ROOM).proposals;
    await first.coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      rowIds: [card!.tasks[0]!.rowId],
      starter: PERSON,
    });
    w.finish('task-1', 'completed', 'Result at settlement.');
    w.tasks.get('task-1')!.status = 'done';
    w.failPublication = true;
    await first.coordinator.reconcile();
    expect(w.room.size).toBe(0);
    expect(
      first.coordinator.view(scope, ROOM).proposals[0]!.tasks[0]!.state,
    ).toBe('working');
    await first.coordinator.close();
    first.db.close();

    w.failPublication = false;
    w.answers.set('session-task-1', 'A later unrelated turn.');
    const restarted = w.open();
    await restarted.coordinator.reconcile();
    await restarted.coordinator.reconcile();
    expect(w.publishCalls).toBe(2);
    expect([...w.room.values()]).toEqual([
      '**Task finished:** [Fix login](/tasks/task-1)',
    ]);
  });

  it.each(['creation', 'dispatch'] as const)(
    'keeps a private %s diagnostic out of the Room card',
    async (step) => {
      const diagnostic = 'Synthetic private Task diagnostic';
      const w = new World();
      const { coordinator, db } = w.open(
        step === 'creation'
          ? {
              createTask: async () => {
                throw new Error(diagnostic);
              },
            }
          : {
              dispatchTask: async () => ({
                kind: 'failed',
                reason: diagnostic,
              }),
            },
      );
      try {
        await propose(coordinator, THREE);
        const [card] = coordinator.view(scope, ROOM).proposals;
        const rowId = card!.tasks[0]!.rowId;
        await coordinator.start({
          scope,
          roomId: ROOM,
          proposalId: card!.proposalId,
          rowIds: [rowId],
          starter: PERSON,
        });
        const stored = new ProjectRoomCoordinatorStore(db).row(rowId);
        expect(stored?.refusal?.includes(diagnostic)).toBe(true);
        const publicRow = coordinator.view(scope, ROOM).proposals[0]!.tasks[0]!;
        expect(JSON.stringify(publicRow).includes(diagnostic)).toBe(false);
        expect(publicRow.refusal).toBe(
          step === 'creation'
            ? 'Check the selected Agent and placement.'
            : 'Open the Task to check its status.',
        );
      } finally {
        await coordinator.close();
        db.close();
      }
    },
  );

  it('publishes a fixed failed status without the engine reason', async () => {
    const w = new World();
    const { coordinator, db } = w.open();
    try {
      await propose(coordinator, THREE);
      const [card] = coordinator.view(scope, ROOM).proposals;
      await coordinator.start({
        scope,
        roomId: ROOM,
        proposalId: card!.proposalId,
        rowIds: [card!.tasks[0]!.rowId],
        starter: PERSON,
      });
      w.finish('task-1', 'failed');
      await coordinator.reconcile();
      expect([...w.room.values()]).toEqual([
        '**Task stopped:** [Fix login](/tasks/task-1)',
      ]);
    } finally {
      await coordinator.close();
      db.close();
    }
  });

  it('retains a legacy prepared result without replaying it into the Room', async () => {
    const w = new World();
    const first = w.open();
    await propose(first.coordinator, THREE);
    const [card] = first.coordinator.view(scope, ROOM).proposals;
    const rowId = card!.tasks[0]!.rowId;
    await first.coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      rowIds: [rowId],
      starter: PERSON,
    });
    const store = new ProjectRoomCoordinatorStore(first.db);
    const legacy =
      '**Task finished:** [Fix login](/tasks/task-1)\n> Synthetic legacy Task answer';
    expect(
      store.transition(rowId, ['working'], {
        outcome: 'completed',
        resultText: legacy,
      }),
    ).toMatchObject({ resultText: legacy });
    await first.coordinator.close();
    first.db.close();
    const restarted = w.open();
    await restarted.coordinator.reconcile();
    expect(w.room.size).toBe(0);
    expect(
      new ProjectRoomCoordinatorStore(restarted.db).row(rowId),
    ).toMatchObject({
      resultText: legacy,
      resultWithheld: expect.any(String),
      state: 'done',
    });
    await restarted.coordinator.close();
    restarted.db.close();
  });

  it('posts nothing for a starter who lost access, and still frees the slot', async () => {
    const w = new World();
    w.settings.maxConcurrentTasks = 1;
    const { coordinator } = w.open();
    await propose(coordinator, THREE);
    const [card] = coordinator.view(scope, ROOM).proposals;
    await coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      starter: PERSON,
    });
    w.finish('task-1', 'completed', 'Done.');
    w.tasks.get('task-1')!.status = 'done';
    w.mayStart = false;
    await coordinator.reconcile();
    expect(w.room.size).toBe(0);
    const rows = coordinator.view(scope, ROOM).proposals[0]!.tasks;
    expect(rows[0]!.state).toBe('done');
    expect(rows[1]!.state).toBe('refused');
    expect(rows[1]!.refusal).toMatch(/can no longer start work/);
  });

  it('starts without asking when the Project says so, within the limit', async () => {
    const w = new World();
    w.settings = {
      startWithoutAsking: true,
      maxConcurrentTasks: 1,
      pullRequests: 'when-asked',
    };
    const { coordinator } = w.open();
    const publication = await propose(coordinator, THREE);
    expect(publication.text).toContain('_Starting 3 new Tasks.');
    expect(
      coordinator.view(scope, ROOM).proposals[0]!.tasks.map((t) => t.state),
    ).toEqual(['working', 'waiting', 'waiting']);
  });

  it('sends a follow-up to the Task already doing that work, and says so with a link', async () => {
    const w = new World();
    const { coordinator } = w.open();
    await propose(coordinator, THREE);
    const [card] = coordinator.view(scope, ROOM).proposals;
    await coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      rowIds: [card!.tasks[0]!.rowId],
      starter: PERSON,
    });
    const publication = await propose(
      coordinator,
      routing({
        route: 'task',
        taskId: 'task-1',
        message: 'Also cover the logout redirect.',
      }),
      'request-2',
      'and logout too',
    );
    expect(publication.text).toContain(
      '_Sent to Task [Fix login](/tasks/task-1)._',
    );
    const forwarded = [...w.submitted.values()].find((s) =>
      s.message.includes('logout redirect'),
    );
    expect(forwarded?.conversationId).toBe('conversation-session-task-1');
    // A Task not started here gets nothing.
    const stray = await propose(
      coordinator,
      routing({ route: 'task', taskId: 'task-99', message: 'hi' }),
      'request-3',
    );
    expect(stray.text).toContain("wasn't started from #general");
  });

  it('the status sweep reports one line per open Task from its stored output', async () => {
    const w = new World();
    w.settings.maxConcurrentTasks = 2;
    const { coordinator } = w.open();
    await propose(coordinator, THREE);
    const [card] = coordinator.view(scope, ROOM).proposals;
    await coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      starter: PERSON,
    });
    // The Task's status label says nothing new; its stored output does.
    w.answers.set(
      'session-task-1',
      'Tried the OAuth path; the callback URL is wrong in staging.',
    );
    let posted = '';
    const sweep = await coordinator.sweep({
      scope,
      roomId: ROOM,
      requesterId: PERSON.id,
      post: (text) => {
        posted = text;
        return 'sweep-message';
      },
    });
    expect(sweep).toEqual({ messageId: 'sweep-message', tasks: 3 });
    const lines = posted.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('[Fix login](/tasks/task-1)');
    expect(lines[0]).toContain('A written answer is available in the Task.');
    expect(posted).not.toContain('the callback URL is wrong in staging');
    expect(posted).not.toContain('Fix the login redirect.');
    expect(lines[1]).toContain('Reported: No output yet.');
    expect(lines[2]).toContain('Waiting on: a free slot');
  });

  it('refuses a pull request the person did not ask for, and counts it on the card', async () => {
    const w = new World();
    const { coordinator } = w.open();
    await propose(
      coordinator,
      routing({
        route: 'tasks',
        tasks: [
          { title: 'Fix login', prompt: 'Fix it.', pullRequest: true },
          { title: 'Docs', prompt: 'Write docs.', pullRequest: true },
        ],
      }),
      'request-1',
      'Fix the login redirect and write docs',
    );
    const [card] = coordinator.view(scope, ROOM).proposals;
    expect(card!.tasks.map((t) => t.mayOpenPullRequest)).toEqual([
      false,
      false,
    ]);
    await coordinator.start({
      scope,
      roomId: ROOM,
      proposalId: card!.proposalId,
      starter: PERSON,
    });
    expect(
      coordinator.guard({
        conversationId: 'conversation-session-task-1',
        opensPullRequest: true,
      })?.decision,
    ).toBe('deny');
    expect(
      coordinator.guard({
        conversationId: 'conversation-session-task-1',
        opensPullRequest: false,
      }),
    ).toBeUndefined();
    expect(
      coordinator.view(scope, ROOM).proposals[0]!.tasks[0]!.pullRequestRefusals,
    ).toBe(1);
    const [first] = [...w.submitted.values()];
    expect(first!.message).toContain('Do not open a pull request');

    // Asked for one: allowed.
    await propose(
      coordinator,
      routing({
        route: 'tasks',
        tasks: [
          { title: 'Fix it', prompt: 'Fix and open a PR.', pullRequest: true },
        ],
      }),
      'request-2',
      'Fix the redirect and open a PR',
    );
    const [asked] = coordinator.view(scope, ROOM).proposals;
    expect(asked!.tasks[0]!.mayOpenPullRequest).toBe(true);
  });

  it('with the preview off it routes nothing and starts nothing', async () => {
    const w = new World();
    w.enabled = false;
    const { coordinator } = w.open();
    const publication = await propose(coordinator, THREE);
    expect(publication.text).toBe('Here is my plan.');
    expect(coordinator.view(scope, ROOM).proposals).toEqual([]);
  });
});
