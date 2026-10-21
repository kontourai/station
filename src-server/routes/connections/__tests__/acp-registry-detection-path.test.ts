import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

/**
 * Catalogue detection must read the user's login-shell PATH, not only the
 * process PATH a service-managed Station starts with. The engine binary here
 * is reachable ONLY through the captured shell PATH, and nothing in this
 * fresh module graph has started that capture before the route asks.
 */

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

let providerEntries: Array<{ source: string; provider: any }> = [];
vi.mock('../../../providers/registries/registry.js', () => ({
  listProviders: (type: string) =>
    providerEntries.filter((entry) => entry.source.startsWith(type)),
}));

const ENGINE_COMMAND = 'station-path-test-engine';
let shellOnlyDir: string;
const makeTempDir = trackTempDirs();

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  shellOnlyDir = makeTempDir('station-shell-path-');
  const binary = join(shellOnlyDir, ENGINE_COMMAND);
  writeFileSync(binary, '#!/bin/sh\n');
  chmodSync(binary, 0o755);
  vi.stubEnv('PATH', '/station-path-test-nonexistent');
  // Sentinel-wrapped exactly as the real `$SHELL -ic` capture prints it.
  execFileMock.mockReset().mockImplementation((_file, _args, _opts, cb) => {
    cb(null, {
      stdout: `__STATION_LOGIN_PATH_START_7f3a9c__${shellOnlyDir}__STATION_LOGIN_PATH_END_7f3a9c__`,
      stderr: '',
    });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform === 'win32')(
  'ACP registry detection and the login-shell PATH',
  () => {
    test('the first detection after start finds an engine only the shell PATH reaches', async () => {
      const { findCliBinary } = await import(
        '../../../providers/auth/cli-auth.js'
      );
      // Same detection expression BuiltinACPConnectionRegistryProvider uses.
      providerEntries = [
        {
          source: 'acpConnectionRegistry:core',
          provider: {
            listAvailable: () => [
              {
                id: 'shell-engine',
                name: 'Shell Engine',
                command: ENGINE_COMMAND,
                detected: findCliBinary(ENGINE_COMMAND) !== null,
              },
            ],
          },
        },
      ];
      const { listDetectedUnconnectedACPRegistryEntries } = await import(
        '../acp.js'
      );

      const detected = await listDetectedUnconnectedACPRegistryEntries({
        loadACPConfig: async () => ({ connections: [] }),
      });

      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(detected).toEqual([{ id: 'shell-engine', name: 'Shell Engine' }]);
    });
  },
);
