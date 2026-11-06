/**
 * #4520: `limits.engines` in the policy parser, the value-free client summary
 * and the status boundary.
 */
import { describe, expect, test } from 'vitest';
import {
  MANAGED_POLICY_ENFORCED_LIMIT_KEYS,
  MANAGED_POLICY_RESERVED_LIMIT_KEYS,
  parseManagedPolicyDocument,
  parseManagedPolicyStatus,
  summarizeManagedPolicy,
} from '../managed-policy.js';
import {
  isAbsoluteManagedBinaryPath,
  MANAGED_POLICY_ENGINE_IDS,
  managedEngineAllowed,
} from '../managed-policy-engines.js';

const base = { schemaVersion: 1, organization: 'Acme' } as const;

function problemsOf(engines: unknown) {
  const result = parseManagedPolicyDocument({ ...base, limits: { engines } });
  if (result.ok) throw new Error('expected the document to be refused');
  return result.problems;
}

function accepted(engines: unknown) {
  const result = parseManagedPolicyDocument({ ...base, limits: { engines } });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.document;
}

describe('limits.engines in the policy document', () => {
  test('is enforced and no longer reserved', () => {
    expect(MANAGED_POLICY_ENFORCED_LIMIT_KEYS).toContain('engines');
    expect(MANAGED_POLICY_RESERVED_LIMIT_KEYS).not.toContain('engines');
  });

  test('accepts an allow list of built-in engine ids', () => {
    expect(accepted({ allowed: ['claude', 'station-agent'] }).limits).toEqual({
      engines: { allowed: ['claude', 'station-agent'] },
    });
    expect(accepted({ allowed: [] }).limits).toEqual({
      engines: { allowed: [] },
    });
  });

  test('refuses an unknown or repeated engine id at load', () => {
    expect(problemsOf({ allowed: ['claude', 'ollama', 'claude'] })).toEqual([
      {
        path: 'limits.engines.allowed[1]',
        message: `must be one of ${MANAGED_POLICY_ENGINE_IDS.join(', ')}`,
      },
      {
        path: 'limits.engines.allowed[2]',
        message: 'repeats an earlier engine',
      },
    ]);
    expect(problemsOf({ allowed: 'claude' })[0]?.path).toBe(
      'limits.engines.allowed',
    );
  });

  test('acpRegistryAgents accepts only false', () => {
    expect(accepted({ acpRegistryAgents: false }).limits).toEqual({
      engines: { acpRegistryAgents: false },
    });
    expect(problemsOf({ acpRegistryAgents: true })[0]?.path).toBe(
      'limits.engines.acpRegistryAgents',
    );
  });

  test('accepts a pinned instance and copies it', () => {
    const instance = {
      locked: false,
      binaryPath: 'C:\\Program Files\\Codex\\codex.exe',
      launchArgs: ['-c', 'model_provider=acme'],
      environment: { OPENAI_BASE_URL: 'https://gw.example.com', EMPTY: '' },
    };
    expect(accepted({ instances: { codex: instance } }).limits).toEqual({
      engines: { instances: { codex: instance } },
    });
  });

  test.each([
    [{ binaryPath: '/x' }, 'limits.engines.instances.claude.locked'],
    [{ locked: true }, 'limits.engines.instances.claude'],
    [
      { locked: true, binaryPath: 'claude' },
      'limits.engines.instances.claude.binaryPath',
    ],
    [
      { locked: true, binaryPath: './bin/claude' },
      'limits.engines.instances.claude.binaryPath',
    ],
    [
      { locked: true, launchArgs: ['ok', 3] },
      'limits.engines.instances.claude.launchArgs',
    ],
    [
      { locked: true, environment: { 'BAD-NAME': 'x' } },
      'limits.engines.instances.claude.environment["BAD-NAME"]',
    ],
    [
      { locked: true, environment: { TMPDIR: '/tmp' } },
      'limits.engines.instances.claude.environment.TMPDIR',
    ],
    [
      { locked: true, environment: { STATION_WORKLOAD_SESSION_ID: 'x' } },
      'limits.engines.instances.claude.environment.STATION_WORKLOAD_SESSION_ID',
    ],
    [
      { locked: true, environment: { A: 1 } },
      'limits.engines.instances.claude.environment.A',
    ],
    [
      { locked: true, binaryPath: '/x', extra: 1 },
      'limits.engines.instances.claude.extra',
    ],
  ])('refuses the instance %j', (instance, path) => {
    expect(
      problemsOf({ instances: { claude: instance } }).map((p) => p.path),
    ).toContain(path);
  });

  test("refuses an instance for Station's own agent, an unknown engine, or one the allow list excludes", () => {
    const pin = { locked: true, binaryPath: '/opt/x' };
    expect(
      problemsOf({
        allowed: ['claude'],
        instances: { 'station-agent': pin, ollama: pin, codex: pin },
      }).map((p) => p.path),
    ).toEqual([
      'limits.engines.instances["station-agent"]',
      'limits.engines.instances.ollama',
      'limits.engines.instances.codex',
    ]);
  });

  test('refuses unknown keys under limits.engines', () => {
    expect(problemsOf({ blocked: ['codex'] })).toEqual([
      {
        path: 'limits.engines.blocked',
        message:
          'unknown key; this version of Station refuses keys it cannot enforce',
      },
    ]);
  });
});

