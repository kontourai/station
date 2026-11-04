import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  decodeManagedPolicy,
  loadInstalledManagedPolicy,
  loadManagedPolicyFromSources,
  MANAGED_POLICY_LOCATION_MAX_CHARS,
  MANAGED_POLICY_MAX_BYTES,
  MANAGED_POLICY_REASON_MAX_CHARS,
  ManagedPolicyInvalidError,
  managedPolicyDirectoryProblem,
  managedPolicyFilePath,
  managedPolicyFileSource,
  managedPolicyStatus,
  readManagedPolicyFile,
  SYSTEM_MANAGED_POLICY_OWNERSHIP,
  systemManagedPolicySources,
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

const posix = process.platform !== 'win32';

describe('symbolic links', () => {
  test.skipIf(!posix)('a dangling link is an error, not absence', () => {
    const link = join(dir(), 'policy.json');
    symlinkSync(join(dir(), 'absent.json'), link);
    const error = invalid(() => readManagedPolicyFile(link));
    expect(error.location).toBe(link);
    expect(error.reason).toContain('it is a symbolic link');
  });

  test.skipIf(!posix)(
    'a link to a readable policy is refused, not followed',
    () => {
      const link = join(dir(), 'policy.json');
      symlinkSync(policyFile(VALID), link);
      expect(invalid(() => readManagedPolicyFile(link)).reason).toContain(
        'it is a symbolic link',
      );
    },
  );

  test.skipIf(!posix)(
    'a dangling system link fails closed and the override cannot stand in',
    () => {
      const link = join(dir(), 'policy.json');
      symlinkSync(join(dir(), 'absent.json'), link);
      const error = invalid(() =>
        loadInstalledManagedPolicy({
          env: { STATION_MANAGED_POLICY_TEST_FILE: policyFile(VALID) },
          systemSources: [managedPolicyFileSource(link)],
        }),
      );
      expect(error.location).toBe(link);
      expect(error.reason).toContain('it is a symbolic link');
    },
  );
});

