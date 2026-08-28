import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * archive#1908: proves the REAL Codex `app-server` spawn call site
 * (`spawnCodexProcess`, reached via the exported `createCodexProcess` with
 * no `processFactory` override) hands the child a Station-owned TMPDIR --
 * covering the second of the three engine binaries named in the issue
 * (Claude Agent SDK, Codex, OpenCode/ACP).
 */
describe('createCodexProcess real spawn TMPDIR (station#1908)', () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), 'station-codex-tmpdir-home-'));
    priorHome = process.env.STATION_HOME;
    process.env.STATION_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
    vi.doUnmock('node:child_process');
    vi.doUnmock('../auth/cli-auth.js');
    vi.resetModules();
  });

  test('the spawned app-server process env.TMPDIR is Station-owned, not the ambient default', async () => {
    const spawnMock = vi.fn(
      (
        _binary: string,
        _args: string[],
        _options: { env: NodeJS.ProcessEnv },
      ) => new EventEmitter(),
    );
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    vi.doMock('../auth/cli-auth.js', () => ({
      findCliBinary: () => '/usr/local/bin/codex',
    }));

    const { createCodexProcess } = await import(
      '../adapters/codex-adapter-transport.js'
    );

    createCodexProcess(undefined, { CODEX_HOME: '/tmp/codex-profile' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnMock.mock.calls[0];
    expect(binary).toBe('/usr/local/bin/codex');
    expect(args).toEqual(['app-server']);
    expect(options.env.TMPDIR).toBe(join(home, 'tmp', 'engine-spawn'));
    // Caller-supplied env is preserved alongside the injected TMPDIR.
    expect(options.env.CODEX_HOME).toBe('/tmp/codex-profile');
  });
});
