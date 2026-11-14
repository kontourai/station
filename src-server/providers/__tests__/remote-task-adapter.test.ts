/**
 * The remote task engine as a chat: the provider adapter over the real
 * remote task service and its HTTP fakes. A chat picks a ready connection as
 * its model; the first turn creates the task with only the person's words,
 * later turns send follow-ups, replies stream as text, and a turn completes
 * once the task rests. Polls run only inside a turn and are driven by the
 * test's timer.
 */
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { harness } from '../../services/remote-task-engines/__tests__/harness.js';
import {
  devinFake,
  githubFake,
} from '../../services/remote-task-engines/__tests__/vendor-fakes.js';
import {
  SendTurnRefusedError,
  SessionStartRefusedError,
} from '../adapter-shape.js';
import { RemoteTaskAdapter } from '../adapters/remote-task-adapter.js';

const ORG = 'org-abc123def456';
const TOKEN = 'cog_test_token_devin_0001';
const REPO = { owner: 'example', name: 'widgets' };

const adapters: RemoteTaskAdapter[] = [];
afterEach(async () => {
  while (adapters.length > 0) await adapters.pop()?.stopAll();
});

async function setup(vendor: 'devin' | 'github-copilot' = 'devin') {
  const devin = devinFake(ORG);
  const github = githubFake();
  const fetchImpl: typeof fetch = (input, init) =>
    String(input).startsWith('https://api.github.com')
      ? github.fake.fetch(input, init)
      : devin.fake.fetch(input, init);
  const h = harness(fetchImpl);
  const connectionId =
    vendor === 'devin'
      ? await h.readyConnection('devin', TOKEN, { orgId: ORG })
      : await h.readyConnection(
          'github-copilot',
          'github_pat_test_0001_abcdef',
        );
  const timers: Array<{ run: () => void; cleared: boolean }> = [];
  const resolved: Array<string | undefined> = [];
  const adapter = new RemoteTaskAdapter({
    service: h.service,
    resolveRepository: async (cwd) => {
      resolved.push(cwd);
      return REPO;
    },
    setTimer: (run) => {
      const timer = { run, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  adapters.push(adapter);
  const events: CanonicalRuntimeEvent[] = [];
  const controller = new AbortController();
  void (async () => {
    for await (const event of adapter.streamEvents({
      signal: controller.signal,
    }))
      events.push(event);
  })().catch(() => {});
  /**
   * Run the pending poll and wait until it settled: the next poll is
   * scheduled, or the turn ended.
   */
  const poll = async () => {
    const timer = timers.filter((t) => !t.cleared).at(-1);
    if (!timer) throw new Error('no poll scheduled');
    timer.cleared = true;
    const scheduled = timers.length;
    const ended = events.filter(
      (e) => e.method === 'turn.completed' || e.method === 'turn.aborted',
    ).length;
    timer.run();
    for (let i = 0; i < 500; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      const endedNow = events.filter(
        (e) => e.method === 'turn.completed' || e.method === 'turn.aborted',
      ).length;
      if (timers.length > scheduled || endedNow > ended) return;
    }
    throw new Error('the poll did not settle');
  };
  const pending = () => timers.filter((t) => !t.cleared).length;
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };
  const methods = () => events.map((e) => e.method);
  return {
    adapter,
    h,
    devin,
    github,
    connectionId,
    events,
    methods,
    poll,
    pending,
    settle,
    resolved,
  };
}

describe('RemoteTaskAdapter', () => {
  test('the model picker lists only connections ready for a chat', async () => {
    const s = await setup();
    expect((await s.adapter.listModelCatalog()).models).toEqual([
      { id: s.connectionId, name: 'Devin', originalId: s.connectionId },
    ]);
    // A managed policy that does not name the vendor hides it.
    s.h.switches.policy = { engines: {} };
    expect((await s.adapter.listModelCatalog()).models).toEqual([]);
    s.h.switches.policy = null;
    s.h.switches.preview = false;
    expect((await s.adapter.listModelCatalog()).models).toEqual([]);
    const prerequisites = await s.adapter.getPrerequisites();
    expect(prerequisites.map((p) => [p.id, p.status])).toEqual([
      ['remote-task-preview', 'missing'],
      ['remote-task-connection', 'missing'],
    ]);
  });

  test('a start on a connection that is not ready is refused before anything is published', async () => {
    const s = await setup();
    s.h.switches.preview = false;
    await expect(
      s.adapter.startSession({
        threadId: 't1',
        provider: 'remote-task',
        modelId: s.connectionId,
      }),
    ).rejects.toBeInstanceOf(SessionStartRefusedError);
    await s.settle();
    expect(s.events).toEqual([]);
  });

  test("the first turn creates the task from the person's words only and streams the reply", async () => {
    const s = await setup();
    await s.adapter.startSession({
      threadId: 't1',
      provider: 'remote-task',
      modelId: s.connectionId,
      cwd: '/work/widgets',
    });
    expect(s.resolved).toEqual(['/work/widgets']);
    const turn = await s.adapter.sendTurn({
      threadId: 't1',
      input: 'Station context: secret project notes\n\nFix the flaky test',
      displayInput: 'Fix the flaky test',
      ambientContext: 'Station context: secret project notes',
    });
    const [create] = s.devin.fake.matching('POST', /\/sessions$/);
    // Nothing of Station's own context leaves the host with the prompt.
    expect(create?.body).toEqual({
      prompt: 'Fix the flaky test',
      repos: ['example/widgets'],
    });
    expect(turn.resumeCursor).toMatchObject({
      kind: 'remote-task',
      connectionId: s.connectionId,
    });
    const taskId = (turn.resumeCursor as { taskId: string }).taskId;
    s.devin.setStatus(taskId, 'running', 'working');
    s.devin.reply(taskId, 'Looking at the test now.');
    await s.poll();
    s.devin.reply(taskId, 'Fixed and opened a PR.');
    Object.assign(s.devin.sessions.get(taskId) as object, {
      acus_consumed: 2,
      pull_requests: [
        {
          pr_url: 'https://github.com/example/widgets/pull/9',
          pr_state: 'open',
        },
      ],
    });
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    await s.settle();
    expect(s.methods()).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'content.text-delta',
      'content.text-delta',
      'turn.completed',
    ]);
    const completed = s.events.at(-1) as Extract<
      CanonicalRuntimeEvent,
      { method: 'turn.completed' }
    >;
    expect(completed.outputText).toBe(
      'Looking at the test now.\n\nFixed and opened a PR.',
    );
    expect(completed.metadata).toMatchObject({
      remoteTask: {
        taskId,
        status: 'idle',
        usage: [{ unit: 'acu', quantity: 2 }],
        outputs: [
          {
            kind: 'pull-request',
            url: 'https://github.com/example/widgets/pull/9',
          },
        ],
      },
    });
    // The turn's polls stop with it: a quiet chat costs nothing.
    expect(s.pending()).toBe(0);
  });

  test('a follow-up does not end on the stale idle status it was sent into', async () => {
    const s = await setup();
    await s.adapter.startSession({
      threadId: 't1',
      provider: 'remote-task',
      modelId: s.connectionId,
    });
    const first = await s.adapter.sendTurn({ threadId: 't1', input: 'Go' });
    const taskId = (first.resumeCursor as { taskId: string }).taskId;
    s.devin.reply(taskId, 'Done.');
    s.devin.setStatus(taskId, 'running', 'finished');
    // A reply arrived and the task rests: the turn ends on this poll.
    await s.poll();
    expect(s.methods().filter((m) => m === 'turn.completed')).toHaveLength(1);
    await s.adapter.sendTurn({ threadId: 't1', input: 'Also the docs' });
    expect(s.devin.fake.matching('POST', /\/messages$/)[0]?.body).toEqual({
      message: 'Also the docs',
    });
    // Devin has not picked the message up yet: still finished.
    await s.poll();
    expect(s.methods().filter((m) => m === 'turn.completed')).toHaveLength(1);
    s.devin.setStatus(taskId, 'running', 'working');
    await s.poll();
    s.devin.reply(taskId, 'Docs updated.');
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    await s.settle();
    const completed = s.events.filter((e) => e.method === 'turn.completed');
    expect(completed).toHaveLength(2);
    // The second reply carries only the new message, not the history.
    expect(
      (
        completed[1] as Extract<
          CanonicalRuntimeEvent,
          { method: 'turn.completed' }
        >
      ).outputText,
    ).toBe('Docs updated.');
  });

  test('a restarted chat resumes its task from the cursor without replaying history', async () => {
    const s = await setup();
    await s.adapter.startSession({
      threadId: 't1',
      provider: 'remote-task',
      modelId: s.connectionId,
    });
    const first = await s.adapter.sendTurn({ threadId: 't1', input: 'Go' });
    const taskId = (first.resumeCursor as { taskId: string }).taskId;
    s.devin.reply(taskId, 'First answer.');
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    await s.adapter.stopSession('t1');
    expect(await s.adapter.hasSession('t1')).toBe(false);
    await s.adapter.startSession({
      threadId: 't1',
      provider: 'remote-task',
      resumeCursor: first.resumeCursor,
    });
    await s.adapter.sendTurn({ threadId: 't1', input: 'Next' });
    expect(s.devin.fake.matching('POST', /\/sessions$/)).toHaveLength(1);
    s.devin.setStatus(taskId, 'running', 'working');
    await s.poll();
    s.devin.reply(taskId, 'Second answer.');
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    await s.settle();
    const texts = s.events
      .filter((e) => e.method === 'content.text-delta')
      .map((e) => (e as { delta: string }).delta);
    expect(texts).toEqual(['First answer.', 'Second answer.']);
  });

  test('a turn while the preview is off is refused before any request', async () => {
    const s = await setup();
    await s.adapter.startSession({
      threadId: 't1',
      provider: 'remote-task',
      modelId: s.connectionId,
    });
    s.h.switches.preview = false;
    await expect(
      s.adapter.sendTurn({ threadId: 't1', input: 'Go' }),
    ).rejects.toBeInstanceOf(SendTurnRefusedError);
    expect(s.devin.fake.requests).toHaveLength(0);
    await s.settle();
    expect(s.methods()).not.toContain('turn.started');
  });

  test('interrupt cancels where the vendor can, and says so where it cannot', async () => {
    const s = await setup();
    await s.adapter.startSession({
      threadId: 't1',
      provider: 'remote-task',
      modelId: s.connectionId,
    });
    const turn = await s.adapter.sendTurn({ threadId: 't1', input: 'Go' });
    expect(await s.adapter.interruptTurn('t1', turn.turnId)).toEqual({
      outcome: 'cancelled',
      turnId: turn.turnId,
    });
    expect(s.devin.fake.matching('DELETE', /\/sessions\//)).toHaveLength(1);
    expect(s.pending()).toBe(0);

    const copilot = await setup('github-copilot');
    await copilot.adapter.startSession({
      threadId: 't2',
      provider: 'remote-task',
      modelId: copilot.connectionId,
    });
    const copilotTurn = await copilot.adapter.sendTurn({
      threadId: 't2',
      input: 'Fix the login button',
    });
    expect(await copilot.adapter.interruptTurn('t2')).toEqual({
      outcome: 'termination-unconfirmed',
      turnId: copilotTurn.turnId,
    });
    // GitHub has no follow-up endpoint: the next turn is refused, unsent.
    const sent = copilot.github.fake.requests.length;
    await expect(
      copilot.adapter.sendTurn({ threadId: 't2', input: 'And the footer' }),
    ).rejects.toMatchObject({ kind: 'input_unsupported' });
    expect(copilot.github.fake.requests).toHaveLength(sent);
  });
});
