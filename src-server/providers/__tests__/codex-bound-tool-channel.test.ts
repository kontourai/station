import { expect, test, vi } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import {
  emit,
  FakeCodexProcess,
  flushIo,
  repliesTo,
  waitFor,
  withTimeout,
} from './codex-adapter-wire-harness.js';

test('dynamic calls are bound to the current Session and turn, approved once, and not replayed', async () => {
  const process = new FakeCodexProcess();
  let previewEnabled = true;
  const execute = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  const adapter = new CodexAdapter({
    processFactory: () => process as never,
    boundToolsEnabled: () => previewEnabled,
    createBoundTools: async () => ({
      tools: [
        {
          name: 'browser_status',
          description: 'status',
          inputSchema: { type: 'object' },
        },
      ],
      call: execute,
      close: async () => {},
    }),
  });
  const events: any[] = [];
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const event = await iterator.next();
      if (event.done) return;
      events.push(event.value);
    }
  })();
  const session = adapter.startSession({
    provider: 'codex',
    threadId: 'session-a',
    cwd: '/tmp',
    agent: {} as never,
  });
  await flushIo();
  await emit(process, { id: '1', result: { userAgent: 'test' } });
  await emit(process, { id: '2', result: { thread: { id: 'native-a' } } });
  await withTimeout(session, 'start');
  const turn = adapter.sendTurn({ threadId: 'session-a', input: 'go' });
  await flushIo();
  await emit(process, { id: '3', result: { turn: { id: 'turn-a' } } });
  await withTimeout(turn, 'turn');
  const params = {
    threadId: 'native-a',
    turnId: 'turn-a',
    callId: 'call-a',
    tool: 'browser_status',
    arguments: {},
  };
  await emit(process, {
    id: 21,
    method: 'item/tool/call',
    params: { ...params, threadId: 'native-b' },
  });
  expect(repliesTo(process, 21)[0].error).toBeDefined();
  await emit(process, { id: 22, method: 'item/tool/call', params });
  const opened = await waitFor(
    () => events.find((event) => event.method === 'request.opened'),
    'approval',
  );
  expect(execute).not.toHaveBeenCalled();
  await adapter.respondToRequest('session-a', opened.requestId, 'accept');
  await waitFor(() => repliesTo(process, 22)[0], 'tool result');
  expect(execute).toHaveBeenCalledOnce();
  await emit(process, { id: 23, method: 'item/tool/call', params });
  expect(repliesTo(process, 23)[0].error).toBeDefined();
  expect(execute).toHaveBeenCalledOnce();
  await emit(process, {
    id: 24,
    method: 'item/tool/call',
    params: { ...params, callId: 'call-b', turnId: 'other-turn' },
  });
  await emit(process, {
    id: 25,
    method: 'item/tool/call',
    params: { ...params, callId: 'call-c', tool: 'device_list' },
  });
  expect(repliesTo(process, 24)[0].error).toBeDefined();
  expect(repliesTo(process, 25)[0].error).toBeDefined();
  await emit(process, {
    id: 26,
    method: 'item/tool/call',
    params: { ...params, callId: 'call-d' },
  });
  const cancelled = await waitFor(
    () => events.filter((event) => event.method === 'request.opened')[1],
    'second approval',
  );
  await emit(process, {
    method: 'serverRequest/resolved',
    params: { requestId: 26 },
  });
  await expect(
    adapter.respondToRequest('session-a', cancelled.requestId, 'accept'),
  ).rejects.toThrow();
  expect(execute).toHaveBeenCalledOnce();
  execute.mockResolvedValueOnce({
    content: [{ type: 'text', text: '{"ok":false,"code":"not-authorized"}' }],
  });
  await emit(process, {
    id: 28,
    method: 'item/tool/call',
    params: { ...params, callId: 'call-f' },
  });
  const refused = await waitFor(
    () => events.filter((event) => event.method === 'request.opened')[2],
    'third approval',
  );
  await adapter.respondToRequest('session-a', refused.requestId, 'accept');
  const refusedReply = await waitFor(
    () => repliesTo(process, 28)[0],
    'refusal result',
  );
  expect(refusedReply.result.success).toBe(false);
  expect(execute).toHaveBeenCalledTimes(2);
  await emit(process, {
    id: 27,
    method: 'item/tool/call',
    params: { ...params, callId: 'call-e' },
  });
  const revoked = await waitFor(
    () => events.filter((event) => event.method === 'request.opened')[3],
    'fourth approval',
  );
  const decision = adapter.respondToRequest(
    'session-a',
    revoked.requestId,
    'accept',
  );
  previewEnabled = false;
  await decision;
  await waitFor(() => repliesTo(process, 27)[0], 'revoked result');
  expect(repliesTo(process, 27)[0].error).toBeDefined();
  expect(execute).toHaveBeenCalledTimes(2);
  previewEnabled = true;
  await emit(process, {
    id: 29,
    method: 'item/tool/call',
    params: { ...params, callId: 'call-g' },
  });
  expect(repliesTo(process, 29)[0]?.error).toBeDefined();
  expect(execute).toHaveBeenCalledTimes(2);
  await adapter.stopSession('session-a');
  await iterator.return?.();
});

