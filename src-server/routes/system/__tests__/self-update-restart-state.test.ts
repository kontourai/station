import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  classifyRestartRecordAtBoot,
  type RestartStateFileOperations,
  readSelfUpdateRestartRecord,
  restartStateFilePath,
  type SelfUpdateRestartRecord,
  writeSelfUpdateRestartRecord,
} from '../self-update-restart-state.js';

let tmpDirs: string[] = [];
function tmpGitRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'self-update-restart-state-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

const baseRecord: SelfUpdateRestartRecord = {
  instanceId: 'default',
  hash: 'abc1234',
  pid: 0,
  port: 3141,
  startedAt: '2026-08-02T03:28:43.483Z',
  status: 'pending',
};

function verifiedRecord(): SelfUpdateRestartRecord {
  return {
    instanceId: 'default',
    hash: 'abc1234',
    pid: 4242,
    port: 3141,
    startedAt: '2026-08-02T03:28:43.483Z',
    status: 'verified',
    resolvedAt: '2026-08-02T03:29:10.000Z',
  };
}

describe('restartStateFilePath', () => {
  test('lives under .station in the checkout root (AC: readable)', () => {
    expect(restartStateFilePath('/repo')).toBe(
      '/repo/.station/self-update-restart.json',
    );
  });
});

describe('write/read round trip', () => {
  test('reads back exactly what was written, creating the parent dir', () => {
    const gitRoot = tmpGitRoot();
    const path = restartStateFilePath(gitRoot);
    writeSelfUpdateRestartRecord(path, baseRecord);
    expect(readSelfUpdateRestartRecord(path)).toEqual(baseRecord);
  });

  test('a later write supersedes the earlier record at the same path', () => {
    const gitRoot = tmpGitRoot();
    const path = restartStateFilePath(gitRoot);
    writeSelfUpdateRestartRecord(path, baseRecord);
    writeSelfUpdateRestartRecord(path, {
      ...baseRecord,
      pid: 4242,
      status: 'verified',
      resolvedAt: '2026-08-02T03:29:10.000Z',
    });
    expect(readSelfUpdateRestartRecord(path)?.status).toBe('verified');
  });
});

describe('writeSelfUpdateRestartRecord publication boundaries', () => {
  function withPriorRecord(): { path: string; previousBytes: string } {
    const path = restartStateFilePath(tmpGitRoot());
    writeSelfUpdateRestartRecord(path, baseRecord);
    return { path, previousBytes: readFileSync(path, 'utf8') };
  }

  function expectPreRenameFailure(
    overrides: Partial<RestartStateFileOperations>,
  ): void {
    const { path, previousBytes } = withPriorRecord();
    expect(() =>
      writeSelfUpdateRestartRecord(path, verifiedRecord(), overrides),
    ).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(previousBytes);
  }

  test('preserves the prior bytes for temporary open, write, file fsync, file close, and rename failures', () => {
    expectPreRenameFailure({
      openSync: () => {
        throw new Error('temporary open failed');
      },
    });
    expectPreRenameFailure({
      writeFileSync: () => {
        throw new Error('temporary write failed');
      },
    });
    expectPreRenameFailure({
      fsyncSync: () => {
        throw new Error('temporary fsync failed');
      },
    });
    expectPreRenameFailure({
      closeSync: () => {
        throw new Error('temporary close failed');
      },
    });
    expectPreRenameFailure({
      renameSync: () => {
        throw new Error('rename failed');
      },
    });
  });

  test('preserves the primary pre-rename failure even when temporary cleanup also fails', () => {
    const { path, previousBytes } = withPriorRecord();
    let temporaryPath = '';
    expect(() =>
      writeSelfUpdateRestartRecord(path, verifiedRecord(), {
        temporaryPath: (target) => {
          temporaryPath = `${target}.cleanup-fault.tmp`;
          return temporaryPath;
        },
        writeFileSync: () => {
          throw new Error('primary write failure');
        },
        rmSync: () => {
          throw new Error('cleanup failure');
        },
      }),
    ).toThrow('primary write failure');
    expect(readFileSync(path, 'utf8')).toBe(previousBytes);
    expect(existsSync(temporaryPath)).toBe(true);
    rmSync(temporaryPath, { force: true });
  });

  test.each(['open', 'fsync', 'close'] as const)(
    'reports a committed durability warning after parent %s failure without replacing the terminal record',
    (fault) => {
      const { path } = withPriorRecord();
      let openCalls = 0;
      let fsyncCalls = 0;
      let closeCalls = 0;
      const result = writeSelfUpdateRestartRecord(path, verifiedRecord(), {
        openSync: (file, flags, mode) => {
          openCalls += 1;
          if (fault === 'open' && openCalls === 2) {
            throw new Error('parent open failure');
          }
          return openSync(file, flags, mode);
        },
        fsyncSync: (descriptor) => {
          fsyncCalls += 1;
          if (fault === 'fsync' && fsyncCalls === 2) {
            throw new Error('parent fsync failure');
          }
          fsyncSync(descriptor);
        },
        closeSync: (descriptor) => {
          closeCalls += 1;
          if (fault === 'close' && closeCalls === 2) {
            throw new Error('parent close failure');
          }
          closeSync(descriptor);
        },
      });

      expect(result).toMatchObject({
        committed: true,
        durability: 'uncertain',
      });
      expect(readSelfUpdateRestartRecord(path)).toEqual(verifiedRecord());
    },
  );

  test('does not open or fsync a directory on Windows after the atomic rename', () => {
    const { path } = withPriorRecord();
    let openCalls = 0;
    const result = writeSelfUpdateRestartRecord(path, verifiedRecord(), {
      platform: 'win32',
      openSync: (file, flags, mode) => {
        openCalls += 1;
        return openSync(file, flags, mode);
      },
    });

    expect(result).toEqual({ committed: true, durability: 'confirmed' });
    expect(openCalls).toBe(1);
    expect(readSelfUpdateRestartRecord(path)).toEqual(verifiedRecord());
  });
});

