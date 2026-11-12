/**
 * #3994 delivery phase 1: retention settings, restore after a host restart,
 * stable shell numbers and the open-or-adopt reservation, against real
 * node-pty shells in a private home: `/bin/sh` on POSIX, cmd.exe on ConPTY
 * on Windows.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFailed,
  test,
  vi,
} from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { NodePtyAdapter } from '../../../adapters/node-pty-adapter.js';
import type { IPtyProcess } from '../../../domain/pty-adapter.js';
import {
  createTerminalHistoryRoutes,
  createTerminalSessionRoutes,
} from '../../../routes/projects/terminal-session-routes.js';
import { InProcessShellHost, type ShellHost } from '../shell-host.js';
import type { TerminalRetention } from '../terminal-retention.js';
import {
  TERMINAL_RESTORED_DIVIDER,
  TerminalSessionRefusal,
  TerminalSessions,
} from '../terminal-sessions.js';
import {
  line,
  PROMPT,
  print,
  printCwd,
  runScript,
  SHELL,
  shown,
  windows,
} from './fixtures/real-shell.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
/** The SDK's Ghostty replay, run as a child: it needs WebAssembly types. */
const REPLAY = fileURLToPath(
  new URL(
    '../../../../packages/sdk/src/__tests__/terminal-view/replay-plain-text.ts',
    import.meta.url,
  ),
);
const makeTempDir = trackTempDirs();
const scope = { projectId: 'project-a', bindingKey: 'project' };
const other = { projectId: 'project-b', bindingKey: 'project' };
const dimensions = { cols: 80, rows: 24 };
const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

