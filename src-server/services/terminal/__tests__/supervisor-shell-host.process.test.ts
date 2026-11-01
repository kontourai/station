// @vitest-environment node
/**
 * Terminals as supervisor workloads, with real PTYs (ConPTY on Windows): the
 * production workload host and `SupervisorShellHost` joined by a channel that
 * serializes every message as the IPC channel does. A core is a
 * `TerminalSessions` instance; disposing one and creating the next on the
 * same home is a core restart.
 */
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  WorkloadEventMessage,
  WorkloadInfo,
  WorkloadRequest,
} from '@kontourai/station-supervisor/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { NodePtyAdapter } from '../../../adapters/node-pty-adapter.js';
import { PtyWorkloadHost, WorkloadFailure } from '../pty-workload-host.js';
import {
  SupervisorShellHost,
  type WorkloadChannel,
} from '../supervisor-shell-host.js';
import { TerminalJournal } from '../terminal-journal.js';
import { TerminalSessions } from '../terminal-sessions.js';

const makeTempDir = trackTempDirs();
const scope = { projectId: 'project-a', bindingKey: 'project' };
const WAIT = { timeout: 30_000, interval: 50 };
const windows = process.platform === 'win32';
const SHELL = windows ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh';
const ENTER = windows ? '\r' : '\n';
/**
 * Markers the shell expands from a variable, so the echo of the typed command
 * never contains them: each appears in the journal exactly once per print.
 */
const SET_MARK = windows ? 'set M=mark\r' : 'M=mark\n';
const mark = (prefix: string) =>
  `echo ${prefix}-${windows ? '%M%' : '$M'}${ENTER}`;

/** The supervisor's relay, in one process: JSON both ways, events a turn later. */
function connect(
  host: PtyWorkloadHost,
  events: Set<(event: WorkloadEventMessage) => void>,
) {
  const listeners = new Set<(event: WorkloadEventMessage) => void>();
  const forward = (event: WorkloadEventMessage) => {
    const copy = JSON.parse(JSON.stringify(event)) as WorkloadEventMessage;
    setImmediate(() => {
      for (const listener of [...listeners]) listener(copy);
    });
  };
  events.add(forward);
  const channel: WorkloadChannel & { close(): void } = {
    async requestWorkload(request: WorkloadRequest) {
      try {
        const result = await host.handle(
          JSON.parse(JSON.stringify(request)) as WorkloadRequest,
        );
        return result === undefined
          ? undefined
          : (JSON.parse(JSON.stringify(result)) as unknown);
      } catch (error) {
        throw Object.assign(new Error(String(error)), {
          code: error instanceof WorkloadFailure ? error.code : 'failed',
        });
      }
    },
    onWorkloadEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      events.delete(forward);
      listeners.clear();
    },
  };
  return channel;
}

const hosts: PtyWorkloadHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stopAll()));
});

function startHost() {
  const routes = new Set<(event: WorkloadEventMessage) => void>();
  const host = new PtyWorkloadHost({
    pty: new NodePtyAdapter(),
    emit: (event) => {
      for (const route of routes) route(event);
    },
  });
  hosts.push(host);
  return { host, routes };
}

function core(home: string, root: string, channel: WorkloadChannel) {
  return new TerminalSessions<string>(
    home,
    new SupervisorShellHost(channel, () => SHELL),
    {
      authorize: () => true,
      resolveRoot: async () => root,
    },
  );
}

