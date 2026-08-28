import { beforeEach, describe, expect, test, vi } from 'vitest';

const platformMock = vi.hoisted(() => vi.fn(() => 'darwin'));
const existsSyncMock = vi.hoisted(() =>
  vi.fn((_path: string): boolean => false),
);

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: platformMock,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
}));
// archive#977: keep this file hermetic -- cli-auth.ts's module-load-time
// login-shell resolve would otherwise spawn a real shell subprocess during
// this file's import. These tests only care about process.env.PATH
// ordering, so the login-shell portion is disabled outright.
vi.stubEnv('STATION_DISABLE_LOGIN_PATH_RESOLVE', '1');

const { findCliBinary } = await import('../cli-auth.js');

describe('findCliBinary', () => {
  beforeEach(() => {
    existsSyncMock.mockReset().mockImplementation(() => false);
    platformMock.mockReturnValue('darwin');
  });

  test('splits PATH on ":" on POSIX and returns the first hit', () => {
    vi.stubEnv('PATH', '/usr/local/bin:/opt/tools/bin');
    existsSyncMock.mockImplementation(
      (candidate) => candidate === '/opt/tools/bin/opencode',
    );

    expect(findCliBinary('opencode')).toBe('/opt/tools/bin/opencode');
    // The POSIX delimiter must not be ';' — a single entry, not two.
    expect(
      existsSyncMock.mock.calls.some(([candidate]) =>
        String(candidate).includes(':'),
      ),
    ).toBe(false);
    vi.unstubAllEnvs();
  });

  test('splits PATH on ";" on Windows and probes executable suffixes', () => {
    platformMock.mockReturnValue('win32');
    vi.stubEnv('PATH', 'C:\\one;C:\\two');
    existsSyncMock.mockImplementation(
      (candidate) => candidate === 'C:\\two/kiro-cli.exe',
    );

    expect(findCliBinary('kiro-cli')).toBe('C:\\two/kiro-cli.exe');
    // Splitting on ':' instead would produce a single mangled dir containing
    // ';' — assert no probed candidate ever contains the ';' delimiter.
    expect(
      existsSyncMock.mock.calls.some(([candidate]) =>
        String(candidate).includes(';'),
      ),
    ).toBe(false);
    vi.unstubAllEnvs();
  });

  test('returns null when nothing on PATH matches', () => {
    vi.stubEnv('PATH', '/usr/local/bin');
    expect(findCliBinary('missing-tool')).toBeNull();
    vi.unstubAllEnvs();
  });

  // archive#766: an ACP connection configured with a fully qualified command
  // (the only spelling that works for a version-manager install) probed
  // AVAILABLE while `chat` refused with "prerequisites missing: CLI, login",
  // because this search joined the absolute path onto each PATH dir.
  test('an absolute command resolves to itself, never a PATH join', () => {
    vi.stubEnv('PATH', '/usr/local/bin');
    const absolute = '/opt/engines/opencode-ai/bin/opencode.exe';
    existsSyncMock.mockImplementation((candidate) => candidate === absolute);

    expect(findCliBinary(absolute)).toBe(absolute);
    expect(
      existsSyncMock.mock.calls.some(([candidate]) =>
        String(candidate).startsWith('/usr/local/bin/'),
      ),
    ).toBe(false);
    vi.unstubAllEnvs();
  });

  test('an absolute command that does not exist is null, not a PATH fallback', () => {
    vi.stubEnv('PATH', '/usr/local/bin');
    // A same-named binary IS on PATH: resolving to it would launch a
    // different program than the one the connection names.
    existsSyncMock.mockImplementation(
      (candidate) => candidate === '/usr/local/bin/opencode.exe',
    );

    expect(findCliBinary('/opt/engines/opencode.exe')).toBeNull();
    vi.unstubAllEnvs();
  });

  test('a ~/ command expands before the absolute check (station#3155)', () => {
    vi.stubEnv('PATH', '/usr/local/bin');
    vi.stubEnv('HOME', '/Users/tester');
    existsSyncMock.mockImplementation(
      (candidate) => candidate === '/Users/tester/bin/agent',
    );

    expect(findCliBinary('~/bin/agent')).toBe('/Users/tester/bin/agent');
    vi.unstubAllEnvs();
  });
});
