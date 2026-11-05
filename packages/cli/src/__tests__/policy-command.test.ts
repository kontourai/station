/**
 * #4516: `station policy check <file>` runs as a real CLI child process
 * through the supported source bootstrap, offline, and its exit status is
 * the contract an administrator's rollout script branches on.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
      'a managed setting',
      JSON.stringify({
        schemaVersion: 1,
        organization: 'A',
        settings: { x: { value: 1, locked: true } },
      }),
      'settings.x: managed settings are not supported',
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

function templates(...args: string[]) {
  const root = fixture();
  const result = spawnSyncBounded(
    process.execPath,
    [
      '--import',
      'tsx',
      join(repoRoot, 'scripts/station-cli.ts'),
      'policy',
      'templates',
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

describe('station policy templates', () => {
  const FILES = [
    'macos/station.mobileconfig',
    'windows/station.admx',
    'windows/en-US/station.adml',
  ];

  test('writes the profile and the Group Policy template; --policy fills the profile', () => {
    const policy = write(
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        limits: { telemetry: false },
      }),
    );
    for (const args of [['--policy', policy], [`--policy=${policy}`]]) {
      const out = join(fixture(), 'templates');
      const result = templates(out, ...args);
      expect(result.status, result.stderr).toBe(0);
      for (const file of FILES)
        expect(existsSync(join(out, file)), file).toBe(true);
      const profile = readFileSync(join(out, FILES[0]), 'utf8');
      expect(profile).toContain('<string>Acme</string>');
      expect(profile).toContain('<key>telemetry</key>');
      expect(readFileSync(join(out, FILES[1]), 'utf8')).toContain(
        'key="SOFTWARE\\Policies\\Kontour\\Station"',
      );
    }
  });

  test('without --policy the profile names a placeholder organization', () => {
    const out = join(fixture(), 'templates');
    const result = templates(out);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Run again with --policy <file>');
    expect(readFileSync(join(out, FILES[0]), 'utf8')).toContain(
      'Example Organization',
    );
  });

  test('an invalid --policy writes nothing and exits 1', () => {
    const policy = write(
      JSON.stringify({ schemaVersion: 1, organization: 'Acme', extra: 1 }),
    );
    const out = join(fixture(), 'templates');
    const result = templates(out, '--policy', policy);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no templates were written');
    expect(existsSync(out)).toBe(false);
  });

  test.each([[[]], [['a', 'b']], [['out', '--policy']], [['out', '--nope']]])(
    'refuses bad arguments %j',
    (args) => {
      const result = templates(...args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'station policy templates <dir> [--policy <file>]',
      );
    },
  );
});
