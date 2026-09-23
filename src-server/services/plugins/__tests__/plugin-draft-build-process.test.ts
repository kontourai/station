/**
 * Epic #2323 S3 review round 3: a draft build runs in a disposable process.
 *
 * A FIFO `package.json` is read by esbuild's own resolver, where no Station
 * check sees it, and blocks esbuild's Go service in a syscall. In-process
 * that service is shared with install builds and leaked threads per attempt.
 * Here the build's process group is killed at the deadline; the test asserts
 * the child is gone and that this process's own esbuild still builds.
 *
 * Spawns processes (`mkfifo`, the build child), so it is classified
 * process-heavy in `scripts/vitest-resource-manifest.mjs`.
 */
import { execFileSync, fork } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPluginDraft } from '@kontourai/station-shared/build';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildPluginDraftInChildProcess,
  draftBuildChildEnv,
} from '../plugin-draft-build-process.js';
import { PluginDraftService } from '../plugin-draft-service.js';

const TEST_TIMEOUT_MS = 60_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function plugin(label = 'child'): string {
  const dir = tempDir('station-draft-proc-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      name: 'proc',
      version: '1.0.0',
      entrypoint: './src/index.tsx',
    }),
  );
  writeFileSync(
    join(dir, 'src', 'index.tsx'),
    `export const components = { pulse: () => ${JSON.stringify(label)} };\n`,
  );
  return dir;
}

const manifest = {
  name: 'proc',
  version: '1.0.0',
  entrypoint: './src/index.tsx',
};

