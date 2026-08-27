import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  collectWorkspaceProvenance,
  summarizeAttempts as summarizeReliabilityAttempts,
  updateHashFromRegularFile as updateReliabilityHashFromRegularFile,
  writeReceiptSecurely as writeReliabilityReceiptSecurely,
} from '../lib/test-reliability.mjs';
import {
  PREPUSH_TEST_FILES,
  PREPUSH_TEST_GROUPS,
} from '../prepush-test-manifest.mjs';
import {
  buildVitestArgs,
  collectProvenance,
  parsePrepushOptions,
  runPrepushTier,
  summarizeAttempts,
  updateHashFromRegularFile,
  writeReceiptSecurely,
} from '../run-prepush-tier.mjs';

const TEST_PROVENANCE = {
  headSha: 'a'.repeat(40),
  dirty: true,
  workspaceDigest: 'b'.repeat(64),
  manifestDigest: 'c'.repeat(64),
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  files: PREPUSH_TEST_FILES,
  vitestArguments: ['run', '--maxWorkers=1', '--no-file-parallelism'],
};

describe('deterministic pre-push tier', () => {
  test('contains unique, existing tests across every critical group', () => {
    expect(Object.keys(PREPUSH_TEST_GROUPS)).toEqual([
      'guardrails',
      'contracts',
      'server',
      'ui',
    ]);
    expect(new Set(PREPUSH_TEST_FILES).size).toBe(PREPUSH_TEST_FILES.length);
    expect(PREPUSH_TEST_FILES.length).toBeGreaterThanOrEqual(40);
    expect(PREPUSH_TEST_FILES.every((file) => existsSync(file))).toBe(true);
  });

  test('excludes known long-running and environment-sensitive classes', () => {
    const joined = PREPUSH_TEST_FILES.join('\n');
    expect(joined).not.toMatch(/dogfood-reconcile/);
    expect(joined).not.toMatch(/\.integration\.test/);
    expect(joined).not.toContain('vitest-worktree-exclusion.test.ts');
    expect(joined).not.toMatch(
      /(?:^|\/)(?:install-script|lifecycle|service)\.test/,
    );
  });

  test('pins one worker and disables file parallelism', () => {
    expect(buildVitestArgs()).toEqual(
      expect.arrayContaining(['--maxWorkers=1', '--no-file-parallelism']),
    );
  });

  test('keeps schema-v2 pre-push metadata separate from neutral provenance helpers', () => {
    expect(collectProvenance).not.toBe(collectWorkspaceProvenance);
    expect(summarizeAttempts).toBe(summarizeReliabilityAttempts);
    expect(updateHashFromRegularFile).toBe(
      updateReliabilityHashFromRegularFile,
    );
    expect(writeReceiptSecurely).toBe(writeReliabilityReceiptSecurely);
  });

  test('preserves schema-v2 provenance key order while adding pre-push metadata', () => {
    expect(Object.keys(collectProvenance())).toEqual([
      'headSha',
      'dirty',
      'workspaceDigest',
      'manifestDigest',
      'nodeVersion',
      'platform',
      'arch',
      'files',
      'vitestArguments',
    ]);
  });

  test('validates repeat arguments and keeps receipts repo-local', () => {
    expect(parsePrepushOptions(['--repeat=20'])).toEqual({
      repeat: 20,
      output: '.kontourai/test-reliability/prepush-repeat-latest.json',
    });
    expect(parsePrepushOptions([]).output).toBe(
      '.kontourai/test-reliability/prepush-latest.json',
    );
    expect(() => parsePrepushOptions(['--repeat=0'])).toThrow(/1 to 100/);
    expect(() => parsePrepushOptions(['--repeat=20junk'])).toThrow(/1 to 100/);
    expect(() => parsePrepushOptions(['--unknown'])).toThrow(
      /unknown argument/,
    );
    expect(() => parsePrepushOptions(['--output=/tmp/result.json'])).toThrow(
      /unknown argument/,
    );
  });

  test('keeps the fast and complete package-script contracts distinct', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(packageJson.scripts.test).toBe('npm run test:prepush');
    expect(packageJson.scripts['test:prepush']).toBe(
      'node scripts/run-verification.mjs request prepush',
    );
    expect(packageJson.scripts['test:prepush:raw']).toBe(
      'npm run prepare:verify-static && node scripts/run-prepush-tier.mjs',
    );
    expect(packageJson.scripts['test:prepush:repeat']).toBe(
      'npm run prepare:verify-static && node scripts/run-prepush-tier.mjs --repeat=20',
    );
    expect(packageJson.scripts['test:full']).toBe(
      'node scripts/run-verification.mjs request test-full',
    );
    expect(packageJson.scripts['test:full:raw']).toBe(
      'node scripts/run-vitest-corpus.mjs',
    );
    expect(packageJson.scripts['test:dogfood-reconcile']).toBe(
      'vitest run scripts/__tests__/station-dogfood-reconcile --no-file-parallelism',
    );
    expect(packageJson.scripts['verify:static']).toBe(
      'node scripts/run-verification.mjs request verify-static',
    );
    expect(packageJson.scripts['verify:static:raw']).not.toContain(
      'npm run test:full:raw',
    );
    expect(packageJson.scripts['full:regression:raw']).toContain(
      'npm run test:full:raw',
    );
    expect(packageJson.scripts['ci:fast']).toBe(
      'node scripts/run-verification.mjs request ci-fast',
    );
    expect(packageJson.scripts['ci:fast:raw']).toBe(
      'node scripts/run-ci-fast.mjs',
    );
  });

  test('records every attempt and fails when any attempt fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-prepush-tier-'));
    const output = join(root, 'result.json');
    let time = 0;
    const statuses = [0, 1, 0];
    try {
      const exitCode = runPrepushTier({
        repeat: 3,
        output,
        run: () => ({ status: statuses.shift() }) as never,
        provenance: () => TEST_PROVENANCE,
        receiptRoot: root,
        now: () => {
          time += 10;
          return time;
        },
      });
      expect(exitCode).toBe(1);
      const receipt = JSON.parse(readFileSync(output, 'utf8'));
      expect(receipt).toMatchObject({
        schemaVersion: 2,
        lane: 'prepush',
        groups: Object.fromEntries(
          Object.entries(PREPUSH_TEST_GROUPS).map(([name, files]) => [
            name,
            files.length,
          ]),
        ),
        fileCount: PREPUSH_TEST_FILES.length,
      });
      expect(receipt.summary).toMatchObject({
        attempts: 3,
        passed: 2,
        failed: 1,
        passRate: 2 / 3,
      });
      expect(receipt.attempts).toEqual([
        { attempt: 1, status: 'passed', exitCode: 0, durationMs: 10 },
        { attempt: 2, status: 'failed', exitCode: 1, durationMs: 10 },
        { attempt: 3, status: 'passed', exitCode: 0, durationMs: 10 },
      ]);
      expect(receipt.provenance).toEqual({
        stable: true,
        before: TEST_PROVENANCE,
        after: TEST_PROVENANCE,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalidates evidence when workspace provenance changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-prepush-tier-'));
    let collection = 0;
    try {
      const exitCode = runPrepushTier({
        repeat: 1,
        output: 'result.json',
        receiptRoot: root,
        run: () => ({ status: 0 }) as never,
        provenance: () => ({
          ...TEST_PROVENANCE,
          workspaceDigest: `${collection++}`.padStart(64, 'd'),
        }),
        now: () => 1,
      });
      const receipt = JSON.parse(
        readFileSync(join(root, 'result.json'), 'utf8'),
      );
      expect(exitCode).toBe(1);
      expect(receipt.provenance.stable).toBe(false);
      expect(receipt.summary).toMatchObject({
        passed: 1,
        failed: 0,
        infrastructureErrors: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('distinguishes launch failures from failing tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-prepush-tier-'));
    try {
      const exitCode = runPrepushTier({
        repeat: 1,
        output: 'result.json',
        receiptRoot: root,
        provenance: () => TEST_PROVENANCE,
        run: () =>
          ({
            status: null,
            signal: 'SIGTERM',
            error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }),
          }) as never,
      });
      const receipt = JSON.parse(
        readFileSync(join(root, 'result.json'), 'utf8'),
      );
      expect(exitCode).toBe(1);
      // `failed` must stay the test-failure count, not "everything that did not
      // pass": a launch failure belongs to `infrastructureErrors` alone
      // (station#1741). The tier still fails — on that field, honestly named.
      expect(receipt.summary).toMatchObject({
        attempts: 1,
        passed: 0,
        failed: 0,
        testFailures: 0,
        infrastructureErrors: 1,
      });
      expect(receipt.attempts[0]).toMatchObject({
        status: 'infrastructure_error',
        exitCode: null,
        signal: 'SIGTERM',
        error: { code: 'ENOENT', message: 'spawn failed' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('atomically replaces receipts with mode 0600', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-prepush-tier-'));
    const output = join(root, 'receipt.json');
    try {
      writeFileSync(output, 'old', { mode: 0o644 });
      chmodSync(output, 0o644);
      writeReceiptSecurely('receipt.json', 'new', root);
      expect(readFileSync(output, 'utf8')).toBe('new');
      if (process.platform !== 'win32') {
        expect(lstatSync(output).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('streams regular provenance files within both byte limits', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-prepush-tier-'));
    const file = join(root, 'source.ts');
    try {
      writeFileSync(file, 'abc');
      const total = { bytes: 0 };
      const hash = createHash('sha256');
      updateHashFromRegularFile(hash, file, total, {
        maxFileBytes: 3,
        maxTotalBytes: 3,
      });
      expect(total.bytes).toBe(3);
      expect(hash.digest('hex')).toBe(
        createHash('sha256').update('abc').digest('hex'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed on per-file and aggregate provenance limits', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-prepush-tier-'));
    const file = join(root, 'source.ts');
    try {
      writeFileSync(file, 'abcd');
      expect(() =>
        updateHashFromRegularFile(
          createHash('sha256'),
          file,
          { bytes: 0 },
          {
            maxFileBytes: 3,
            maxTotalBytes: 10,
          },
        ),
      ).toThrow(/file exceeds its byte limit/);
      expect(() =>
        updateHashFromRegularFile(
          createHash('sha256'),
          file,
          { bytes: 2 },
          {
            maxFileBytes: 10,
            maxTotalBytes: 5,
          },
        ),
      ).toThrow(/total byte limit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when an untracked file grows during hashing', () => {
    const initialStat = {
      dev: 1,
      ino: 2,
      size: 1,
      mtimeMs: 10,
      isFile: () => true,
    };
    let fstatCalls = 0;
    let readCalls = 0;
    expect(() =>
      updateHashFromRegularFile(
        createHash('sha256'),
        'growing.ts',
        { bytes: 0 },
        {
          maxFileBytes: 10,
          maxTotalBytes: 10,
          lstat: () => initialStat,
          open: () => 1,
          fstat: () => ({
            ...initialStat,
            size: fstatCalls++ === 0 ? 1 : 2,
          }),
          read: (_descriptor, buffer) => {
            if (readCalls++ > 0) return 0;
            buffer[0] = 97;
            return 1;
          },
          close: () => undefined,
        },
      ),
    ).toThrow(/changed while reading/);

    let oversizedRead = false;
    expect(() =>
      updateHashFromRegularFile(
        createHash('sha256'),
        'growing.ts',
        { bytes: 0 },
        {
          maxFileBytes: 1,
          maxTotalBytes: 1,
          lstat: () => initialStat,
          open: () => 1,
          fstat: () => initialStat,
          read: () => {
            if (oversizedRead) return 0;
            oversizedRead = true;
            return 2;
          },
          close: () => undefined,
        },
      ),
    ).toThrow(/exceeded its byte limit while reading/);
  });

  test.runIf(process.platform !== 'win32')(
    'refuses a symlinked receipt destination',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'station-prepush-tier-'));
      const outside = join(root, 'outside.json');
      try {
        writeFileSync(outside, 'keep');
        mkdirSync(join(root, 'receipts'));
        symlinkSync(outside, join(root, 'receipts', 'latest.json'));
        expect(() =>
          writeReceiptSecurely('receipts/latest.json', 'replace', root),
        ).toThrow(/symbolic link/);
        expect(readFileSync(outside, 'utf8')).toBe('keep');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== 'win32')(
    'refuses a symlinked parent before creating external directories',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'station-prepush-tier-'));
      const outside = mkdtempSync(join(tmpdir(), 'station-prepush-outside-'));
      try {
        symlinkSync(outside, join(root, 'linked'));
        expect(() =>
          writeReceiptSecurely('linked/nested/latest.json', 'replace', root),
        ).toThrow(/symbolic link/);
        expect(existsSync(join(outside, 'nested'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  test('summarizes an empty or passing attempt set deterministically', () => {
    expect(summarizeAttempts([])).toMatchObject({ passRate: 0, durationMs: 0 });
    expect(
      summarizeAttempts([
        { status: 'passed', durationMs: 10 },
        { status: 'passed', durationMs: 20 },
      ]),
    ).toMatchObject({ passRate: 1, durationMs: 30, slowestAttemptMs: 20 });
  });

  test('keeps infrastructure errors out of the failed count', () => {
    // The discriminating case: a set where non-passing and failed differ.
    // `attempts - passed` would report `failed: 2` here (station#1741).
    expect(
      summarizeAttempts([
        { status: 'passed', durationMs: 10 },
        { status: 'failed', durationMs: 20 },
        { status: 'infrastructure_error', durationMs: 30 },
      ]),
    ).toEqual({
      attempts: 3,
      passed: 1,
      failed: 1,
      testFailures: 1,
      infrastructureErrors: 1,
      passRate: 1 / 3,
      durationMs: 60,
      slowestAttemptMs: 30,
    });
  });
});
