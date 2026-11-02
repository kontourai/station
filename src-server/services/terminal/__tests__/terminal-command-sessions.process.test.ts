// @vitest-environment node
/**
 * #3994 command sessions and restart with real processes: a `command`
 * session's output cap and exit through the in-process host, an agent's ACP
 * terminals as command sessions through the bridge client, and an explicit
 * restart of an interactive PTY under the same id.
 */
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { NodePtyAdapter } from '../../../adapters/node-pty-adapter.js';
import { createTerminalSessionRoutes } from '../../../routes/projects/terminal-session-routes.js';
import { createACPBridgeClient } from '../../acp/acp-bridge-client.js';
import {
  AcpSessionTerminals,
  limitAcpOutput,
} from '../../acp/acp-session-terminals.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { InProcessShellHost } from '../shell-host.js';
import { TerminalSessions } from '../terminal-sessions.js';

const makeTempDir = trackTempDirs();
const scope = { projectId: 'project-a', bindingKey: 'project' };
const agentScope = { projectId: 'project-a', bindingKey: 'thread:agent' };
const WAIT = { timeout: 30_000, interval: 50 };
const windows = process.platform === 'win32';
const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

function service(home: string, root: string) {
  return new TerminalSessions<string>(
    home,
    new InProcessShellHost(new NodePtyAdapter(), () =>
      windows ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh',
    ),
    {
      authorize: (principal) => principal === 'operator',
      resolveRoot: async () => root,
    },
  );
}

async function text(
  sessions: TerminalSessions<string>,
  id: string,
  target = scope,
) {
  const snapshot = await sessions.readInternal(target, id);
  return snapshot.journal.records.map((record) => record.data).join('');
}

function bridge(terminals: AcpSessionTerminals, cwd: string) {
  let next = 0;
  return createACPBridgeClient({
    cwd,
    terminals: new Map(),
    sessionTerminals: terminals,
    approvalRegistry: new ApprovalRegistry(logger),
    getActiveWriter: () => null,
    nextTerminalId: () => `acp-term-${++next}`,
    onSessionUpdate: async () => {},
    onExtNotification: () => {},
    onExtMethod: async () => ({}),
  });
}

describe('command terminal sessions (in-process host)', () => {
  it('ends a command at its output cap, journals no more than the cap and reports it', async () => {
    const home = makeTempDir('command-cap-');
    const root = await realpath(makeTempDir('command-cap-root-'));
    const sessions = service(home, root);
    const { terminalId, exited } = await sessions.openInternal(scope, {
      cwd: root,
      cols: 80,
      rows: 24,
      kind: 'command',
      outputCapBytes: 64 * 1024,
      launch: {
        file: process.execPath,
        args: [
          '-e',
          "const line='x'.repeat(1023)+'\\n';setInterval(()=>process.stdout.write(line.repeat(16)),5)",
        ],
      },
    });
    const exit = await exited;
    expect(exit.outputCapped).toBe(true);
    const output = await text(sessions, terminalId);
    expect(Buffer.byteLength(output)).toBeGreaterThan(0);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64 * 1024);
    const [record] = await sessions.listObservable('operator');
    expect(record).toMatchObject({
      terminalId,
      kind: 'command',
      outputCapBytes: 64 * 1024,
      outputCapped: true,
      status: 'exited',
    });
    await sessions.dispose();
  }, 60_000);

  it('refuses an output cap outside its bounds instead of clamping it', async () => {
    const home = makeTempDir('command-cap-bounds-');
    const root = await realpath(makeTempDir('command-cap-bounds-root-'));
    const sessions = service(home, root);
    for (const outputCapBytes of [1023, 1024 ** 3 + 1])
      await expect(
        sessions.openInternal(scope, {
          cwd: root,
          cols: 80,
          rows: 24,
          kind: 'command',
          outputCapBytes,
          launch: { file: process.execPath, args: ['-e', ''] },
        }),
      ).rejects.toThrow();
    expect(await sessions.listObservable('operator')).toEqual([]);
    await sessions.dispose();
  });

  it('journals stdout and stderr without a PTY and reports the exit code', async () => {
    const home = makeTempDir('command-exit-');
    const root = await realpath(makeTempDir('command-exit-root-'));
    const sessions = service(home, root);
    const { terminalId, exited } = await sessions.openInternal(scope, {
      cwd: root,
      cols: 80,
      rows: 24,
      kind: 'command',
      launch: {
        file: process.execPath,
        args: [
          '-e',
          "console.log('out', process.stdout.isTTY === true);console.error('err');process.exit(3)",
        ],
      },
    });
    expect(await exited).toEqual({
      exitCode: 3,
      signal: null,
      outputCapped: false,
    });
    const output = await text(sessions, terminalId);
    expect(output).toContain('out false');
    expect(output).toContain('err');
    await sessions.dispose();
  }, 30_000);
});

