/**
 * Workloads (protocol 1.3) over real processes: the supervisor runs the
 * fixture workload host and relays the fixture core's requests to it.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import type {
  WorkloadInfo,
  WorkloadReadResult,
  WorkloadRequest,
} from '../protocol.ts';
import { startSupervisor } from './harness.ts';

const makeTempDir = trackTempDirs();
const FAKE_HOST = fileURLToPath(
  new URL('./__fixtures__/fake-workload-host.mjs', import.meta.url),
);
const WAIT = { timeout: 30_000, interval: 50 };

/** Echoes each stdin chunk back, prefixed, so output follows input. */
const ECHO = [
  '-e',
  "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('echo:'+d))",
];

function httpJson(
  port: number,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        agent: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve(JSON.parse(text) as Record<string, unknown>));
      },
    );
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function workload<T = unknown>(
  port: number,
  request: WorkloadRequest,
): Promise<T> {
  const reply = await httpJson(port, '/workload', request);
  if (reply.ok !== true) {
    throw new Error(`workload ${request.op} refused: ${JSON.stringify(reply)}`);
  }
  return reply.result as T;
}

function spawnEcho(dir: string, workloadId: string): WorkloadRequest {
  return {
    op: 'spawn',
    workloadId,
    kind: 'command',
    candidates: [{ command: process.execPath, args: ECHO }],
    // Not the temp home: Windows cannot remove a directory that is a live
    // process's working directory, and teardown may race the workload's end.
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
    cols: 80,
    rows: 24,
    journal: { directory: join(dir, 'journal') },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readAll(port: number, workloadId: string): Promise<string> {
  const result = await workload<WorkloadReadResult>(port, {
    op: 'read',
    workloadId,
    fromSeq: 0,
    maxBytes: 1024 * 1024,
  });
  return result.records.map((record) => record.data).join('');
}

describe('supervisor workloads (real processes)', () => {
  it('keeps a workload running, with the same pid and its whole journal, across a handoff', async () => {
    const home = makeTempDir('sup-workloads-');
    const supervisor = await startSupervisor({
      home,
      env: { FAKE_CORE_WORKLOADS: '1' },
      args: ['--workload-host', FAKE_HOST],
    });
    const port = supervisor.port;
    expect((await httpJson(port, '/boot')).granted).toEqual(['workloads']);

    const spawned = await workload<WorkloadInfo>(
      port,
      spawnEcho(home, 'shell-1'),
    );
    expect(spawned).toMatchObject({ workloadId: 'shell-1', state: 'running' });
    await workload(port, { op: 'write', workloadId: 'shell-1', data: 'one\n' });
    await vi.waitFor(
      async () => expect(await readAll(port, 'shell-1')).toBe('echo:one\n'),
      WAIT,
    );
    // Generation 1 hears the output it caused.
    await vi.waitFor(async () => {
      const events = (await httpJson(port, '/workload-events')) as unknown;
      expect(events).toContainEqual(
        expect.objectContaining({ workloadId: 'shell-1', event: 'output' }),
      );
    }, WAIT);

    const result = await supervisor.handoff();
    expect(result, supervisor.output()).toMatchObject({
      outcome: 'committed',
      generation: 2,
    });
    const boot = await httpJson(port, '/boot');
    expect(boot.generation).toBe(2);
    expect(boot.granted).toEqual(['workloads']);

    // Generation 2 finds the same process and reads everything before it.
    const listed = await workload<WorkloadInfo[]>(port, { op: 'list' });
    expect(listed).toEqual([
      expect.objectContaining({
        workloadId: 'shell-1',
        pid: spawned.pid,
        state: 'running',
      }),
    ]);
    expect(pidAlive(spawned.pid)).toBe(true);
    await workload(port, { op: 'write', workloadId: 'shell-1', data: 'two\n' });
    await vi.waitFor(
      async () =>
        expect(await readAll(port, 'shell-1')).toBe('echo:one\necho:two\n'),
      WAIT,
    );
    const status = await supervisor.status();
    expect(status.supervisor.protocol).toEqual({ major: 1, minor: 3 });
    expect(status.workloads).toEqual([
      {
        workloadId: 'shell-1',
        kind: 'command',
        pid: spawned.pid,
        state: 'running',
      },
    ]);

    // Ending it ends its process and is reported to the serving generation.
    const ended = await workload<WorkloadInfo>(port, {
      op: 'terminate',
      workloadId: 'shell-1',
    });
    expect(ended.state).toBe('exited');
    expect(pidAlive(spawned.pid)).toBe(false);
    await vi.waitFor(async () => {
      const events = (await httpJson(port, '/workload-events')) as unknown;
      expect(events).toContainEqual(
        expect.objectContaining({ workloadId: 'shell-1', event: 'exit' }),
      );
    }, WAIT);
  });

  it('grants workloads only to a core that asks, and only with a workload host', async () => {
    const quiet = await startSupervisor({
      home: makeTempDir('sup-workloads-12-'),
      args: ['--workload-host', FAKE_HOST],
    });
    // A core that did not announce `workloads` (a 1.2 core) is not granted it.
    expect((await httpJson(quiet.port, '/boot')).granted).toEqual([]);
    const reply = await httpJson(quiet.port, '/workload', { op: 'list' });
    expect(reply).toMatchObject({ ok: false, code: 'bad-request' });

    // No host beside the entry and none named: nothing is granted.
    const hostless = await startSupervisor({
      home: makeTempDir('sup-workloads-nohost-'),
      env: { FAKE_CORE_WORKLOADS: '1' },
    });
    expect((await httpJson(hostless.port, '/boot')).granted).toEqual([]);
  });

  it('ends its workloads and its host when it stops', async () => {
    const home = makeTempDir('sup-workloads-stop-');
    const pidFile = join(home, 'host.pid');
    const supervisor = await startSupervisor({
      home,
      env: { FAKE_CORE_WORKLOADS: '1', FAKE_HOST_PID_FILE: pidFile },
      args: ['--workload-host', FAKE_HOST],
    });
    const spawned = await workload<WorkloadInfo>(
      supervisor.port,
      spawnEcho(home, 'shell-stop'),
    );
    const hostPid = Number(readFileSync(pidFile, 'utf8'));
    expect(pidAlive(hostPid)).toBe(true);
    const connection = await supervisor.connect();
    try {
      await connection.request({ type: 'stop', id: 'stop-1' }, ['stop.result']);
    } finally {
      connection.close();
    }
    expect((await supervisor.exited).code).toBe(0);
    await vi.waitFor(() => {
      expect(pidAlive(spawned.pid)).toBe(false);
      expect(pidAlive(hostPid)).toBe(false);
    }, WAIT);
  });

  it('reports every workload ended when its host dies, and starts a new host for the next spawn', async () => {
    const home = makeTempDir('sup-workloads-crash-');
    const pidFile = join(home, 'host.pid');
    const supervisor = await startSupervisor({
      home,
      env: { FAKE_CORE_WORKLOADS: '1', FAKE_HOST_PID_FILE: pidFile },
      args: ['--workload-host', FAKE_HOST],
    });
    const port = supervisor.port;
    await workload(port, spawnEcho(home, 'doomed'));
    const firstHost = Number(readFileSync(pidFile, 'utf8'));
    process.kill(firstHost, 'SIGKILL');
    await vi.waitFor(async () => {
      const events = (await httpJson(port, '/workload-events')) as unknown;
      expect(events).toContainEqual({
        type: 'workload.event',
        workloadId: 'doomed',
        event: 'exit',
        exit: expect.objectContaining({ outputIncomplete: true }),
      });
    }, WAIT);
    expect((await supervisor.status()).workloads).toEqual([
      expect.objectContaining({ workloadId: 'doomed', state: 'exited' }),
    ]);
    // Nothing runs now: an address finds no workload.
    expect(
      await httpJson(port, '/workload', { op: 'attach', workloadId: 'doomed' }),
    ).toMatchObject({ ok: false, code: 'not-found' });

    const again = await workload<WorkloadInfo>(
      port,
      spawnEcho(home, 'second'),
    );
    expect(again.state).toBe('running');
    expect(Number(readFileSync(pidFile, 'utf8'))).not.toBe(firstHost);
  });
});