describe('the engine summary', () => {
  const document = accepted({
    allowed: ['claude', 'codex'],
    instances: {
      codex: {
        locked: true,
        launchArgs: ['--secret-token', 'tok-123'],
        environment: { Z_KEY: 'zz-secret', A_URL: 'https://gw.example.com' },
      },
    },
  });

  test('names what is pinned and carries no launch value', () => {
    const summary = summarizeManagedPolicy(document);
    expect(summary.limits).toEqual({});
    expect(summary.engines).toEqual({
      allowed: ['claude', 'codex'],
      acpRegistryAgents: true,
      pinned: [
        {
          engine: 'codex',
          locked: true,
          fields: ['launchArgs', 'environment'],
          environmentNames: ['A_URL', 'Z_KEY'],
        },
      ],
    });
    const text = JSON.stringify(summary);
    for (const secret of ['tok-123', 'zz-secret', 'gw.example.com'])
      expect(text).not.toContain(secret);
  });

  test('a policy without limits.engines has no engine summary', () => {
    const summary = summarizeManagedPolicy({
      schemaVersion: 1,
      organization: 'Acme',
    });
    expect('engines' in summary).toBe(false);
  });

  const status = (summary: unknown) =>
    parseManagedPolicyStatus(
      JSON.parse(
        JSON.stringify({
          state: 'loaded',
          source: { kind: 'file', location: '/etc/station/policy.json' },
          digest: `sha256:${'c'.repeat(64)}`,
          summary,
        }),
      ),
    );

  test('survives the status boundary', () => {
    const summary = summarizeManagedPolicy(document);
    const parsed = status(summary);
    expect(parsed?.state === 'loaded' && parsed.summary).toEqual(summary);
  });

  test('the status boundary refuses values smuggled into limits or a malformed engine summary', () => {
    const summary = summarizeManagedPolicy(document);
    expect(
      status({ ...summary, limits: { engines: { allowed: ['claude'] } } }),
    ).toBeNull();
    expect(
      status({ ...summary, engines: { ...summary.engines, allowed: ['x'] } }),
    ).toBeNull();
    expect(
      status({
        ...summary,
        engines: {
          ...summary.engines,
          pinned: [{ engine: 'codex', locked: 'yes', fields: [] }],
        },
      }),
    ).toBeNull();
  });
});

describe('engine predicates', () => {
  test('without an allow list every engine, a plugin engine included, may run', () => {
    expect(managedEngineAllowed(undefined, 'some-plugin-engine')).toBe(true);
    expect(managedEngineAllowed({}, 'codex')).toBe(true);
  });

  test('an allow list admits only the engines it lists', () => {
    expect(managedEngineAllowed({ allowed: ['claude'] }, 'claude')).toBe(true);
    expect(managedEngineAllowed({ allowed: ['claude'] }, 'codex')).toBe(false);
    expect(managedEngineAllowed({ allowed: [] }, 'claude')).toBe(false);
  });

  test.each([
    ['/usr/local/bin/claude', true],
    ['C:\\tools\\codex.exe', true],
    ['C:/tools/codex.exe', true],
    ['\\\\server\\share\\muse.exe', true],
    ['claude', false],
    ['~/bin/claude', false],
    ['bin/claude', false],
  ])('%s is absolute: %s', (path, expected) => {
    expect(isAbsoluteManagedBinaryPath(path)).toBe(expected);
  });
});