async function text(
  sessions: TerminalSessions<string>,
  id: string,
  fromSeq = 0,
) {
  const snapshot = await sessions.read('operator', scope, id, fromSeq);
  return snapshot.journal.records.map((record) => record.data).join('');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('terminals as supervisor workloads (real PTYs)', () => {
  it('keeps a shell running across a core restart: same pid, every record once, in order', async () => {
    const home = makeTempDir('workload-sessions-');
    const root = await realpath(makeTempDir('workload-root-'));
    const { host, routes } = startHost();

    const first = connect(host, routes);
    const before = core(home, root, first);
    const opened = await before.open('operator', scope, { cols: 80, rows: 24 });
    const id = opened.terminalId;
    const pid = opened.pid;
    expect(pid).toEqual(expect.any(Number));
    await before.write('operator', scope, id, SET_MARK + mark('first'));
    await vi.waitFor(
      async () => expect(count(await text(before, id), 'first-mark')).toBe(1),
      WAIT,
    );

    // The core stops (a handoff drains it): it detaches, the shell lives on.
    await before.dispose();
    first.close();
    expect(pidAlive(pid as number)).toBe(true);
    // Output while no core is attached is journaled by the host.
    await host.handle({
      op: 'write',
      workloadId: id,
      data: mark('detached'),
    });
    await vi.waitFor(async () => {
      const read = (await host.handle({
        op: 'read',
        workloadId: id,
        fromSeq: 0,
        maxBytes: 1024 * 1024,
      })) as { records: { data: string }[] };
      expect(
        count(read.records.map((r) => r.data).join(''), 'detached-mark'),
      ).toBe(1);
    }, WAIT);

    // The next core reattaches the same process and reads everything.
    const after = core(home, root, connect(host, routes));
    const [listed] = await after.list('operator', scope);
    expect(listed).toMatchObject({ terminalId: id, status: 'running' });
    const snapshot = await after.read('operator', scope, id);
    expect(snapshot.pid).toBe(pid);
    const seqs = snapshot.journal.records.map((record) => record.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    const replay = snapshot.journal.records.map((r) => r.data).join('');
    expect(count(replay, 'first-mark')).toBe(1);
    expect(count(replay, 'detached-mark')).toBe(1);

    // It operates the reattached shell, and hears new output.
    const changed = vi.fn();
    after.onChange(changed);
    const resumeFrom = seqs.at(-1) ?? 0;
    await after.write('operator', scope, id, mark('after'));
    await vi.waitFor(async () => {
      const tail = await text(after, id, resumeFrom);
      expect(count(tail, 'after-mark')).toBe(1);
      expect(tail).not.toContain('first-mark');
    }, WAIT);
    expect(changed).toHaveBeenCalledWith(id);

    // Closing ends it, and its journal stays readable from disk.
    await after.close('operator', scope, id);
    expect(pidAlive(pid as number)).toBe(false);
    const closed = await after.read('operator', scope, id);
    expect(closed.status).toBe('exited');
    expect(
      count(closed.journal.records.map((r) => r.data).join(''), 'after-mark'),
    ).toBe(1);
    await after.dispose();
  });

  it('marks a shell that ended while no core was attached exited, with its output', async () => {
    const home = makeTempDir('workload-ended-');
    const root = await realpath(makeTempDir('workload-ended-root-'));
    const { host, routes } = startHost();
    const first = connect(host, routes);
    const before = core(home, root, first);
    const { terminalId: id } = await before.open('operator', scope, {
      cols: 80,
      rows: 24,
    });
    await before.dispose();
    first.close();
    await host.handle({
      op: 'write',
      workloadId: id,
      data: `echo last-words${ENTER}exit${ENTER}`,
    });
    await vi.waitFor(async () => {
      const info = (await host.handle({
        op: 'attach',
        workloadId: id,
      })) as WorkloadInfo;
      expect(info.state).toBe('exited');
    }, WAIT);

    const after = core(home, root, connect(host, routes));
    const [listed] = await after.list('operator', scope);
    expect(listed?.status).toBe('exited');
    expect(count(await text(after, id), 'last-words')).toBeGreaterThanOrEqual(
      1,
    );
    await after.dispose();
  });

  it('ends a command and every process it started, escalating past a process that ignores SIGTERM', async () => {
    const dir = makeTempDir('workload-kill-');
    const pidFile = join(dir, 'grandchild.pid');
    const stubborn = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const parent = [
      "const {spawn}=require('node:child_process');",
      "const {writeFileSync}=require('node:fs');",
      `const c=spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{stdio:'ignore'});`,
      `writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`,
      "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
    ].join('');
    const { host } = startHost();
    const info = (await host.handle({
      op: 'spawn',
      workloadId: 'stubborn',
      kind: 'command',
      candidates: [{ command: process.execPath, args: ['-e', parent] }],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      cols: 80,
      rows: 24,
      journal: { directory: join(dir, 'journal') },
    })) as WorkloadInfo;
    let grandchild = 0;
    await vi.waitFor(async () => {
      const read = (await host.handle({
        op: 'read',
        workloadId: 'stubborn',
        fromSeq: 0,
        maxBytes: 4096,
      })) as { records: { data: string }[] };
      expect(read.records.map((r) => r.data).join('')).toContain('ready');
      grandchild = Number(readFileSync(pidFile, 'utf8'));
      expect(grandchild).toBeGreaterThan(0);
    }, WAIT);
    expect(pidAlive(info.pid)).toBe(true);
    expect(pidAlive(grandchild)).toBe(true);

    const ended = (await host.handle({
      op: 'terminate',
      workloadId: 'stubborn',
    })) as WorkloadInfo;
    expect(ended.state).toBe('exited');
    expect(pidAlive(info.pid)).toBe(false);
    await vi.waitFor(() => expect(pidAlive(grandchild)).toBe(false), WAIT);
  }, 60_000);

  it('ends a command at its output cap and journals no more than the cap', async () => {
    const dir = makeTempDir('workload-cap-');
    const { host } = startHost();
    await host.handle({
      op: 'spawn',
      workloadId: 'chatty',
      kind: 'command',
      candidates: [
        {
          command: process.execPath,
          args: [
            '-e',
            "const line='x'.repeat(1023)+'\\n';setInterval(()=>process.stdout.write(line.repeat(16)),5)",
          ],
        },
      ],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      cols: 80,
      rows: 24,
      journal: { directory: join(dir, 'journal') },
      outputCapBytes: 64 * 1024,
    });
    await vi.waitFor(async () => {
      const info = (await host.handle({
        op: 'attach',
        workloadId: 'chatty',
      })) as WorkloadInfo;
      expect(info.state).toBe('exited');
    }, WAIT);
    // The journal is closed; read it from disk as a core does.
    const journal = new TerminalJournal(join(dir, 'journal'));
    await journal.load();
    const read = await journal.read(0, 1024 * 1024);
    const bytes = read.records.reduce(
      (sum, record) => sum + Buffer.byteLength(record.data),
      0,
    );
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
  }, 60_000);
});
