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
import {
  EVERY_KEY_ENGINE_GATEWAY,
  EVERY_KEY_ENGINE_SUMMARY,
  EVERY_KEY_FEED_URL,
  EVERY_KEY_POLICY,
  EVERY_KEY_SUMMARY_LIMITS,
} from '../../../contracts/src/__tests__/managed-policy-every-key.fixture.js';

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
  // #4515: the combined policy the contracts round trip uses, every enforced
  // key at once, accepted by the real CLI exactly as server startup would.
  test('accepts a policy that sets every enforced key, and its summary never names the mirror', () => {
    const path = write(JSON.stringify(EVERY_KEY_POLICY));
    const text = check(path);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain(`Policy ${path} is valid.`);
    // #4515: the names of the limits it sets, never their values.
    expect(text.stdout).toContain(
      '  Limits: telemetry, webhookAutomations, registries, clients, updates, engines',
    );
    expect(Object.keys(EVERY_KEY_POLICY.limits)).toHaveLength(6);
    expect(text.stdout).toContain('defaultMaxTurns');
    expect(text.stdout).not.toContain(EVERY_KEY_FEED_URL);
    expect(text.stdout).not.toContain(EVERY_KEY_ENGINE_GATEWAY);

    const json = check(path, '--json');
    expect(json.status, json.stderr).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report).toMatchObject({ valid: true, path });
    expect(report.summary.limits).toEqual(EVERY_KEY_SUMMARY_LIMITS);
    expect(report.summary.engines).toEqual(EVERY_KEY_ENGINE_SUMMARY);
    expect(report.summary.lockedSettings).toEqual(['defaultMaxTurns']);
    expect(json.stdout).not.toContain(EVERY_KEY_FEED_URL);
    expect(json.stdout).not.toContain(EVERY_KEY_ENGINE_GATEWAY);
  });

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
          defaultApprovalMode: { value: 'ask', locked: true },
          region: { value: 'eu-west-1', locked: true },
        },
      }),
    );
    const result = check(path);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Managed settings: 5');
    expect(result.stdout).toMatch(
      /defaultMaxTurns \([^)]+\): locked to 40; the Station value and project overrides cannot be changed/,
    );
    // #4517 round 2: a lock states what it does not cover, under the key.
    const notCovered = (key: string) => {
      const lines = result.stdout.split('\n');
      const at = lines.findIndex((line) => line.trim().startsWith(`${key} (`));
      const next = lines[at + 1]?.trim() ?? '';
      return next.startsWith('Not covered: ') ? next : undefined;
    };
    expect(notCovered('defaultApprovalMode')).toBe(
      "Not covered: A mode a person picks for a conversation, an Agent's own approval default and a person's per-engine default still apply. The hard approval bound is `limits.maxApprovalMode` (#4518).",
    );
    expect(notCovered('region')).toBe(
      "Not covered: An Agent's own region, then a model connection's region, still apply before this one.",
    );
    expect(notCovered('defaultMaxTurns')).toContain('maxSteps');
    expect(notCovered('approvalGuardian')).toBeUndefined();
    // A default is changeable anyway, so it carries no such line.
    expect(notCovered('workspaceCheckpoints')).toBeUndefined();
    expect(result.stdout).toMatch(
      /workspaceCheckpoints \([^)]+\): defaults to true where nothing closer is set; users can change it/,
    );

    const json = check(path, '--json');
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.summary.lockedSettings).toEqual([
      'approvalGuardian',
      'defaultApprovalMode',
      'defaultMaxTurns',
      'region',
    ]);
    // Paths only: no managed value reaches the summary.
    expect(JSON.stringify(report.summary)).not.toContain('40');
  }, 120_000);

  // #4517: the composite structure startup checks (`schemas/app.schema.json`
  // and `appConfigSemanticError`) is checked here too, with the same schema.
  test.each([
    [
      'a composite field of the wrong type',
      { approvalGuardian: { value: { enabled: 'false' }, locked: true } },
      /\(\/approvalGuardian\/enabled: must be boolean\)/,
    ],
    [
      'a composite with an unknown field',
      { approvalGuardian: { value: { mode: 'sometimes' }, locked: true } },
      /a managed setting does not match the settings schema/,
    ],
  ])(
    'exits 1 for %s, as startup would refuse it',
    (_label, settings, reason) => {
      const path = write(
        JSON.stringify({ schemaVersion: 1, organization: 'Acme', settings }),
      );
      const result = check(path);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Station would refuse to start.');
      expect(result.stderr).toContain(
        'a managed setting does not match the settings schema',
      );
      expect(result.stderr).toMatch(reason);
      const json = check(path, '--json');
      expect(json.status).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ valid: false, path });
    },
    120_000,
  );

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
        // A key the plan reserves and no slice enforces yet (#4518). When
        // it is enforced no reserved key remains: drop this case then.
        limits: { maxApprovalMode: 'auto' },
      }),
      'limits.maxApprovalMode: this limit is not supported by this version of Station',
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

  // #4515: a policy the contract parser accepts but the settings schema
  // refuses (#4517) is one every server refuses at startup, so it must not
  // reach a configuration profile either.
  test('a --policy whose managed setting fails the settings schema writes nothing', () => {
    const policy = write(
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        settings: {
          approvalGuardian: { value: { enabled: 'false' }, locked: true },
        },
      }),
    );
    // The same file is refused by `check`, the startup validation.
    expect(check(policy).status).toBe(1);
    const out = join(fixture(), 'templates');
    const result = templates(out, '--policy', policy);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain('no templates were written');
    expect(result.stderr).toContain(
      'a managed setting does not match the settings schema',
    );
    expect(existsSync(out)).toBe(false);
  }, 120_000);

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
