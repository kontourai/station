/**
 * #5063 through the real Project Room agent module and room store: a
 * request in `#general` carries the coordinator frame, and its answer is
 * routed before it is posted, once, with its card bound to the message.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createProjectRoomAgentRuntime,
  type ProjectRoomAgentExecution,
} from '../project-room-agent-module.js';
import { ProjectRoomCoordinator } from '../project-room-coordinator.js';
import { ProjectRoomCoordinatorStore } from '../project-room-coordinator-store.js';
import { createProjectRoomRuntime } from '../project-room-store.js';

describe('the #general coordinator in the room agent module', () => {
  const makeTempDir = trackTempDirs();
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const close of cleanup.reverse()) close();
    cleanup.length = 0;
  });

  function fixture() {
    const home = realpathSync(makeTempDir('room-coordinator-'));
    const room = createProjectRoomRuntime(home);
    const authority = {
      scope: {
        stationId: 's',
        localProjectId: 'incarnation',
        portableProjectId: 'p',
        localProjectSlug: 'project',
      },
      requester: { kind: 'person' as const, id: 'owner', displayName: 'Owner' },
      executionRoot: home,
      assertCurrent() {},
    };
    room.store.ensureRoom(authority.scope, authority.assertCurrent);
    let answerText = '';
    const contexts: string[] = [];
    const execution: ProjectRoomAgentExecution = {
      async prepare() {
        return { label: 'Builder' };
      },
      async launch(capture) {
        contexts.push(capture.context);
      },
      async answer() {
        return answerText ? { turnId: 'turn-1', text: answerText } : null;
      },
      async cancel() {},
    };
    let enabled = true;
    const db = new DatabaseSync(join(home, 'coordinator.sqlite'));
    const coordinator = new ProjectRoomCoordinator(
      new ProjectRoomCoordinatorStore(db),
      {
        enabled: () => enabled,
        settings: () => ({
          startWithoutAsking: false,
          maxConcurrentTasks: 2,
          pullRequests: 'when-asked',
        }),
        placement: () => 'project',
        agentLabel: async () => undefined,
        currentScope: () => authority.scope,
        mayStart: () => true,
        createTask: async () => {
          throw new Error('nothing starts before Start');
        },
        dispatchTask: async () => {
          throw new Error('nothing starts before Start');
        },
        readTask: () => undefined,
        conversationForSession: () => undefined,
        submitTurn: () => 'queued',
        turnEntry: () => undefined,
        turnTerminal: () => undefined,
        assistantText: async () => undefined,
        publishForStarter: () => {
          throw new Error('no result yet');
        },
      },
    );
    const runtime = createProjectRoomAgentRuntime(
      home,
      room.store,
      execution,
      coordinator,
    );
    cleanup.push(
      () => db.close(),
      () => room.close(),
      () => runtime.close(),
    );
    return {
      authority,
      room,
      module: runtime.module,
      coordinator,
      contexts,
      answer(text: string) {
        answerText = text;
      },
      previewOff() {
        enabled = false;
      },
    };
  }

  const ask = (text: string) => ({
    intentId: randomUUID(),
    agentId: 'builder',
    text,
  });

  it('frames a #general request for the coordinator and posts its routed answer once', async () => {
    const f = fixture();
    const handle = await f.module.request(
      f.authority,
      ask('Fix login, update the docs and bump deps'),
    );
    const frame = JSON.parse(f.contexts[0]!.split('\n')[0]!);
    expect(frame.coordinator.instructions).toContain('<station_routing>');
    expect(frame.coordinator.tasks).toEqual([]);

    f.answer(
      'Three separate pieces of work.\n<station_routing>{"route":"tasks","tasks":[{"title":"Fix login","prompt":"Fix the login redirect."},{"title":"Update docs","prompt":"Document it."},{"title":"Bump deps","prompt":"Bump lint."}]}</station_routing>',
    );
    const settled = await f.module.reconcile(f.authority, handle.requestId);
    expect(settled.state).toBe('published');
    // A replayed reconcile (the observer and an explicit Check answer) adds
    // nothing.
    await f.module.reconcile(f.authority, handle.requestId);

    const history = f.room.store.history(f.authority.scope, 0, 100);
    const answers = history.messages.filter((m) => m.actor.kind === 'agent');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.text).toBe(
      'Three separate pieces of work.\n\n_Proposed 3 new Tasks. Start them from the card below._',
    );
    const view = f.coordinator.view(
      f.authority.scope,
      history.checkpoint.roomId,
    );
    expect(view.proposals).toHaveLength(1);
    expect(view.proposals[0]!.messageId).toBe(answers[0]!.messageId);
    expect(view.proposals[0]!.tasks.map((t) => t.state)).toEqual([
      'proposed',
      'proposed',
      'proposed',
    ]);
  });

  it('answers a quick question in place, and the room shows no routing block', async () => {
    const f = fixture();
    const handle = await f.module.request(
      f.authority,
      ask('Which Node version?'),
    );
    f.answer('Node 24.\n<station_routing>{"route":"answer"}</station_routing>');
    await f.module.reconcile(f.authority, handle.requestId);
    const [message] = f.room.store
      .history(f.authority.scope, 0, 100)
      .messages.filter((m) => m.actor.kind === 'agent');
    expect(message!.text).toBe('Node 24.\n\n_Answered here; no Task started._');
    expect(
      f.coordinator.view(f.authority.scope, message!.roomId).proposals,
    ).toEqual([]);
  });

  it('leaves the room agent as it was with the preview off', async () => {
    const f = fixture();
    f.previewOff();
    const handle = await f.module.request(f.authority, ask('Plan the work'));
    const frame = JSON.parse(f.contexts[0]!.split('\n')[0]!);
    expect(frame.coordinator).toBeUndefined();
    f.answer('Plain answer');
    await f.module.reconcile(f.authority, handle.requestId);
    const [message] = f.room.store
      .history(f.authority.scope, 0, 100)
      .messages.filter((m) => m.actor.kind === 'agent');
    expect(message!.text).toBe('Plain answer');
  });
});
