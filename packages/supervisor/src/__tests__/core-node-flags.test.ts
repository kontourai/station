import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { FAKE_CORE, startSupervisor } from './harness.ts';

const makeTempDir = trackTempDirs();

describe('core generation Node flags (real processes)', () => {
  it('forks each core with the young-generation cap and none of its own flags', async () => {
    const home = makeTempDir('sup-flags-');
    const root = makeTempDir('sup-flags-root-');
    const report = join(root, 'exec-argv.json');
    // Records what the forked core itself saw, then runs the fixture core.
    const entry = join(root, 'core.mjs');
    writeFileSync(
      entry,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.execArgv));`,
        `await import(${JSON.stringify(pathToFileURL(FAKE_CORE).href)});`,
      ].join('\n'),
    );
    const supervisor = await startSupervisor({
      home,
      entry,
      // The supervisor's own flag, which the core must not inherit.
      nodeArgs: ['--stack-size=2000'],
    });
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual([
        '--max-semi-space-size=16',
      ]),
    );
    expect((await supervisor.status()).state).toBe('serving');
  });
});