describe('special files', () => {
  test.skipIf(!posix)('a FIFO is refused as not a regular file', () => {
    const path = join(dir(), 'policy.json');
    execFileSync('mkfifo', [path], { windowsHide: true });
    // Hold a write end open so that, if the non-blocking open regressed,
    // this in-process read would fail the assertion instead of hanging the
    // worker. The non-blocking open itself is proven by the CLI and server
    // child-process tests, which have no writer.
    const writer = openSync(path, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    try {
      expect(invalid(() => readManagedPolicyFile(path)).reason).toBe(
        'it is not a regular file',
      );
    } finally {
      closeSync(writer);
    }
  });
});

describe('system ownership', () => {
  const uid = process.getuid?.() ?? -1;

  /** A root `trusted` (0700, ours) holding `trusted/Station/policy.json`. */
  function ownedTree() {
    const trusted = dir();
    chmodSync(trusted, 0o755);
    const station = join(trusted, 'Station');
    mkdirSync(station, { mode: 0o755 });
    const path = join(station, 'policy.json');
    writeFileSync(path, VALID, { mode: 0o644 });
    chmodSync(path, 0o644);
    return {
      trusted,
      station,
      path,
      ownership: { ownerUid: uid, trustedRoot: trusted },
    };
  }

  test('system sources require root ownership up to /', () => {
    expect(SYSTEM_MANAGED_POLICY_OWNERSHIP).toEqual({
      ownerUid: 0,
      trustedRoot: '/',
    });
    const [source] = systemManagedPolicySources('linux');
    expect(source.descriptor.location).toBe('/etc/station/policy.json');
  });

  test.skipIf(!posix || uid === 0)(
    'the system file source refuses a file the user owns',
    () => {
      // Reaches the source the server loads, so dropping the ownership
      // requirement from it fails here, not only in the helper test.
      const path = policyFile(VALID);
      const [source] = systemManagedPolicySources(process.platform, path);
      const error = invalid(() => source.read());
      expect(error.reason).toBe(
        `${path} must be owned by root (uid 0), but is owned by uid ${uid}`,
      );
    },
  );

  test.skipIf(!posix || uid === 0)(
    'a user-owned file at a system source is refused, naming the file',
    () => {
      const path = policyFile(VALID);
      const error = invalid(() =>
        readManagedPolicyFile(path, SYSTEM_MANAGED_POLICY_OWNERSHIP),
      );
      expect(error.reason).toBe(
        `${path} must be owned by root (uid 0), but is owned by uid ${uid}`,
      );
      // The same file without the system requirement (check, override).
      expect(readManagedPolicyFile(path)).toEqual({
        kind: 'text',
        text: VALID,
      });
    },
  );

  test.skipIf(!posix)('an owned, unwritable chain is accepted', () => {
    const { path, ownership } = ownedTree();
    expect(readManagedPolicyFile(path, ownership)).toEqual({
      kind: 'text',
      text: VALID,
    });
  });

  test.skipIf(!posix)('a group- or world-writable file is refused', () => {
    const { path, ownership } = ownedTree();
    chmodSync(path, 0o664);
    expect(invalid(() => readManagedPolicyFile(path, ownership)).reason).toBe(
      `${path} must not be writable by its group or other users (mode 664)`,
    );
    chmodSync(path, 0o646);
    expect(
      invalid(() => readManagedPolicyFile(path, ownership)).reason,
    ).toContain('mode 646');
  });

  test.skipIf(!posix)(
    'a writable parent directory is refused, naming it',
    () => {
      const { station, trusted, path, ownership } = ownedTree();
      chmodSync(station, 0o775);
      expect(invalid(() => readManagedPolicyFile(path, ownership)).reason).toBe(
        `${station} must not be writable by its group or other users (mode 775)`,
      );
      chmodSync(station, 0o755);
      chmodSync(trusted, 0o757);
      expect(invalid(() => readManagedPolicyFile(path, ownership)).reason).toBe(
        `${trusted} must not be writable by its group or other users (mode 757)`,
      );
    },
  );

  test.skipIf(!posix)(
    'a linked parent is checked where it leads, not only where it sits',
    () => {
      const { trusted, ownership } = ownedTree();
      const elsewhere = dir();
      chmodSync(elsewhere, 0o777);
      writeFileSync(join(elsewhere, 'policy.json'), VALID, { mode: 0o644 });
      symlinkSync(elsewhere, join(trusted, 'Linked'));
      const error = invalid(() =>
        readManagedPolicyFile(
          join(trusted, 'Linked', 'policy.json'),
          ownership,
        ),
      );
      expect(error.reason).toMatch(/is not under |must not be writable/);
    },
  );

  test.skipIf(process.platform !== 'darwin')(
    'the stock macOS chain above the policy directory is accepted',
    () => {
      // /Library is root:wheel 0755 and /Library/Application Support is
      // root:admin 0755 on a stock Mac; group ownership is not a problem.
      expect(
        managedPolicyDirectoryProblem(
          '/Library/Application Support',
          SYSTEM_MANAGED_POLICY_OWNERSHIP,
        ),
      ).toBeNull();
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'the stock Linux chain above the policy directory is accepted',
    () => {
      expect(
        managedPolicyDirectoryProblem('/etc', SYSTEM_MANAGED_POLICY_OWNERSHIP),
      ).toBeNull();
    },
  );
});

describe('duplicate keys', () => {
  test('a second member with the same name is refused, not merged', () => {
    const error = invalid(() =>
      decodeManagedPolicy('/p', {
        kind: 'text',
        text: '{"schemaVersion":1,"organization":"Admin","limits":{"telemetry":false},"limits":{}}',
      }),
    );
    expect(error.reason).toBe('duplicate key limits');
  });

  test('names are compared after unescaping', () => {
    expect(
      invalid(() =>
        decodeManagedPolicy('/p', {
          kind: 'text',
          text: '{"schemaVersion":1,"organization":"A","\\u006frganization":"B"}',
        }),
      ).reason,
    ).toBe('duplicate key organization');
  });
});

describe('diagnostic bounds', () => {
  test('a huge key keeps the fatal line short, one line, marker first', () => {
    const key = 'k'.repeat(100_000);
    const error = invalid(() =>
      decodeManagedPolicy('/p', {
        kind: 'text',
        text: JSON.stringify({ schemaVersion: 1, organization: 'A', [key]: 1 }),
      }),
    );
    expect(error.message.startsWith('STATION_MANAGED_POLICY_INVALID: ')).toBe(
      true,
    );
    expect(error.message.length).toBeLessThan(4096);
    expect(error.message).toContain('(100000 characters)');
  });

  test('a long location and reason are truncated and newlines removed', () => {
    const error = new ManagedPolicyInvalidError(
      `/a\n${'l'.repeat(5000)}`,
      `r${'x'.repeat(10_000)}`,
    );
    expect(error.location.length).toBeLessThan(
      MANAGED_POLICY_LOCATION_MAX_CHARS + 64,
    );
    expect(error.reason.length).toBeLessThan(
      MANAGED_POLICY_REASON_MAX_CHARS + 64,
    );
    expect(error.message).not.toContain('\n');
    expect(error.message).toMatch(/more characters\)\. Station will not start/);
    // Literals beside the constants under test.
    expect(MANAGED_POLICY_LOCATION_MAX_CHARS).toBe(1024);
    expect(MANAGED_POLICY_REASON_MAX_CHARS).toBe(2048);
  });
});
