import { describe, expect, test, vi } from 'vitest';

/**
 * station#766 review follow-up: `findCliBinaryAsync` must answer an ABSOLUTE
 * command without waiting on login-shell PATH resolution.
 *
 * Its caller is the ACP process spawn (`acp-process.ts`), and that wait is a
 * `$SHELL -ic` subprocess bounded at 5s -- half the ACP probe's 10s per-phase
 * deadline, spent resolving a PATH a fully qualified command never uses.
 *
 * This file is deliberately SEPARATE from `cli-auth-find-binary.test.ts`, which
 * stubs `STATION_DISABLE_LOGIN_PATH_RESOLVE=1` at module scope. Under that flag
 * the resolution short-circuits to a resolved promise, so an await-first
 * implementation passes just as happily as a short-circuiting one -- the
 * assertion cannot fail, and proves nothing. Here the flag is left OFF and the
 * login shell is mocked to NEVER settle, so awaiting it hangs the call: the
 * only way to return is to short-circuit before the await.
 */

const execFileMock = vi.hoisted(() =>
  // Never settles. An implementation that awaits login-path resolution before
  // answering can never resolve, and the test fails on the race below.
  vi.fn(() => new Promise<never>(() => {})),
);
const existsSyncMock = vi.hoisted(() =>
  vi.fn((_path: string): boolean => false),
);

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
}));

const { findCliBinaryAsync } = await import('../cli-auth.js');

const ABSOLUTE = '/opt/engines/opencode-ai/bin/opencode.exe';

describe('findCliBinaryAsync with login-path resolution outstanding', () => {
  test('answers an absolute command without awaiting the login shell', async () => {
    existsSyncMock.mockImplementation((candidate) => candidate === ABSOLUTE);

    const pending = Symbol('still-waiting-on-login-shell');
    const result = await Promise.race([
      findCliBinaryAsync(ABSOLUTE),
      // One macrotask is generous: the short-circuit is synchronous work.
      new Promise((resolve) => setTimeout(() => resolve(pending), 50)),
    ]);

    expect(result).toBe(ABSOLUTE);
  });

  test('an absolute command that is absent answers null, still without waiting', async () => {
    existsSyncMock.mockImplementation(() => false);

    const pending = Symbol('still-waiting-on-login-shell');
    const result = await Promise.race([
      findCliBinaryAsync(ABSOLUTE),
      new Promise((resolve) => setTimeout(() => resolve(pending), 50)),
    ]);

    // null, not the pending sentinel: an absolute miss is answered immediately
    // rather than falling through to a PATH search that needs the login shell.
    expect(result).toBeNull();
  });
});
