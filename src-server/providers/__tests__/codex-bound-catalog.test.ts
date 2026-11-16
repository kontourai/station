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
import { revokeStationControlMcpToken } from '../../runtime/mcp/station-control-mcp-token.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
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
  previewOn: boolean,
  result: unknown = { content: [{ type: 'text', text: '{"ok":true}' }] },
) {
  const child = new FakeCodexProcess();
  const mint = vi.fn(() => ({
    url: 'http://127.0.0.1:12345/mcp/station-control',
    token: 'header-token',
  }));
  const created: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const adapter = new CodexAdapter({
    processFactory: () => child as never,
    boundToolsEnabled: () => previewOn,
    boundToolsEpoch: () => 1,
    resolveBoundToolPolicy: async () => async () => ({ behavior: 'allow' }),
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
  });
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
  return { child, adapter, mint, created, calls, answer };
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
    agent: { toolServers: [control()] } as never,
    ...extra,
  });
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
