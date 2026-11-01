// @vitest-environment node
/**
 * Journey over real processes: the built supervisor bundle, the built
 * workload host bundle (`station-pty-host.js`, found beside the core entry as
 * in a real build), and a core generation built from the production terminal
 * modules (`fixtures/workload-journey-core.ts`). A live shell (ConPTY on
 * Windows) keeps its pid and every journal record, once and in order, while
 * generation 1 hands off to generation 2; stopping the supervisor ends it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveControlEndpoint,
  type SupervisorStatus,
} from '@kontourai/station-supervisor/protocol';
import * as esbuild from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { scaleLivenessMs } from '../../../../scripts/lib/liveness-scale.mjs';
import { STATION_SERVER_EXTERNALS } from '../../../../scripts/lib/server-build-config.mjs';
import {
  type ControlConnection,
  connectControl,
} from '../../../__test-utils__/supervisor-control.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
// Inside the checkout (git-ignored as dist-server-*), so node-pty resolves
// from the checkout's node_modules, as it does beside a real build.
const buildDir = join(
  repoRoot,
  `dist-server-workload-journey-${process.pid}-${randomUUID().slice(0, 8)}`,
);
const SUPERVISOR = join(buildDir, 'station-supervisor.js');
const CORE = join(buildDir, 'journey-core.js');
const HOST = join(buildDir, 'station-pty-host.js');
const INSTANCE = 'terminals';
const BUILD_TIMEOUT_MS = scaleLivenessMs(120_000);
const STEP_TIMEOUT_MS = scaleLivenessMs(60_000);
const windows = process.platform === 'win32';
const SHELL = windows ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh';
const ENTER = windows ? '\r' : '\n';
/**
 * Markers the shell expands from a variable, so the echo of the typed command
 * never contains them: each appears in the journal exactly once per print.
 */
const SET_MARK = windows ? 'set M=mark' : 'M=mark';
const mark = (prefix: string) =>
  windows ? `echo ${prefix}-%M%` : `echo ${prefix}-$M`;
/** Output that arrives about two seconds later: during the handoff. */
const DELAYED = windows
  ? `ping -n 3 127.0.0.1 >nul & ${mark('delayed')}`
  : `sleep 2; ${mark('delayed')}`;

const makeTempDir = trackTempDirs({
  base: process.env.STATION_VITEST_HOST_TMPDIR ?? tmpdir(),
});
const children = new Set<ChildProcess>();

beforeAll(async () => {
  mkdirSync(buildDir, { recursive: true });
  const shared = {
    bundle: true,
    platform: 'node' as const,
    target: 'node24',
    format: 'esm' as const,
    external: STATION_SERVER_EXTERNALS,
    banner: {
      js: "import { createRequire as __stationCreateRequire } from 'node:module'; const require = __stationCreateRequire(import.meta.url);",
    },
    logLevel: 'error' as const,
  };
  const { supervisorBuildOptions } = (await import(
    pathToFileURL(join(repoRoot, 'packages/supervisor/build-options.mjs')).href
  )) as { supervisorBuildOptions(outfile: string): esbuild.BuildOptions };
  await Promise.all([
    esbuild.build(supervisorBuildOptions(SUPERVISOR)),
    // The production workload host entry, as esbuild.config.mjs builds it.
    esbuild.build({
      ...shared,
      entryPoints: [join(repoRoot, 'src-server/tools/station-pty-host.ts')],
      outfile: HOST,
    }),
    esbuild.build({
      ...shared,
      entryPoints: [join(here, 'fixtures/workload-journey-core.ts')],
      outfile: CORE,
    }),
  ]);
}, BUILD_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((done) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return done();
          const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
          child.once('exit', () => {
            clearTimeout(killer);
            done();
          });
          child.kill('SIGTERM');
        }),
    ),
  );
  children.clear();
});

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (typeof address !== 'object' || !address) throw new Error('no port');
  // Never the user's own Station ports.
  if ([3000, 3141, 3142, 3143, 3144].includes(address.port)) return freePort();
  return address.port;
}

function call<T>(port: number, path: string, body?: string): Promise<T> {
  return new Promise((done, fail) => {
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
        res.on('end', () =>
          res.statusCode === 200
            ? done(JSON.parse(text) as T)
            : fail(new Error(`${path}: ${res.statusCode} ${text}`)),
        );
      },
    );
    request.on('error', fail);
    request.end(body);
  });
}