test('resume admits only the freshly authorized catalog and refuses stale persisted names', async () => {
  const process = new FakeCodexProcess();
  let previewEpoch = 0;
  const execute = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  const adapter = new CodexAdapter({
    processFactory: () => process as never,
    boundToolsEnabled: () => true,
    boundToolsEpoch: () => previewEpoch,
    createBoundTools: async () => ({
      tools: [
        {
          name: 'browser_status',
          description: 'status',
          inputSchema: { type: 'object' },
        },
      ],
      call: execute,
      close: async () => {},
    }),
  });
  const events: any[] = [];
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const event = await iterator.next();
      if (event.done) return;
      events.push(event.value);
    }
  })();
  const session = adapter.startSession({
    provider: 'codex',
    threadId: 'session-resumed',
    cwd: '/tmp',
    agent: {} as never,
    resumeCursor: { codexThreadId: 'native-resumed' },
  });
  await flushIo();
  await emit(process, { id: '1', result: { userAgent: 'test' } });
  await emit(process, {
    id: '2',
    result: { thread: { id: 'native-resumed' } },
  });
  await withTimeout(session, 'resume');
  const turn = adapter.sendTurn({ threadId: 'session-resumed', input: 'go' });
  await flushIo();
  await emit(process, { id: '3', result: { turn: { id: 'turn-new' } } });
  await withTimeout(turn, 'turn');
  const call = {
    threadId: 'native-resumed',
    turnId: 'turn-new',
    arguments: {},
  };
  for (const [id, name] of [
    [31, 'browser_open'],
    [32, 'never_authorized'],
  ] as const) {
    await emit(process, {
      id,
      method: 'item/tool/call',
      params: { ...call, callId: `call-${id}`, tool: name },
    });
    expect(repliesTo(process, id)[0].error).toBeDefined();
  }
  expect(
    events.filter((event) => event.method === 'request.opened'),
  ).toHaveLength(0);
  expect(execute).not.toHaveBeenCalled();
  await emit(process, {
    id: 33,
    method: 'item/tool/call',
    params: { ...call, callId: 'call-33', tool: 'browser_status' },
  });
  const opened = await waitFor(
    () => events.find((event) => event.method === 'request.opened'),
    'resumed approval',
  );
  await adapter.respondToRequest('session-resumed', opened.requestId, 'accept');
  await waitFor(() => repliesTo(process, 33)[0], 'resumed tool result');
  expect(execute).toHaveBeenCalledOnce();
  previewEpoch += 2;
  await emit(process, {
    id: 34,
    method: 'item/tool/call',
    params: { ...call, callId: 'call-34', tool: 'browser_status' },
  });
  expect(repliesTo(process, 34)[0]?.error).toBeDefined();
  expect(execute).toHaveBeenCalledOnce();
  await adapter.stopSession('session-resumed');
  await iterator.return?.();
});

test('a provider disconnect cancels a pending tool approval before any effect', async () => {
  const process = new FakeCodexProcess();
  const execute = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  const adapter = new CodexAdapter({
    processFactory: () => process as never,
    boundToolsEnabled: () => true,
    createBoundTools: async () => ({
      tools: [
        {
          name: 'browser_status',
          description: 'status',
          inputSchema: { type: 'object' },
        },
      ],
      call: execute,
      close: async () => {},
    }),
  });
  const events: any[] = [];
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const event = await iterator.next();
      if (event.done) return;
      events.push(event.value);
    }
  })();
  const session = adapter.startSession({
    provider: 'codex',
    threadId: 'disconnect-session',
    cwd: '/tmp',
    agent: {} as never,
  });
  await flushIo();
  await emit(process, { id: '1', result: { userAgent: 'test' } });
  await emit(process, {
    id: '2',
    result: { thread: { id: 'native-disconnect' } },
  });
  await withTimeout(session, 'start');
  const turn = adapter.sendTurn({
    threadId: 'disconnect-session',
    input: 'go',
  });
  await flushIo();
  await emit(process, { id: '3', result: { turn: { id: 'turn-disconnect' } } });
  await withTimeout(turn, 'turn');
  await emit(process, {
    id: 41,
    method: 'item/tool/call',
    params: {
      threadId: 'native-disconnect',
      turnId: 'turn-disconnect',
      callId: 'call-disconnect',
      tool: 'browser_status',
      arguments: {},
    },
  });
  const opened = await waitFor(
    () => events.find((event) => event.method === 'request.opened'),
    'approval',
  );
  process.emit('exit', 1, null);
  const cancelled = await waitFor(
    () =>
      events.find(
        (event) =>
          event.method === 'request.resolved' &&
          event.requestId === opened.requestId,
      ),
    'cancelled approval',
  );
  expect(cancelled.status).toBe('cancelled');
  await expect(
    adapter.respondToRequest('disconnect-session', opened.requestId, 'accept'),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await adapter.stopAll();
  await iterator.return?.();
});
