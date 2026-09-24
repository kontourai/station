/**
 * #2456 no-loss pin: the delegate and provider cards now render through
 * `backgroundTaskEntryFromChildWork`, and every expected string below was
 * produced by the PRE-contract `background-tasks-store.ts` (commit a671a619d)
 * from the same event sequences, then frozen. Compared as `JSON.stringify`,
 * so key order and every member are pinned byte for byte — a card that gains,
 * loses or reorders a field fails here.
 */
import {
  type DelegateChildWorkSource,
  projectDelegateChildWork,
} from '@kontourai/station-contracts/child-work';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../../hooks/orchestration/types';
import type { ChatBackgroundTask } from '../active-chats-state';
import {
  type BackgroundTasksState,
  createEmptyBackgroundTasksState,
  ingestBackgroundTaskEvent,
  reconcileBackgroundTasksSnapshot,
  selectChatBackgroundTasks,
} from '../background-tasks-store';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');

function ev(
  method: string,
  threadId: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): OrchestrationEvent {
  return {
    provider: 'claude',
    threadId,
    createdAt,
    method,
    ...extra,
  } as unknown as OrchestrationEvent;
}

function fold(
  events: OrchestrationEvent[],
  state: BackgroundTasksState = createEmptyBackgroundTasksState(),
): BackgroundTasksState {
  return events.reduce(ingestBackgroundTaskEvent, state);
}

function bind(delegate: string, parent: string, at: string) {
  return ev('session.started', delegate, at, {
    metadata: { taskId: delegate, parentTaskId: parent },
  });
}

type Row = Record<string, unknown>;
const identityRow = (row: Row): Row => row;
/** What a #2456 server adds to the same row: `childWork.asChild`. */
const currentServerRow = (row: Row): Row => {
  const asChild = projectDelegateChildWork(
    row as unknown as DelegateChildWorkSource,
  );
  return asChild ? { ...row, childWork: { asChild } } : row;
};

const SCENARIOS: Record<string, (decorate?: (row: Row) => Row) => unknown> = {
  bindTurnComplete: () =>
    fold([
      bind('del-1', 'chat-1', '2026-09-23T10:00:00.000Z'),
      ev('turn.started', 'del-1', '2026-09-23T10:00:01.000Z', {
        turnId: 't1',
        prompt: 'Summarise the repo\nsecond line',
      }),
      ev('turn.completed', 'del-1', '2026-09-23T10:00:05.000Z', {
        turnId: 't1',
      }),
    ]),
  abortReopenError: () =>
    fold([
      bind('del-2', 'chat-1', '2026-09-23T10:01:00.000Z'),
      ev('turn.started', 'del-2', '2026-09-23T10:01:01.000Z', {
        turnId: 't1',
        prompt: 'x'.repeat(120),
      }),
      ev('turn.aborted', 'del-2', '2026-09-23T10:01:02.000Z', {
        turnId: 't1',
      }),
      ev('turn.started', 'del-2', '2026-09-23T10:01:03.000Z', {
        turnId: 't2',
        prompt: 'retry',
      }),
      ev('runtime.error', 'del-2', '2026-09-23T10:01:04.000Z', {
        message: 'boom',
      }),
    ]),
  missedBindFromSnapshotThenExit: (decorate = identityRow) => {
    const seeded = reconcileBackgroundTasksSnapshot(
      createEmptyBackgroundTasksState(),
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'chat-1',
            status: 'running',
            hasActiveTurn: false,
          },
          {
            provider: 'claude',
            threadId: 'del-3',
            status: 'running',
            hasActiveTurn: false,
            createdAt: '2026-09-23T09:00:00.000Z',
            delegation: { taskId: 'del-3', parentTaskId: 'chat-1' },
          },
        ].map(decorate),
      } as OrchestrationSnapshotPayload,
    );
    return fold(
      [
        ev('turn.started', 'del-3', '2026-09-23T10:02:00.000Z', {
          turnId: 't1',
          prompt: 'late bind',
        }),
        ev('session.exited', 'del-3', '2026-09-23T10:02:03.000Z'),
      ],
      seeded,
    );
  },
  snapshotSeedDemoteStale: (decorate = identityRow) => {
    const sessions = [
      {
        provider: 'claude',
        threadId: 'chat-1',
        status: 'running',
        hasActiveTurn: true,
      },
      {
        provider: 'claude',
        threadId: 'del-4',
        status: 'running',
        hasActiveTurn: true,
        createdAt: '2026-09-23T09:30:00.000Z',
        lastEventAt: '2026-09-23T09:31:00.000Z',
        delegation: {
          taskId: 'del-4',
          parentTaskId: 'chat-1',
          targetId: 'reviewer',
        },
      },
      {
        provider: 'claude',
        threadId: 'del-5',
        status: 'running',
        hasActiveTurn: true,
        createdAt: '2026-09-23T09:40:00.000Z',
        delegation: { taskId: 'del-5', parentTaskId: 'chat-1' },
      },
    ];
    const first = reconcileBackgroundTasksSnapshot(
      fold([
        ev('tool.started', 'chat-1', '2026-09-23T09:59:00.000Z', {
          toolCallId: 'call-1',
          toolName: 'Bash',
        }),
      ]),
      { sessions: sessions.map(decorate) } as OrchestrationSnapshotPayload,
    );
    // del-4 idle now; del-5 vanished from the snapshot entirely.
    return reconcileBackgroundTasksSnapshot(first, {
      sessions: [
        { ...sessions[0], hasActiveTurn: false },
        { ...sessions[1], hasActiveTurn: false },
      ].map(decorate),
    } as OrchestrationSnapshotPayload);
  },
  pruneFinished: () => {
    const events: OrchestrationEvent[] = [];
    for (let i = 0; i < 53; i += 1) {
      const id = `del-p${String(i).padStart(2, '0')}`;
      const start = new Date(Date.parse('2026-09-23T08:00:00.000Z') + i * 1000);
      events.push(bind(id, 'chat-p', start.toISOString()));
      events.push(
        ev(
          'turn.completed',
          id,
          new Date(start.getTime() + 500).toISOString(),
          {
            turnId: 't',
          },
        ),
      );
    }
    return fold(events);
  },
  providerSelection: () => {
    const state = fold([
      ev('tool.started', 'chat-1', '2026-09-23T10:05:00.000Z', {
        toolCallId: 'toolu_1',
        toolName: 'Task',
      }),
      bind('del-6', 'chat-1', '2026-09-23T10:04:00.000Z'),
    ]);
    const providerTasks: ChatBackgroundTask[] = [
      {
        taskId: 'task-a',
        toolCallId: 'toolu_1',
        description: 'Explore the repo',
        subagentType: 'Explore',
        backgrounded: true,
        spawnDepth: 1,
        sessionThreadId: 'exec-1',
      },
      {
        taskId: 'task-b',
        description: '',
        subagentType: 'general-purpose',
        backgrounded: false,
        spawnDepth: undefined,
      },
      { taskId: 'task-c', backgrounded: false },
    ];
    return selectChatBackgroundTasks(state, 'chat-1', providerTasks);
  },
};