describe('readSelfUpdateRestartRecord (fail-closed)', () => {
  test('a missing file reads as null', () => {
    const gitRoot = tmpGitRoot();
    expect(
      readSelfUpdateRestartRecord(restartStateFilePath(gitRoot)),
    ).toBeNull();
  });

  test('malformed JSON reads as null, never throws', () => {
    const gitRoot = tmpGitRoot();
    const path = restartStateFilePath(gitRoot);
    writeSelfUpdateRestartRecord(path, baseRecord);
    writeFileSync(path, '{not json');
    expect(readSelfUpdateRestartRecord(path)).toBeNull();
  });

  test('a record missing required fields reads as null instead of a fabricated status', () => {
    const gitRoot = tmpGitRoot();
    const path = restartStateFilePath(gitRoot);
    mkdirSync(join(gitRoot, '.station'), { recursive: true });
    writeFileSync(path, JSON.stringify({ status: 'verified' }));
    expect(readSelfUpdateRestartRecord(path)).toBeNull();
  });

  test('an unrecognized status value reads as null', () => {
    const gitRoot = tmpGitRoot();
    const path = restartStateFilePath(gitRoot);
    mkdirSync(join(gitRoot, '.station'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...baseRecord, status: 'ok' }));
    expect(readSelfUpdateRestartRecord(path)).toBeNull();
  });

  test.each([
    [
      { ...baseRecord, pid: 4242, status: 'verified' },
      'terminal record without resolvedAt',
    ],
    [
      {
        ...baseRecord,
        pid: 4242,
        status: 'verified',
        resolvedAt: '2026-08-02T03:29:10.000Z',
        unexpected: true,
      },
      'unknown field',
    ],
    [
      {
        ...baseRecord,
        pid: 4242,
        status: 'failed',
        resolvedAt: '2026-08-02T03:29:10.000Z',
      },
      'failed record without a bounded failure code',
    ],
    [
      {
        ...baseRecord,
        pid: 4242,
        status: 'failed',
        resolvedAt: '2026-08-02T03:29:10.000Z',
        failureCode: 'watchdog-crashed',
        detail: 'https://user:password@example.test/private',
      },
      'failed record carrying a raw diagnostic detail',
    ],
    [
      {
        ...baseRecord,
        pid: 4242,
        status: 'verified',
        resolvedAt: '2026-08-02T03:28:42.000Z',
      },
      'terminal record resolved before it began',
    ],
  ])('rejects a %s without rewriting it', (record, _label) => {
    const gitRoot = tmpGitRoot();
    const path = restartStateFilePath(gitRoot);
    mkdirSync(join(gitRoot, '.station'), { recursive: true });
    const original = JSON.stringify(record);
    writeFileSync(path, original);

    expect(readSelfUpdateRestartRecord(path)).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test.each([
    [{ ...baseRecord, pid: 12 }, 'pending record with a spawned-process pid'],
    [
      { ...verifiedRecord(), pid: 0 },
      'terminal record with the parent pre-spawn pid',
    ],
  ])('rejects a %s without rewriting it', (record, _label) => {
    const gitRoot = tmpGitRoot();
    const path = restartStateFilePath(gitRoot);
    mkdirSync(join(gitRoot, '.station'), { recursive: true });
    const original = JSON.stringify(record);
    writeFileSync(path, original);

    expect(readSelfUpdateRestartRecord(path)).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test('publishes a complete new record only after rename, so a concurrent reader sees the prior complete record', () => {
    const gitRoot = tmpGitRoot();
    const path = restartStateFilePath(gitRoot);
    writeSelfUpdateRestartRecord(path, baseRecord);
    let observed: SelfUpdateRestartRecord | null = null;
    writeSelfUpdateRestartRecord(
      path,
      {
        ...baseRecord,
        pid: 4242,
        status: 'verified',
        resolvedAt: '2026-08-02T03:29:10.000Z',
      },
      {
        renameSync: (temporary, target) => {
          observed = readSelfUpdateRestartRecord(target as string);
          renameSync(temporary, target);
        },
      },
    );

    expect(observed).toEqual(baseRecord);
    expect(readSelfUpdateRestartRecord(path)?.status).toBe('verified');
  });
});

describe('classifyRestartRecordAtBoot (AC: read on boot, surface unresolved/failed)', () => {
  const NOW = Date.parse('2026-08-02T03:30:00.000Z');

  test('no record at all is not reported', () => {
    expect(classifyRestartRecordAtBoot(null, NOW)).toEqual({ kind: 'none' });
  });

  test('a verified record is not reported as a problem', () => {
    const record: SelfUpdateRestartRecord = {
      ...baseRecord,
      pid: 4242,
      status: 'verified',
      resolvedAt: '2026-08-02T03:29:00.000Z',
    };
    expect(classifyRestartRecordAtBoot(record, NOW)).toEqual({
      kind: 'verified',
      record,
    });
  });

  test('a fresh pending record (< 90s old) is an ordinary in-flight restart, not a problem', () => {
    const record: SelfUpdateRestartRecord = {
      ...baseRecord,
      status: 'pending',
      startedAt: new Date(NOW - 10_000).toISOString(),
    };
    expect(classifyRestartRecordAtBoot(record, NOW)).toEqual({
      kind: 'in-flight',
      record,
    });
  });

  test('a pending record older than the watchdog budget is surfaced as stale (AC: unresolved never silent)', () => {
    const record: SelfUpdateRestartRecord = {
      ...baseRecord,
      status: 'pending',
      startedAt: new Date(NOW - 5 * 60_000).toISOString(),
    };
    const finding = classifyRestartRecordAtBoot(record, NOW);
    expect(finding.kind).toBe('stale-pending');
    expect((finding as { ageMs: number }).ageMs).toBeGreaterThan(90_000);
  });

  test('a failed record is always surfaced regardless of age (AC: failed restart never silent)', () => {
    const record: SelfUpdateRestartRecord = {
      ...baseRecord,
      pid: 4242,
      status: 'failed',
      resolvedAt: new Date(NOW - 1_000).toISOString(),
      failureCode: 'health-unreachable',
    };
    expect(classifyRestartRecordAtBoot(record, NOW)).toEqual({
      kind: 'failed',
      record,
    });
  });

  test('an unparseable startedAt is treated as infinitely stale rather than silently ok', () => {
    const record: SelfUpdateRestartRecord = {
      ...baseRecord,
      status: 'pending',
      startedAt: 'not-a-date',
    };
    const finding = classifyRestartRecordAtBoot(record, NOW);
    expect(finding.kind).toBe('stale-pending');
  });
});
