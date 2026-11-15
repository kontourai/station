/**
 * The Cursor Cloud Agents v1 binding through the real service, against an
 * HTTP fake serving the reference's own example bodies
 * (https://cursor.com/docs/cloud-agent/api/endpoints). The fake's agent
 * stream sends `assistant` text deltas, as the reference documents for an
 * ordinary agent; Station reads each finished run's `result` instead and
 * never opens the stream.
 */
import { describe, expect, test } from 'vitest';
import { RemoteTaskStore } from '../stores.js';
import { harness } from './harness.js';
import { cursorFake } from './vendor-fakes.js';

const TOKEN = 'key_cursor_test_0001';

async function setup() {
  const cursor = cursorFake();
  const h = harness(cursor.fake.fetch);
  const connectionId = await h.readyConnection('cursor', TOKEN);
  return { cursor, h, connectionId };
}

const agentMessages = (
  events: ReadonlyArray<{ author: string; text: string }>,
) => events.filter((e) => e.author === 'agent').map((e) => e.text);

describe('Cursor binding', () => {
  test('creates an agent with v1 fields and never forwards tool servers', async () => {
    const { cursor, h, connectionId } = await setup();
    const task = await h.service.createTask(connectionId, {
      prompt: 'Add a README with setup instructions',
      repository: { owner: 'your-org', name: 'your-repo' },
      baseRef: 'main',
      model: 'composer-2',
      createPullRequest: true,
    });
    const [create] = cursor.fake.requests;
    expect(create?.url.pathname).toBe('/v1/agents');
    expect(create?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(create?.body).toEqual({
      prompt: { text: 'Add a README with setup instructions' },
      model: { id: 'composer-2' },
      repos: [
        { url: 'https://github.com/your-org/your-repo', startingRef: 'main' },
      ],
      autoCreatePR: true,
    });
    expect(create?.body).not.toHaveProperty('mcpServers');
    expect(task).toMatchObject({
      taskId: cursor.agentId,
      status: 'queued',
      vendorStatus: 'ACTIVE:CREATING',
    });
  });

  test('a follow-up to a busy agent steers it instead of failing', async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.state.busy = true;
    const result = await h.service.sendMessage(
      connectionId,
      cursor.agentId,
      'Also cover the error path',
    );
    expect(result).toEqual({ delivery: 'steered' });
    const runs = cursor.fake.matching('POST', /\/runs$/);
    expect(runs.map((r) => r.body)).toEqual([
      { prompt: { text: 'Also cover the error path' } },
      { prompt: { text: 'Also cover the error path' }, delivery: 'steer' },
    ]);
  });

  test("stores each finished run's result once, never a stream delta, and opens no stream", async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.state.run.status = 'RUNNING';
    const running = await h.service.syncTask(connectionId, cursor.agentId);
    // A running run has no result yet: nothing from the agent, and the
    // stream's deltas ("I'll ", "update ", ...) are never read.
    expect(agentMessages(running.appended)).toEqual([]);

    cursor.finishRun('Added README.md with installation instructions.');
    const finished = await h.service.syncTask(connectionId, cursor.agentId);
    expect(agentMessages(finished.appended)).toEqual([
      'Added README.md with installation instructions.',
    ]);

    // A follow-up run finishes; earlier results are not stored again.
    cursor.startRun(
      'run-00000000-0000-0000-0000-000000000002',
      '2026-04-13T18:50:00.000Z',
    );
    await h.service.sendMessage(connectionId, cursor.agentId, 'Add tests');
    cursor.finishRun('Added a test for the README check.');
    const second = await h.service.syncTask(connectionId, cursor.agentId);
    expect(agentMessages(second.appended)).toEqual([
      'Added a test for the README check.',
    ]);
    const replay = await h.service.syncTask(connectionId, cursor.agentId);
    expect(replay.appended).toEqual([]);

    const { events } = h.service.readEvents(connectionId, cursor.agentId, 0);
    expect(agentMessages(events)).toEqual([
      'Added README.md with installation instructions.',
      'Added a test for the README check.',
    ]);
    expect(cursor.fake.matching('GET', /\/stream$/)).toHaveLength(0);
  });

  test('reads a result the runs list leaves out from the run itself', async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.state.omitResultInList = true;
    cursor.finishRun('Done from the run read.');
    const result = await h.service.syncTask(connectionId, cursor.agentId);
    expect(agentMessages(result.appended)).toEqual(['Done from the run read.']);
  });

  test('an archived agent is read to its last result once, then not paged again', async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.finishRun('Last words.');
    cursor.state.agent.status = 'ARCHIVED';
    // The runs list stays readable for an archived agent (OpenAPI).
    const first = await h.service.syncTask(connectionId, cursor.agentId);
    expect(first.quiescent).toBe(true);
    expect(first.task.status).toBe('completed');
    expect(agentMessages(first.appended)).toEqual(['Last words.']);
    const lists = () => cursor.fake.matching('GET', /\/runs$/).length;
    expect(lists()).toBe(1);
    // Settled: the next sync reads the agent but pages nothing.
    const second = await h.service.syncTask(connectionId, cursor.agentId);
    expect(second.quiescent).toBe(true);
    expect(lists()).toBe(1);
    expect(h.service.isActive(connectionId, cursor.agentId)).toBe(false);
  });

  test('a burst of finished runs past the first list page is stored in full', async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.state.run.status = 'RUNNING';
    await h.service.syncTask(connectionId, cursor.agentId);
    // 130 runs finish between polls: past one list page even at limit=100.
    cursor.finishRun('run 0 done');
    for (let i = 1; i < 130; i += 1) {
      cursor.startRun(
        `run-10000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        new Date(
          Date.parse('2026-04-13T19:00:00.000Z') + i * 60_000,
        ).toISOString(),
      );
      cursor.finishRun(`run ${i} done`);
    }
    const result = await h.service.syncTask(connectionId, cursor.agentId);
    expect(agentMessages(result.appended)).toEqual(
      Array.from({ length: 130 }, (_, i) => `run ${i} done`),
    );
    // limit is sent, and paging stops once it reaches a stored run.
    const lists = cursor.fake.matching('GET', /\/runs$/);
    expect(lists.at(-1)?.url.searchParams.get('limit')).toBe('100');
    cursor.startRun(
      'run-00000000-0000-0000-0000-000000000099',
      '2026-04-13T20:00:00.000Z',
    );
    cursor.finishRun('one more');
    const listsBefore = cursor.fake.matching('GET', /\/runs$/).length;
    const again = await h.service.syncTask(connectionId, cursor.agentId);
    expect(agentMessages(again.appended)).toEqual(['one more']);
    // The follow-up's first list page already holds a stored run: one list.
    expect(cursor.fake.matching('GET', /\/runs$/).length - listsBefore).toBe(1);
  });

  test('a burst past ten list pages is resumed from the vendor cursor, not dropped', async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.state.run.status = 'RUNNING';
    await h.service.syncTask(connectionId, cursor.agentId);
    // 1,050 runs: fifty past the ten pages one call reads at limit=100.
    cursor.finishRun('run 0 done');
    for (let i = 1; i < 1050; i += 1) {
      cursor.startRun(
        `run-10000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        new Date(
          Date.parse('2026-04-13T19:00:00.000Z') + i * 60_000,
        ).toISOString(),
      );
      cursor.finishRun(`run ${i} done`);
    }
    const listsBefore = cursor.fake.matching('GET', /\/runs$/).length;
    const result = await h.service.syncTask(connectionId, cursor.agentId);
    expect(new Set(agentMessages(result.appended))).toEqual(
      new Set(Array.from({ length: 1050 }, (_, i) => `run ${i} done`)),
    );
    expect(result.appended.filter((e) => e.author === 'agent')).toHaveLength(
      1050,
    );
    expect(result.quiescent).toBe(true);
    // Ten pages, then one more from the resume cursor.
    const lists = cursor.fake.matching('GET', /\/runs$/).slice(listsBefore);
    expect(lists).toHaveLength(11);
    expect(lists.at(-1)?.url.searchParams.get('cursor')).toBe('1000');
    // The backlog read, listing starts from the newest run again.
    cursor.startRun(
      'run-00000000-0000-0000-0000-000000000099',
      '2026-04-14T19:00:00.000Z',
    );
    cursor.finishRun('one more');
    const again = await h.service.syncTask(connectionId, cursor.agentId);
    expect(agentMessages(again.appended)).toEqual(['one more']);
    expect(
      cursor.fake
        .matching('GET', /\/runs$/)
        .at(-1)
        ?.url.searchParams.get('cursor'),
    ).toBeNull();
  });

  test('runs that ended with no result are read once each, and the task settles', async () => {
    const { cursor, h, connectionId } = await setup();
    // Seven cancelled runs, none with a result, in the list or on its own.
    cursor.endRunWithoutResult('CANCELLED');
    for (let i = 1; i < 7; i += 1) {
      cursor.startRun(
        `run-10000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        `2026-04-13T19:0${i}:00.000Z`,
      );
      cursor.endRunWithoutResult('CANCELLED');
    }
    const runReads = () =>
      cursor.fake.matching('GET', /\/runs\/run-[^/]+$/).length;
    const first = await h.service.syncTask(connectionId, cursor.agentId);
    expect(first.quiescent).toBe(true);
    expect(agentMessages(first.appended)).toEqual([]);
    expect(
      first.appended.filter((e) => e.text.endsWith('with no result.')),
    ).toHaveLength(7);
    // The sync's own latest-run read, then each run once.
    expect(runReads()).toBe(8);
    expect(h.service.isActive(connectionId, cursor.agentId)).toBe(false);
    // Settled: the next sync reads the agent and its latest run, nothing else.
    const requests = cursor.fake.requests.length;
    const second = await h.service.syncTask(connectionId, cursor.agentId);
    expect(second.quiescent).toBe(true);
    expect(second.appended).toEqual([]);
    expect(cursor.fake.requests.length - requests).toBe(2);
  });

  test('finished runs listed without a result are all read, none twice, before the task settles', async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.state.omitResultInList = true;
    cursor.finishRun('result 0');
    for (let i = 1; i < 8; i += 1) {
      cursor.startRun(
        `run-10000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        `2026-04-13T19:0${i}:00.000Z`,
      );
      cursor.finishRun(`result ${i}`);
    }
    const result = await h.service.syncTask(connectionId, cursor.agentId);
    expect(agentMessages(result.appended)).toEqual(
      Array.from({ length: 8 }, (_, i) => `result ${i}`),
    );
    expect(result.quiescent).toBe(true);
    // Each resultless run read exactly once: the sync's own latest-run read
    // plus eight fallback reads, never one already stored again.
    expect(cursor.fake.matching('GET', /\/runs\/run-[^/]+$/)).toHaveLength(9);
  });

  test('cancels the latest run, and reads token usage once the agent stops', async () => {
    const { cursor, h, connectionId } = await setup();
    await h.service.cancelTask(connectionId, cursor.agentId);
    expect(
      cursor.fake.matching('POST', /\/runs\/[^/]+\/cancel$/)[0]?.url.pathname,
    ).toBe(
      `/v1/agents/${cursor.agentId}/runs/run-00000000-0000-0000-0000-000000000001/cancel`,
    );
    cursor.finishRun('Stopped early.', 'FINISHED');
    Object.assign(cursor.state.run, {
      git: {
        branches: [
          {
            repoUrl: 'github.com/your-org/your-repo',
            branch: 'cursor/add-readme-a1b2',
            prUrl: 'https://github.com/your-org/your-repo/pull/123',
          },
        ],
      },
    });
    const result = await h.service.syncTask(connectionId, cursor.agentId);
    expect(result.quiescent).toBe(true);
    expect(result.task.status).toBe('completed');
    expect(result.task.usage).toEqual([{ unit: 'tokens', quantity: 76390 }]);
    expect(result.task.outputs).toEqual([
      {
        kind: 'pull-request',
        url: 'https://github.com/your-org/your-repo/pull/123',
      },
    ]);
    expect(cursor.fake.matching('GET', /\/usage$/)).toHaveLength(1);
  });

  test('a poll costs three requests and usage is not read while the agent runs', async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.state.run.status = 'RUNNING';
    await h.service.syncTask(connectionId, cursor.agentId);
    // agent, latest run, runs list
    expect(cursor.fake.requests).toHaveLength(3);
    await h.service.syncTask(connectionId, cursor.agentId);
    expect(cursor.fake.matching('GET', /\/usage$/)).toHaveLength(0);
    expect(
      new RemoteTaskStore(h.home).get(connectionId, cursor.agentId)
        ?.vendorCursor,
    ).toBeNull();
  });
});
