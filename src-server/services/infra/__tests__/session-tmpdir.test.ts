import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { HostImageTurnCapture } from '../../orchestration/host-image-turn-capture.js';
import {
  engineSessionTmpDir,
  existingSessionTmpDir,
  installSessionTmpDirPolicy,
  reapStaleSessionTmpDirs,
  removeSessionTmpDir,
  sessionTmpDirPath,
  sessionTmpRoot,
} from '../session-tmpdir.js';

describe('per-session engine TMPDIR (chat-host-images)', () => {
  let home: string;
  let previousHome: string | undefined;
  let uninstall: (() => void) | undefined;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'session-tmpdir-')));
    previousHome = process.env.STATION_HOME;
    process.env.STATION_HOME = home;
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    if (previousHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
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
    expect(existingSessionTmpDir('thread/../with:odd chars')).toBe(dir);
    removeSessionTmpDir('thread/../with:odd chars');
    expect(existsSync(dir!)).toBe(false);
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
