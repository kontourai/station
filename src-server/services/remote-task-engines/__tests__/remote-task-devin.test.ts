/**
 * The Devin v3 binding through the real service, against an HTTP fake that
 * serves the documented SessionResponse / SessionMessage / page shapes
 * (https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md,
 * https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages).
 */
import { REMOTE_TASK_EVENT_TEXT_MAX_CHARS } from '@kontourai/station-contracts/remote-task-engine';
import { describe, expect, test } from 'vitest';
import { devinStatus } from '../bindings/devin.js';
import { RemoteTaskError } from '../remote-task-error.js';
import {
  REMOTE_TASK_STORED_EVENT_BYTES_MAX,
  RemoteTaskStore,
} from '../stores.js';
import { harness } from './harness.js';
import { devinFake, json } from './vendor-fakes.js';

const ORG = 'org-abc123def456';
const TOKEN = 'cog_test_token_devin_0001';

async function setup() {
  const devin = devinFake(ORG);
  const h = harness(devin.fake.fetch);
  const connectionId = await h.readyConnection('devin', TOKEN, { orgId: ORG });
  return { devin, h, connectionId };
}

describe('Devin binding', () => {
  test('creates a session with the prompt and repository, as the token itself', async () => {
    const { devin, h, connectionId } = await setup();
    const task = await h.service.createTask(connectionId, {
      prompt: 'Fix the flaky test',
      repository: { owner: 'example', name: 'widgets' },
    });
    const [create] = devin.fake.matching('POST', /\/sessions$/);
    expect(create?.url.pathname).toBe(`/v3/organizations/${ORG}/sessions`);
    expect(create?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    // Never impersonates and never forwards secrets.
    expect(create?.body).toEqual({
      prompt: 'Fix the flaky test',
      repos: ['example/widgets'],
    });
    expect(task).toMatchObject({
      vendor: 'devin',
      status: 'queued',
      vendorStatus: 'new',
      url: expect.stringContaining('app.devin.ai'),
    });
    expect(task.taskId).toMatch(/^devin-/);
  });

  test('refuses options Devin does not offer before any request', async () => {
    const { devin, h, connectionId } = await setup();
    await expect(
      h.service.createTask(connectionId, { prompt: 'x', model: 'gpt-x' }),
    ).rejects.toMatchObject({ code: 'remote-task-capability-unsupported' });
    expect(devin.fake.requests).toHaveLength(0);
  });

  test('sends a follow-up and pages messages from the cursor across pages', async () => {
    const { devin, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
    });
    await h.service.sendMessage(connectionId, taskId, 'Also update the docs');
    const [send] = devin.fake.matching('POST', /\/messages$/);
    expect(send?.body).toEqual({ message: 'Also update the docs' });

    for (let i = 0; i < 150; i += 1) devin.reply(taskId, `step ${i}`);
    devin.setStatus(taskId, 'running', 'working');
    const result = await h.service.syncTask(connectionId, taskId);
    // Prompt + follow-up + 150 replies, plus Station's status line.
    const vendorEvents = result.appended.filter(
      (e) => !e.id.startsWith('station:'),
    );
    expect(vendorEvents).toHaveLength(152);
    expect(vendorEvents.map((e) => e.sequence)).toEqual(
      [...vendorEvents.keys()].map((i) => vendorEvents[0]!.sequence + i),
    );
    const pages = devin.fake.matching('GET', /\/messages$/);
    expect(pages.map((p) => p.url.searchParams.get('after'))).toEqual([
      null,
      'c99',
    ]);
    expect(result.quiescent).toBe(false);
  });

  test('catches up after a restart from the stored cursor, without duplicates', async () => {
    const { devin, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
    });
    devin.setStatus(taskId, 'running', 'working');
    for (let i = 0; i < 120; i += 1) devin.reply(taskId, `step ${i}`);
    await h.service.syncTask(connectionId, taskId);
    // Station is off; Devin keeps working.
    devin.reply(taskId, 'made progress');
    devin.reply(taskId, 'opened a PR');
    // A fresh service over the same home stands in for the restart.
    const restarted = harness(devin.fake.fetch, h.home);
    const store = new RemoteTaskStore(h.home);
    const before = store.get(connectionId, taskId);
    // The last page's end_cursor was null: the last cursor Devin issued is kept.
    expect(before?.vendorCursor).toBe('c99');
    const result = await restarted.service.syncTask(connectionId, taskId);
    expect(result.appended.map((e) => e.text)).toEqual([
      'made progress',
      'opened a PR',
    ]);
    expect(
      devin.fake
        .matching('GET', /\/messages$/)
        .at(-1)
        ?.url.searchParams.get('after'),
    ).toBe('c99');

    // A cursor lost in a crash replays the page: stored ids drop it.
    await store.mutate(connectionId, taskId, (record) => ({
      ...record,
      vendorCursor: null,
    }));
    const replay = await restarted.service.syncTask(connectionId, taskId);
    expect(replay.appended).toEqual([]);
    const { events } = h.service.readEvents(connectionId, taskId, 0);
    expect(events.filter((e) => e.text === 'opened a PR')).toHaveLength(1);
  });

  test('terminates through DELETE and reports ACUs, USD overage and pull requests', async () => {
    const { devin, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
    });
    Object.assign(devin.sessions.get(taskId) as object, {
      acus_consumed: 3.5,
      on_demand_usage: 1.25,
      pull_requests: [
        {
          pr_url: 'https://github.com/example/widgets/pull/7',
          pr_state: 'open',
        },
      ],
    });
    await h.service.cancelTask(connectionId, taskId);
    expect(devin.fake.matching('DELETE', /\/sessions\//)).toHaveLength(1);
    const task = await h.service.getTask(connectionId, taskId);
    expect(task.status).toBe('completed');
    expect(task.usage).toEqual([
      { unit: 'acu', quantity: 3.5 },
      { unit: 'usd', quantity: 1.25 },
    ]);
    expect(task.outputs).toEqual([
      {
        kind: 'pull-request',
        url: 'https://github.com/example/widgets/pull/7',
        state: 'open',
      },
    ]);
  });

  test('a 429 becomes a rate-limit refusal carrying the vendor wait', async () => {
    const { devin, h, connectionId } = await setup();
    devin.fake.inject(1, () =>
      json(
        429,
        { title: 'Too Many Requests', status: 429 },
        { 'retry-after': '30' },
      ),
    );
    const error = await h.service
      .createTask(connectionId, { prompt: 'Go' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteTaskError);
    expect(error).toMatchObject({
      code: 'remote-task-rate-limited',
      status: 429,
      details: { retryAfterMs: 30_000, vendorStatus: 429 },
    });
  });

  test('the token is removed from a vendor error code as well as its message', async () => {
    const { devin, h, connectionId } = await setup();
    devin.fake.inject(1, () =>
      json(422, {
        title: 'Unprocessable',
        status: 422,
        detail: 'bad request',
        error_code: `invalid_token_${TOKEN}`,
      }),
    );
    const error = (await h.service
      .createTask(connectionId, { prompt: 'Go' })
      .catch((caught: unknown) => caught)) as RemoteTaskError;
    expect(error.details.vendorCode).toBe('invalid_token_[redacted]');
    expect(JSON.stringify(error.details)).not.toContain(TOKEN);
  });

  test("passes on the vendor's refusal, with the token removed", async () => {
    const { devin, h, connectionId } = await setup();
    devin.fake.inject(1, () =>
      json(403, {
        title: 'Forbidden',
        status: 403,
        detail: `token ${TOKEN} lacks UseDevinSessions`,
        error_code: 'forbidden',
      }),
    );
    const error = (await h.service
      .createTask(connectionId, { prompt: 'Go' })
      .catch((caught: unknown) => caught)) as RemoteTaskError;
    expect(error.code).toBe('remote-task-vendor-refused');
    expect(error.message).toContain('lacks UseDevinSessions');
    expect(error.message).not.toContain(TOKEN);
    expect(error.details.vendorCode).toBe('forbidden');
  });

  test.each([
    ['new', undefined, 'queued'],
    ['claimed', undefined, 'queued'],
    ['running', 'working', 'running'],
    ['running', 'waiting_for_user', 'waiting-for-user'],
    ['running', 'waiting_for_approval', 'waiting-for-user'],
    ['running', 'finished', 'idle'],
    ['suspended', 'inactivity', 'idle'],
    ['resuming', undefined, 'running'],
    ['exit', undefined, 'completed'],
    ['error', undefined, 'failed'],
    ['something-new', undefined, 'unknown'],
  ])('maps %s/%s to %s', (status, detail, expected) => {
    expect(devinStatus(status, detail)).toBe(expected);
  });

  test('a one-page session keeps no cursor and stores nothing twice across polls', async () => {
    const { devin, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
    });
    devin.setStatus(taskId, 'running', 'working');
    devin.reply(taskId, 'first');
    await h.service.syncTask(connectionId, taskId);
    devin.reply(taskId, 'second');
    const again = await h.service.syncTask(connectionId, taskId);
    expect(
      again.appended.filter((e) => e.author !== 'system').map((e) => e.text),
    ).toEqual(['second']);
    // Devin issued no cursor (end_cursor null on its only page), so each poll
    // re-reads that one page from the start.
    expect(
      devin.fake
        .matching('GET', /\/messages$/)
        .map((r) => r.url.searchParams.get('after')),
    ).toEqual([null, null]);
    const { events } = h.service.readEvents(connectionId, taskId, 0);
    expect(events.filter((e) => e.text === 'first')).toHaveLength(1);
  });

  test('a long transcript never wedges sync: text is capped and storage trimmed by bytes', async () => {
    const { devin, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
    }, 60_000);
    devin.setStatus(taskId, 'running', 'working');
    const long = 'x'.repeat(6_000);
    // 800 messages of 6,000 characters: past the 4 MiB budget.
    for (let i = 0; i < 800; i += 1) devin.reply(taskId, `${i}:${long}`);
    // A 20,000-character message is cut and marked.
    devin.reply(taskId, 'y'.repeat(20_000));
    const results = [];
    for (let i = 0; i < 2; i += 1)
      results.push(await h.service.syncTask(connectionId, taskId));
    const stored = new RemoteTaskStore(h.home).get(connectionId, taskId);
    expect(stored).toBeDefined();
    const bytes = Buffer.byteLength(JSON.stringify(stored?.events), 'utf8');
    expect(bytes).toBeLessThanOrEqual(REMOTE_TASK_STORED_EVENT_BYTES_MAX);
    const last = stored?.events.at(-1);
    expect(last?.text).toHaveLength(REMOTE_TASK_EVENT_TEXT_MAX_CHARS);
    expect(last?.truncated).toBe(true);
    // Every message Devin sent got a sequence, though the oldest were dropped.
    expect(stored?.nextSequence).toBeGreaterThan(800);
    const read = h.service.readEvents(connectionId, taskId, 0);
    expect(read.missed).toBe(true);
    expect(read.firstSequence).toBeGreaterThan(1);
    // A later poll still succeeds.
    devin.reply(taskId, 'still going');
    const later = await h.service.syncTask(connectionId, taskId);
    expect(later.appended.map((e) => e.text)).toEqual(['still going']);
  });

  test('a session that finishes is read to its last message once, then not paged again', async () => {
    const { devin, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
    });
    devin.reply(taskId, 'final answer');
    devin.setStatus(taskId, 'exit');
    const finishing = await h.service.syncTask(connectionId, taskId);
    expect(finishing.appended.map((e) => e.text)).toContain('final answer');
    expect(finishing.quiescent).toBe(true);
    const pages = () => devin.fake.matching('GET', /\/messages$/).length;
    const before = pages();
    await h.service.syncTask(connectionId, taskId);
    expect(pages()).toBe(before);
  });

  test("a 410 on a finished session's messages ends paging instead of failing", async () => {
    const { devin, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
    });
    devin.setStatus(taskId, 'exit');
    devin.fake.injectFor('GET', /\/messages$/, () =>
      json(410, { title: 'Gone', status: 410 }),
    );
    const result = await h.service.syncTask(connectionId, taskId);
    expect(result.quiescent).toBe(true);
    expect(h.service.isActive(connectionId, taskId)).toBe(false);
  });

  test('a 410 while the session still runs is a failure, not an end', async () => {
    const { devin, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
    });
    devin.setStatus(taskId, 'running', 'working');
    devin.fake.injectFor('GET', /\/messages$/, () =>
      json(410, { title: 'Gone', status: 410 }),
    );
    await expect(
      h.service.syncTask(connectionId, taskId),
    ).rejects.toMatchObject({
      code: 'remote-task-vendor-refused',
    });
  });

  test('a finished session stops polling until the next sync', async () => {
    const { devin, h, connectionId } = await setup();
    const { taskId } = await h.service.createTask(connectionId, {
      prompt: 'Go',
    });
    devin.setStatus(taskId, 'running', 'finished');
    const result = await h.service.syncTask(connectionId, taskId);
    expect(result.quiescent).toBe(true);
    expect(h.service.isActive(connectionId, taskId)).toBe(false);
  });
});
