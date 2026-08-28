import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * archive#977: dedicated coverage for the login-shell PATH fallback. Each
 * test resets modules and re-imports cli-auth.ts fresh so the
 * module-level "resolve once per process lifetime" cache never leaks
 * between tests -- every test gets its own resolution.
 */

const platformMock = vi.hoisted(() => vi.fn(() => 'darwin'));
const existsSyncMock = vi.hoisted(() =>
  vi.fn((_path: string): boolean => false),
);
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: platformMock,
  homedir: () => '/home/test-user',
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

const SENTINEL_START = '__STATION_LOGIN_PATH_START_7f3a9c__';
const SENTINEL_END = '__STATION_LOGIN_PATH_END_7f3a9c__';

/**
 * Resolves the mocked execFile call with a successful login-shell PATH,
 * sentinel-wrapped exactly as the real -ic capture produces it. `noise`
 * simulates banner/prompt/rc-file stdout an interactive shell can emit
 * around the sentinel-wrapped payload.
 */
function resolveLoginPathWith(pathValue: string, noise = '') {
  const stdout = `${noise}${SENTINEL_START}${pathValue}${SENTINEL_END}${noise}`;
  execFileMock.mockImplementation((_file, _args, _opts, callback) => {
    callback(null, { stdout, stderr: '' });
  });
}

/** Rejects the mocked execFile call, simulating a missing shell/timeout. */
function rejectLoginPathResolve() {
  execFileMock.mockImplementation((_file, _args, _opts, callback) => {
    callback(new Error('mock: login shell unavailable'));
  });
}

/** Resolves with UNWRAPPED stdout -- no sentinels at all (e.g. a shell that
 * ran but never reached our printf, or an incompatible -ic environment). */
function resolveLoginPathWithoutSentinels(stdout: string) {
  execFileMock.mockImplementation((_file, _args, _opts, callback) => {
    callback(null, { stdout, stderr: '' });
  });
}

describe('login-shell PATH fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    platformMock.mockReturnValue('darwin');
    existsSyncMock.mockReset().mockImplementation(() => false);
    execFileMock.mockReset();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('findCliBinary finds a command only on the login-shell PATH, not on process.env.PATH', async () => {
    vi.stubEnv('PATH', '/usr/bin');
    resolveLoginPathWith('/opt/nix/bin');
    existsSyncMock.mockImplementation(
      (candidate) => candidate === '/opt/nix/bin/codex',
    );

    const { resolveAugmentedPath, findCliBinary } = await import(
      '../cli-auth.js'
    );
    await resolveAugmentedPath();

    expect(findCliBinary('codex')).toBe('/opt/nix/bin/codex');
  });

  test('precedence: a command on both process.env.PATH and the login PATH resolves from process.env.PATH first', async () => {
    vi.stubEnv('PATH', '/usr/bin:/opt/tools/bin');
    resolveLoginPathWith('/opt/nix/bin');
    existsSyncMock.mockImplementation(
      (candidate) =>
        candidate === '/opt/tools/bin/codex' ||
        candidate === '/opt/nix/bin/codex',
    );

    const { resolveAugmentedPath, findCliBinary } = await import(
      '../cli-auth.js'
    );
    await resolveAugmentedPath();

    expect(findCliBinary('codex')).toBe('/opt/tools/bin/codex');
  });

  test('degrades to process.env.PATH alone when the login shell resolve fails, without throwing', async () => {
    vi.stubEnv('PATH', '/usr/bin');
    rejectLoginPathResolve();
    existsSyncMock.mockImplementation(
      (candidate) => candidate === '/usr/bin/codex',
    );

    const { resolveAugmentedPath, findCliBinary, resolveLoginShellPath } =
      await import('../cli-auth.js');

    await expect(resolveLoginShellPath()).resolves.toBe('');
    await resolveAugmentedPath();

    expect(findCliBinary('codex')).toBe('/usr/bin/codex');
  });

  test('the opt-out flag disables the login-PATH search entirely', async () => {
    vi.stubEnv('PATH', '/usr/bin');
    vi.stubEnv('STATION_DISABLE_LOGIN_PATH_RESOLVE', '1');
    resolveLoginPathWith('/opt/nix/bin');
    existsSyncMock.mockImplementation(
      (candidate) => candidate === '/opt/nix/bin/codex',
    );

    const { resolveAugmentedPath, findCliBinary } = await import(
      '../cli-auth.js'
    );
    const combined = await resolveAugmentedPath();

    expect(combined).toBe('/usr/bin');
    expect(findCliBinary('codex')).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // archive#977 review HIGH: -ic (interactive) can print a MOTD/banner,
  // a prompt fragment, or rc-file echo/debug output to stdout around the
  // captured PATH. The sentinel extraction must pull out exactly the PATH
  // between the two markers and ignore everything else.
  test('extracts the PATH from between sentinels, ignoring banner/prompt noise', async () => {
    vi.stubEnv('PATH', '/usr/bin');
    resolveLoginPathWith(
      '/opt/nix/bin:/opt/nix/sbin',
      'Last login: Mon Jan 1 00:00:00\nwelcome-message-line\n$ ',
    );
    existsSyncMock.mockImplementation(
      (candidate) => candidate === '/opt/nix/bin/codex',
    );

    const { resolveLoginShellPath, resolveAugmentedPath, findCliBinary } =
      await import('../cli-auth.js');

    await expect(resolveLoginShellPath()).resolves.toBe(
      '/opt/nix/bin:/opt/nix/sbin',
    );
    await resolveAugmentedPath();
    expect(findCliBinary('codex')).toBe('/opt/nix/bin/codex');
  });

  test('degrades to empty when the shell output never contains the sentinels', async () => {
    vi.stubEnv('PATH', '/usr/bin');
    resolveLoginPathWithoutSentinels('/opt/nix/bin (no sentinels here)');

    const { resolveLoginShellPath } = await import('../cli-auth.js');

    await expect(resolveLoginShellPath()).resolves.toBe('');
  });

  // archive#977 review disclosed gap: the sync findCliBinary can observe a
  // cold cache (resolution still in flight) and report "missing" on that
  // one call; it self-heals once resolution lands.
  test('cold-cache: the first sync call can miss a login-PATH-only command, then self-heals', async () => {
    vi.stubEnv('PATH', '/usr/bin');
    let releaseExecFile!: (value: unknown) => void;
    execFileMock.mockImplementation((_file, _args, _opts, callback) => {
      new Promise((resolve) => {
        releaseExecFile = resolve;
      }).then(() => {
        callback(null, {
          stdout: `${SENTINEL_START}/opt/nix/bin${SENTINEL_END}`,
          stderr: '',
        });
      });
    });
    existsSyncMock.mockImplementation(
      (candidate) => candidate === '/opt/nix/bin/codex',
    );

    const { findCliBinary, resolveAugmentedPath } = await import(
      '../cli-auth.js'
    );

    // First call kicks off resolution but reads the cold cache -- misses.
    expect(findCliBinary('codex')).toBeNull();

    releaseExecFile(undefined);
    await resolveAugmentedPath();

    // Second call sees the now-resolved login PATH -- self-heals.
    expect(findCliBinary('codex')).toBe('/opt/nix/bin/codex');
  });
});
