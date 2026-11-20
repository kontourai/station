/**
 * #2376 slice 2: with the Codex bound channel on, station-control travels as
 * `dynamicTools` at `bound` and Station mints no header token. Codex keeps a
 * thread's `dynamicTools` across `thread/resume` and accepts none there, so a
 * resumed thread takes the bound catalog only when it started with it; any
 * other resume keeps the header-token server. These drive the real adapter
 * and the real bound tool server and read what crosses the app-server pipe.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { createCodexBoundToolServer } from '../../runtime/mcp/station-control-in-process.js';
import {
  mintStationControlMcpHeaderAuth,
  revokeStationControlMcpToken,
  verifyStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import { restrictedNetworkStationControlTools } from '../../tools/station-control-policy.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { codexResumeCursor } from '../adapters/codex-adapter-events.js';
import {
  emit,
  FakeCodexProcess,
  flushIo,
  repliesTo,
  waitFor,
  withTimeout,
} from './codex-adapter-wire-harness.js';

const control = () => ({
  id: 'station-control',
  displayName: 'Station Control',
  transport: 'stdio',
  command: process.execPath,
  args: [builtinStationControlServerPath()],
});

const sessions: string[] = [];
afterEach(() => {
  for (const id of sessions.splice(0)) revokeStationControlMcpToken(id);
});

function harness(
  previewOn: boolean | (() => boolean),
  result: unknown = { content: [{ type: 'text', text: '{"ok":true}' }] },
  options: { decision?: 'allow' | 'defer' } = {},
) {
  const child = new FakeCodexProcess();
  const mint = vi.fn((sessionId: string) =>
    mintStationControlMcpHeaderAuth(12345, sessionId),
  );
  const created: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const adapter = new CodexAdapter({
    processFactory: () => child as never,
    boundToolsEnabled:
      typeof previewOn === 'function' ? previewOn : () => previewOn,
    boundToolsEpoch: () => 1,
    resolveBoundToolPolicy: async () => async () => ({
      behavior: options.decision ?? 'allow',
    }),
    resolveSourceHome: () => '/tmp',
    createBoundTools: async (input) => {
      created.push(input);
      const server = await createCodexBoundToolServer({
        ...input,
        dispatch: async () => {
          throw new Error('unexpected dispatch');
        },
      });
      return {
        ...server,
        call: async (name: string) => {
          calls.push(name);
          return result;
        },
      };
    },
    mintStationControlMcpAuth: mint,
    revokeStationControlMcpAuth: revokeStationControlMcpToken,
  });
  const events: any[] = [];
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      events.push(next.value);
    }
  })();
  const requests = () =>
    child.stdin.lines
      .map((line) => JSON.parse(line))
      .filter((line) => typeof line.method === 'string' && 'id' in line);
  const answer = async (method: string, result: unknown) => {
    const request = await waitFor(
      () => requests().find((line) => line.method === method),
      method,
    );
    await emit(child, { id: request.id, result });
    return request;
  };
  return { child, adapter, mint, created, calls, answer, events };
}

async function start(
  h: ReturnType<typeof harness>,
  threadId: string,
  nativeId: string,
  extra: Record<string, unknown> = {},
) {
  sessions.push(threadId);
  const started = h.adapter.startSession({
    provider: 'codex',
    threadId,
    cwd: '/tmp',
    agent: { toolServers: [control()] },
    ...extra,
  } as never);
  await flushIo();
  await h.answer('initialize', { userAgent: 'test' });
  const method = extra.resumeCursor ? 'thread/resume' : 'thread/start';
  const request = await h.answer(method, { thread: { id: nativeId } });
  const session = await withTimeout(started, 'start');
  return { request, session };
}

test('preview on: a new thread carries the station-control catalog as dynamicTools and no header token', async () => {
  const h = harness(true);
  const { request, session } = await start(h, 'catalog-start', 'native-a');
  const names = request.params.dynamicTools.map(
    (tool: { name: string }) => tool.name,
  );
  // Bound-only station-control tools ride the channel beside browser tools.
  expect(names).toEqual(
    expect.arrayContaining([
      'list_agents',
      'get_usage',
      'update_agent',
      'device_list',
      'browser_status',
    ]),
  );
  expect(h.mint).not.toHaveBeenCalled();
  expect(JSON.stringify(request.params.config ?? {})).not.toContain(
    'station-control',
  );
  expect(h.created).toEqual([expect.objectContaining({ stationControl: {} })]);
  expect(session.resumeCursor).toMatchObject({
    codexThreadId: 'native-a',
    boundCatalog: true,
  });
  // A station-control call from the model reaches the bound server.
  const turn = h.adapter.sendTurn({ threadId: 'catalog-start', input: 'go' });
  await h.answer('turn/start', { turn: { id: 'turn-a' } });
  // The cursor a later resume reads keeps the marker after every turn.
  expect((await withTimeout(turn, 'turn')).resumeCursor).toMatchObject({
    codexThreadId: 'native-a',
    boundCatalog: true,
  });
  await emit(h.child, {
    id: 90,
    method: 'item/tool/call',
    params: {
      threadId: 'native-a',
      turnId: 'turn-a',
      callId: 'call-a',
      tool: 'list_agents',
      arguments: {},
    },
  });
  const reply = await waitFor(() => repliesTo(h.child, 90)[0], 'reply');
  expect(reply.result?.success).toBe(true);
  expect(h.calls).toEqual(['list_agents']);
  await h.adapter.stopSession('catalog-start');
});

test('preview off: the header-token server is delivered as before', async () => {
  const h = harness(false);
  const { request, session } = await start(h, 'catalog-off', 'native-off');
  expect(request.params.dynamicTools).toBeUndefined();
  expect(h.mint).toHaveBeenCalledOnce();
  expect(request.params.config).toMatchObject({
    'mcp_servers.station-control.url':
      'http://127.0.0.1:12345/mcp/station-control',
  });
  expect(h.created).toEqual([]);
  expect(session.resumeCursor).not.toHaveProperty('boundCatalog');
  await h.adapter.stopSession('catalog-off');
});

test('resume of a thread that started with the catalog keeps it bound and mints no header token', async () => {
  const h = harness(true);
  const { request, session } = await start(h, 'catalog-resume', 'native-r', {
    resumeCursor: { codexThreadId: 'native-r', boundCatalog: true },
  });
  // Codex's thread/resume takes no dynamicTools; it restores the persisted
  // ones (live probe against codex-cli 0.167.0).
  expect(request.params.dynamicTools).toBeUndefined();
  expect(h.mint).not.toHaveBeenCalled();
  expect(JSON.stringify(request.params.config ?? {})).not.toContain(
    'station-control',
  );
  expect(h.created).toEqual([expect.objectContaining({ stationControl: {} })]);
  expect(session.resumeCursor).toMatchObject({ boundCatalog: true });
  await h.adapter.stopSession('catalog-resume');
});

test('resume of a thread without the catalog falls back to the header-token server', async () => {
  const h = harness(true);
  const { request, session } = await start(h, 'catalog-fallback', 'native-f', {
    resumeCursor: { codexThreadId: 'native-f' },
  });
  expect(h.mint).toHaveBeenCalledOnce();
  expect(request.params.config).toMatchObject({
    'mcp_servers.station-control.url':
      'http://127.0.0.1:12345/mcp/station-control',
  });
  // Browser and device tools still use the bound channel, as before.
  expect(h.created).toHaveLength(1);
  expect(h.created[0]).not.toHaveProperty('stationControl');
  expect(session.resumeCursor).not.toHaveProperty('boundCatalog');
  // The thread holds no station-control dynamic tool, and a persisted or
  // forged name is refused rather than run.
  const turn = h.adapter.sendTurn({
    threadId: 'catalog-fallback',
    input: 'go',
  });
  await h.answer('turn/start', { turn: { id: 'turn-f' } });
  await withTimeout(turn, 'turn');
  await emit(h.child, {
    id: 91,
    method: 'item/tool/call',
    params: {
      threadId: 'native-f',
      turnId: 'turn-f',
      callId: 'call-f',
      tool: 'list_agents',
      arguments: {},
    },
  });
  const reply = await waitFor(() => repliesTo(h.child, 91)[0], 'reply');
  expect(reply.error).toBeDefined();
  expect(h.calls).toEqual([]);
  await h.adapter.stopSession('catalog-fallback');
});

test('a coordinator-derived control server stays on the header channel', async () => {
  const h = harness(true);
  sessions.push('catalog-coordinator');
  const started = h.adapter.startSession({
    provider: 'codex',
    threadId: 'catalog-coordinator',
    cwd: '/tmp',
    agent: {
      toolServers: [
        { ...control(), coordinatorDerived: true, coordinatorGeneration: 1 },
      ],
    } as never,
  });
  await flushIo();
  await h.answer('initialize', { userAgent: 'test' });
  const request = await h.answer('thread/start', {
    thread: { id: 'native-c' },
  });
  const session = await withTimeout(started, 'start');
  expect(h.mint).toHaveBeenCalledOnce();
  expect(
    request.params.dynamicTools.map((tool: { name: string }) => tool.name),
  ).not.toContain('list_agents');
  expect(session.resumeCursor).not.toHaveProperty('boundCatalog');
  await h.adapter.stopSession('catalog-coordinator');
});

test("the bound catalog follows the Agent's selection and takes the HTTP route's argument size", async () => {
  const h = harness(true);
  sessions.push('catalog-selection');
  const started = h.adapter.startSession({
    provider: 'codex',
    threadId: 'catalog-selection',
    cwd: '/tmp',
    agent: {
      toolServers: [
        {
          ...control(),
          allowedTools: ['list_agents', 'html_render', 'device_list'],
          disabledTools: ['device_list'],
        },
      ],
    } as never,
  });
  await flushIo();
  await h.answer('initialize', { userAgent: 'test' });
  await h.answer('config/read', { config: { mcp_servers: {} } });
  const request = await h.answer('thread/start', {
    thread: { id: 'native-s' },
  });
  await withTimeout(started, 'start');
  expect(h.created).toEqual([
    expect.objectContaining({
      stationControl: { allowedTools: ['list_agents', 'html_render'] },
    }),
  ]);
  expect(
    request.params.dynamicTools
      .map((tool: { name: string }) => tool.name)
      .filter((name: string) => !name.startsWith('browser_'))
      .sort(),
  ).toEqual(['html_render', 'list_agents']);
  // Codex gets no station-control MCP entry to enable.
  expect(JSON.stringify(request.params.config ?? {})).not.toContain(
    'station-control',
  );
  const turn = h.adapter.sendTurn({
    threadId: 'catalog-selection',
    input: 'go',
  });
  await h.answer('turn/start', { turn: { id: 'turn-s' } });
  await withTimeout(turn, 'turn');
  const call = { threadId: 'native-s', turnId: 'turn-s', arguments: {} };
  await emit(h.child, {
    id: 92,
    method: 'item/tool/call',
    params: { ...call, callId: 'call-disabled', tool: 'device_list' },
  });
  expect(
    (await waitFor(() => repliesTo(h.child, 92)[0], 'disabled')).error,
  ).toBeDefined();
  // 100 KB of HTML: above the browser/device cap, within html_render's.
  await emit(h.child, {
    id: 93,
    method: 'item/tool/call',
    params: {
      ...call,
      callId: 'call-html',
      tool: 'html_render',
      arguments: { html: 'x'.repeat(100_000) },
    },
  });
  const reply = await waitFor(() => repliesTo(h.child, 93)[0], 'html');
  expect(reply.result?.success).toBe(true);
  expect(h.calls).toEqual(['html_render']);
  await h.adapter.stopSession('catalog-selection');
});

test('an MCP-app result shows the model its structured content, as Codex MCP does', async () => {
  const inventory = { sessions: [{ id: 'session-1', title: 'Fix login' }] };
  const h = harness(true, {
    content: [{ type: 'text', text: 'Session inventory available.' }],
    structuredContent: inventory,
  });
  await start(h, 'catalog-structured', 'native-m');
  const turn = h.adapter.sendTurn({
    threadId: 'catalog-structured',
    input: 'go',
  });
  await h.answer('turn/start', { turn: { id: 'turn-m' } });
  await withTimeout(turn, 'turn');
  await emit(h.child, {
    id: 94,
    method: 'item/tool/call',
    params: {
      threadId: 'native-m',
      turnId: 'turn-m',
      callId: 'call-m',
      tool: 'list_agents',
      arguments: {},
    },
  });
  const reply = await waitFor(() => repliesTo(h.child, 94)[0], 'reply');
  expect(reply.result.contentItems).toEqual([
    { type: 'inputText', text: 'Session inventory available.' },
    { type: 'inputText', text: JSON.stringify(inventory) },
  ]);
  await h.adapter.stopSession('catalog-structured');
});

async function openTurn(
  h: ReturnType<typeof harness>,
  threadId: string,
  turnId: string,
  extra: Record<string, unknown> = {},
) {
  const turn = h.adapter.sendTurn({ threadId, input: 'go', ...extra } as never);
  await h.answer('turn/start', { turn: { id: turnId } });
  await withTimeout(turn, 'turn');
}

async function callTool(
  h: ReturnType<typeof harness>,
  id: number,
  params: Record<string, unknown>,
) {
  await emit(h.child, { id, method: 'item/tool/call', params });
  return waitFor(() => repliesTo(h.child, id)[0], `reply ${id}`);
}

test('the argument cap is per tool: browser and device stay at 40,000 bytes, the catalog at 1 MiB', async () => {
  const h = harness(true);
  await start(h, 'catalog-cap', 'native-cap');
  await openTurn(h, 'catalog-cap', 'turn-cap');
  const call = { threadId: 'native-cap', turnId: 'turn-cap' };
  const browser = await callTool(h, 95, {
    ...call,
    callId: 'big-browser',
    tool: 'browser_status',
    arguments: { pad: 'x'.repeat(40_000) },
  });
  expect(browser.error).toBeDefined();
  const device = await callTool(h, 94, {
    ...call,
    callId: 'big-device',
    tool: 'device_list',
    arguments: { pad: 'x'.repeat(40_000) },
  });
  expect(device.error).toBeDefined();
  const overhead = Buffer.byteLength(JSON.stringify({ html: '' }));
  const over = await callTool(h, 96, {
    ...call,
    callId: 'over-cap',
    tool: 'html_render',
    arguments: { html: 'x'.repeat(1_048_576 - overhead + 1) },
  });
  expect(over.error).toBeDefined();
  const at = await callTool(h, 97, {
    ...call,
    callId: 'at-cap',
    tool: 'html_render',
    arguments: { html: 'x'.repeat(1_048_576 - overhead) },
  });
  expect(at.result?.success).toBe(true);
  // Neither refused input reached approval or execution.
  expect(h.events.filter((e) => e.method === 'request.opened')).toEqual([]);
  expect(h.calls).toEqual(['html_render']);
  await h.adapter.stopSession('catalog-cap');
});

test('Ask mode: a deferred mutating catalog tool asks first, and a decline never runs it', async () => {
  const h = harness(true, undefined, { decision: 'defer' });
  const ask = { modelOptions: { approvalMode: 'ask' }, confinement: 'host' };
  await start(h, 'catalog-ask', 'native-ask', {
    agent: { slug: 'agent', toolServers: [control()] },
    ...ask,
  });
  await openTurn(h, 'catalog-ask', 'turn-ask', ask);
  await emit(h.child, {
    id: 98,
    method: 'item/tool/call',
    params: {
      threadId: 'native-ask',
      turnId: 'turn-ask',
      callId: 'update',
      tool: 'update_agent',
      arguments: { slug: 'other' },
    },
  });
  const opened = await waitFor(
    () => h.events.find((e) => e.method === 'request.opened'),
    'approval',
  );
  expect(opened.payload.toolName).toBe('mcp__station-control__update_agent');
  expect(h.calls).toEqual([]);
  await h.adapter.respondToRequest('catalog-ask', opened.requestId, 'decline');
  const reply = await waitFor(() => repliesTo(h.child, 98)[0], 'decline');
  expect(reply.error).toBeDefined();
  expect(h.calls).toEqual([]);
  await h.adapter.stopSession('catalog-ask');
});

test('a restricted network narrows the catalog to the restricted allowlist', async () => {
  const h = harness(true);
  sessions.push('catalog-net');
  const started = h.adapter.startSession({
    provider: 'codex',
    threadId: 'catalog-net',
    cwd: '/tmp',
    agent: { toolServers: [control()] },
    confinementPlan: { network: { mode: 'restricted' } },
  } as never);
  // Codex cannot restrict its network, so this start is later refused; the
  // offer it sent is what is checked here.
  started.catch(() => {});
  await flushIo();
  await h.answer('initialize', { userAgent: 'test' });
  const request = await h.answer('thread/start', {
    thread: { id: 'native-net' },
  });
  await started.catch(() => {});
  const names: string[] = request.params.dynamicTools.map(
    (tool: { name: string }) => tool.name,
  );
  const allowed = new Set(restrictedNetworkStationControlTools());
  expect(names).toContain('list_agents');
  for (const name of ['delegate_task', 'device_list'])
    expect(names).not.toContain(name);
  for (const name of names.filter((n) => !n.startsWith('browser_')))
    expect(allowed.has(name)).toBe(true);
  expect(h.created[0]).toMatchObject({
    stationControl: { allowedTools: [...allowed] },
  });
});

test('the marker follows only the same native thread', async () => {
  expect(
    codexResumeCursor('native-1', {
      codexThreadId: 'native-1',
      boundCatalog: true,
    }),
  ).toMatchObject({ boundCatalog: true });
  expect(
    codexResumeCursor('native-2', {
      codexThreadId: 'native-1',
      boundCatalog: true,
    }),
  ).not.toHaveProperty('boundCatalog');
  // A resume that Codex answers with another thread does not carry it.
  const h = harness(true);
  const { session } = await start(h, 'catalog-moved', 'native-other', {
    resumeCursor: { codexThreadId: 'native-1', boundCatalog: true },
  });
  expect(session.resumeCursor).toMatchObject({ codexThreadId: 'native-other' });
  expect(session.resumeCursor).not.toHaveProperty('boundCatalog');
  await h.adapter.stopSession('catalog-moved');
});

test('a catalog thread resumed with the preview off uses the header server and points persisted calls at it', async () => {
  const h = harness(false);
  const { request, session } = await start(
    h,
    'catalog-off-resume',
    'native-o',
    {
      resumeCursor: { codexThreadId: 'native-o', boundCatalog: true },
    },
  );
  expect(h.mint).toHaveBeenCalledOnce();
  expect(request.params.config).toMatchObject({
    'mcp_servers.station-control.url':
      'http://127.0.0.1:12345/mcp/station-control',
  });
  // The thread still holds the catalog, so a later resume may use it again.
  expect(session.resumeCursor).toMatchObject({ boundCatalog: true });
  await openTurn(h, 'catalog-off-resume', 'turn-o');
  const reply = await callTool(h, 99, {
    threadId: 'native-o',
    turnId: 'turn-o',
    callId: 'persisted',
    tool: 'list_agents',
    arguments: {},
  });
  expect(reply.error.message).toContain('station-control MCP tool');
  // A saved browser copy has no MCP twin, so it gets no pointer.
  const browser = await callTool(h, 101, {
    threadId: 'native-o',
    turnId: 'turn-o',
    callId: 'persisted-browser',
    tool: 'browser_status',
    arguments: {},
  });
  expect(browser.error.message).toBe('Bound tool refused');
  expect(h.calls).toEqual([]);
  await h.adapter.stopSession('catalog-off-resume');
});

test('a catalog thread whose control became coordinator-derived refuses persisted catalog calls with a pointer', async () => {
  const h = harness(true);
  const { request } = await start(h, 'catalog-coord-resume', 'native-cr', {
    resumeCursor: { codexThreadId: 'native-cr', boundCatalog: true },
    agent: {
      toolServers: [
        { ...control(), coordinatorDerived: true, coordinatorGeneration: 1 },
      ],
    },
  });
  expect(h.mint).toHaveBeenCalledOnce();
  expect(JSON.stringify(request.params.config)).toContain('station-control');
  expect(h.created[0]).not.toHaveProperty('stationControl');
  await openTurn(h, 'catalog-coord-resume', 'turn-cr');
  const reply = await callTool(h, 100, {
    threadId: 'native-cr',
    turnId: 'turn-cr',
    callId: 'persisted',
    tool: 'list_agents',
    arguments: {},
  });
  expect(reply.error.message).toContain('station-control MCP tool');
  // A withdrawn catalog name gets its pointer before any size check.
  const big = await callTool(h, 102, {
    threadId: 'native-cr',
    turnId: 'turn-cr',
    callId: 'persisted-big',
    tool: 'html_render',
    arguments: { html: 'x'.repeat(50_000) },
  });
  expect(big.error.message).toContain('station-control MCP tool');
  expect(h.calls).toEqual([]);
  await h.adapter.stopSession('catalog-coord-resume');
});

test('an adopted lineage keeps the header server and also serves persisted catalog copies on the bound channel', async () => {
  const h = harness(true);
  const { request, session } = await start(h, 'catalog-adopted', 'native-ad', {
    resumeCursor: {
      codexThreadId: 'native-ad',
      sourceAffinity: { kind: 'codex-config-home', ref: 'a'.repeat(64) },
    },
  });
  expect(h.mint).toHaveBeenCalledOnce();
  expect(JSON.stringify(request.params.config)).toContain('station-control');
  expect(h.created).toEqual([expect.objectContaining({ stationControl: {} })]);
  expect(session.resumeCursor).not.toHaveProperty('boundCatalog');
  const headerToken = h.mint.mock.results[0]!.value.token;
  expect(
    verifyStationControlMcpToken(headerToken, {
      channels: ['http-header-token'],
      serverId: 'station-control',
    }),
  ).toMatchObject({ sessionId: 'catalog-adopted' });
  await openTurn(h, 'catalog-adopted', 'turn-ad');
  const reply = await callTool(h, 101, {
    threadId: 'native-ad',
    turnId: 'turn-ad',
    callId: 'copy',
    tool: 'list_agents',
    arguments: {},
  });
  expect(reply.result?.success).toBe(true);
  expect(h.calls).toEqual(['list_agents']);
  await h.adapter.stopSession('catalog-adopted');
  expect(verifyStationControlMcpToken(headerToken)).toBeUndefined();
});
