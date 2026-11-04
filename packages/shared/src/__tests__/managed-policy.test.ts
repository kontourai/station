import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  loadInstalledManagedPolicy,
  loadManagedPolicyFromSources,
  MANAGED_POLICY_MAX_BYTES,
  ManagedPolicyInvalidError,
  managedPolicyFilePath,
  managedPolicyFileSource,
  managedPolicyStatus,
  readManagedPolicyFile,
} from '../managed-policy.js';

const makeTempDir = trackTempDirs();

function dir(): string {
  return makeTempDir('station-policy-source-');
}

function policyFile(body: string): string {
  const path = join(dir(), 'policy.json');
  writeFileSync(path, body);
  return path;
}

const VALID = JSON.stringify({ schemaVersion: 1, organization: 'Acme' });

function invalid(action: () => unknown): ManagedPolicyInvalidError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedPolicyInvalidError);
    return error as ManagedPolicyInvalidError;
  }
  throw new Error('expected ManagedPolicyInvalidError');
}

describe('system paths', () => {
  test('are fixed literals per OS, never environment-expanded', () => {
    expect(managedPolicyFilePath('darwin')).toBe(
      '/Library/Application Support/Station/policy.json',
    );
    expect(managedPolicyFilePath('win32')).toBe(
      'C:\\Program Files\\Station\\policy.json',
    );
    expect(managedPolicyFilePath('linux')).toBe('/etc/station/policy.json');
  });
});

describe('file source', () => {
  test('a missing file is no policy', () => {
    expect(readManagedPolicyFile(join(dir(), 'absent.json'))).toBeUndefined();
    expect(
      loadManagedPolicyFromSources([
        managedPolicyFileSource(join(dir(), 'absent.json')),
      ]),
    ).toBeNull();
  });

  test('a directory at the path is an error naming the path', () => {
    const path = join(dir(), 'policy.json');
    mkdirSync(path);
    const error = invalid(() => readManagedPolicyFile(path));
    expect(error.location).toBe(path);
    expect(error.reason).toBe('it is a directory, not a file');
    expect(error.message).toMatch(
      /^STATION_MANAGED_POLICY_INVALID: Station cannot use the managed policy at /,
    );
  });

  test('a file over the size bound is refused, not truncated', () => {
    const path = policyFile(' '.repeat(MANAGED_POLICY_MAX_BYTES + 1));
    expect(invalid(() => readManagedPolicyFile(path)).reason).toBe(
      `the file is larger than ${MANAGED_POLICY_MAX_BYTES} bytes`,
    );
    // Exactly at the bound is read whole.
    const atBound = policyFile(
      VALID + ' '.repeat(MANAGED_POLICY_MAX_BYTES - VALID.length),
    );
    expect(
      loadManagedPolicyFromSources([managedPolicyFileSource(atBound)])?.summary
        .organization,
    ).toBe('Acme');
  });

  test('invalid JSON and schema problems name the path and the reason', () => {
    const broken = policyFile('{');
    expect(
      invalid(() =>
        loadManagedPolicyFromSources([managedPolicyFileSource(broken)]),
      ).reason,
    ).toMatch(/^it is not valid JSON \(/);
    const unknown = policyFile(
      JSON.stringify({ schemaVersion: 1, organization: 'A', x: 1 }),
    );
    const error = invalid(() =>
      loadManagedPolicyFromSources([managedPolicyFileSource(unknown)]),
    );
    expect(error.location).toBe(unknown);
    expect(error.problems.map((problem) => problem.path)).toEqual(['x']);
  });

  test('a UTF-8 byte-order mark is accepted', () => {
    const path = policyFile(`\uFEFF${VALID}`);
    expect(
      loadManagedPolicyFromSources([managedPolicyFileSource(path)])?.document,
    ).toEqual({ schemaVersion: 1, organization: 'Acme' });
  });

  test('the digest is sha256 over the canonical document', () => {
    const path = policyFile('{ "organization": "Acme",\n "schemaVersion": 1 }');
    const loaded = loadManagedPolicyFromSources([
      managedPolicyFileSource(path),
    ]);
    expect(loaded?.digest).toBe(
      `sha256:${createHash('sha256').update('{"organization":"Acme","schemaVersion":1}').digest('hex')}`,
    );
    expect(managedPolicyStatus(loaded)).toEqual({
      state: 'loaded',
      source: { kind: 'file', location: path },
      digest: loaded?.digest,
      summary: {
        organization: 'Acme',
        supportUrl: null,
        lockedSettings: [],
        limits: {},
      },
    });
    expect(managedPolicyStatus(null)).toEqual({ state: 'none' });
  });

  test('more than one source present is an error naming both', () => {
    const a = policyFile(VALID);
    const b = policyFile(VALID);
    const error = invalid(() =>
      loadManagedPolicyFromSources([
        managedPolicyFileSource(a),
        managedPolicyFileSource(b),
      ]),
    );
    expect(error.location).toBe(`${a} and ${b}`);
    expect(error.reason).toContain('more than one policy source');
  });
});

describe('test override', () => {
  test('is honored only when no system source is installed', () => {
    const override = policyFile(VALID);
    const loaded = loadInstalledManagedPolicy({
      env: { STATION_MANAGED_POLICY_TEST_FILE: override },
      systemSources: [managedPolicyFileSource(join(dir(), 'absent.json'))],
    });
    expect(loaded?.source).toEqual({
      kind: 'test-override',
      location: override,
    });
  });

  test('cannot replace or hide an installed system policy', () => {
    const system = policyFile(
      JSON.stringify({ schemaVersion: 1, organization: 'Admin' }),
    );
    const override = policyFile(VALID);
    const error = invalid(() =>
      loadInstalledManagedPolicy({
        env: { STATION_MANAGED_POLICY_TEST_FILE: override },
        systemSources: [managedPolicyFileSource(system)],
      }),
    );
    expect(error.location).toBe(system);
    expect(error.reason).toContain('the test override cannot replace it');
    // Without the override the system policy loads normally.
    expect(
      loadInstalledManagedPolicy({
        env: {},
        systemSources: [managedPolicyFileSource(system)],
      })?.summary.organization,
    ).toBe('Admin');
  });

  test('an invalid system policy still fails closed under the override', () => {
    const system = join(dir(), 'policy.json');
    mkdirSync(system);
    const error = invalid(() =>
      loadInstalledManagedPolicy({
        env: { STATION_MANAGED_POLICY_TEST_FILE: policyFile(VALID) },
        systemSources: [managedPolicyFileSource(system)],
      }),
    );
    expect(error.location).toBe(system);
  });

  test('must be absolute and must exist', () => {
    const none = [managedPolicyFileSource(join(dir(), 'absent.json'))];
    expect(
      invalid(() =>
        loadInstalledManagedPolicy({
          env: { STATION_MANAGED_POLICY_TEST_FILE: 'policy.json' },
          systemSources: none,
        }),
      ).reason,
    ).toContain('must be an absolute path');
    expect(
      invalid(() =>
        loadInstalledManagedPolicy({
          env: {
            STATION_MANAGED_POLICY_TEST_FILE: join(dir(), 'missing.json'),
          },
          systemSources: none,
        }),
      ).reason,
    ).toContain('names a file that does not exist');
  });
});
