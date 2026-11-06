/**
 * #4522: `station upgrade` runs as a real CLI child process through the
 * supported source bootstrap and refuses when the machine's managed policy
 * turns updates off. The child runs in a private directory that is neither a
 * git checkout nor a packaged install, so an upgrade the policy failed to
 * stop ends in a different refusal instead of touching any checkout.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const makeTempDir = trackTempDirs();

function upgradeWith(policy: unknown) {
  const root = makeTempDir('station-upgrade-managed-');
  const policyPath = join(root, 'policy.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  const result = spawnSyncBounded(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      join(repoRoot, 'scripts/station-cli.ts'),
      'upgrade',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 90_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json'),
        HOME: root,
        USERPROFILE: root,
        STATION_HOME: join(root, 'home'),
        STATION_ROOT: join(root, 'station-root'),
        STATION_PORT: '9',
        STATION_MANAGED_POLICY_TEST_FILE: policyPath,
        STATION_INSTALL_PUBLIC_MANIFEST_URL: '',
      },
    },
  );
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

describe('station upgrade under a managed policy (#4522)', () => {
  test('off: the upgrade is refused with the policy sentence and a failing exit', () => {
    const { status, output } = upgradeWith({
      schemaVersion: 1,
      organization: 'Acme',
      limits: { updates: { mode: 'off' } },
    });
    expect(status, output).toBe(1);
    expect(output).toContain(
      "station upgrade: This machine's managed policy turns off Station updates. Nothing was changed.",
    );
  }, 120_000);

  test('the same directory without off reaches the install check (the refusal above is the policy’s)', () => {
    const { status, output } = upgradeWith({
      schemaVersion: 1,
      organization: 'Acme',
      limits: { updates: { mode: 'auto' } },
    });
    expect(status, output).not.toBe(0);
    expect(output).not.toContain('managed policy');
    expect(output).toContain(
      'Cannot upgrade a non-Git checkout without signed packaged release provenance.',
    );
  }, 120_000);

  test('an unusable policy refuses the upgrade', () => {
    const { status, output } = upgradeWith({ schemaVersion: 1 });
    expect(status, output).toBe(1);
    expect(output).toContain('STATION_MANAGED_POLICY_INVALID');
  }, 120_000);
});
