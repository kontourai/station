/**
 * The remote task engine as a chat: the provider adapter over the real
 * remote task service and its HTTP fakes. A chat picks a ready connection as
 * its model; the first turn creates the task with only what the person typed
 * (`personText`), replies stream from the shared store, a turn ends only once
 * the vendor reacted and rests (or at its wake or work bound), and every turn
 * ends with a line naming the status and results. Polls run only inside a
 * turn and are driven by the test's timer and clock.
 */
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { harness } from '../../services/remote-task-engines/__tests__/harness.js';
import {
  cursorFake,
  devinFake,
  githubFake,
  json,
} from '../../services/remote-task-engines/__tests__/vendor-fakes.js';
import {
  PersonAuthoredTurnRequiredError,
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

type Vendor = 'devin' | 'github-copilot' | 'cursor';

async function setup(
  vendor: Vendor = 'devin',
  options: { repository?: typeof REPO | null } = {},
) {
  const devin = devinFake(ORG);
  const github = githubFake();
  const cursor = cursorFake();
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com'))
      return github.fake.fetch(input, init);
    if (url.startsWith('https://api.cursor.com'))
      return cursor.fake.fetch(input, init);
    return devin.fake.fetch(input, init);
  };
  const h = harness(fetchImpl);
  const connectionId =
    vendor === 'devin'
      ? await h.readyConnection('devin', TOKEN, { orgId: ORG })
      : vendor === 'cursor'
        ? await h.readyConnection('cursor', 'key_cursor_test_0001')
        : await h.readyConnection('github-copilot', 'github_pat_test_0001_abc');
  const timers: Array<{ run: () => void; cleared: boolean; ms: number }> = [];
  const clock = { now: 1_000_000 };
  const repository =
    options.repository === undefined ? REPO : (options.repository ?? undefined);
  const adapter = new RemoteTaskAdapter({
    service: h.service,
    resolveRepository: async () => repository,
    now: () => clock.now,
    setTimer: (run, ms) => {
      const timer = { run, cleared: false, ms };
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
  const ended = () =>
    events.filter(
      (e) => e.method === 'turn.completed' || e.method === 'turn.aborted',
    ).length;
  /** Run the pending poll (advancing the clock) and wait until it settled. */
  const poll = async (advanceMs = 15_000) => {
    const timer = timers.filter((t) => !t.cleared).at(-1);
    if (!timer) throw new Error('no poll scheduled');
    timer.cleared = true;
    clock.now += advanceMs;
    const scheduled = timers.length;
    const before = ended();
    timer.run();
    for (let i = 0; i < 500; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      if (timers.length > scheduled || ended() > before) return;
    }
    throw new Error('the poll did not settle');
  };
  const pending = () => timers.filter((t) => !t.cleared).length;
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };
  const start = (threadId = 't1') =>
    adapter.startSession({
      threadId,
      provider: 'remote-task',
      modelId: connectionId,
      cwd: '/work/widgets',
    });
  const send = (text: string, threadId = 't1') =>
    adapter.sendTurn({ threadId, input: text, personText: text });
  const texts = () =>
    events
      .filter((e) => e.method === 'content.text-delta')
      .map((e) => (e as { delta: string }).delta);
  const last = <M extends CanonicalRuntimeEvent['method']>(method: M) =>
    events.filter((e) => e.method === method).at(-1) as
      | Extract<CanonicalRuntimeEvent, { method: M }>
      | undefined;
  return {
    adapter,
    h,
    devin,
    github,
    cursor,
    connectionId,
    events,
    poll,
    pending,
    settle,
    start,
    send,
    texts,
    last,
    clock,
    ended,
  };
}

describe('RemoteTaskAdapter', () => {
  test('the model picker lists only connections ready for a chat', async () => {
    const s = await setup();
    expect((await s.adapter.listModelCatalog()).models).toEqual([
      { id: s.connectionId, name: 'Devin', originalId: s.connectionId },
    ]);
    s.h.switches.policy = { engines: {} };
    expect((await s.adapter.listModelCatalog()).models).toEqual([]);
    s.h.switches.policy = null;
    s.h.switches.preview = false;
    expect((await s.adapter.listModelCatalog()).models).toEqual([]);
  });

  test('a start on a connection that is not ready is refused before anything is published', async () => {
    const s = await setup();
    s.h.switches.preview = false;
    await expect(s.start()).rejects.toBeInstanceOf(SessionStartRefusedError);
    await s.settle();
    expect(s.events).toEqual([]);
  });

  test("the first turn sends only the person's typed text, and nothing without it", async () => {
    const s = await setup();
    await s.start();
    await expect(
      s.adapter.sendTurn({
        threadId: 't1',
        input: 'Station context\n\nFix it',
        displayInput: 'Independent review request',
      }),
    ).rejects.toBeInstanceOf(PersonAuthoredTurnRequiredError);
    expect(s.devin.fake.requests).toHaveLength(0);
    await s.adapter.sendTurn({
      threadId: 't1',
      input: 'Station context: secret project notes\n\nFix the flaky test',
      personText: 'Fix the flaky test',
    });
    expect(s.devin.fake.matching('POST', /\/sessions$/)[0]?.body).toEqual({
      prompt: 'Fix the flaky test',
      repos: ['example/widgets'],
    });
  });

  test('a reply the tracker stored first still shows in the turn, and the turn ends with its results', async () => {
    const s = await setup();
    await s.start();
    const turn = await s.send('Fix the flaky test');
    const taskId = (turn.resumeCursor as { taskId: string }).taskId;
    s.devin.reply(taskId, 'Fixed and opened a PR.');
    Object.assign(s.devin.sessions.get(taskId) as object, {
      pull_requests: [
        {
          pr_url: 'https://github.com/example/widgets/pull/9',
          pr_state: 'open',
        },
      ],
    });
    s.devin.setStatus(taskId, 'running', 'finished');
    // The tracker (or a GET) syncs before the turn's own poll.
    const tracked = await s.h.service.syncTask(s.connectionId, taskId);
    expect(
      tracked.appended.some((e) => e.text === 'Fixed and opened a PR.'),
    ).toBe(true);
    await s.poll();
    await s.settle();
    expect(s.texts()[0]).toBe('Fixed and opened a PR.');
    const completed = s.last('turn.completed');
    expect(completed?.outputText).toContain('Fixed and opened a PR.');
    expect(completed?.outputText).toContain(
      'Pull request: https://github.com/example/widgets/pull/9 (open).',
    );
    expect(s.events.map((e) => e.method)).toEqual(
      expect.arrayContaining(['tool.started', 'tool.completed']),
    );
    expect(s.pending()).toBe(0);
  });

  test('a follow-up into a slow wake waits past the old three polls and ends "still waking" at its bound, not empty', async () => {
    const s = await setup();
    await s.start();
    const first = await s.send('Go');
    const taskId = (first.resumeCursor as { taskId: string }).taskId;
    s.devin.reply(taskId, 'Done.');
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    expect(s.ended()).toBe(1);
    await s.send('Also the docs');
    // Devin has not picked the message up: still "finished" for ten polls.
    for (let i = 0; i < 10; i += 1) await s.poll(15_000);
    expect(s.ended()).toBe(1);
    // Past the wake bound (ten minutes after the send).
    await s.poll(10 * 60_000);
    const aborted = s.last('turn.aborted');
    expect(aborted?.reason).toContain('may still be waking');
    expect(s.last('turn.completed')).toBe(
      s.events.filter((e) => e.method === 'turn.completed')[0],
    );
    // Its late reply shows with the next message, not lost.
    s.devin.reply(taskId, 'Docs updated.');
    await s.send('Thanks');
    s.devin.setStatus(taskId, 'running', 'working');
    await s.poll();
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    expect(s.texts()).toContain('Docs updated.');
  });

  test("a late reply to an earlier turn shows in the next one but is not the vendor's answer to it", async () => {
    const s = await setup();
    await s.start();
    const first = await s.send('Go');
    const taskId = (first.resumeCursor as { taskId: string }).taskId;
    s.devin.reply(taskId, 'Done.');
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    expect(s.ended()).toBe(1);
    await s.send('Also the docs');
    await s.poll(10 * 60_000);
    expect(s.last('turn.aborted')?.reason).toContain('may still be waking');
    expect(s.ended()).toBe(2);
    // The reply to "Also the docs" lands after that turn ended, before the
    // next message; Devin has not picked "And the changelog" up yet.
    s.devin.reply(taskId, 'Docs updated.');
    await s.send('And the changelog');
    await s.poll();
    expect(s.texts()).toContain('Docs updated.');
    // Still open: a reply written before this message is not its answer.
    expect(s.ended()).toBe(2);
    s.devin.setStatus(taskId, 'running', 'working');
    await s.poll();
    s.devin.reply(taskId, 'Changelog updated.');
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    expect(s.ended()).toBe(3);
    expect(s.last('turn.completed')?.outputText).toContain(
      'Changelog updated.',
    );
  });

  test('a rate-limited vendor never holds a turn past its wake bound, and a long Retry-After is honoured', async () => {
    const s = await setup();
    await s.start();
    await s.send('Go');
    // Every request from here is refused with an hour's Retry-After.
    s.devin.fake.inject(1000, () =>
      json(429, { detail: 'Too many requests' }, { 'retry-after': '3600' }),
    );
    const requests = () => s.devin.fake.requests.length;
    const before = requests();
    await s.poll();
    expect(requests()).toBe(before + 1);
    // Inside the vendor's wait: progress only, never another request.
    for (let i = 0; i < 3; i += 1) await s.poll(150_000);
    expect(requests()).toBe(before + 1);
    expect(s.last('tool.progress')?.message).toContain('asked Station to wait');
    expect(s.ended()).toBe(0);
    // Ten minutes after the send with no reaction: the turn ends.
    await s.poll(150_000);
    expect(s.last('turn.aborted')?.reason).toContain('may still be waking');
    expect(s.pending()).toBe(0);
    expect(requests()).toBe(before + 1);
  });

  test('a rate-limited vendor never holds a working turn past its work bound', async () => {
    const s = await setup();
    await s.start();
    const turn = await s.send('Go');
    const taskId = (turn.resumeCursor as { taskId: string }).taskId;
    s.devin.setStatus(taskId, 'running', 'working');
    await s.poll();
    s.devin.fake.inject(1000, () =>
      json(429, { detail: 'Too many requests' }, { 'retry-after': '3600' }),
    );
    const before = s.devin.fake.requests.length;
    for (let i = 0; i < 30 && s.ended() === 0; i += 1) await s.poll(150_000);
    const completed = s.last('turn.completed');
    expect(completed?.metadata).toMatchObject({ stillWorking: true });
    expect(completed?.outputText).toContain('still working');
    // One refused request, then only progress until the bound.
    expect(s.devin.fake.requests.length).toBe(before + 1);
    expect(s.pending()).toBe(0);
  });

  test('Stop in a Devin chat stops following and leaves the session running', async () => {
    const s = await setup();
    await s.start();
    const turn = await s.send('Go');
    expect(await s.adapter.interruptTurn('t1', turn.turnId)).toEqual({
      outcome: 'termination-unconfirmed',
      turnId: turn.turnId,
    });
    // Devin's cancel is terminate: never sent from a chat's Stop.
    expect(s.devin.fake.matching('DELETE', /\/sessions\//)).toHaveLength(0);
    await s.settle();
    expect(s.last('turn.aborted')?.reason).toContain('keeps working on it');
    expect(s.pending()).toBe(0);
    // The chat still takes follow-ups to the running session.
    await s.send('Carry on');
    expect(s.devin.fake.matching('POST', /\/messages$/)).toHaveLength(1);
  });

  test('Stop in a Cursor chat cancels the run, which leaves the agent usable', async () => {
    const s = await setup('cursor');
    await s.start();
    const turn = await s.send('Add a README');
    expect(await s.adapter.interruptTurn('t1', turn.turnId)).toEqual({
      outcome: 'cancelled',
      turnId: turn.turnId,
    });
    expect(s.cursor.fake.matching('POST', /\/cancel$/)).toHaveLength(1);
  });

  test('a Devin session that ended takes no more messages', async () => {
    const s = await setup();
    await s.start();
    const first = await s.send('Go');
    const taskId = (first.resumeCursor as { taskId: string }).taskId;
    s.devin.reply(taskId, 'All done.');
    s.devin.setStatus(taskId, 'exit');
    await s.poll();
    const sent = s.devin.fake.requests.length;
    await expect(s.send('One more thing')).rejects.toMatchObject({
      kind: 'input_unsupported',
      message: expect.stringContaining('has ended'),
    });
    expect(s.devin.fake.requests).toHaveLength(sent);
  });

  test('a Copilot chat shows its status, pull request and where to answer', async () => {
    const s = await setup('github-copilot');
    await s.start();
    const turn = await s.send('Fix the login button');
    const taskId = (turn.resumeCursor as { taskId: string }).taskId;
    Object.assign(s.github.tasks.get(taskId) as object, {
      state: 'waiting_for_user',
      artifacts: [
        {
          provider: 'github',
          type: 'pull',
          data: { id: 42, global_id: 'PR_x' },
        },
      ],
    });
    await s.poll();
    await s.settle();
    const line = s.texts().at(-1) ?? '';
    expect(line).toContain('GitHub Copilot cloud agent: waiting for you.');
    expect(line).toContain('Pull request: pull:42.');
    expect(line).toContain(`Task: https://github.com/copilot/tasks/${taskId}`);
    expect(line).toContain('Answer it in GitHub Copilot cloud agent');
  });

  test('two first sends at once create one task', async () => {
    const s = await setup();
    await s.start();
    const [a, b] = await Promise.allSettled([s.send('One'), s.send('Two')]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const refused = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(SendTurnRefusedError);
    expect(s.devin.fake.matching('POST', /\/sessions$/)).toHaveLength(1);
  });

  test('a failed task ends the turn as aborted, not as a normal stop', async () => {
    const s = await setup();
    await s.start();
    const turn = await s.send('Go');
    const taskId = (turn.resumeCursor as { taskId: string }).taskId;
    s.devin.setStatus(taskId, 'error');
    await s.poll();
    await s.settle();
    expect(s.last('turn.aborted')?.reason).toContain('failed');
    expect(s.last('turn.completed')).toBeUndefined();
  });

  test('a long task ends the turn "still working" at the work bound and keeps polls under the stall window', async () => {
    const s = await setup();
    await s.start();
    const turn = await s.send('Big refactor');
    const taskId = (turn.resumeCursor as { taskId: string }).taskId;
    s.devin.setStatus(taskId, 'running', 'working');
    await s.poll();
    expect(s.last('tool.progress')?.message).toBe('Devin: running:working');
    await s.poll(61 * 60_000);
    const completed = s.last('turn.completed');
    expect(completed?.finishReason).toBe('other');
    expect(completed?.outputText).toContain('still working on this');
    expect(completed?.metadata).toMatchObject({ stillWorking: true });
  });

  test('a Copilot chat without a GitHub origin is refused at start; a Devin chat starts with a warning', async () => {
    const copilot = await setup('github-copilot', { repository: null });
    await expect(copilot.start()).rejects.toMatchObject({
      message: expect.stringContaining('no GitHub origin'),
    });
    const devin = await setup('devin', { repository: null });
    await devin.start();
    await devin.settle();
    expect(devin.last('runtime.warning')?.message).toContain(
      'no GitHub origin remote',
    );
  });

  test('a restarted chat resumes its task from the cursor without replaying history', async () => {
    const s = await setup();
    await s.start();
    const first = await s.send('Go');
    const taskId = (first.resumeCursor as { taskId: string }).taskId;
    s.devin.reply(taskId, 'First answer.');
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    await s.adapter.stopSession('t1');
    await s.adapter.startSession({
      threadId: 't1',
      provider: 'remote-task',
      resumeCursor: first.resumeCursor,
    });
    await s.send('Next');
    expect(s.devin.fake.matching('POST', /\/sessions$/)).toHaveLength(1);
    s.devin.setStatus(taskId, 'running', 'working');
    await s.poll();
    s.devin.reply(taskId, 'Second answer.');
    s.devin.setStatus(taskId, 'running', 'finished');
    await s.poll();
    const agentTexts = s.texts().filter((t) => !t.includes('Devin:'));
    expect(agentTexts).toEqual(['First answer.', 'Second answer.']);
  });

  test('a turn while the preview is off is refused before any request', async () => {
    const s = await setup();
    await s.start();
    s.h.switches.preview = false;
    await expect(s.send('Go')).rejects.toBeInstanceOf(SendTurnRefusedError);
    expect(s.devin.fake.requests).toHaveLength(0);
  });
});
