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
  let policyDenied = true;
  const execute = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  const adapter = new CodexAdapter({
    processFactory: () => process as never,
    boundToolsEnabled: () => previewEnabled,
    resolveBoundToolPolicy: async () => async () =>
      policyDenied
        ? {
            behavior: 'deny',
            denial: {
              allowed: false,
              reason: 'Project policy refused this tool.',
            },
          }
        : { behavior: 'defer' },
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
    id: 20,
    method: 'item/tool/call',
    params: { ...params, callId: 'policy-denied' },
  });
  expect(repliesTo(process, 20)[0]?.error).toBeDefined();
  expect(execute).not.toHaveBeenCalled();
  policyDenied = false;
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
    resolveBoundToolPolicy: async () => async () => ({ behavior: 'defer' }),
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
    resolveBoundToolPolicy: async () => async () => ({ behavior: 'defer' }),
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

test('a delegated Session without approval authority refuses an approval-bound tool', async () => {
  const process = new FakeCodexProcess();
  const execute = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  const adapter = new CodexAdapter({
    processFactory: () => process as never,
    boundToolsEnabled: () => true,
    resolveBoundToolPolicy: async () => async () => ({ behavior: 'defer' }),
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
    threadId: 'delegated-session',
    cwd: '/tmp',
    agent: {} as never,
    metadata: { delegation: { denyApprovals: true } },
  });
  await flushIo();
  await emit(process, { id: '1', result: { userAgent: 'test' } });
  await emit(process, {
    id: '2',
    result: { thread: { id: 'native-delegated' } },
  });
  await withTimeout(session, 'start');
  const turn = adapter.sendTurn({ threadId: 'delegated-session', input: 'go' });
  await flushIo();
  await emit(process, { id: '3', result: { turn: { id: 'turn-delegated' } } });
  await withTimeout(turn, 'turn');
  await emit(process, {
    id: 42,
    method: 'item/tool/call',
    params: {
      threadId: 'native-delegated',
      turnId: 'turn-delegated',
      callId: 'call-delegated',
      tool: 'browser_status',
      arguments: {},
    },
  });
  expect(repliesTo(process, 42)[0]?.error).toBeDefined();
  expect(events.some((event) => event.method === 'request.opened')).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  await adapter.stopSession('delegated-session');
  await iterator.return?.();
});

test('replay protection is scoped to the current turn across long sessions', async () => {
  let turn = 'turn-0';
  const { CodexBoundToolChannel } = await import(
    '../adapters/codex-bound-tool-channel.js'
  );
  const channel = new CodexBoundToolChannel(
    'native',
    new Set(['browser_status']),
    () => turn,
    () => true,
  );
  const invoke = (turnId: string) =>
    channel.invoke(
      { threadId: 'native', turnId, callId: 'same-id', name: 'browser_status' },
      async () => true,
      async () => 'ok',
      () => true,
    );
  for (let index = 0; index < 4100; index++) {
    turn = `turn-${index}`;
    await expect(invoke(turn)).resolves.toBe('ok');
  }
  await expect(invoke(turn)).rejects.toThrow('bound-tool-refused');
  await expect(invoke('turn-0')).rejects.toThrow('bound-tool-refused');
});

test('a call whose turn expires after execution withholds the result', async () => {
  let current = true;
  const { CodexBoundToolChannel } = await import(
    '../adapters/codex-bound-tool-channel.js'
  );
  const channel = new CodexBoundToolChannel(
    'native',
    new Set(['browser_open']),
    () => 'turn',
    () => current,
  );
  await expect(
    channel.invoke(
      {
        threadId: 'native',
        turnId: 'turn',
        callId: 'call',
        name: 'browser_open',
      },
      async () => true,
      async () => {
        current = false;
        return 'done';
      },
      () => true,
    ),
  ).rejects.toThrow('bound-tool-executed-result-withheld');
});