function alive(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Every process below `pid`, found while it is still running. */
function descendantsOf(pid: number): number[] {
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    let out = '';
    try {
      out = execFileSync('pgrep', ['-P', String(parent)], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
      });
    } catch {
      // pgrep exits 1 when there are none.
    }
    for (const line of out.split('\n')) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

/** SIGKILL only PIDs this test recorded spawning (or that descend from them). */
function killRecorded(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

/** SIGKILL the process group led by a recorded pid, if it still exists. */
function killRecordedGroup(pid: number): void {
  try {
    if (alive(pid, true)) process.kill(-pid, 'SIGKILL');
  } catch {}
}

async function waitFor(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  return check();
}

describe.skipIf(process.platform === 'win32')('draft build process', () => {
  test(
    'builds a draft in a child process that is gone afterwards',
    async () => {
      const dir = plugin();
      const outdir = join(tempDir('station-draft-proc-out-'), '1');
      let pid: number | undefined;
      const result = await buildPluginDraftInChildProcess(
        { pluginDir: dir, outdir, registrationKey: 'k:1', manifest },
        { onSpawn: (spawned) => (pid = spawned) },
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(existsSync(join(outdir, 'bundle.js'))).toBe(true);
      expect(pid).toBeTypeOf('number');
      expect(await waitFor(() => !alive(pid as number, true))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a FIFO package.json build is stopped at the deadline, its whole process group dies, and this process still builds',
    async () => {
      // `node_modules` is skipped by the pre-build sweep (it can be huge), so
      // a FIFO there reaches esbuild's resolver: the blocked read the child
      // process exists for.
      const dir = plugin();
      writeFileSync(
        join(dir, 'src', 'index.tsx'),
        "import value from 'blocking-package';\nexport const components = { pulse: () => value };\n",
      );
      mkdirSync(join(dir, 'node_modules', 'blocking-package'), {
        recursive: true,
      });
      execFileSync(
        'mkfifo',
        [join(dir, 'node_modules', 'blocking-package', 'package.json')],
        { windowsHide: true, timeout: 10_000 },
      );
      let pid: number | undefined;
      const controller = new AbortController();
      const outdir = join(tempDir('station-draft-proc-out-'), '1');
      // Just before the deadline, record what the child started (its esbuild
      // service) so their deaths can be asserted too, not only the child's.
      let descendants: number[] = [];
      setTimeout(() => {
        if (pid !== undefined) descendants = descendantsOf(pid);
        controller.abort();
      }, 3_000);
      const started = Date.now();
      const result = await buildPluginDraftInChildProcess(
        {
          pluginDir: dir,
          outdir,
          registrationKey: 'k:1',
          manifest,
          signal: controller.signal,
        },
        { onSpawn: (spawned) => (pid = spawned) },
      );
      const elapsed = Date.now() - started;
      // It was the deadline that ended it, not a refusal.
      expect(result).toEqual({
        ok: false,
        diagnostics: [
          { text: 'The draft build was stopped before it finished.' },
        ],
      });
      expect(elapsed).toBeGreaterThanOrEqual(2_900);
      expect(elapsed).toBeLessThan(10_000);
      expect(pid).toBeTypeOf('number');
      // The child and everything in its group (its esbuild service, the
      // thread blocked on the FIFO) are gone.
      expect(await waitFor(() => !alive(pid as number, true))).toBe(true);
      expect(descendants.length).toBeGreaterThan(0);
      expect(
        await waitFor(() => descendants.every((child) => !alive(child))),
      ).toBe(true);
      expect(existsSync(join(outdir, 'bundle.js'))).toBe(false);

      // This process's own esbuild service was never involved.
      const inProcess = await buildPluginDraft({
        pluginDir: plugin('in-process'),
        outdir: join(tempDir('station-draft-proc-out-'), '2'),
        registrationKey: 'k:2',
        manifest,
      });
      expect(inProcess.ok).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the pre-build sweep refuses a FIFO outside node_modules before esbuild starts',
    async () => {
      const dir = plugin();
      execFileSync('mkfifo', [join(dir, 'src', 'package.json')], {
        windowsHide: true,
        timeout: 10_000,
      });
      const started = Date.now();
      const swept = await buildPluginDraft({
        pluginDir: dir,
        outdir: join(tempDir('station-draft-proc-out-'), '3'),
        registrationKey: 'k:3',
        manifest,
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(swept).toMatchObject({
        ok: false,
        diagnostics: [{ file: 'src/package.json' }],
      });
    },
    TEST_TIMEOUT_MS,
  );

  // The service's default builder is the disposable process, not this
  // process's esbuild: while a blocked draft builds, a build child exists,
  // and after the deadline none does.
  test(
    'the draft service builds in a disposable process by default',
    async () => {
      const dir = plugin();
      writeFileSync(
        join(dir, 'src', 'index.tsx'),
        "import value from 'blocking-package';\nexport const components = { pulse: () => value };\n",
      );
      mkdirSync(join(dir, 'node_modules', 'blocking-package'), {
        recursive: true,
      });
      execFileSync(
        'mkfifo',
        [join(dir, 'node_modules', 'blocking-package', 'package.json')],
        { windowsHide: true, timeout: 10_000 },
      );
      const service = new PluginDraftService({
        draftsRoot: join(tempDir('station-draft-proc-home-'), 'plugin-drafts'),
        emitRebuilt: () => {},
        buildTimeoutMs: 3_000,
        pollIntervalMs: 60_000,
      });
      try {
        const before = new Set(descendantsOf(process.pid));
        service.lease('proc', dir);
        const spawned = await waitFor(
          () => descendantsOf(process.pid).some((pid) => !before.has(pid)),
          2_500,
        );
        expect(spawned).toBe(true);
        const children = descendantsOf(process.pid).filter(
          (pid) => !before.has(pid),
        );
        await service.idle('proc', dir);
        expect(service.status('proc', dir).diagnostics[0].text).toContain(
          'did not finish within',
        );
        expect(await waitFor(() => children.every((pid) => !alive(pid)))).toBe(
          true,
        );
      } finally {
        service.dispose();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /** A plugin whose build blocks in esbuild's resolver on a FIFO. */
  function blockingPlugin(): string {
    const dir = plugin();
    writeFileSync(
      join(dir, 'src', 'index.tsx'),
      "import value from 'blocking-package';\nexport const components = { pulse: () => value };\n",
    );
    mkdirSync(join(dir, 'node_modules', 'blocking-package'), {
      recursive: true,
    });
    execFileSync(
      'mkfifo',
      [join(dir, 'node_modules', 'blocking-package', 'package.json')],
      { windowsHide: true, timeout: 10_000 },
    );
    return dir;
  }

  // Round 4 MEDIUM: the child is detached into its own session, so a server
  // that dies mid-build (crash, SIGKILL) used to leave it and its blocked
  // esbuild service running under init. Only PIDs this test spawned (or that
  // descend from them) are signalled.
  test(
    'a build child and its esbuild service exit when the server that started them dies',
    async () => {
      const dir = blockingPlugin();
      const parent = fork(
        new URL('./fixtures/plugin-draft-build-parent.ts', import.meta.url),
        [],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        },
      );
      const parentPid = parent.pid as number;
      let recordedChild: number | undefined;
      let recordedGrandchildren: number[] = [];
      try {
        const childPid = await new Promise<number>((resolvePromise, reject) => {
          const timer = setTimeout(
            () => reject(new Error('no child pid reported')),
            15_000,
          );
          parent.once('message', (message: { childPid?: number }) => {
            clearTimeout(timer);
            if (typeof message.childPid === 'number')
              resolvePromise(message.childPid);
          });
          parent.send({
            pluginDir: dir,
            outdir: join(tempDir('station-draft-proc-out-'), '1'),
          });
        });
        // Wait until the child has started its esbuild service and is blocked.
        expect(
          await waitFor(() => descendantsOf(childPid).length > 0, 10_000),
        ).toBe(true);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        const grandchildren = descendantsOf(childPid);
        recordedChild = childPid;
        recordedGrandchildren = grandchildren;
        expect(alive(childPid)).toBe(true);

        process.kill(parentPid, 'SIGKILL');

        expect(await waitFor(() => !alive(childPid), 5_000)).toBe(true);
        expect(
          await waitFor(() => grandchildren.every((pid) => !alive(pid)), 5_000),
        ).toBe(true);
      } finally {
        // Clean up only what this test recorded spawning, if a regression
        // left it running (the child leads its own group).
        killRecorded([parentPid, ...recordedGrandchildren]);
        if (recordedChild !== undefined) killRecordedGroup(recordedChild);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'dispose() mid-build stops the build child at once, not at its deadline',
    async () => {
      const dir = blockingPlugin();
      const service = new PluginDraftService({
        draftsRoot: join(tempDir('station-draft-proc-home-'), 'plugin-drafts'),
        emitRebuilt: () => {},
        buildTimeoutMs: 60_000,
        pollIntervalMs: 60_000,
      });
      const before = new Set(descendantsOf(process.pid));
      service.lease('proc', dir);
      expect(
        await waitFor(
          () => descendantsOf(process.pid).some((pid) => !before.has(pid)),
          10_000,
        ),
      ).toBe(true);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      const spawned = descendantsOf(process.pid).filter(
        (pid) => !before.has(pid),
      );
      const started = Date.now();
      try {
        service.dispose();
        expect(
          await waitFor(() => spawned.every((pid) => !alive(pid)), 5_000),
        ).toBe(true);
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        for (const pid of spawned) killRecordedGroup(pid);
        killRecorded(spawned);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Round 4 LOW: the child gets a minimal environment, never the server's
  // provider keys. Read from the running child's own environment, found by
  // the pid this test recorded.
  test(
    'the build child does not inherit the server environment',
    async () => {
      const sentinel = 'STATION_DRAFT_TEST_SECRET';
      process.env[sentinel] = 'sk-sentinel-value';
      try {
        expect(draftBuildChildEnv()).not.toHaveProperty(sentinel);
        const dir = blockingPlugin();
        const controller = new AbortController();
        let pid: number | undefined;
        const building = buildPluginDraftInChildProcess(
          {
            pluginDir: dir,
            outdir: join(tempDir('station-draft-proc-out-'), '1'),
            registrationKey: 'k:1',
            manifest,
            signal: controller.signal,
          },
          { onSpawn: (spawned) => (pid = spawned) },
        );
        expect(await waitFor(() => pid !== undefined)).toBe(true);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        const environment =
          process.platform === 'linux'
            ? execFileSync('cat', [`/proc/${pid}/environ`], {
                encoding: 'utf8',
                windowsHide: true,
              })
            : execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], {
                encoding: 'utf8',
                windowsHide: true,
              });
        // The probe can see the environment at all (PATH is passed on).
        expect(environment).toContain('PATH=');
        expect(environment).not.toContain(sentinel);
        expect(environment).not.toContain('sk-sentinel-value');
        controller.abort();
        await building;
      } finally {
        delete process.env[sentinel];
      }
    },
    TEST_TIMEOUT_MS,
  );
});
