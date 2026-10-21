import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

/**
 * An installer that adds its own bin directory through the shell rc (OpenCode,
 * Kilo, Grok, Kimi) is invisible to a PATH captured once at startup. This runs
 * the real login-shell capture against a stub `$SHELL` whose reported PATH a
 * test controls, then installs a binary after startup.
 */
const makeTempDir = trackTempDirs();
const ENGINE = 'station-late-installed-engine';
const MIN_INTERVAL_MS = 10_000; // LOGIN_PATH_RECAPTURE_MIN_INTERVAL_MS

describe.skipIf(process.platform === 'win32')(
  'login-shell PATH recapture',
  () => {
    const previousShell = process.env.SHELL;
    const previousDisable = process.env.STATION_DISABLE_LOGIN_PATH_RESOLVE;
    let shellPathFile: string;
    let installDir: string;

    beforeEach(async () => {
      vi.resetModules();
      const dir = makeTempDir('station-recapture-');
      installDir = join(dir, 'vendor', 'bin');
      shellPathFile = join(dir, 'shell-path');
      writeFileSync(shellPathFile, '/nonexistent-station-dir');
      const { LOGIN_PATH_START_SENTINEL, LOGIN_PATH_END_SENTINEL } =
        await import('../cli-auth.js');
      const shell = join(dir, 'stub-shell');
      writeFileSync(
        shell,
        `#!/bin/sh\nprintf '%s%s%s' '${LOGIN_PATH_START_SENTINEL}' "$(cat '${shellPathFile}')" '${LOGIN_PATH_END_SENTINEL}'\n`,
      );
      chmodSync(shell, 0o755);
      process.env.SHELL = shell;
      delete process.env.STATION_DISABLE_LOGIN_PATH_RESOLVE;
    });

    afterEach(() => {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
      if (previousDisable === undefined)
        delete process.env.STATION_DISABLE_LOGIN_PATH_RESOLVE;
      else process.env.STATION_DISABLE_LOGIN_PATH_RESOLVE = previousDisable;
    });

    function installEngineAfterStartup() {
      mkdirSync(installDir, { recursive: true });
      const binary = join(installDir, ENGINE);
      writeFileSync(binary, '#!/bin/sh\nexit 0\n');
      chmodSync(binary, 0o755);
      // What the vendor installer's rc line does for the next shell.
      writeFileSync(shellPathFile, `/nonexistent-station-dir:${installDir}`);
      return binary;
    }

    test('a recapture finds a binary installed after the first capture', async () => {
      const cli = await import('../cli-auth.js');
      await cli.resolveAugmentedPath();
      expect(cli.findCliBinary(ENGINE)).toBeNull();

      const binary = installEngineAfterStartup();
      // The startup capture is cached: without a recapture it stays unseen.
      await cli.resolveAugmentedPath();
      expect(cli.findCliBinary(ENGINE)).toBeNull();

      await cli.recaptureLoginShellPath(Date.now() + MIN_INTERVAL_MS + 1);
      expect(cli.findCliBinary(ENGINE)).toBe(binary);
    });

    test('recaptures are rate-limited', async () => {
      const cli = await import('../cli-auth.js');
      await cli.resolveAugmentedPath();
      installEngineAfterStartup();

      // Inside the interval since the startup capture: no new shell runs.
      await cli.recaptureLoginShellPath(Date.now() + 1_000);
      expect(cli.findCliBinary(ENGINE)).toBeNull();
    });

    test('a failed recapture keeps the PATH it already had', async () => {
      const cli = await import('../cli-auth.js');
      const binary = installEngineAfterStartup();
      await cli.resolveAugmentedPath();
      expect(cli.findCliBinary(ENGINE)).toBe(binary);

      process.env.SHELL = join(installDir, 'no-such-shell');
      await cli.recaptureLoginShellPath(Date.now() + MIN_INTERVAL_MS + 1);
      expect(cli.findCliBinary(ENGINE)).toBe(binary);
    });
  },
);
