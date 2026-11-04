/**
 * #4517: the CLI commands that write `config/app.json` without a server
 * apply the managed policy's locks themselves. Each runs as a real CLI child
 * process through the supported source bootstrap, with the policy injected
 * the way the server reads it (`STATION_MANAGED_POLICY_TEST_FILE`), and the
 * stored file is read back from disk.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STATION_HOME_SCHEMA_VERSION } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, test } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const makeTempDir = trackTempDirs();

const DENIAL =
  "Acme's policy manages this setting. For help, visit https://help.example/station";

function fixture(
  settings: Record<string, { value: unknown; locked: boolean }>,
) {
  const root = makeTempDir('station-managed-offline-');
  const home = join(root, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, '.station-home-schema.json'),
    JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
  );
  const appPath = join(home, 'config', 'app.json');
  writeFileSync(appPath, JSON.stringify({ defaultMaxTurns: 7 }, null, 2));
  const policyPath = join(root, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: 1,
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
      settings,
    }),
  );
  const run = (...args: string[]) => {
    const result = spawnSyncBounded(
      process.execPath,
      ['--import', 'tsx', join(repoRoot, 'scripts/station-cli.ts'), ...args],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          STATION_HOME: home,
          STATION_ROOT: join(root, 'station-root'),
          STATION_MANAGED_POLICY_TEST_FILE: policyPath,
          // Offline: nothing may answer here.
          STATION_PORT: '9',
        },
      },
    );
    return {
      status: result.status,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  };
  return {
    run,
    stored: () => JSON.parse(readFileSync(appPath, 'utf8')),
  };
}

describe('offline CLI writes under a managed policy', () => {
  test('config set --offline refuses a locked setting and leaves the file as it was', () => {
    const f = fixture({ defaultMaxTurns: { value: 40, locked: true } });
    const refused = f.run('config', 'set', 'defaultMaxTurns', '9', '--offline');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(DENIAL);
    expect(f.stored().defaultMaxTurns).toBe(7);

    // The locked value itself writes nothing: no policy value in user files.
    const same = f.run('config', 'set', 'defaultMaxTurns', '40', '--offline');
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toContain('already that value (managed by policy)');
    expect(f.stored().defaultMaxTurns).toBe(7);

    // An unmanaged setting still saves.
    const other = f.run(
      'config',
      'set',
      'checkoutStaleAfterDays',
      '4',
      '--offline',
    );
    expect(other.status, other.stderr).toBe(0);
    expect(f.stored()).toMatchObject({
      defaultMaxTurns: 7,
      checkoutStaleAfterDays: 4,
    });
  }, 180_000);

  test('station registry <url> refuses a locked registryUrl', () => {
    const f = fixture({
      registryUrl: {
        value: 'https://registry.example/index.json',
        locked: true,
      },
    });
    const refused = f.run('registry', 'https://elsewhere.example/index.json');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(DENIAL);
    expect(f.stored()).not.toHaveProperty('registryUrl');
  }, 120_000);
});
