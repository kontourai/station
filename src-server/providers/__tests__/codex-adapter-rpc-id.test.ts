/**
 * #562: a JSON-RPC reply must carry the peer's request id exactly as it was
 * sent — value AND type. Codex issues its server requests (approvals) with
 * numeric ids and silently drops a reply whose id is `"0"` for request `0`,
 * so an approval Station recorded as resolved never reached the engine and
 * the delegated task stalled in `running`.
 *
 * Every case drives the real `CodexAdapter` through its child's stdout and
 * reads the reply off its stdin, asserting the parsed id's value and
 * `typeof`. The id table covers numeric zero, a non-zero number, an ordinary
 * string, and a numeric-looking string (which must stay a string).
 */
import { describe, expect, test } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import {
  commandApproval,
  emit,
  FakeCodexProcess,
  flushIo,
  openedRequestId,
  repliesTo,
  startedAdapter,
  THREAD,
  waitFor,
  withTimeout,
} from './codex-adapter-wire-harness.js';

const IDS: Array<[string, string | number]> = [
  ['numeric zero', 0],
  ['non-zero number', 7],
  ['string', 'approval-1'],
  ['numeric-looking string', '0'],
];

describe('#562: Codex JSON-RPC replies echo the request id with its type', () => {
  test.each(IDS)(
    'respond accept answers a %s id unchanged',
    async (_name, id) => {
      const { adapter, process, events } = await startedAdapter();
      await emit(process, commandApproval(id));
      const requestId = await openedRequestId(events);

      await adapter.respondToRequest(THREAD, requestId, 'accept');

      const [reply] = repliesTo(process, id);
      expect(reply).toEqual({
        jsonrpc: '2.0',
        id,
        result: { decision: 'accept' },
      });
      expect(typeof reply.id).toBe(typeof id);
      await adapter.stopAll();
    },
  );

  test.each(IDS)(
    'respond decline answers a %s id unchanged',
    async (_name, id) => {
      const { adapter, process, events } = await startedAdapter();
      await emit(process, commandApproval(id));
      const requestId = await openedRequestId(events);

      await adapter.respondToRequest(THREAD, requestId, 'decline');

      const [reply] = repliesTo(process, id);
      expect(reply).toEqual({
        jsonrpc: '2.0',
        id,
        result: { decision: 'decline' },
      });
      expect(typeof reply.id).toBe(typeof id);
      await adapter.stopAll();
    },
  );

  test.each(IDS)(
    'a session-grant auto-approval answers a %s id unchanged',
    async (_name, id) => {
      const { adapter, process, events } = await startedAdapter();
      // Seed the grant with a distinct id so only the auto-approval can
      // produce a reply carrying `id`.
      await emit(process, commandApproval('grant-seed', 'cmd-seed'));
      const seedRequestId = await openedRequestId(events);
      await adapter.respondToRequest(THREAD, seedRequestId, 'acceptForSession');

      await emit(process, commandApproval(id, 'cmd-2'));

      const reply = await waitFor(
        () => repliesTo(process, id)[0],
        'auto-approval reply',
      );
      expect(reply).toEqual({
        jsonrpc: '2.0',
        id,
        result: { decision: 'accept' },
      });
      expect(typeof reply.id).toBe(typeof id);
      // Auto-approved: no second prompt was opened.
      expect(
        events.filter((event) => event.method === 'request.opened'),
      ).toHaveLength(1);
      await adapter.stopAll();
    },
  );

  test.each(IDS)(
    'an interrupt cancels an open approval (#2316) on a %s id unchanged',
    async (_name, id) => {
      const { adapter, process, events } = await startedAdapter();
      await emit(process, commandApproval(id));
      await openedRequestId(events);

      const interrupt = adapter.interruptTurn(THREAD, 'turn-1');
      await flushIo();
      const interruptRpc = await waitFor(
        () =>
          process.stdin.lines
            .map((line) => JSON.parse(line))
            .find((line) => line.method === 'turn/interrupt'),
        'turn/interrupt',
      );
      await emit(process, { id: interruptRpc.id, result: {} });
      await withTimeout(interrupt, 'interruptTurn');

      const [reply] = repliesTo(process, id);
      expect(reply).toEqual({
        jsonrpc: '2.0',
        id,
        result: { decision: 'cancel' },
      });
      expect(typeof reply.id).toBe(typeof id);
      await adapter.stopAll();
    },
  );

  test.each(IDS)(
    'an unsupported server request is refused on a %s id unchanged',
    async (_name, id) => {
      const { adapter, process } = await startedAdapter();
      await emit(process, {
        id,
        method: 'station/test/unsupportedRequest',
        params: {},
      });

      const [reply] = repliesTo(process, id);
      expect(reply).toMatchObject({
        jsonrpc: '2.0',
        id,
        error: { code: -32601 },
      });
      expect(typeof reply.id).toBe(typeof id);
      await adapter.stopAll();
    },
  );

  test('a numeric id never settles a pending Station request with the same digits', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process as never,
    });
    let settled = false;
    const session = adapter
      .startSession({ provider: 'codex', threadId: THREAD, cwd: '/tmp/p' })
      .finally(() => {
        settled = true;
      });
    await flushIo();
    // Station's `initialize` went out as id "1". A numeric 1 is a different
    // JSON-RPC id and must not be taken as its reply.
    const initialize = JSON.parse(process.stdin.lines[0]);
    expect(initialize).toMatchObject({ id: '1', method: 'initialize' });
    await emit(process, { id: 1, result: { userAgent: 'wrong-id' } });
    await flushIo();
    expect(
      process.stdin.lines
        .map((line) => JSON.parse(line))
        .some((line) => line.method === 'thread/start'),
    ).toBe(false);
    expect(settled).toBe(false);

    await emit(process, { id: '1', result: { userAgent: 'test' } });
    await emit(process, {
      id: '2',
      result: { thread: { id: 'codex-thread' } },
    });
    await withTimeout(session, 'startSession');
    await adapter.stopAll();
  });

  test('the quota probe takes only its own string ids as replies', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process as never,
    });
    const read = adapter.readQuotaSnapshot({ connectionId: 'codex-rpc-id' });
    await flushIo();
    // Numeric look-alikes of Station's "1"/"2" carry a different payload;
    // taking them as replies would report 99%.
    await emit(process, { id: 1, result: {} });
    await emit(process, {
      id: 2,
      result: { rateLimits: { primary: { usedPercent: 99 } } },
    });
    await emit(process, { id: '1', result: {} });
    await emit(process, {
      id: '2',
      result: { rateLimits: { primary: { usedPercent: 42 } } },
    });
    await expect(withTimeout(read, 'readQuotaSnapshot')).resolves.toMatchObject(
      {
        kind: 'snapshot',
        snapshot: { windows: [{ id: 'primary', usedPercent: 42 }] },
      },
    );
  });

  test('model discovery takes only its own string ids as replies', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process as never,
    });
    const models = adapter.listModels();
    await flushIo();
    await emit(process, { id: 1, result: {} });
    await emit(process, {
      id: 2,
      result: { data: [{ model: 'wrong-id', displayName: 'Wrong' }] },
    });
    await emit(process, { id: '1', result: {} });
    await emit(process, {
      id: '2',
      result: {
        data: [{ model: 'right-id', displayName: 'Right' }],
        nextCursor: null,
      },
    });
    const listed = await withTimeout(models, 'listModels');
    expect(listed.map((model) => model.id)).toEqual(['right-id']);
  });
});
