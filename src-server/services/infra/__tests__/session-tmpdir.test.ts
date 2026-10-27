import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { HostImageTurnCapture } from '../../orchestration/host-image-turn-capture.js';
import {
  engineSessionTmpDir,
  installSessionTmpDirPolicy,
  noteEngineTmpDir,
  reapStaleSessionTmpDirs,
  removeSessionTmpDir,
  sessionTempRoot,
  sessionTmpDirPath,
  sessionTmpRoot,
} from '../session-tmpdir.js';

const makeTempDir = trackTempDirs();

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
    const dir = engineSessionTmpDir('thread/../with:odd chars');
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
    expect(engineSessionTmpDir('loose')).toBe(loose);
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
    noteEngineTmpDir('confined', confined);
    expect(sessionTempRoot('confined')).toBeUndefined();
    uninstall = installSessionTmpDirPolicy(() => true);
    noteEngineTmpDir('confined', confined);
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
    const dir = engineSessionTmpDir('thread-exit')!;
    writeFileSync(join(dir, 'shot.png'), 'x');
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