describe('ACP agent terminals on terminal sessions', () => {
  async function setup(name: string) {
    const home = makeTempDir(`${name}-`);
    const root = await realpath(makeTempDir(`${name}-root-`));
    const sessions = service(home, root);
    const client = bridge(
      new AcpSessionTerminals(sessions, agentScope, root),
      root,
    );
    return { home, root, sessions, client };
  }

  it('runs a command as a journaled, user-visible command session', async () => {
    const { root, sessions, client } = await setup('acp-session');
    const { terminalId } = (await client.createTerminal({
      sessionId: 's',
      command: process.execPath,
      args: ['-e', "console.log('hello from acp')"],
    })) as { terminalId: string };
    expect(terminalId).toBe('acp-term-1');
    await expect(
      client.waitForTerminalExit({ sessionId: 's', terminalId }),
    ).resolves.toEqual({ exitCode: 0, signal: null });
    const out = await client.terminalOutput({ sessionId: 's', terminalId });
    expect(out).toMatchObject({
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
    });
    expect(out.output).toContain('hello from acp');
    // The same command is a session the operator can list and read.
    const [record] = await sessions.listObservable('operator');
    expect(record).toMatchObject({
      ...agentScope,
      kind: 'command',
      cwd: root,
      status: 'exited',
      exitCode: 0,
    });
    expect(await text(sessions, record!.terminalId, agentScope)).toContain(
      'hello from acp',
    );
    await client.releaseTerminal({ sessionId: 's', terminalId });
    await expect(
      client.terminalOutput({ sessionId: 's', terminalId }),
    ).rejects.toMatchObject({ code: -32602 });
    await sessions.dispose();
  }, 30_000);

  it('truncates output from the beginning to outputByteLimit', async () => {
    const { sessions, client } = await setup('acp-limit');
    const { terminalId } = (await client.createTerminal({
      sessionId: 's',
      command: process.execPath,
      args: ['-e', "process.stdout.write('a'.repeat(100)+'TAIL-é')"],
      outputByteLimit: 10,
    })) as { terminalId: string };
    await client.waitForTerminalExit({ sessionId: 's', terminalId });
    const out = await client.terminalOutput({ sessionId: 's', terminalId });
    expect(out.truncated).toBe(true);
    // The last 10 bytes ('é' is two).
    expect(out.output).toBe('aaaTAIL-é');
    // A limit that would split a character drops the partial character.
    expect(limitAcpOutput('xé', 1)).toEqual({ output: '', truncated: true });
    expect(limitAcpOutput('xé', 3)).toEqual({ output: 'xé', truncated: false });
    await sessions.dispose();
  }, 30_000);

  it('reports a command that cannot start as exit 127 with the reason', async () => {
    const { sessions, client } = await setup('acp-enoent');
    const { terminalId } = (await client.createTerminal({
      sessionId: 's',
      command: `${process.execPath}-no-such-binary`,
      args: [],
    })) as { terminalId: string };
    await expect(
      client.waitForTerminalExit({ sessionId: 's', terminalId }),
    ).resolves.toEqual({ exitCode: 127, signal: null });
    const out = await client.terminalOutput({ sessionId: 's', terminalId });
    expect(out.output).toContain('spawn failed');
    expect(out.output).toContain('ENOENT');
    expect(out.exitStatus).toEqual({ exitCode: 127, signal: null });
    await sessions.dispose();
  }, 30_000);

  it('refuses a terminal directory outside the agent session directory', async () => {
    const { sessions, client } = await setup('acp-cwd');
    const outside = await realpath(makeTempDir('acp-cwd-outside-'));
    await expect(
      client.createTerminal({
        sessionId: 's',
        command: process.execPath,
        args: ['-e', ''],
        cwd: outside,
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(await sessions.listObservable('operator')).toEqual([]);
    await sessions.dispose();
  });

  it.skipIf(windows)(
    'kills a command and its children, reporting the signal, not an exit code',
    async () => {
      const { sessions, client } = await setup('acp-kill');
      const { terminalId } = (await client.createTerminal({
        sessionId: 's',
        command: process.execPath,
        args: ['-e', "console.log('ready');setInterval(()=>{},1000)"],
      })) as { terminalId: string };
      await vi.waitFor(async () => {
        const out = await client.terminalOutput({ sessionId: 's', terminalId });
        expect(out.output).toContain('ready');
        expect(out.exitStatus).toBeNull();
      }, WAIT);
      await client.killTerminal({ sessionId: 's', terminalId });
      await expect(
        client.waitForTerminalExit({ sessionId: 's', terminalId }),
      ).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
      // Killed, not released: its output is still there.
      const out = await client.terminalOutput({ sessionId: 's', terminalId });
      expect(out.output).toContain('ready');
      expect(out.exitStatus).toEqual({ exitCode: null, signal: 'SIGTERM' });
      await sessions.dispose();
    },
    30_000,
  );

  it.skipIf(windows)(
    'splits a composed shell line as before',
    async () => {
      const { sessions, client } = await setup('acp-split');
      const { terminalId } = (await client.createTerminal({
        sessionId: 's',
        command: `${process.execPath} -p "40 + 2"`,
        args: [],
      })) as { terminalId: string };
      await client.waitForTerminalExit({ sessionId: 's', terminalId });
      const out = await client.terminalOutput({ sessionId: 's', terminalId });
      expect(out.output.trim()).toBe('42');
      await sessions.dispose();
    },
    30_000,
  );
});

// POSIX PTY fixture, as terminal-sessions.process.test.ts.
describe.skipIf(windows)('explicit restart (in-process host)', () => {
  it('restarts under the same id in a new journal segment, confined to the binding', async () => {
    const home = makeTempDir('restart-');
    const root = await realpath(makeTempDir('restart-root-'));
    await mkdir(join(root, 'sub'));
    const sessions = service(home, root);
    const opened = await sessions.open('operator', scope, {
      cols: 80,
      rows: 24,
    });
    const id = opened.terminalId;
    await sessions.write('operator', scope, id, 'M=mark; echo first-$M\n');
    await vi.waitFor(
      async () => expect(await text(sessions, id)).toContain('first-mark'),
      WAIT,
    );

    // Confinement: escaping the binding and absolute paths are refused, and
    // the shell keeps running.
    for (const subdirectory of ['..', root])
      await expect(
        sessions.restart('operator', scope, id, { subdirectory }),
      ).rejects.toThrow(/outside its binding|must be relative/);
    expect((await sessions.read('operator', scope, id)).pid).toBe(opened.pid);
    // Observe authority does not restart.
    await expect(
      sessions.restart('stranger', scope, id, { subdirectory: 'sub' }),
    ).rejects.toThrow('Terminal access refused');

    const before = await sessions.read('operator', scope, id);
    const restarted = await sessions.restart('operator', scope, id, {
      subdirectory: 'sub',
    });
    expect(restarted).toMatchObject({
      terminalId: id,
      status: 'running',
      cwd: join(root, 'sub'),
      restart: { count: 1 },
    });
    // A late prompt may still land before the old shell ends.
    const afterSeq = restarted.restart!.afterSeq;
    expect(afterSeq).toBeGreaterThanOrEqual(before.journal.lastSeq);
    expect(restarted.pid).not.toBe(opened.pid);
    await sessions.write(
      'operator',
      scope,
      id,
      'M=mark; echo second-$M; pwd\n',
    );
    await vi.waitFor(async () => {
      const after = await sessions.read('operator', scope, id, afterSeq);
      const tail = after.journal.records.map((r) => r.data).join('');
      expect(tail).toContain('second-mark');
      expect(tail).toContain(join(root, 'sub'));
      expect(tail).not.toContain('first-mark');
    }, WAIT);
    // Earlier output stays readable, in order, with no gap.
    const all = await sessions.read('operator', scope, id);
    const seqs = all.journal.records.map((record) => record.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(all.journal.records.map((r) => r.data).join('')).toContain(
      'first-mark',
    );
    // The new run began a new segment file.
    await sessions.close('operator', scope, id);
    const segments = (
      await readdir(join(home, 'terminal-journals', id))
    ).filter((name) => name.endsWith('.jsonl'));
    expect(segments.length).toBeGreaterThanOrEqual(2);
    await sessions.dispose();
  }, 60_000);

  it('restarts through the HTTP seam and refuses a command session', async () => {
    const home = makeTempDir('restart-http-');
    const root = await realpath(makeTempDir('restart-http-root-'));
    const sessions = new TerminalSessions<Request>(
      home,
      new InProcessShellHost(new NodePtyAdapter(), () => '/bin/sh'),
      { authorize: () => true, resolveRoot: async () => root },
    );
    const routes = createTerminalSessionRoutes(
      sessions,
      () => 'project-a',
      () => true,
    );
    const operator = new Request('http://localhost/');
    const opened = await sessions.open(operator, scope, { cols: 80, rows: 24 });
    const restart = (id: string, body: unknown) =>
      routes.request(`http://localhost/alpha/terminal-sessions/${id}/restart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(
      (await restart(opened.terminalId, { subdirectory: '..' })).status,
    ).toBe(403);
    const response = await restart(opened.terminalId, {});
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown }).data).toMatchObject({
      terminalId: opened.terminalId,
      status: 'running',
      restart: { count: 1 },
    });

    const command = await sessions.openInternal(scope, {
      cwd: root,
      cols: 80,
      rows: 24,
      kind: 'command',
      launch: { file: process.execPath, args: ['-e', ''] },
    });
    await command.exited;
    expect((await restart(command.terminalId, {})).status).toBe(403);
    await expect(
      sessions.restart(operator, scope, command.terminalId),
    ).rejects.toThrow('This terminal cannot be restarted');
    await sessions.close(operator, scope, opened.terminalId);
    await sessions.dispose();
  }, 60_000);
});
