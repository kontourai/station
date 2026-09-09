import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createDesktopCompanion,
  launchDesktopCompanion,
  readDesktopCompanion,
} from '../commands/desktop-companion.js';

const homes: string[] = [];
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'station-tray-test-')));
  homes.push(home);
  mkdirSync(join(home, 'runtime'), { mode: 0o700 });
  const registration = {
    version: 1 as const,
    enabled: true,
    executable: realpathSync(process.execPath),
    pid: 9876543,
    birth: 'original-birth',
  };
  const path = join(home, 'runtime/desktop-companion.json');
  writeFileSync(path, JSON.stringify(registration), { mode: 0o600 });
  return { home, path, registration };
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('desktop companion supervision', () => {
  test('a headless installation does not launch any desktop app', () => {
    const launch = vi.fn();
    const read = vi.fn().mockReturnValue(null);
    createDesktopCompanion('/unused', {
      read,
      launch,
      graphicalSession: () => true,
    }).check();
    expect(launch).not.toHaveBeenCalled();
  });
  test('a service outside a graphical session does not even inspect app registration', () => {
    const read = vi.fn();
    createDesktopCompanion('/unused', {
      read,
      graphicalSession: () => false,
    }).check();
    expect(read).not.toHaveBeenCalled();
  });
  test('the registered app is restored after exit, without scanning or guessing an app channel', () => {
    const { registration } = fixture();
    const launch = vi.fn();
    createDesktopCompanion('/unused', {
      read: () => registration,
      birth: () => null,
      alive: () => false,
      launch,
      graphicalSession: () => true,
    }).check();
    expect(launch).toHaveBeenCalledExactlyOnceWith(registration.executable);
  });
  test.each(['same', 'unavailable'] as const)(
    'does not duplicate an existing app when process identity is %s',
    (kind) => {
      const { registration } = fixture();
      const launch = vi.fn();
      createDesktopCompanion('/unused', {
        read: () => registration,
        birth: () => (kind === 'same' ? registration.birth : null),
        alive: () => true,
        launch,
        graphicalSession: () => true,
      }).check();
      expect(launch).not.toHaveBeenCalled();
    },
  );
  test('PID reuse does not make a missing app look alive', () => {
    const { registration } = fixture();
    const launch = vi.fn();
    createDesktopCompanion('/unused', {
      read: () => registration,
      birth: () => 'different-birth',
      alive: () => true,
      launch,
      graphicalSession: () => true,
    }).check();
    expect(launch).toHaveBeenCalledOnce();
  });
  test('honors explicit tray quit and backs off failed startup attempts', () => {
    const { registration } = fixture();
    const launch = vi.fn();
    let now = 0;
    const companion = createDesktopCompanion('/unused', {
      read: () => registration,
      birth: () => null,
      alive: () => false,
      launch,
      now: () => now,
      graphicalSession: () => true,
    });
    companion.check();
    companion.check();
    expect(launch).toHaveBeenCalledTimes(1);
    now = 30_000;
    companion.check();
    expect(launch).toHaveBeenCalledTimes(2);
    registration.enabled = false;
    now = 600_000;
    companion.check();
    expect(launch).toHaveBeenCalledTimes(2);
  });
  test('a deliberate quit pauses only the current service run', () => {
    const { registration } = fixture();
    const paused = {
      ...registration,
      enabled: false,
      pausedForService: 'service-one',
    };
    const launch = vi.fn();
    let serviceBirth: string | null = 'service-one';
    const companion = createDesktopCompanion('/unused', {
      read: () => paused,
      birth: () => null,
      alive: () => false,
      launch,
      graphicalSession: () => true,
      serviceBirth: () => serviceBirth,
    });
    companion.check();
    expect(launch).not.toHaveBeenCalled();
    serviceBirth = null;
    companion.check();
    expect(launch).not.toHaveBeenCalled();
    serviceBirth = 'service-two';
    companion.check();
    expect(launch).toHaveBeenCalledOnce();
  });

  test('malformed registration never stops the service or invokes an executable', () => {
    const launch = vi.fn();
    const warn = vi.fn();
    const companion = createDesktopCompanion('/unused', {
      read: () => {
        throw new Error('invalid');
      },
      launch,
      warn,
      graphicalSession: () => true,
    });
    expect(() => {
      companion.check();
      companion.check();
    }).not.toThrow();
    expect(launch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(process.platform === 'win32')('real companion launch', () => {
  test('starts the exact executable in tray-only mode with the selected service home', async () => {
    const { home } = fixture();
    const executable = join(home, 'desktop-test');
    const output = join(home, 'launch.json');
    writeFileSync(
      executable,
      `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2), home:process.env.STATION_HOME, root:process.env.STATION_ROOT}));
`,
      { mode: 0o700 },
    );
    const child = launchDesktopCompanion(
      executable,
      home,
      join(home, 'station-root'),
    );
    try {
      const [code] = await once(child, 'exit');
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
        args: ['--tray-only'],
        home,
        root: join(home, 'station-root'),
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    }
  });
});

describe.skipIf(process.platform === 'win32')(
  'private registration boundary',
  () => {
    test('accepts a private registration and treats an absent record as headless', () => {
      const { home, path, registration } = fixture();
      expect(readDesktopCompanion(home)).toEqual(registration);
      rmSync(path);
      expect(readDesktopCompanion(home)).toBeNull();
    });
    test('rejects public or symlinked registration files', () => {
      const { home, path } = fixture();
      chmodSync(path, 0o644);
      expect(() => readDesktopCompanion(home)).toThrow(/private/);
      rmSync(path);
      symlinkSync(join(home, 'elsewhere'), path);
      expect(() => readDesktopCompanion(home)).toThrow(/Invalid/);
    });
    test('rejects an executable that other users can modify', () => {
      const { home, path, registration } = fixture();
      const executable = join(home, 'app');
      writeFileSync(executable, 'test', { mode: 0o777 });
      chmodSync(executable, 0o777);
      writeFileSync(path, JSON.stringify({ ...registration, executable }));
      expect(() => readDesktopCompanion(home)).toThrow(/not trusted/);
    });
  },
);
