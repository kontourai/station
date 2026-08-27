import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { STATION_SERVER_EXTERNALS } from '../../../scripts/lib/server-build-config.mjs';

/**
 * station#3278. The watchdog's entrypoint guard compared `import.meta.url` to
 * `pathToFileURL(process.argv[1])`. Node resolves the entry module through
 * realpath; argv stays as invoked — so through any symlinked path the guard
 * failed and the watchdog STARTED, DID NOTHING, AND EXITED 0. A clean-looking
 * run in which the process it exists to watch was not watched, which is
 * absence-of-signal-as-success in its purest form.
 *
 * The discriminator: malformed input must exit 1 with the runner's own
 * crash-verdict message. Under the naive guard, a symlinked invocation exits
 * 0 with NO output, having never parsed argv at all. Runs the real bundled artifact, built the way esbuild.config.mjs
 * builds it — the source through tsx would leave the shipped shape unproven.
 */
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..', '..');

let workspace: string;
let bundle: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'watchdog-entrypoint-'));
  bundle = join(workspace, 'dist-server', 'self-update-watchdog.js');
  await esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    entryPoints: [
      join(repoRoot, 'src-server', 'tools', 'self-update-watchdog-runner.ts'),
    ],
    outfile: bundle,
    external: STATION_SERVER_EXTERNALS,
    banner: {
      js: "import { createRequire as __stationCreateRequire } from 'node:module'; const require = __stationCreateRequire(import.meta.url);",
    },
  });
}, 60_000);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function runBundle(invokePath: string): { status: number; output: string } {
  try {
    execFileSync(process.execPath, [invokePath, 'not-json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: '' };
  } catch (error) {
    const failure = error as {
      status?: number;
      stderr?: string;
      stdout?: string;
    };
    return {
      status: failure.status ?? -1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('the watchdog runs no matter how its path is spelled', () => {
  test('direct invocation runs (control)', () => {
    const run = runBundle(bundle);
    expect(run.status).toBe(1);
    expect(run.output).toContain('crashed before a terminal verdict');
  });

  test('invocation through a symlinked DIRECTORY still runs', () => {
    // /tmp and /var/folders are symlinks on macOS, so in production this is
    // not an exotic spelling — it is the default one.
    const link = join(workspace, 'linked-dir');
    symlinkSync(dirname(bundle), link);
    const run = runBundle(join(link, 'self-update-watchdog.js'));
    expect(run.status).toBe(1);
    expect(run.output).toContain('crashed before a terminal verdict');
  });

  test('invocation through a symlinked FILE still runs', () => {
    const link = join(workspace, 'watchdog-link.js');
    symlinkSync(bundle, link);
    const run = runBundle(link);
    expect(run.status).toBe(1);
    expect(run.output).toContain('crashed before a terminal verdict');
  });
});
