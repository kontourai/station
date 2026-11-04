/**
 * #4516: `station policy check <file>` runs as a real CLI child process
 * through the supported source bootstrap, offline, and its exit status is
 * the contract an administrator's rollout script branches on.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const makeTempDir = trackTempDirs();

function fixture(): string {
  return makeTempDir('station-policy-check-');
}

function check(...args: string[]) {
  const root = fixture();
  const result = spawnSyncBounded(
    process.execPath,
    [
      '--import',
      'tsx',
      join(repoRoot, 'scripts/station-cli.ts'),
      'policy',
      'check',
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        STATION_HOME: join(root, 'home'),
        STATION_ROOT: join(root, 'home'),
        // Offline: nothing may answer here.
        STATION_PORT: '9',
      },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function write(body: string): string {
  const path = join(fixture(), 'policy.json');
  writeFileSync(path, body);
  return path;
}

describe('station policy check', () => {
  test('exits 0 on a valid policy and prints what it does', () => {
    const path = write(
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        supportUrl: 'https://help.example/station',
      }),
    );
    const result = check(path);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Policy ${path} is valid.`);
    expect(result.stdout).toContain(
      'Organization: Acme (users see "Managed by Acme")',
    );
    expect(result.stdout).toMatch(/Fingerprint: sha256:[0-9a-f]{64}/);

    const json = check(path, '--json');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      valid: true,
      path,
      summary: { organization: 'Acme', lockedSettings: [], limits: {} },
    });
  }, 120_000);

  test('prints what each managed setting does; the summary lists locked paths only', () => {
    const path = write(
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        settings: {
          defaultMaxTurns: { value: 40, locked: true },
          workspaceCheckpoints: { value: true, locked: false },
          approvalGuardian: { value: { enabled: false }, locked: true },
        },
      }),
    );
    const result = check(path);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Managed settings: 3');
    expect(result.stdout).toMatch(
      /defaultMaxTurns \([^)]+\): locked to 40; users, projects and agents cannot change it/,
    );
    expect(result.stdout).toMatch(
      /workspaceCheckpoints \([^)]+\): defaults to true where nothing closer is set; users can change it/,
    );
    expect(result.stdout).toContain(
      'Its structure is checked against the settings schema when Station starts.',
    );

    const json = check(path, '--json');
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.summary.lockedSettings).toEqual([
      'approvalGuardian',
      'defaultMaxTurns',
    ]);
    // Paths only: no managed value reaches the summary.
    expect(JSON.stringify(report.summary)).not.toContain('40');
  }, 120_000);

  test.each([
    ['invalid JSON', '{"schemaVersion":', 'it is not valid JSON'],
    [
      'an unknown key',
      JSON.stringify({ schemaVersion: 1, organization: 'A', extra: true }),
      'extra: unknown key',
    ],
    [
      'a wrong schemaVersion',
      JSON.stringify({ schemaVersion: 0, organization: 'A' }),
      'schemaVersion: must be 1',
    ],
    [
      'an unsupported limit',
      JSON.stringify({
        schemaVersion: 1,
        organization: 'A',
        limits: { updates: { mode: 'off' } },
      }),
      'limits.updates: this limit is not supported by this version of Station',
    ],
    [
      'an unknown setting',
      JSON.stringify({
        schemaVersion: 1,
        organization: 'A',
        settings: { x: { value: 1, locked: true } },
      }),
      'settings.x: unknown setting',
    ],
    [
      'a setting value of the wrong type',
      JSON.stringify({
        schemaVersion: 1,
        organization: 'A',
        settings: { defaultMaxTurns: { value: 'many', locked: true } },
      }),
      'settings.defaultMaxTurns.value: defaultMaxTurns: expected a number',
    ],
    [
      'a duplicate key (the second limits would erase the first)',
      '{"schemaVersion":1,"organization":"Admin","limits":{"telemetry":false},"limits":{}}',
      'duplicate key limits',
    ],
    [
      'a duplicate key spelled with an escape',
      '{"schemaVersion":1,"organization":"Admin","limits":{},"\\u006cimits":{}}',
      'duplicate key limits',
    ],
  ])(
    'exits 1 on %s and names the problem',
    (_name, body, problem) => {
      const path = write(body);
      const result = check(path);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Policy ${path} is not valid: Station would refuse to start.`,
      );
      expect(result.stderr).toContain(problem);

      const json = check(path, '--json');
      expect(json.status).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ valid: false, path });
    },
    120_000,
  );

  test('exits 1 for a directory or a missing file', () => {
    const directory = join(fixture(), 'policy.json');
    mkdirSync(directory);
    const isDirectory = check(directory);
    expect(isDirectory.status).toBe(1);
    expect(isDirectory.stderr).toContain('it is a directory, not a file');

    const missing = check(join(fixture(), 'absent.json'));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('no file exists at this path');
  }, 120_000);

  test.skipIf(process.platform === 'win32')(
    'exits 1 promptly on a FIFO instead of waiting for a writer',
    () => {
      const path = join(fixture(), 'policy.json');
      execFileSync('mkfifo', [path], { windowsHide: true });
      const started = Date.now();
      const result = check(path);
      // A blocking open would hang until the 60 s kill (status null).
      expect(result.status, result.stderr).toBe(1);
      expect(Date.now() - started).toBeLessThan(55_000);
      expect(result.stderr).toContain('it is not a regular file');
    },
    120_000,
  );

  test.skipIf(process.platform === 'win32')(
    'exits 1 on a symbolic link, dangling or not, without following it',
    () => {
      const target = write(
        JSON.stringify({ schemaVersion: 1, organization: 'A' }),
      );
      const link = join(fixture(), 'policy.json');
      symlinkSync(target, link);
      const followed = check(link);
      expect(followed.status, followed.stdout).toBe(1);
      expect(followed.stderr).toContain('it is a symbolic link');

      const dangling = join(fixture(), 'policy.json');
      symlinkSync(join(fixture(), 'absent.json'), dangling);
      const result = check(dangling);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('it is a symbolic link');
    },
    120_000,
  );
});
