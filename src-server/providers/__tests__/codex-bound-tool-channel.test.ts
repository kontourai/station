import { expect, onTestFinished, test, vi } from 'vitest';
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
      expired: () => false,
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
      expired: () => false,
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
      expired: () => false,
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
      expired: () => false,
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
      expired: () => false,
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
    const inventory = (line: string) => {
      const request: unknown = JSON.parse(line);
      if (
        request === null ||
        typeof request !== 'object' ||
        !('method' in request) ||
        request.method !== 'mcpServerStatus/list'
      )
        return;
      expect(request).toMatchObject({
        params: { threadId: 'native', serverName: control.id },
      });
      if (!('id' in request))
        throw Error('MCP inventory request has no RPC id');
      queueMicrotask(() =>
        child.stdout.write(
          `${JSON.stringify({
            id: request.id,
            result: {
              data: [
                {
                  name: control.id,
                  runtimeStatus: 'connected',
                  authStatus: 'bearerToken',
                  tools: {},
                  toolsError: null,
                },
              ],
            },
          })}\n`,
        ),
      );
    };
    child.stdin.on('line', inventory);
    onTestFinished(async () => {
      child.stdin.off('line', inventory);
      await adapter.stopSession(`control-${firstDerived}`);
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
    const requestId = (method: string) =>
      waitFor(() => {
        for (const line of child.stdin.lines) {
          const frame: unknown = JSON.parse(line);
          if (
            frame !== null &&
            typeof frame === 'object' &&
            'method' in frame &&
            frame.method === method &&
            'id' in frame &&
            (typeof frame.id === 'string' || typeof frame.id === 'number')
          )
            return frame.id;
        }
        return undefined;
      }, `outgoing ${method}`);
    await emit(child, {
      id: await requestId('initialize'),
      result: { userAgent: 'test' },
    });
    await emit(child, {
      id: await requestId('thread/start'),
      result: { thread: { id: 'native' } },
    });
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
      expired: () => false,
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

test('interrupt history stays bounded and retains the newest cancellation without retiring the session', async () => {
  const child = new FakeCodexProcess();
  const execute = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  const adapter = new CodexAdapter({
    processFactory: () => child as never,
    boundToolsEnabled: () => true,
    resolveBoundToolPolicy: async () => async () => ({ behavior: 'allow' }),
    createBoundTools: async () => ({
      tools: [{ name: 'browser_status', inputSchema: { type: 'object' } }],
      expired: () => false,
      call: execute,
      close: async () => {},
    }),
  });
  const started = adapter.startSession({
    provider: 'codex',
    threadId: 'long-session',
    cwd: '/tmp',
    agent: {} as never,
  });
  await flushIo();
  await emit(child, { id: '1', result: { userAgent: 'test' } });
  await emit(child, { id: '2', result: { thread: { id: 'native-long' } } });
  await withTimeout(started, 'start');
  const record = (adapter as any).transport.getSession('long-session');
  record.cancelledBoundTurns = new Set(
    Array.from({ length: 4100 }, (_, i) => `old-${i}`),
  );
  for (let i = 0; i < 40; i++) {
    const turnId = `turn-${i}`;
    record.activeTurnId = turnId;
    const interrupt = adapter.interruptTurn('long-session', turnId);
    const rpc = await waitFor(
      () =>
        child.stdin.lines
          .map((line) => JSON.parse(line))
          .find(
            (item) =>
              item.method === 'turn/interrupt' && item.params.turnId === turnId,
          ),
      'interrupt request',
    );
    await emit(child, { id: rpc.id, result: {} });
    await withTimeout(interrupt, 'interrupt');
    expect(record.cancelledBoundTurns.size).toBeLessThanOrEqual(32);
  }
  expect(record.cancelledBoundTurns.has('turn-39')).toBe(true);
  record.activeTurnId = 'turn-39';
  await emit(child, {
    id: 201,
    method: 'item/tool/call',
    params: {
      threadId: 'native-long',
      turnId: 'turn-39',
      callId: 'cancelled',
      tool: 'browser_status',
      arguments: {},
    },
  });
  expect(repliesTo(child, 201)[0]?.error.message).toBe('Bound tool refused');
  expect(execute).not.toHaveBeenCalled();
  record.activeTurnId = 'fresh';
  await emit(child, {
    id: 202,
    method: 'item/tool/call',
    params: {
      threadId: 'native-long',
      turnId: 'fresh',
      callId: 'fresh',
      tool: 'browser_status',
      arguments: {},
    },
  });
  const response = await waitFor(() => repliesTo(child, 202)[0], 'fresh tool');
  expect(response.result.success).toBe(true);
  expect(execute).toHaveBeenCalledOnce();
  await adapter.stopSession('long-session');
});

test('expired Codex credentials refuse on the wire before opening approval', async () => {
  const { createCodexBoundToolServer } = await import(
    '../../runtime/mcp/station-control-in-process.js'
  );
  const child = new FakeCodexProcess();
  const adapter = new CodexAdapter({
    processFactory: () => child as never,
    boundToolsEnabled: () => true,
    resolveBoundToolPolicy: async () => async () => ({ behavior: 'defer' }),
    createBoundTools: async (input) =>
      createCodexBoundToolServer({
        ...input,
        dispatch: async () => {
          throw new Error('unexpected dispatch');
        },
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
    threadId: 'expiry-session',
    cwd: '/tmp',
    agent: {} as never,
  });
  await flushIo();
  await emit(child, { id: '1', result: { userAgent: 'test' } });
  await emit(child, { id: '2', result: { thread: { id: 'native-expiry' } } });
  await withTimeout(started, 'start');
  const turn = adapter.sendTurn({ threadId: 'expiry-session', input: 'go' });
  await flushIo();
  await emit(child, { id: '3', result: { turn: { id: 'turn' } } });
  await withTimeout(turn, 'turn');
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.now() + 12 * 60 * 60 * 1000 + 1);
  try {
    await emit(child, {
      id: 301,
      method: 'item/tool/call',
      params: {
        threadId: 'native-expiry',
        turnId: 'turn',
        callId: 'expired',
        tool: 'browser_status',
        arguments: {},
      },
    });
    const response = await waitFor(
      () => repliesTo(child, 301)[0],
      'expiry refusal',
    );
    expect(response.error.message).toBe(
      'Bound tool unavailable; restart the Session',
    );
    expect(events.some((event) => event.method === 'request.opened')).toBe(
      false,
    );
  } finally {
    now.mockRestore();
    await adapter.stopSession('expiry-session');
    await iterator.return?.();
  }
});

test('credential expiry during approval returns a restart instruction on the wire', async () => {
  const { createCodexBoundToolServer } = await import(
    '../../runtime/mcp/station-control-in-process.js'
  );
  const child = new FakeCodexProcess();
  const dispatch = vi.fn(async () => new Response('{}'));
  const adapter = new CodexAdapter({
    processFactory: () => child as never,
    boundToolsEnabled: () => true,
    resolveBoundToolPolicy: async () => async () => ({ behavior: 'defer' }),
    createBoundTools: async (input) =>
      createCodexBoundToolServer({ ...input, dispatch }),
  });
  const events: any[] = [];
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  void (async () => {
    for await (const event of { [Symbol.asyncIterator]: () => iterator })
      events.push(event);
  })();
  const started = adapter.startSession({
    provider: 'codex',
    threadId: 'expiry-approval',
    cwd: '/tmp',
    agent: {} as never,
  });
  await flushIo();
  await emit(child, { id: '1', result: { userAgent: 'test' } });
  await emit(child, {
    id: '2',
    result: { thread: { id: 'native-expiry-approval' } },
  });
  await withTimeout(started, 'start');
  const turn = adapter.sendTurn({ threadId: 'expiry-approval', input: 'go' });
  await flushIo();
  await emit(child, { id: '3', result: { turn: { id: 'turn' } } });
  await withTimeout(turn, 'turn');
  await emit(child, {
    id: 302,
    method: 'item/tool/call',
    params: {
      threadId: 'native-expiry-approval',
      turnId: 'turn',
      callId: 'expiring',
      tool: 'browser_status',
      arguments: {},
    },
  });
  const approval = await waitFor(
    () => events.find((event) => event.method === 'request.opened'),
    'approval',
  );
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.now() + 12 * 60 * 60 * 1000 + 1);
  try {
    await adapter.respondToRequest(
      'expiry-approval',
      approval.requestId,
      'accept',
    );
    const response = await waitFor(
      () => repliesTo(child, 302)[0],
      'expiry during approval',
    );
    expect(response.error.message).toBe(
      'Bound tool unavailable; restart the Session',
    );
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
    await adapter.stopSession('expiry-approval');
    await iterator.return?.();
  }
});