async function until<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  diagnostics: () => string,
): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for ${what}: ${String(last)}\n${diagnostics()}`,
      );
    await new Promise((done) => setTimeout(done, 100));
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Read {
  pid: number | null;
  status: string;
  records: { seq: number; data: string }[];
}
const joined = (read: Read) => read.records.map((r) => r.data).join('');
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('a supervised terminal', () => {
  it(
    'keeps its pid and every journal record across a core handoff, and ends with the supervisor',
    async () => {
      const root = makeTempDir('svt-');
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      mkdirSync(home);
      mkdirSync(workspace);
      const port = await freePort();
      const supervisor = spawn(
        process.execPath,
        [SUPERVISOR, '--entry', CORE, '--home', home, '--instance', INSTANCE],
        {
          env: {
            ...process.env,
            JOURNEY_HOME: home,
            JOURNEY_ROOT: await realpath(workspace),
            JOURNEY_SHELL: SHELL,
            JOURNEY_PORT: String(port),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      children.add(supervisor);
      let output = '';
      const append = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-256 * 1024);
      };
      supervisor.stdout?.on('data', append);
      supervisor.stderr?.on('data', append);
      const diagnostics = () => output;
      const endpoint = resolveControlEndpoint({ home, instance: INSTANCE });
      let control: ControlConnection | null = null;
      let nextId = 1;
      const status = async (): Promise<SupervisorStatus> => {
        control ??= await connectControl(endpoint.path, endpoint.tokenPath);
        const reply = await control.request(
          { type: 'status', id: `s${nextId++}` },
          ['status.result'],
        );
        if (reply.type !== 'status.result')
          throw new Error(JSON.stringify(reply));
        return reply.status;
      };
      try {
        await until(
          'generation 1 serving',
          async () => {
            if (!existsSync(endpoint.tokenPath)) return undefined;
            const current = await status();
            return current.active?.state === 'serving' ? current : undefined;
          },
          diagnostics,
        );
        const state1 = await call<{ generation: number; workloads: boolean }>(
          port,
          '/state',
        );
        // The supervisor found the workload host beside the core entry.
        expect(state1).toMatchObject({ generation: 1, workloads: true });

        const opened = await call<{ terminalId: string; pid: number }>(
          port,
          '/open',
          '',
        );
        const id = opened.terminalId;
        const read = (from = 0) =>
          call<Read>(port, `/read?id=${id}&from=${from}`);
        await call(
          port,
          `/write?id=${id}`,
          `${SET_MARK}${ENTER}${mark('before')}${ENTER}`,
        );
        await until(
          'the shell to answer generation 1',
          async () =>
            count(joined(await read()), 'before-mark') >= 1 ? true : undefined,
          diagnostics,
        );
        // Output that lands while generation 1 drains or no core is attached.
        await call(port, `/write?id=${id}`, `${DELAYED}${ENTER}`);

        control ??= await connectControl(endpoint.path, endpoint.tokenPath);
        const handoff = await control.request(
          { type: 'handoff', id: `h${nextId++}` },
          ['handoff.result'],
        );
        expect(handoff, diagnostics()).toMatchObject({
          outcome: 'committed',
          generation: 2,
        });
        const state2 = await call<{ generation: number; workloads: boolean }>(
          port,
          '/state',
        );
        expect(state2).toMatchObject({ generation: 2, workloads: true });

        // Generation 2 reattached the same process and lost nothing.
        const replay = await until(
          'the delayed output in generation 2',
          async () => {
            const current = await read();
            return count(joined(current), 'delayed-mark') >= 1
              ? current
              : undefined;
          },
          diagnostics,
        );
        expect(replay.status).toBe('running');
        expect(replay.pid).toBe(opened.pid);
        const seqs = replay.records.map((record) => record.seq);
        expect(seqs).toEqual(seqs.map((_, index) => index + 1));
        const supervised = await status();
        expect(supervised.workloads).toEqual([
          expect.objectContaining({
            workloadId: id,
            pid: opened.pid,
            state: 'running',
            kind: 'interactive',
          }),
        ]);

        // And it operates the shell, reading on from where it was.
        const from = seqs.at(-1) ?? 0;
        await call(port, `/write?id=${id}`, `${mark('after')}${ENTER}`);
        const tail = await until(
          'the shell to answer generation 2',
          async () => {
            const current = await read(from);
            return count(joined(current), 'after-mark') >= 1
              ? current
              : undefined;
          },
          diagnostics,
        );
        expect(joined(tail)).not.toContain('before-mark');
        // Nothing lost or doubled: each marker printed once appears once.
        const all = joined(await read());
        for (const marker of ['before-mark', 'delayed-mark', 'after-mark'])
          expect(count(all, marker), marker).toBe(1);

        // Stopping the supervisor ends the shell with it.
        await control.request({ type: 'stop', id: `x${nextId++}` }, [
          'stop.result',
        ]);
        control.close();
        control = null;
        await until(
          'the supervisor to exit',
          async () => (supervisor.exitCode !== null ? true : undefined),
          diagnostics,
        );
        await until(
          'the shell to end with its supervisor',
          async () => (pidAlive(opened.pid) ? undefined : true),
          diagnostics,
        );
      } finally {
        (control as ControlConnection | null)?.close();
      }
    },
    STEP_TIMEOUT_MS * 8,
  );
});