/** Frozen from the pre-contract store; see the file docblock. */
const EXPECTED: Record<string, string> = {
  bindTurnComplete:
    '{"entries":{"del-1":{"id":"del-1","kind":"agent","source":"delegate-session","chatThreadId":"chat-1","delegateThreadId":"del-1","stop":{"kind":"delegate-interrupt"},"title":"Summarise the repo","startedAt":1790157600000,"state":"completed","endedAt":1790157605000}},"delegateParents":{"del-1":"chat-1"}}',
  abortReopenError:
    '{"entries":{"del-2":{"id":"del-2","kind":"agent","source":"delegate-session","chatThreadId":"chat-1","delegateThreadId":"del-2","stop":{"kind":"delegate-interrupt"},"title":"retry","startedAt":1790157663000,"state":"failed","endedAt":1790157664000}},"delegateParents":{"del-2":"chat-1"}}',
  missedBindFromSnapshotThenExit:
    '{"entries":{"del-3":{"id":"del-3","kind":"agent","source":"delegate-session","chatThreadId":"chat-1","delegateThreadId":"del-3","stop":{"kind":"delegate-interrupt"},"title":"late bind","startedAt":1790157720000,"state":"stopped","endedAt":1790157723000}},"delegateParents":{"del-3":"chat-1"}}',
  snapshotSeedDemoteStale:
    '{"entries":{"call-1":{"id":"call-1","kind":"tool","source":"tool-event","chatThreadId":"chat-1","title":"Bash","startedAt":1790157540000,"state":"stopped","endedAt":1790164800000},"del-4":{"id":"del-4","kind":"agent","source":"delegate-session","chatThreadId":"chat-1","delegateThreadId":"del-4","stop":{"kind":"delegate-interrupt"},"title":"Delegated task \u2014 reviewer","startedAt":1790155800000,"state":"stopped","endedAt":1790155860000},"del-5":{"id":"del-5","kind":"agent","source":"delegate-session","chatThreadId":"chat-1","delegateThreadId":"del-5","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790156400000,"state":"stopped","endedAt":1790164800000}},"delegateParents":{"del-4":"chat-1","del-5":"chat-1"}}',
  pruneFinished:
    '{"entries":{"del-p03":{"id":"del-p03","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p03","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150403000,"state":"completed","endedAt":1790150403500},"del-p04":{"id":"del-p04","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p04","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150404000,"state":"completed","endedAt":1790150404500},"del-p05":{"id":"del-p05","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p05","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150405000,"state":"completed","endedAt":1790150405500},"del-p06":{"id":"del-p06","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p06","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150406000,"state":"completed","endedAt":1790150406500},"del-p07":{"id":"del-p07","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p07","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150407000,"state":"completed","endedAt":1790150407500},"del-p08":{"id":"del-p08","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p08","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150408000,"state":"completed","endedAt":1790150408500},"del-p09":{"id":"del-p09","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p09","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150409000,"state":"completed","endedAt":1790150409500},"del-p10":{"id":"del-p10","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p10","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150410000,"state":"completed","endedAt":1790150410500},"del-p11":{"id":"del-p11","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p11","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150411000,"state":"completed","endedAt":1790150411500},"del-p12":{"id":"del-p12","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p12","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150412000,"state":"completed","endedAt":1790150412500},"del-p13":{"id":"del-p13","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p13","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150413000,"state":"completed","endedAt":1790150413500},"del-p14":{"id":"del-p14","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p14","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150414000,"state":"completed","endedAt":1790150414500},"del-p15":{"id":"del-p15","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p15","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150415000,"state":"completed","endedAt":1790150415500},"del-p16":{"id":"del-p16","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p16","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150416000,"state":"completed","endedAt":1790150416500},"del-p17":{"id":"del-p17","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p17","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150417000,"state":"completed","endedAt":1790150417500},"del-p18":{"id":"del-p18","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p18","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150418000,"state":"completed","endedAt":1790150418500},"del-p19":{"id":"del-p19","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p19","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150419000,"state":"completed","endedAt":1790150419500},"del-p20":{"id":"del-p20","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p20","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150420000,"state":"completed","endedAt":1790150420500},"del-p21":{"id":"del-p21","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p21","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150421000,"state":"completed","endedAt":1790150421500},"del-p22":{"id":"del-p22","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p22","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150422000,"state":"completed","endedAt":1790150422500},"del-p23":{"id":"del-p23","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p23","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150423000,"state":"completed","endedAt":1790150423500},"del-p24":{"id":"del-p24","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p24","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150424000,"state":"completed","endedAt":1790150424500},"del-p25":{"id":"del-p25","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p25","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150425000,"state":"completed","endedAt":1790150425500},"del-p26":{"id":"del-p26","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p26","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150426000,"state":"completed","endedAt":1790150426500},"del-p27":{"id":"del-p27","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p27","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150427000,"state":"completed","endedAt":1790150427500},"del-p28":{"id":"del-p28","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p28","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150428000,"state":"completed","endedAt":1790150428500},"del-p29":{"id":"del-p29","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p29","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150429000,"state":"completed","endedAt":1790150429500},"del-p30":{"id":"del-p30","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p30","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150430000,"state":"completed","endedAt":1790150430500},"del-p31":{"id":"del-p31","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p31","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150431000,"state":"completed","endedAt":1790150431500},"del-p32":{"id":"del-p32","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p32","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150432000,"state":"completed","endedAt":1790150432500},"del-p33":{"id":"del-p33","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p33","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150433000,"state":"completed","endedAt":1790150433500},"del-p34":{"id":"del-p34","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p34","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150434000,"state":"completed","endedAt":1790150434500},"del-p35":{"id":"del-p35","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p35","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150435000,"state":"completed","endedAt":1790150435500},"del-p36":{"id":"del-p36","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p36","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150436000,"state":"completed","endedAt":1790150436500},"del-p37":{"id":"del-p37","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p37","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150437000,"state":"completed","endedAt":1790150437500},"del-p38":{"id":"del-p38","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p38","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150438000,"state":"completed","endedAt":1790150438500},"del-p39":{"id":"del-p39","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p39","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150439000,"state":"completed","endedAt":1790150439500},"del-p40":{"id":"del-p40","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p40","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150440000,"state":"completed","endedAt":1790150440500},"del-p41":{"id":"del-p41","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p41","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150441000,"state":"completed","endedAt":1790150441500},"del-p42":{"id":"del-p42","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p42","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150442000,"state":"completed","endedAt":1790150442500},"del-p43":{"id":"del-p43","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p43","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150443000,"state":"completed","endedAt":1790150443500},"del-p44":{"id":"del-p44","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p44","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150444000,"state":"completed","endedAt":1790150444500},"del-p45":{"id":"del-p45","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p45","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150445000,"state":"completed","endedAt":1790150445500},"del-p46":{"id":"del-p46","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p46","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150446000,"state":"completed","endedAt":1790150446500},"del-p47":{"id":"del-p47","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p47","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150447000,"state":"completed","endedAt":1790150447500},"del-p48":{"id":"del-p48","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p48","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150448000,"state":"completed","endedAt":1790150448500},"del-p49":{"id":"del-p49","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p49","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150449000,"state":"completed","endedAt":1790150449500},"del-p50":{"id":"del-p50","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p50","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150450000,"state":"completed","endedAt":1790150450500},"del-p51":{"id":"del-p51","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p51","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150451000,"state":"completed","endedAt":1790150451500},"del-p52":{"id":"del-p52","kind":"agent","source":"delegate-session","chatThreadId":"chat-p","delegateThreadId":"del-p52","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790150452000,"state":"completed","endedAt":1790150452500}},"delegateParents":{"del-p00":"chat-p","del-p01":"chat-p","del-p02":"chat-p","del-p03":"chat-p","del-p04":"chat-p","del-p05":"chat-p","del-p06":"chat-p","del-p07":"chat-p","del-p08":"chat-p","del-p09":"chat-p","del-p10":"chat-p","del-p11":"chat-p","del-p12":"chat-p","del-p13":"chat-p","del-p14":"chat-p","del-p15":"chat-p","del-p16":"chat-p","del-p17":"chat-p","del-p18":"chat-p","del-p19":"chat-p","del-p20":"chat-p","del-p21":"chat-p","del-p22":"chat-p","del-p23":"chat-p","del-p24":"chat-p","del-p25":"chat-p","del-p26":"chat-p","del-p27":"chat-p","del-p28":"chat-p","del-p29":"chat-p","del-p30":"chat-p","del-p31":"chat-p","del-p32":"chat-p","del-p33":"chat-p","del-p34":"chat-p","del-p35":"chat-p","del-p36":"chat-p","del-p37":"chat-p","del-p38":"chat-p","del-p39":"chat-p","del-p40":"chat-p","del-p41":"chat-p","del-p42":"chat-p","del-p43":"chat-p","del-p44":"chat-p","del-p45":"chat-p","del-p46":"chat-p","del-p47":"chat-p","del-p48":"chat-p","del-p49":"chat-p","del-p50":"chat-p","del-p51":"chat-p","del-p52":"chat-p"}}',
  providerSelection:
    '{"running":[{"id":"del-6","kind":"agent","source":"delegate-session","chatThreadId":"chat-1","delegateThreadId":"del-6","stop":{"kind":"delegate-interrupt"},"title":"Delegated task","startedAt":1790157840000,"state":"running"},{"id":"task-a","kind":"agent","source":"provider-task","chatThreadId":"chat-1","title":"Explore the repo","detail":"Explore","startedAt":1790157900000,"state":"running","sessionThreadId":"exec-1","stop":{"kind":"provider-task-stop"}},{"id":"task-b","kind":"agent","source":"provider-task","chatThreadId":"chat-1","title":"general-purpose","detail":"general-purpose","startedAt":1790164800000,"state":"running"},{"id":"task-c","kind":"agent","source":"provider-task","chatThreadId":"chat-1","title":"Background task","startedAt":1790164800000,"state":"running"}],"finished":[]}',
};

describe('#2456 background-task cards are byte-equal through the child-work renderer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [name, run] of Object.entries(SCENARIOS)) {
    test(name, () => {
      const actual = JSON.stringify(run());
      if (process.env.CHILD_WORK_PARITY_PRINT) {
        console.log(`PARITY ${name} ${JSON.stringify(actual)}`);
      }
      expect(actual).toBe(EXPECTED[name]);
    });
  }

  // A current server's snapshot row carries `childWork.asChild` beside
  // `delegation`; reconcile reads the former and must land on the very same
  // cards the delegation-only (older server) row produced.
  for (const name of [
    'missedBindFromSnapshotThenExit',
    'snapshotSeedDemoteStale',
  ]) {
    test(`${name} from a current server's childWork.asChild`, () => {
      expect(JSON.stringify(SCENARIOS[name](currentServerRow))).toBe(
        EXPECTED[name],
      );
    });
  }
});
