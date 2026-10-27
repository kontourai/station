import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
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
  sessionTempRoot,
  sessionTmpDirPath,
  sessionTmpRoot,
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
  });

  afterEach(() => {
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
    expect(basename(dir!)).toMatch(
      new RegExp(`^session-${process.pid}-[0-9a-f]{24}$`),
    );
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
    const dead = join(root, `session-999999-${'a'.repeat(24)}`);
    const alive = join(root, `session-12345-${'b'.repeat(24)}`);
    const mine = join(root, `session-${process.pid}-${'c'.repeat(24)}`);
    const foreign = join(root, 'not-a-session');
    for (const dir of [dead, alive, mine, foreign]) mkdirSync(dir);
    writeFileSync(join(dead, 'leftover.png'), 'x');
    const reaped = reapStaleSessionTmpDirs(home, {
      isAlive: (pid) => pid === 12345,
    });
    expect(reaped).toBe(1);
    expect(existsSync(dead)).toBe(false);
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
