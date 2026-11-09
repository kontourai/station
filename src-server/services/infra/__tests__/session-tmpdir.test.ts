import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { HostImageTurnCapture } from '../../orchestration/host-image-turn-capture.js';
import {
  commitEngineLaunch,
  engineSessionTmpDir,
  installSessionTmpDirPolicy,
  launchedRootOf,
  ownedDirTestHooks,
  reapStaleSessionTmpDirs,
  removeLaunchedRoot,
  removeSessionTmpDir,
  SESSION_TMPDIR_MAX_BYTES,
  sessionTempRoot,
  sessionTmpDirPath,
  sessionTmpDirTestHooks,
  sessionTmpRoot,
  shortSessionTmpRoots,
  stampLaunchExit,
} from '../session-tmpdir.js';

const makeTempDir = trackTempDirs();

/** What a spawning adapter does: prepare the folder, start, then commit. */
function launch(threadId: string): string | undefined {
  const dir = engineSessionTmpDir(threadId);
  commitEngineLaunch(threadId, dir ? { own: dir } : undefined);
  return dir;
}

function launchConfined(threadId: string, dir: string): void {
  commitEngineLaunch(threadId, { confined: dir });
}

describe('per-session engine TMPDIR (chat-host-images)', () => {
  let home: string;
  let previousHome: string | undefined;
  let uninstall: (() => void) | undefined;

  beforeEach(() => {
    home = realpathSync(makeTempDir('session-tmpdir-'));
    previousHome = process.env.STATION_HOME;
    process.env.STATION_HOME = home;
    // These cases cover the in-home root; the short roots are covered below.
    sessionTmpDirTestHooks.shortBases = () => [];
  });

  afterEach(() => {
    sessionTmpDirTestHooks.shortBases = undefined;
    uninstall?.();
    uninstall = undefined;
    if (previousHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = previousHome;
  });

  test('no policy, or a policy that refuses, leaves the shared directory in place', () => {
    expect(engineSessionTmpDir('thread-a')).toBeUndefined();
    uninstall = installSessionTmpDirPolicy(() => false);
    expect(engineSessionTmpDir('thread-a')).toBeUndefined();
    expect(existsSync(sessionTmpRoot(home))).toBe(false);
  });

  test('an admitted session gets an owner-only directory named for this process and a digest of the thread', () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    const dir = launch('thread/../with:odd chars');
    expect(dir).toBe(sessionTmpDirPath('thread/../with:odd chars', home));
    expect(basename(dir!)).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{16}$`));
    expect(statSync(dir!).mode & 0o777).toBe(0o700);
    expect(sessionTempRoot('thread/../with:odd chars')).toBe(dir);
    removeSessionTmpDir('thread/../with:odd chars');
    expect(existsSync(dir!)).toBe(false);
  });

  test('an existing directory is tightened to 0700; a link in its place is refused', () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    const loose = sessionTmpDirPath('loose', home);
    mkdirSync(loose, { recursive: true, mode: 0o755 });
    chmodSync(loose, 0o755);
    expect(launch('loose')).toBe(loose);
    expect(statSync(loose).mode & 0o777).toBe(0o700);
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, sessionTmpDirPath('linked', home));
    expect(engineSessionTmpDir('linked')).toBeUndefined();
    expect(sessionTempRoot('linked')).toBeUndefined();
  });

  test('a confinement own TMPDIR is a root only while admitted, and its owner removes it', () => {
    const confined = join(home, 'confined-session');
    mkdirSync(confined, { mode: 0o700 });
    launchConfined('confined', confined);
    expect(sessionTempRoot('confined')).toBeUndefined();
    uninstall = installSessionTmpDirPolicy(() => true);
    launchConfined('confined', confined);
    expect(sessionTempRoot('confined')).toBe(confined);
    removeSessionTmpDir('confined');
    expect(sessionTempRoot('confined')).toBeUndefined();
    expect(existsSync(confined)).toBe(true);
  });

  test('a session that never launched with a root has none', () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    mkdirSync(sessionTmpDirPath('not-launched', home), {
      recursive: true,
      mode: 0o700,
    });
    expect(sessionTempRoot('not-launched')).toBeUndefined();
  });

  test('a removal queued for one launch leaves a later launch of the same thread alone', () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    const first = launch('restarted')!;
    const exited = launchedRootOf('restarted');
    // The thread restarts before the removal for the first launch runs.
    const second = launch('restarted')!;
    expect(second).toBe(first);
    writeFileSync(join(second, 'live.png'), 'x');
    removeLaunchedRoot('restarted', exited);
    expect(existsSync(join(second, 'live.png'))).toBe(true);
    expect(sessionTempRoot('restarted')).toBe(second);
  });

  test('exit, restart, then the late removal behind an in-flight capture: the live folder survives', async () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    const workspace = makeTempDir('session-tmpdir-ws-');
    writeFileSync(join(workspace, 'shot.png'), 'not really an image');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = new HostImageTurnCapture({
      preview: { select: (branches) => branches.enabled() },
      eventStore: {
        listTurnEventsByMethods: () =>
          [
            {
              payload: {
                method: 'content.text-delta',
                itemId: 'i',
                delta: `![x](${join(workspace, 'shot.png')})`,
              },
            },
          ] as never,
        resolveEventContent: (events) => events as never,
      },
      sessionCwd: () => workspace,
      publish: () => {},
      logger: { warn: () => {} },
      hooks: { beforeOpen: () => gate },
    });
    launch('late');
    const base = {
      provider: 'codex' as const,
      threadId: 'late',
      createdAt: new Date().toISOString(),
    };
    capture.observe({
      ...base,
      eventId: 'done',
      method: 'turn.completed',
      turnId: 't1',
    });
    // The adapter publishes the exit (stamping its launch), then Station observes it.
    stampLaunchExit({
      method: 'session.exited',
      eventId: 'exit',
      threadId: 'late',
    });
    capture.observe({
      ...base,
      eventId: 'exit',
      method: 'session.exited',
      sessionId: 'late',
    });
    const restarted = launch('late')!;
    writeFileSync(join(restarted, 'live.png'), 'x');
    release();
    await capture.settled();
    expect(existsSync(join(restarted, 'live.png'))).toBe(true);
    expect(sessionTempRoot('late')).toBe(restarted);
  });

  test('an exit Station observes only after the thread restarted removes nothing of the new launch', async () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    launch('delayed');
    // The adapter publishes the exit of launch 1 ...
    stampLaunchExit({
      method: 'session.exited',
      eventId: 'exit-1',
      threadId: 'delayed',
    });
    // ... the thread restarts (same path) before Station gets to observe it ...
    const restarted = launch('delayed')!;
    writeFileSync(join(restarted, 'live.png'), 'x');
    const capture = new HostImageTurnCapture({
      preview: { select: (branches) => branches.disabled() },
      eventStore: undefined,
      sessionCwd: () => undefined,
      publish: () => {},
      logger: { warn: () => {} },
    });
    // ... and only then does Station observe the exit.
    capture.observe({
      eventId: 'exit-1',
      provider: 'codex',
      threadId: 'delayed',
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      sessionId: 'delayed',
    });
    await capture.settled();
    expect(existsSync(join(restarted, 'live.png'))).toBe(true);
    expect(sessionTempRoot('delayed')).toBe(restarted);
  });

  test('a launch that gets no root clears the record; the previous folder goes when that launch ends', () => {
    let on = true;
    uninstall = installSessionTmpDirPolicy(() => on);
    const first = launch('relaunch')!;
    const firstLaunch = launchedRootOf('relaunch');
    on = false;
    expect(launch('relaunch')).toBeUndefined();
    expect(sessionTempRoot('relaunch')).toBeUndefined();
    // Not at replacement: the first engine may still be draining.
    expect(existsSync(first)).toBe(true);
    removeLaunchedRoot('relaunch', firstLaunch);
    expect(existsSync(first)).toBe(false);
  });

  test('preparing a folder for a start that never commits changes nothing', () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    const live = launch('failed-start')!;
    const liveLaunch = launchedRootOf('failed-start');
    writeFileSync(join(live, 'live.png'), 'x');
    // A restart prepares (same path) and then throws before committing.
    engineSessionTmpDir('failed-start');
    expect(launchedRootOf('failed-start')).toBe(liveLaunch);
    expect(existsSync(join(live, 'live.png'))).toBe(true);
  });

  test('a confined restart replaces an own folder, which goes only when its own launch ends', () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    const own = launch('confined-restart')!;
    const ownLaunch = launchedRootOf('confined-restart');
    const confined = join(home, 'confined-launch');
    mkdirSync(confined, { mode: 0o700 });
    launchConfined('confined-restart', confined);
    // The old engine may still be draining after a stop dropped its record.
    expect(existsSync(own)).toBe(true);
    expect(sessionTempRoot('confined-restart')).toBe(confined);
    removeLaunchedRoot('confined-restart', ownLaunch);
    expect(existsSync(own)).toBe(false);
    expect(sessionTempRoot('confined-restart')).toBe(confined);
    // A confinement folder that fails the ownership check clears the record.
    const linked = join(home, 'confined-linked');
    symlinkSync(confined, linked);
    launchConfined('confined-restart', linked);
    expect(sessionTempRoot('confined-restart')).toBeUndefined();
    expect(existsSync(confined)).toBe(true);
  });

  test('the mode is tightened on the folder itself, never through a link to another', () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    const target = join(home, 'open-target');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    mkdirSync(sessionTmpRoot(home), { recursive: true });
    symlinkSync(target, sessionTmpDirPath('via-link', home));
    expect(engineSessionTmpDir('via-link')).toBeUndefined();
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  test('a folder swapped after it was opened is refused (identity re-confirmed)', () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    const dir = sessionTmpDirPath('swapped', home);
    ownedDirTestHooks.afterOpen = (opened) => {
      if (opened !== dir) return;
      renameSync(dir, `${dir}-moved`);
      mkdirSync(dir, { mode: 0o700 });
    };
    try {
      expect(engineSessionTmpDir('swapped')).toBeUndefined();
    } finally {
      ownedDirTestHooks.afterOpen = undefined;
    }
  });

  test('a policy that throws never blocks a start', () => {
    uninstall = installSessionTmpDirPolicy(() => {
      throw new Error('preview state unreadable');
    });
    expect(engineSessionTmpDir('thread-a')).toBeUndefined();
  });

  test('the sweep removes only directories whose owning process is gone', () => {
    const root = sessionTmpRoot(home);
    mkdirSync(root, { recursive: true });
    // An older Station's name, and the current one.
    const dead = join(root, `session-999999-${'a'.repeat(24)}`);
    const deadCurrent = join(root, `999998-${'d'.repeat(16)}`);
    const alive = join(root, `session-12345-${'b'.repeat(24)}`);
    const mine = join(root, `${process.pid}-${'c'.repeat(16)}`);
    const foreign = join(root, 'not-a-session');
    for (const dir of [dead, deadCurrent, alive, mine, foreign]) mkdirSync(dir);
    writeFileSync(join(dead, 'leftover.png'), 'x');
    const reaped = reapStaleSessionTmpDirs(home, {
      isAlive: (pid) => pid === 12345,
    });
    expect(reaped).toBe(2);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(deadCurrent)).toBe(false);
    expect([alive, mine, foreign].every((dir) => existsSync(dir))).toBe(true);
  });

  test('a session exit removes its directory, after a capture still reading it', async () => {
    uninstall = installSessionTmpDirPolicy(() => true);
    const dir = launch('thread-exit')!;
    writeFileSync(join(dir, 'shot.png'), 'x');
    stampLaunchExit({
      method: 'session.exited',
      eventId: 'exit',
      threadId: 'thread-exit',
    });
    const capture = new HostImageTurnCapture({
      preview: { select: (branches) => branches.disabled() },
      eventStore: undefined,
      sessionCwd: () => undefined,
      publish: () => {},
      logger: { warn: () => {} },
    });
    capture.observe({
      eventId: 'exit',
      provider: 'codex',
      threadId: 'thread-exit',
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      sessionId: 'thread-exit',
    });
    await capture.settled();
    expect(existsSync(dir)).toBe(false);
  });
});

/**
 * The engine's TMPDIR is where agents' tools put Unix sockets, whose paths
 * `sun_path` caps at 104 bytes (macOS) or 108 (Linux), NUL included.
 */
describe.skipIf(process.platform === 'win32')(
  'per-session engine TMPDIR socket-path budget',
  () => {
    let previousHome: string | undefined;
    let uninstall: (() => void) | undefined;
    // Under the system /tmp so a test-owned root fits the budget; removed
    // after each test whether it passed or not.
    const makeShortDir = trackTempDirs({ base: '/tmp' });

    /** A short base under the system /tmp, so a test-owned root fits. */
    function shortBase(): string {
      return realpathSync(makeShortDir('st'));
    }

    function withHome(dir: string): string {
      mkdirSync(dir, { recursive: true });
      process.env.STATION_HOME = dir;
      return dir;
    }

    /** A realistic long home: a macOS-style data folder and a named instance. */
    function longHome(): string {
      return withHome(
        join(
          realpathSync(makeTempDir('session-tmpdir-long-')),
          'Users',
          'firstname.lastname',
          'Library',
          'Application Support',
          'Station',
          'instances',
          'workstation-review',
        ),
      );
    }

    beforeEach(() => {
      previousHome = process.env.STATION_HOME;
      uninstall = installSessionTmpDirPolicy(() => true);
    });

    afterEach(() => {
      sessionTmpDirTestHooks.shortBases = undefined;
      uninstall?.();
      uninstall = undefined;
      if (previousHome === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previousHome;
    });

    test('a long STATION_HOME still gets a TMPDIR that leaves 40 bytes under the macOS socket limit', () => {
      const home = longHome();
      const thread = 'thread-long-home';
      // Baseline: the home layout alone is far over budget.
      const inHome = join(
        sessionTmpRoot(home),
        `${process.pid}-${'0'.repeat(16)}`,
      );
      expect(Buffer.byteLength(inHome)).toBeGreaterThan(
        SESSION_TMPDIR_MAX_BYTES,
      );
      // The real roots (this process's temp directory, else /tmp).
      const dir = launch(thread)!;
      try {
        expect(dir).toBe(sessionTmpDirPath(thread, home));
        expect(SESSION_TMPDIR_MAX_BYTES).toBe(64);
        expect(Buffer.byteLength(dir)).toBeLessThanOrEqual(
          SESSION_TMPDIR_MAX_BYTES,
        );
        expect(shortSessionTmpRoots()).toContain(dirname(dir));
        expect(dir.startsWith(home)).toBe(false);
        for (const owned of [dir, dirname(dir)]) {
          const stats = lstatSync(owned);
          expect(stats.isDirectory() && !stats.isSymbolicLink()).toBe(true);
          expect(stats.mode & 0o777).toBe(0o700);
          expect(stats.uid).toBe(process.getuid!());
        }
        expect(sessionTempRoot(thread)).toBe(dir);
      } finally {
        removeSessionTmpDir(thread);
      }
      expect(existsSync(dir)).toBe(false);
    });

    test('a Unix socket listens at the full budget inside the TMPDIR a long home gets', async () => {
      longHome();
      const thread = 'thread-socket';
      const dir = launch(thread)!;
      try {
        // tsx's IPC pipe, the path that failed with EINVAL ...
        const tsxDir = join(dir, `tsx-${process.getuid!()}`);
        mkdirSync(tsxDir);
        // ... and a name using every byte the budget leaves (103 + NUL = 104).
        const widest = join(dir, 'x'.repeat(103 - Buffer.byteLength(dir) - 1));
        expect(Buffer.byteLength(widest)).toBe(103);
        for (const path of [join(tsxDir, '4194304.pipe'), widest]) {
          const server = createServer();
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(path, resolve);
          });
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } finally {
        removeSessionTmpDir(thread);
      }
    });

    test('a short STATION_HOME keeps the directory in its own tmp tree', () => {
      const home = withHome(shortBase());
      sessionTmpDirTestHooks.shortBases = () => [shortBase()];
      const dir = launch('thread-short-home')!;
      expect(dir).toBe(
        join(
          sessionTmpRoot(home),
          basename(sessionTmpDirPath('thread-short-home', home)),
        ),
      );
      expect(Buffer.byteLength(dir)).toBeLessThanOrEqual(
        SESSION_TMPDIR_MAX_BYTES,
      );
      removeSessionTmpDir('thread-short-home');
    });

    test('a short root that is a link, or not private to this user, is passed over', () => {
      const home = longHome();
      const base = shortBase();
      sessionTmpDirTestHooks.shortBases = () => [base];
      const [root] = shortSessionTmpRoots();
      const elsewhere = shortBase();
      symlinkSync(elsewhere, root!);
      const dir = launch('thread-linked-root')!;
      // The over-budget home path, never a folder through the planted link.
      expect(dir.startsWith(sessionTmpRoot(home))).toBe(true);
      expect(readdirSync(elsewhere)).toEqual([]);
      removeSessionTmpDir('thread-linked-root');
      // A real root is re-tightened to 0700 and then used.
      rmSync(root!);
      mkdirSync(root!, { mode: 0o755 });
      chmodSync(root!, 0o755);
      const tightened = launch('thread-loose-root')!;
      expect(dirname(tightened)).toBe(root);
      expect(statSync(root!).mode & 0o777).toBe(0o700);
      removeSessionTmpDir('thread-loose-root');
    });

    test('the sweep reaps a short root by owner process, and never through a link', () => {
      longHome();
      const base = shortBase();
      sessionTmpDirTestHooks.shortBases = () => [base];
      const [root] = shortSessionTmpRoots();
      mkdirSync(root!, { mode: 0o700 });
      const dead = join(root!, `999999-${'a'.repeat(16)}`);
      const alive = join(root!, `12345-${'b'.repeat(16)}`);
      const legacyName = join(root!, `session-999997-${'c'.repeat(24)}`);
      for (const dir of [dead, alive, legacyName]) mkdirSync(dir);
      const isAlive = (pid: number) => pid === 12345;
      expect(reapStaleSessionTmpDirs(undefined, { isAlive })).toBe(1);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(alive) && existsSync(legacyName)).toBe(true);
      // A root that resolves elsewhere is not swept.
      const linkedBase = shortBase();
      const target = shortBase();
      const victim = join(target, `999999-${'e'.repeat(16)}`);
      mkdirSync(victim);
      symlinkSync(target, join(linkedBase, basename(root!)));
      sessionTmpDirTestHooks.shortBases = () => [linkedBase];
      // realpath of the base is taken, but the root itself is the link.
      expect(reapStaleSessionTmpDirs(undefined, { isAlive })).toBe(0);
      expect(existsSync(victim)).toBe(true);
    });
  },
);
