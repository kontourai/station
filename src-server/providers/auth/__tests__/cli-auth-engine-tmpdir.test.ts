import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { augmentedSpawnEnv } from '../cli-auth.js';

/**
 * archive#1908: `augmentedSpawnEnv` backs BOTH the Claude Agent SDK spawn
 * (claude-adapter.ts) and the ACP-connected engine spawn (acp-process.ts,
 * covering OpenCode/Kiro/etc) -- proving it here covers the other two of
 * the three engine binaries named in the issue (Codex's real spawn path is
 * covered separately in codex-adapter-transport-tmpdir.test.ts).
 */
describe('augmentedSpawnEnv TMPDIR (station#1908)', () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'station-cli-auth-tmpdir-home-'));
    priorHome = process.env.STATION_HOME;
    process.env.STATION_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('sets TMPDIR to a Station-owned directory, not the ambient default', async () => {
    const env = await augmentedSpawnEnv({ SOME_VAR: 'x' });
    expect(env.TMPDIR).toBe(join(home, 'tmp', 'engine-spawn'));
    // The ambient default (process.env.TMPDIR, or unset) must be overridden,
    // not merely inherited -- otherwise every engine child still writes into
    // the service's own unreaped tmp.
    expect(env.TMPDIR).not.toBe(process.env.TMPDIR);
    // Base env is still preserved alongside the injected TMPDIR/PATH.
    expect(env.SOME_VAR).toBe('x');
  });
});