test('device catalog uses the first control entry and excludes coordinator-derived authority', async () => {
  const { builtinStationControlServerPath } = await import(
    '../../runtime/bootstrap/station-control-runtime-env.js'
  );
  const control = {
    id: 'station-control',
    displayName: 'Station Control',
    transport: 'stdio',
    command: process.execPath,
    args: [builtinStationControlServerPath()],
    coordinatorGeneration: 1,
  };
  for (const [firstDerived, secondDerived] of [
    [true, false],
    [false, true],
  ] as const) {
    const child = new FakeCodexProcess();
    const create = vi.fn(async () => ({
      tools: [],
      call: vi.fn(),
      close: async () => {},
    }));
    const adapter = new CodexAdapter({
      processFactory: () => child as never,
      boundToolsEnabled: () => true,
      createBoundTools: create,
      mintStationControlMcpAuth: () => ({
        url: 'http://127.0.0.1:12345/mcp/station-control',
        token: 'test',
      }),
    });
    const session = adapter.startSession({
      provider: 'codex',
      threadId: `control-${firstDerived}`,
      cwd: '/tmp',
      agent: {
        toolServers: [
          { ...control, coordinatorDerived: firstDerived },
          { ...control, coordinatorDerived: secondDerived },
        ],
      } as never,
    });
    await flushIo();
    await emit(child, { id: '1', result: { userAgent: 'test' } });
    await emit(child, { id: '2', result: { thread: { id: 'native' } } });
    await withTimeout(session, 'start');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ includeDevices: !firstDerived }),
    );
    await adapter.stopSession(`control-${firstDerived}`);
  }
});

test('session approval applies to later defers, and interrupt fences pending and executing calls', async () => {
  const child = new FakeCodexProcess();
  let finish!: (value: { content: { type: string; text: string }[] }) => void;
  const execute = vi.fn(
    () =>
      new Promise<{ content: { type: string; text: string }[] }>((resolve) => {
        finish = resolve;
      }),
  );
  const adapter = new CodexAdapter({
    processFactory: () => child as never,
    boundToolsEnabled: () => true,
    resolveBoundToolPolicy: async () => async () => ({ behavior: 'defer' }),
    createBoundTools: async () => ({
      tools: [
        { name: 'browser_status', inputSchema: { type: 'object' } },
        { name: 'browser_open', inputSchema: { type: 'object' } },
      ],
      call: execute,
      close: async () => {},
    }),
  });
  const events: any[] = [];
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  void (async () => {
    for await (const event of { [Symbol.asyncIterator]: () => iterator })
      events.push(event);
  })();
  const started = adapter.startSession({
    provider: 'codex',
    threadId: 'interrupt-session',
    cwd: '/tmp',
    agent: {} as never,
  });
  await flushIo();
  await emit(child, { id: '1', result: { userAgent: 'test' } });
  await emit(child, { id: '2', result: { thread: { id: 'native' } } });
  await withTimeout(started, 'start');
  const turn = adapter.sendTurn({ threadId: 'interrupt-session', input: 'go' });
  await flushIo();
  await emit(child, { id: '3', result: { turn: { id: 'turn' } } });
  await withTimeout(turn, 'turn');
  const call = (id: number, tool = 'browser_status') =>
    emit(child, {
      id,
      method: 'item/tool/call',
      params: {
        threadId: 'native',
        turnId: 'turn',
        callId: `call-${id}`,
        tool,
        arguments: {},
      },
    });
  await call(101);
  const approval = await waitFor(
    () => events.find((e) => e.method === 'request.opened'),
    'approval',
  );
  await adapter.respondToRequest(
    'interrupt-session',
    approval.requestId,
    'acceptForSession',
  );
  await waitFor(
    () => (execute.mock.calls.length === 1 ? true : undefined),
    'execution',
  );
  await call(102);
  await waitFor(
    () => (execute.mock.calls.length === 2 ? true : undefined),
    'session approval',
  );
  expect(events.filter((e) => e.method === 'request.opened')).toHaveLength(1);
  for (let id = 103; id < 117; id++) await call(id, 'browser_open');
  await waitFor(
    () =>
      events.filter((e) => e.method === 'request.opened').length === 15
        ? true
        : undefined,
    'pending approvals',
  );
  await call(117, 'browser_open');
  expect(repliesTo(child, 117)[0]?.error).toBeDefined();
  const pending = events.filter((e) => e.method === 'request.opened')[1];
  const interrupted = adapter.interruptTurn('interrupt-session');
  await flushIo();
  const request = child.stdin.lines
    .map((line) => JSON.parse(line))
    .find((line) => line.method === 'turn/interrupt');
  expect(request).toBeDefined();
  await emit(child, { id: request.id, result: {} });
  await withTimeout(interrupted, 'interrupt');
  await expect(
    adapter.respondToRequest('interrupt-session', pending.requestId, 'accept'),
  ).rejects.toThrow();
  expect(
    events.some(
      (e) =>
        e.method === 'request.resolved' &&
        e.requestId === pending.requestId &&
        e.status === 'cancelled',
    ),
  ).toBe(true);
  finish({ content: [{ type: 'text', text: 'ok' }] });
  const response = await waitFor(
    () => repliesTo(child, 102)[0],
    'withheld result',
  );
  expect(response.error.message).toContain('executed; result withheld');
  await adapter.stopSession('interrupt-session');
  await iterator.return?.();
});
