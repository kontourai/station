/**
 * The Cursor Cloud Agents v1 binding through the real service, against an
 * HTTP fake serving the reference's own example bodies and its agent SSE
 * stream (https://cursor.com/docs/cloud-agent/api/endpoints).
 */
import { describe, expect, test } from 'vitest';
import { RemoteTaskStore } from '../stores.js';
import { harness } from './harness.js';
import { CURSOR_FINISHED_RUN, cursorFake } from './vendor-fakes.js';

const TOKEN = 'key_cursor_test_0001';

async function setup() {
  const cursor = cursorFake();
  const h = harness(cursor.fake.fetch);
  const connectionId = await h.readyConnection('cursor', TOKEN);
  return { cursor, h, connectionId };
}

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

  test('pages messages from the stream and resumes with Last-Event-ID, without duplicates', async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.state.run.status = 'RUNNING';
    cursor.state.stream.push(
      {
        id: '1713033000000-0',
        event: 'assistant',
        data: { text: "I'll update the README now." },
      },
      {
        id: '1713033005000-0',
        event: 'tool_call',
        data: { callId: 'call-1', name: 'read_file', status: 'running' },
      },
    );
    const first = await h.service.syncTask(connectionId, cursor.agentId);
    expect(
      first.appended.filter((e) => e.author === 'agent').map((e) => e.text),
    ).toEqual(["I'll update the README now."]);
    const streams = () => cursor.fake.matching('GET', /\/stream$/);
    expect(streams()[0]?.headers.get('last-event-id')).toBeNull();

    cursor.state.stream.push({
      id: '1713033302000-0',
      event: 'assistant',
      data: { text: 'Also adding a section on running the tests.' },
    });
    const second = await h.service.syncTask(connectionId, cursor.agentId);
    // The cursor is the last id read, the tool call's included.
    expect(streams()[1]?.headers.get('last-event-id')).toBe('1713033005000-0');
    expect(
      second.appended.filter((e) => e.author === 'agent').map((e) => e.text),
    ).toEqual(['Also adding a section on running the tests.']);

    // An expired stream position re-reads what Cursor retains; the store
    // drops what it already holds.
    cursor.state.expiredBefore = '9';
    const third = await h.service.syncTask(connectionId, cursor.agentId);
    expect(third.appended.filter((e) => e.author === 'agent')).toEqual([]);
    expect(streams().at(-1)?.headers.get('last-event-id')).toBeNull();
    const store = new RemoteTaskStore(h.home);
    expect(store.get(connectionId, cursor.agentId)?.vendorCursor).toBe(
      '1713033302000-0',
    );
  });

  test('cancels the latest run, and reads token usage once the agent stops', async () => {
    const { cursor, h, connectionId } = await setup();
    await h.service.cancelTask(connectionId, cursor.agentId);
    expect(
      cursor.fake.matching('POST', /\/runs\/[^/]+\/cancel$/)[0]?.url.pathname,
    ).toBe(
      `/v1/agents/${cursor.agentId}/runs/run-00000000-0000-0000-0000-000000000001/cancel`,
    );
    cursor.state.run = structuredClone(CURSOR_FINISHED_RUN);
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

  test('usage is not read on every poll while the agent runs', async () => {
    const { cursor, h, connectionId } = await setup();
    cursor.state.run.status = 'RUNNING';
    await h.service.syncTask(connectionId, cursor.agentId);
    await h.service.syncTask(connectionId, cursor.agentId);
    expect(cursor.fake.matching('GET', /\/usage$/)).toHaveLength(0);
  });
});