describe('terminal retention, restore and reservation with real node-pty', () => {
  let home: string;
  let root: string;
  let sessions: TerminalSessions<Request>;
  let retention: TerminalRetention;
  let spawned: number;
  let projects: Set<string>;
  const nativeProcesses: {
    process: import('node-pty').IPty;
    spawnedAt: number;
    pipeReadyAt?: number;
    firstDataAt?: number;
    exitedAt?: number;
  }[] = [];
  const request = () => new Request('http://localhost:43995');

  async function observedNodePty(): Promise<typeof import('node-pty')> {
    const native = await import('node-pty');
    return {
      ...native,
      spawn(...args) {
        const process = native.spawn(...args);
        const observation: (typeof nativeProcesses)[number] = {
          process,
          spawnedAt: performance.now(),
        };
        nativeProcesses.push(observation);
        const socket = '_socket' in process ? process._socket : undefined;
        if (
          typeof socket === 'object' &&
          socket !== null &&
          'once' in socket &&
          typeof socket.once === 'function'
        )
          socket.once('ready_datapipe', () => {
            observation.pipeReadyAt = performance.now();
          });
        const data = process.onData(() => {
          observation.firstDataAt = performance.now();
          data.dispose();
        });
        const exit = process.onExit(() => {
          observation.exitedAt = performance.now();
          exit.dispose();
        });
        return process;
      },
    };
  }

  function scalar(owner: unknown, key: string) {
    if (typeof owner !== 'object' || owner === null) return undefined;
    const value: unknown = Reflect.get(owner, key);
    return typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string'
      ? value
      : undefined;
  }

  function create(
    options: { restorable?: boolean; host?: ShellHost } = {},
  ): TerminalSessions<Request> {
    const pty = new InProcessShellHost(
      new NodePtyAdapter(windows ? observedNodePty : undefined),
      () => SHELL,
    );
    const counting: ShellHost = options.host ?? {
      spawn: async (input) => {
        spawned += 1;
        return pty.spawn(input);
      },
    };
    sessions = new TerminalSessions<Request>(
      home,
      counting,
      {
        authorize: (_principal, target) =>
          ['project-a', 'project-b'].includes(target.projectId),
        resolveRoot: async (_principal, target) =>
          target.projectId === 'project-a' ? root : join(home, 'b'),
        ...(options.restorable !== false && {
          restoreRoot: async (target) => {
            if (!projects.has(target.projectId))
              throw new TerminalSessionRefusal('its Project no longer exists');
            return target.projectId === 'project-a' ? root : join(home, 'b');
          },
        }),
      },
      {},
      {},
      async () => ({ ...retention }),
    );
    return sessions;
  }

  async function text(id: string, target = scope) {
    return (await sessions.read(request(), target, id)).journal.records
      .map((record) => record.data)
      .join('');
  }

  /**
   * Scrollback and screen after replaying `data` at the shell's size, or
   * journal records at their recorded sizes in a view of `box`, as the
   * terminal view replays them (#4625).
   */
  async function rendered(
    data: string | { data: string; resize?: object }[],
    box = dimensions,
  ): Promise<string> {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        REPLAY,
        String(box.cols),
        String(box.rows),
        ...(typeof data === 'string' ? [] : ['--records']),
      ],
      { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.end(typeof data === 'string' ? data : JSON.stringify(data));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0)
      throw new Error(`terminal replay exited ${code}: ${stderr.slice(-2000)}`);
    const { text } = JSON.parse(stdout) as { text: string };
    return text;
  }

  async function output(id: string, marker: string) {
    await expect
      .poll(async () => shown(await text(id)), { timeout: 10_000 })
      .toContain(marker);
  }

  async function exited(id: string, target = scope) {
    await expect
      .poll(
        async () =>
          (await sessions.list(request(), target)).find(
            (record) => record.terminalId === id,
          )?.status,
        { timeout: 10_000 },
      )
      .toBe('exited');
  }

  beforeEach(async () => {
    nativeProcesses.length = 0;
    onTestFailed(() => {
      if (!windows) return;
      // Read-only ConPTY state, retained only when this real-process case fails.
      console.error(
        'terminal-retention native lifecycle',
        JSON.stringify(
          nativeProcesses.map((observation) => {
            const { process, spawnedAt } = observation;
            const socket = '_socket' in process ? process._socket : undefined;
            const agent = '_agent' in process ? process._agent : undefined;
            return {
              pid: process.pid,
              ageMs: performance.now() - spawnedAt,
              pipeReadyMs:
                observation.pipeReadyAt === undefined
                  ? null
                  : observation.pipeReadyAt - spawnedAt,
              firstDataMs:
                observation.firstDataAt === undefined
                  ? null
                  : observation.firstDataAt - spawnedAt,
              exitMs:
                observation.exitedAt === undefined
                  ? null
                  : observation.exitedAt - spawnedAt,
              ready: scalar(process, '_isReady'),
              nativeExitCode: scalar(agent, '_exitCode'),
              socketConnecting: scalar(socket, 'connecting'),
              socketDestroyed: scalar(socket, 'destroyed'),
              socketState: scalar(socket, 'readyState'),
            };
          }),
        ),
      );
    });
    home = makeTempDir('station-terminal-retention-');
    root = join(home, 'a');
    await mkdir(root);
    await mkdir(join(home, 'b'));
    spawned = 0;
    projects = new Set(['project-a', 'project-b']);
    retention = {
      persist: true,
      directory: join(home, 'terminal-journals'),
      maxAgeMs: 30 * DAY,
      maxTerminalBytes: 16 * MIB,
      maxTotalBytes: 1024 * MIB,
    };
    create();
  });

  afterEach(async () => {
    await sessions.dispose();
    vi.restoreAllMocks();
  });

  test('a shell whose host restarted reopens in its directory below its journal and a divider, without re-running a command', async () => {
    const first = await sessions.open(request(), scope, dimensions);
    await sessions.write(
      request(),
      scope,
      first.terminalId,
      line(
        windows ? 'echo ran>>ran.txt' : 'echo ran >> ran.txt',
        print('before:', 'restart'),
      ),
    );
    await output(first.terminalId, 'before:restart');
    // An in-process host ends its shells with the core: the host restarted.
    await sessions.dispose();
    expect(spawned).toBe(1);
    create();
    const restored = await sessions.read(request(), scope, first.terminalId);
    expect(spawned).toBe(2);
    expect(restored.status).toBe('running');
    expect(restored.restoredAt).toEqual(expect.any(Number));
    expect(restored.pid).not.toBeNull();
    expect(restored.pid).not.toBe(first.pid);
    const replay = shown(await text(first.terminalId));
    expect(replay.indexOf('before:restart')).toBeGreaterThanOrEqual(0);
    expect(replay.indexOf('restored after restart')).toBeGreaterThan(
      replay.indexOf('before:restart'),
    );
    // The reopened shell is live and in the same directory; the command
    // that ran before the restart did not run again.
    await sessions.write(
      request(),
      scope,
      first.terminalId,
      line(printCwd('after:')),
    );
    await output(first.terminalId, `after:${await realRoot()}`);
    // What a person sees: the journal replayed through Station's emulator
    // keeps the earlier output and the divider above the reopened shell. A
    // reopened ConPTY clears the screen first, which once erased both.
    const screen = await rendered(await text(first.terminalId));
    const divider = screen.indexOf('restored after restart');
    expect(screen.indexOf('before:restart')).toBeGreaterThanOrEqual(0);
    expect(divider).toBeGreaterThan(screen.indexOf('before:restart'));
    expect(screen.lastIndexOf('after:')).toBeGreaterThan(divider);
    expect((await readFile(join(root, 'ran.txt'), 'utf8')).trim()).toBe('ran');
    expect(TERMINAL_RESTORED_DIVIDER).toContain('restored after restart');
  });

  test('a resize is journaled in order, and a replay at the recorded sizes keeps the lines that had scrolled (#4625)', async () => {
    const opened = await sessions.open(request(), scope, dimensions);
    const id = opened.terminalId;
    await output(id, PROMPT);
    // 40 numbered rows: at 24 rows the first ones scroll off the screen.
    await sessions.write(
      request(),
      scope,
      id,
      line(
        windows
          ? 'for /L %i in (1,1,40) do @echo row-%i.'
          : 'i=1; while [ $i -le 40 ]; do echo "row-$i."; i=$((i+1)); done',
      ),
    );
    await output(id, 'row-40.');
    const beforeResize = (await sessions.read(request(), scope, id)).journal
      .lastSeq;
    // ConPTY repaints its whole screen for the new size.
    await sessions.resize(request(), scope, id, 80, 10);
    await sessions.write(request(), scope, id, line(print('after:', 'resize')));
    await output(id, 'after:resize');
    const records = (await sessions.read(request(), scope, id)).journal.records;
    const sizes = records.filter((record) => record.resize);
    // The spawn's size opens the journal; the resize follows the output
    // written before it.
    expect(records[0]?.resize).toEqual({ cols: 80, rows: 24 });
    expect(sizes.map((record) => record.resize)).toEqual([
      { cols: 80, rows: 24 },
      { cols: 80, rows: 10 },
    ]);
    expect(sizes[1]!.seq).toBeGreaterThan(beforeResize);
    for (const record of sizes) expect(record.data).toBe('');
    // A view of another size replays every row, including those that had
    // scrolled before the resize repainted the screen.
    const screen = await rendered(records, { cols: 100, rows: 30 });
    for (let row = 1; row <= 40; row++)
      expect(screen, `row-${row}.`).toContain(`row-${row}.`);
    expect(screen).toContain('after:resize');
  });

  test('a shell stays ended when restore is not offered, its Project is gone, or it ended by itself', async () => {
    const kept = await sessions.open(request(), scope, dimensions);
    const removed = await sessions.open(request(), other, dimensions);
    const finished = await sessions.open(request(), scope, dimensions);
    await sessions.write(request(), scope, finished.terminalId, 'exit\r');
    await exited(finished.terminalId);
    await sessions.dispose();
    projects.delete('project-b');
    create({ restorable: false });
    expect(
      (await sessions.read(request(), scope, kept.terminalId)).status,
    ).toBe('exited');
    await sessions.dispose();
    spawned = 0;
    create();
    expect(
      (await sessions.read(request(), scope, kept.terminalId)).status,
    ).toBe('running');
    const gone = await sessions.read(request(), other, removed.terminalId);
    expect(gone.status).toBe('exited');
    expect(gone.restoreRefused?.reason).toBe('its Project no longer exists');
    expect(
      (await sessions.read(request(), scope, finished.terminalId)).status,
    ).toBe('exited');
    expect(spawned).toBe(1);
  });

  test('a host that kept a shell running or saw it end is never restored over', async () => {
    const opened = await sessions.open(request(), scope, dimensions);
    await sessions.dispose();
    // As a supervised core leaves it: detached from a shell still running.
    const file = join(home, 'terminal-sessions.json');
    const asDetached = async () => {
      const records = JSON.parse(await readFile(file, 'utf8')) as Record<
        string,
        unknown
      >[];
      for (const record of records) {
        record.status = 'running';
        delete record.hostStopped;
        delete record.endedAt;
        delete record.exitCode;
      }
      await writeFile(file, JSON.stringify(records));
    };
    await asDetached();
    // The supervisor reattached it (a handoff): tracked, not respawned.
    let spawns = 0;
    const exitListeners: ((event: { exitCode: number }) => void)[] = [];
    const hosted = {
      pid: 4242,
      journal: {
        read: async () => ({
          firstSeq: 1,
          lastSeq: 0,
          reset: false,
          records: [],
        }),
        flush: async () => {},
        discard: async () => {},
        seal: () => {},
        append: async () => {},
        backpressured: false,
        drained: true,
      },
      onOutput: () => () => {},
      detach: () => {},
      onData: () => () => {},
      onExit: (listener: (event: { exitCode: number }) => void) => {
        exitListeners.push(listener);
        return () => {};
      },
      write: () => {},
      resize: () => {},
      kill: () => {},
    } as unknown as IPtyProcess;
    const host = (attach: 'live' | 'ended'): ShellHost => ({
      spawn: async () => {
        spawns += 1;
        throw new Error('must not spawn');
      },
      attach: async () =>
        attach === 'live' ? (hosted as never) : ('ended' as const),
    });
    create({ host: host('live') });
    const reattached = await sessions.read(request(), scope, opened.terminalId);
    expect(reattached.status).toBe('running');
    expect(reattached.pid).toBe(4242);
    expect(reattached.restoredAt).toBeUndefined();
    await sessions.dispose();
    await asDetached();
    create({ host: host('ended') });
    expect(
      (await sessions.read(request(), scope, opened.terminalId)).status,
    ).toBe('exited');
    expect(spawns).toBe(0);
  });

  test('ended terminals expire after the maximum age, and settings changes apply without a restart', async () => {
    const old = await sessions.open(request(), scope, dimensions);
    await sessions.close(request(), scope, old.terminalId);
    const directory = join(home, 'terminal-journals', old.terminalId);
    expect(existsSync(directory)).toBe(true);
    retention.maxAgeMs = DAY;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + DAY / 2);
    await sessions.usage(request());
    expect(existsSync(directory)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * DAY);
    const usage = await sessions.usage(request());
    expect(existsSync(directory)).toBe(false);
    expect(usage.terminals).toBe(0);
    await expect(
      sessions.read(request(), scope, old.terminalId),
    ).rejects.toThrow('not found');
  });

  test('moving the history location migrates ended journals and keeps running ones in place until they end', async () => {
    const ended = await sessions.open(request(), scope, dimensions);
    await sessions.write(
      request(),
      scope,
      ended.terminalId,
      line(print('moved:', 'output')),
    );
    await output(ended.terminalId, 'moved:output');
    await sessions.close(request(), scope, ended.terminalId);
    const running = await sessions.open(request(), scope, dimensions);
    const target = join(home, 'elsewhere', 'journals');
    retention.directory = target;
    await sessions.usage(request());
    expect(existsSync(join(target, ended.terminalId))).toBe(true);
    expect(existsSync(join(home, 'terminal-journals', ended.terminalId))).toBe(
      false,
    );
    expect(shown(await text(ended.terminalId))).toContain('moved:output');
    expect(
      existsSync(join(home, 'terminal-journals', running.terminalId)),
    ).toBe(true);
    // New terminals write to the new location, and it survives a restart.
    const fresh = await sessions.open(request(), scope, dimensions);
    await output(fresh.terminalId, PROMPT);
    expect(existsSync(join(target, fresh.terminalId))).toBe(true);
    await sessions.dispose();
    create();
    expect(shown(await text(ended.terminalId))).toContain('moved:output');
  });

  test('with history off a new terminal writes nothing to disk', async () => {
    retention.persist = false;
    const opened = await sessions.open(request(), scope, dimensions);
    await sessions.write(
      request(),
      scope,
      opened.terminalId,
      line(print('memory:', 'only')),
    );
    await output(opened.terminalId, 'memory:only');
    expect(existsSync(join(home, 'terminal-journals', opened.terminalId))).toBe(
      false,
    );
    expect((await sessions.list(request(), scope))[0]?.persist).toBe(false);
  });

  test('the total size budget bounds retained terminals and usage and clearing work per Project and for everything', async () => {
    retention.maxTerminalBytes = MIB;
    retention.maxTotalBytes = 3 * MIB;
    const a1 = await sessions.open(request(), scope, dimensions);
    await sessions.write(request(), scope, a1.terminalId, 'echo one\r');
    await output(a1.terminalId, 'one');
    await sessions.close(request(), scope, a1.terminalId);
    const a2 = await sessions.open(request(), scope, dimensions);
    const b1 = await sessions.open(request(), other, dimensions);
    await sessions.close(request(), other, b1.terminalId);
    // Three slots: a fourth evicts the oldest ended terminal.
    const a3 = await sessions.open(request(), scope, dimensions);
    expect(
      (await sessions.list(request(), scope)).map((r) => r.terminalId),
    ).toEqual([a2.terminalId, a3.terminalId]);
    const usage = await sessions.usage(request());
    expect(usage.terminals).toBe(3);
    expect(
      usage.projects.find((p) => p.projectId === 'project-a'),
    ).toMatchObject({ terminals: 2, running: 2 });
    expect(
      usage.projects.find((p) => p.projectId === 'project-b')?.bytes,
    ).toBeGreaterThan(0);
    expect(await sessions.clearHistory(request(), 'project-a')).toEqual({
      cleared: 0,
      running: 2,
    });
    expect(await sessions.clearHistory(request(), 'project-b')).toEqual({
      cleared: 1,
      running: 0,
    });
    expect(existsSync(join(home, 'terminal-journals', b1.terminalId))).toBe(
      false,
    );
    await sessions.close(request(), scope, a2.terminalId);
    expect(await sessions.clearHistory(request())).toEqual({
      cleared: 1,
      running: 1,
    });
    expect(
      (await sessions.list(request(), scope)).map((r) => r.terminalId),
    ).toEqual([a3.terminalId]);
  });

  test('shell numbers stay stable when the oldest ended shells are evicted, and older records are numbered on load', async () => {
    retention.maxTerminalBytes = MIB;
    retention.maxTotalBytes = 3 * MIB;
    const one = await sessions.open(request(), scope, dimensions);
    const two = await sessions.open(request(), scope, dimensions);
    const three = await sessions.open(request(), scope, dimensions);
    expect([one.ordinal, two.ordinal, three.ordinal]).toEqual([1, 2, 3]);
    await sessions.close(request(), scope, one.terminalId);
    const four = await sessions.open(request(), scope, dimensions);
    const listed = await sessions.list(request(), scope);
    expect(listed.map((r) => [r.terminalId, r.ordinal])).toEqual([
      [two.terminalId, 2],
      [three.terminalId, 3],
      [four.terminalId, 4],
    ]);
    // Another binding counts from one.
    retention.maxTotalBytes = 1024 * MIB;
    const elsewhere = await sessions.open(request(), other, dimensions);
    expect(elsewhere.ordinal).toBe(1);
    await sessions.dispose();
    // A home written before stored numbers: numbered in creation order.
    const file = join(home, 'terminal-sessions.json');
    const records = JSON.parse(await readFile(file, 'utf8')) as {
      ordinal?: number;
    }[];
    for (const record of records) delete record.ordinal;
    await writeFile(file, JSON.stringify(records));
    create({ restorable: false });
    expect(
      (await sessions.list(request(), scope)).map((r) => r.ordinal),
    ).toEqual([1, 2, 3]);
  });

  test('agent commands are retained in their own pool: they never expire user shells, get no number and are not restored', async () => {
    retention.maxTerminalBytes = MIB;
    retention.maxTotalBytes = 2 * MIB;
    const shell = await sessions.open(request(), scope, dimensions);
    await sessions.close(request(), scope, shell.terminalId);
    await sessions.dispose();
    // As #4453 writes an agent's ACP terminal: `kind: 'command'`, no launch.
    const file = join(home, 'terminal-sessions.json');
    const records = JSON.parse(await readFile(file, 'utf8')) as Record<
      string,
      unknown
    >[];
    const command = (n: number, status: string) => ({
      projectId: 'project-a',
      bindingKey: 'project',
      terminalId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      cwd: records[0]!.cwd,
      cols: 80,
      rows: 24,
      status,
      journalUnavailable: false,
      createdAt: Date.now() + n,
      kind: 'command',
    });
    for (let n = 1; n <= 20; n++) records.push(command(n, 'exited'));
    // One recorded running when its host went away: a command, not a shell.
    records.push(command(21, 'running'));
    await writeFile(file, JSON.stringify(records));
    spawned = 0;
    create();
    const listed = await sessions.list(request(), scope);
    const commands = listed.filter((r) => r.kind === 'command');
    // The command pool keeps its newest 16; the older user shell survives.
    expect(commands).toHaveLength(16);
    expect(commands.map((r) => r.terminalId).at(-1)).toMatch(/0021$/);
    expect(listed.find((r) => r.terminalId === shell.terminalId)).toMatchObject(
      { ordinal: 1, status: 'exited' },
    );
    expect(commands.every((r) => r.ordinal === undefined)).toBe(true);
    expect(commands.find((r) => r.terminalId.endsWith('0021'))?.status).toBe(
      'exited',
    );
    expect(spawned).toBe(0);
    // User shells fill and expire within their own pool; commands stay.
    const second = await sessions.open(request(), scope, dimensions);
    expect(second.ordinal).toBe(2);
    await sessions.close(request(), scope, second.terminalId);
    await sessions.open(request(), scope, dimensions);
    const after = await sessions.list(request(), scope);
    expect(after.filter((r) => r.kind === 'command')).toHaveLength(16);
    expect(after.some((r) => r.terminalId === shell.terminalId)).toBe(false);
  });

  test('real agent command sessions (#4453 openInternal) land in the command pool and never expire a user shell', async () => {
    const shell = await sessions.open(request(), scope, dimensions);
    await sessions.close(request(), scope, shell.terminalId);
    await exited(shell.terminalId);
    const ids: string[] = [];
    for (let n = 1; n <= 20; n++) {
      // As AcpSessionTerminals.create opens an agent's ACP terminal.
      const opened = await sessions.openInternal(scope, {
        cwd: root,
        ...dimensions,
        launch: runScript(`echo command-${n}`),
        kind: 'command',
      });
      await expect(opened.exited).resolves.toMatchObject({ exitCode: 0 });
      ids.push(opened.terminalId);
    }
    const listed = await sessions.list(request(), scope);
    const commands = listed.filter((r) => r.kind === 'command');
    // Twenty ended commands: the pool of 16 expired only its own oldest.
    expect(commands.map((r) => r.terminalId)).toEqual(ids.slice(4));
    expect(commands.every((r) => r.ordinal === undefined)).toBe(true);
    expect(listed.find((r) => r.terminalId === shell.terminalId)).toMatchObject(
      { ordinal: 1, status: 'exited' },
    );
    // A command is never reopened after its host restarts.
    await sessions.dispose();
    spawned = 0;
    create();
    const after = await sessions.list(request(), scope);
    expect(spawned).toBe(0);
    expect(after.filter((r) => r.kind === 'command')).toHaveLength(16);
    expect(after.some((r) => r.terminalId === shell.terminalId)).toBe(true);
    // The next shell is still numbered after the user's, not the commands.
    const next = await sessions.open(request(), scope, dimensions);
    expect(next.ordinal).toBe(2);
  });

  test("a restarted shell drops its previous run's end markers, so a later exit by itself is not restored", async () => {
    const shell = await sessions.open(request(), scope, dimensions);
    await sessions.dispose();
    // The in-process host stopped with its core: ended, marked hostStopped.
    const file = join(home, 'terminal-sessions.json');
    const stored = () =>
      readFile(file, 'utf8').then(
        (raw) =>
          (JSON.parse(raw) as Record<string, unknown>[]).find(
            (r) => r.terminalId === shell.terminalId,
          )!,
      );
    expect(await stored()).toMatchObject({ hostStopped: true });
    create({ restorable: false });
    await sessions.restart(request(), scope, shell.terminalId);
    const restarted = await stored();
    expect(restarted.status).toBe('running');
    expect(restarted.hostStopped).toBeUndefined();
    expect(restarted.endedAt).toBeUndefined();
    // It now ends by itself while its host keeps running.
    await sessions.close(request(), scope, shell.terminalId);
    await exited(shell.terminalId);
    await sessions.dispose();
    spawned = 0;
    create();
    await expect
      .poll(
        async () =>
          (await sessions.list(request(), scope)).find(
            (r) => r.terminalId === shell.terminalId,
          )?.status,
      )
      .toBe('exited');
    expect(spawned).toBe(0);
  });

  test('two clients opening an empty binding at the same moment get one shell', async () => {
    const app = new Hono();
    app.route(
      '/api/projects',
      createTerminalSessionRoutes(
        sessions,
        () => 'project-a',
        () => true,
      ),
    );
    app.route(
      '/api/terminal/history',
      createTerminalHistoryRoutes(sessions, () => true),
    );
    const server = serve({
      fetch: app.fetch,
      port: 0,
      hostname: '127.0.0.1',
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const open = () =>
        fetch(`http://127.0.0.1:${port}/api/projects/alpha/terminal-sessions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            connection: 'close',
          },
          body: JSON.stringify({ ...dimensions, adopt: true }),
        }).then(async (response) => ({
          status: response.status,
          body: (await response.json()) as {
            data: { terminalId: string; adopted?: boolean };
          },
        }));
      const [first, second] = await Promise.all([open(), open()]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.body.data.terminalId).toBe(first.body.data.terminalId);
      expect(
        [first.body.data.adopted, second.body.data.adopted].filter(Boolean),
      ).toHaveLength(1);
      expect(spawned).toBe(1);
      expect(await sessions.list(request(), scope)).toHaveLength(1);
      // Without `adopt` a second shell opens, as before.
      const plain = await fetch(
        `http://127.0.0.1:${port}/api/projects/alpha/terminal-sessions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            connection: 'close',
          },
          body: JSON.stringify(dimensions),
        },
      );
      expect(plain.status).toBe(200);
      expect(spawned).toBe(2);
      const usage = await fetch(
        `http://127.0.0.1:${port}/api/terminal/history`,
        { headers: { connection: 'close' } },
      );
      expect(
        ((await usage.json()) as { data: { terminals: number } }).data
          .terminals,
      ).toBe(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function realRoot() {
    return realpath(root);
  }

  test('journal files for the restored shell stay in one directory', async () => {
    const opened = await sessions.open(request(), scope, dimensions);
    await sessions.dispose();
    create();
    await output(opened.terminalId, 'restored after restart');
    expect(
      (await readdir(join(home, 'terminal-journals'))).filter(
        (name) => name === opened.terminalId,
      ),
    ).toHaveLength(1);
  });
});
