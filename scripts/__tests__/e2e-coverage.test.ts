import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  E2E_INVALID_TEST_INFO_PATTERN,
  e2eArtifactPathErrors,
  e2eManifest,
  listE2ESourceFiles,
} from '../../tests/e2e-manifest.mjs';
import {
  assertSupportedE2EPlatform,
  BUCKETS,
  bucketVerdict,
  createE2ERunIdentity,
  DEFAULT_E2E_CAPACITY,
  executedCount,
  failingSpecs,
  formatCounts,
  parseCoverageArgs,
  projectCoverageEvidence,
  projectionRequiresFailure,
  readCapacity,
  runBuckets,
  startBucket,
  summarize,
  writeBucketOutputs,
} from '../run-e2e-coverage.mjs';

const ESC = String.fromCharCode(27);

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function ownedExecutionFixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const completion = deferred();
  let alive = true;
  return {
    child,
    completion: completion.promise,
    isAlive: () => alive,
    settle(result) {
      alive = false;
      completion.resolve(result);
    },
  };
}

describe('summarize', () => {
  it('reads Playwright tallies', () => {
    expect(summarize('  5 failed\n  102 passed (2.6m)\n')).toEqual({
      failed: 5,
      passed: 102,
    });
  });

  it('handles an all-green bucket', () => {
    expect(summarize('  234 passed (4.6m)\n')).toEqual({ passed: 234 });
  });

  it('reports nothing when Playwright printed no tally', () => {
    expect(summarize('npm error Missing script')).toEqual({});
  });

  // The bytes below are copied verbatim from a real `--only=first-run` capture.
  // Playwright colours the epilogue and the `line` reporter prefixes it with a
  // cursor-up + erase-line, so a `^`-anchored match against raw output found
  // nothing and every bucket reported "no test tally reported".
  it('reads a tally off real, escape-laden Playwright output', () => {
    const real = `${ESC}[1A${ESC}[2K${ESC}[32m  1 passed${ESC}[39m${ESC}[2m (46.2s)${ESC}[22m\n`;
    expect(summarize(real)).toEqual({ passed: 1 });
  });

  it('reads a coloured mixed tally', () => {
    const real = [
      `${ESC}[1A${ESC}[2K${ESC}[31m  5 failed${ESC}[39m`,
      `${ESC}[33m  2 flaky${ESC}[39m`,
      `${ESC}[33m  3 skipped${ESC}[39m`,
      `${ESC}[32m  102 passed${ESC}[39m${ESC}[2m (2.6m)${ESC}[22m`,
    ].join('\n');
    expect(summarize(real)).toEqual({
      failed: 5,
      flaky: 2,
      skipped: 3,
      passed: 102,
    });
  });

  it('counts interrupted runs, which Playwright also prints', () => {
    expect(summarize('  1 interrupted\n')).toEqual({ interrupted: 1 });
  });

  it('still refuses a count quoted mid-line, not just mid-word', () => {
    expect(summarize('Error: expected 3 passed items in the list')).toEqual({});
  });
});

describe('executedCount', () => {
  it('counts only tests whose bodies ran', () => {
    expect(executedCount({ passed: 10, failed: 2, flaky: 1, skipped: 7 })).toBe(
      13,
    );
  });

  it('is zero for a bucket that only skipped', () => {
    expect(executedCount({ skipped: 4, 'did not run': 2 })).toBe(0);
  });
});

describe('bucketVerdict', () => {
  it('passes a bucket that exited clean and ran tests', () => {
    expect(bucketVerdict({ ok: true, counts: { passed: 12 } })).toBe('PASS');
  });

  it('fails a bucket that exited non-zero', () => {
    expect(bucketVerdict({ ok: false, counts: { failed: 1, passed: 3 } })).toBe(
      'FAIL',
    );
  });

  // A bucket that exits 0 having run nothing looks identical to a green one
  // through an exit code alone. It has happened here: a bucket died in 13s
  // having executed no specs. Zero tests is zero coverage.
  it('marks a clean exit with no tests EMPTY, not PASS', () => {
    expect(bucketVerdict({ ok: true, counts: {} })).toBe('EMPTY');
  });

  it('marks an all-skipped bucket EMPTY too', () => {
    expect(bucketVerdict({ ok: true, counts: { skipped: 9 } })).toBe('EMPTY');
  });
});

describe('formatCounts', () => {
  it('puts failures first so a red bucket reads as red', () => {
    expect(formatCounts({ passed: 102, failed: 5 })).toBe(
      '5 failed, 102 passed',
    );
  });

  it('is explicit when there is no tally, rather than silently empty', () => {
    expect(formatCounts({})).toBe('no test tally reported');
  });
});

describe('full-run evidence identity', () => {
  it('creates a safe run identity', () => {
    expect(createE2ERunIdentity(1_700_000_000_000, 123)).toMatch(
      /^e2e-[a-z0-9]+-123$/,
    );
  });

  it('projects a failed completed run rather than retaining previous success', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-e2e-coverage-'));
    const previous = process.cwd();
    try {
      const evidenceRoot = join(
        root,
        '.kontourai',
        'e2e-runs',
        'e2e-test-1',
        'evidence',
      );
      mkdirSync(join(evidenceRoot, 'gallery'), { recursive: true });
      writeFileSync(join(evidenceRoot, 'gallery', 'shot.png'), 'image');
      process.chdir(root);
      const manifest = projectCoverageEvidence(
        [
          {
            name: 'screenshot',
            verdict: 'FAIL',
            counts: { failed: 1 },
            seconds: 1,
          },
        ],
        {
          runId: 'e2e-test-1',
          evidenceRoot,
          revision: 'abc',
        },
      );
      expect(manifest.verdict).toBe('FAIL');
      expect(manifest.projectionBinding.runId).toBe('e2e-test-1');
      expect(
        JSON.parse(
          readFileSync(
            join(root, '.kontourai', 'e2e-latest', 'manifest.json'),
            'utf8',
          ),
        ).buckets[0].verdict,
      ).toBe('FAIL');
      expect(
        readFileSync(
          join(
            root,
            '.kontourai',
            'e2e-latest',
            'runs',
            'e2e-test-1',
            'gallery',
            'shot.png',
          ),
          'utf8',
        ),
      ).toBe('image');
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces prior green evidence with a bounded red omission when artifacts are unsafe', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-e2e-coverage-'));
    const previous = process.cwd();
    try {
      const greenRoot = join(root, 'green');
      mkdirSync(greenRoot);
      writeFileSync(join(greenRoot, 'shot.png'), 'image');
      process.chdir(root);
      projectCoverageEvidence(
        [{ name: 'product', verdict: 'PASS', counts: { passed: 1 } }],
        { runId: 'green-run', evidenceRoot: greenRoot, revision: 'abc' },
      );
      const unsafeRoot = join(root, 'unsafe');
      mkdirSync(unsafeRoot);
      writeFileSync(join(unsafeRoot, 'report.exe'), 'untrusted');
      const manifest = projectCoverageEvidence(
        [{ name: 'product', verdict: 'FAIL', counts: { failed: 1 } }],
        { runId: 'red-run', evidenceRoot: unsafeRoot, revision: 'abc' },
      );
      expect(manifest).toMatchObject({
        runId: 'red-run',
        verdict: 'FAIL',
        files: [],
        evidenceOmission: { reason: expect.stringContaining('unsupported') },
      });
      expect(projectionRequiresFailure(manifest)).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            join(root, '.kontourai', 'e2e-latest', 'manifest.json'),
            'utf8',
          ),
        ).runId,
      ).toBe('red-run');
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('screenshot gallery rendering', () => {
  it('escapes run-derived text and prohibits gallery scripts', () => {
    const source = readFileSync('tests/screenshots.spec.ts', 'utf8');
    expect(source).toContain('function escapeHtml');
    expect(source).toContain("script-src 'none'");
    expect(source).toContain("escapeHtml(shot.error ?? '')");
    expect(source).toContain('escapeHtml(capturedAt)');
  });
});

describe('failingSpecs', () => {
  it('names the spec files that failed', () => {
    const out = [
      '  1) [chromium] › tests/mcp-ui-host-bridge.spec.ts:206:3 › thing',
      '  2) [chromium] › tests/mcp-ui-host-security.spec.ts:258:3 › other',
      '  3) [chromium] › tests/mcp-ui-host-security.spec.ts:284:3 › more',
    ].join('\n');
    expect(failingSpecs(out)).toEqual([
      'tests/mcp-ui-host-bridge.spec.ts',
      'tests/mcp-ui-host-security.spec.ts',
    ]);
  });

  it('finds none in a green run', () => {
    expect(failingSpecs('  234 passed (4.6m)')).toEqual([]);
  });

  // Playwright wraps the failure list in red, so this needs the same
  // escape-stripping the tally does.
  it('names specs in real, coloured failure output', () => {
    const real = [
      `${ESC}[31m  1) [chromium] › tests/mcp-ui-host-bridge.spec.ts:206:3 › thing${ESC}[39m`,
      `${ESC}[31m  2) [chromium] › tests/mcp-ui-host-security.spec.ts:258:3 › other${ESC}[39m`,
    ].join('\n');
    expect(failingSpecs(real)).toEqual([
      'tests/mcp-ui-host-bridge.spec.ts',
      'tests/mcp-ui-host-security.spec.ts',
    ]);
  });
});

describe('weighted bucket scheduler', () => {
  const pass = (bucket) => ({
    ...bucket,
    ok: true,
    verdict: 'PASS',
    counts: { passed: 1 },
    specs: [],
    output: `${bucket.name} output\n`,
    seconds: 0,
    runnerError: null,
  });

  it('never exceeds its declared host capacity', async () => {
    let activeWeight = 0;
    let maxObservedWeight = 0;
    await runBuckets(BUCKETS, {
      capacity: DEFAULT_E2E_CAPACITY,
      runBucket: async (bucket) => pass(bucket),
      onEvent: ({ type, bucket }) => {
        if (type === 'start') activeWeight += bucket.weight;
        else activeWeight -= bucket.weight;
        maxObservedWeight = Math.max(maxObservedWeight, activeWeight);
      },
    });
    expect(maxObservedWeight).toBeLessThanOrEqual(DEFAULT_E2E_CAPACITY);
    // The default admits a heavy bucket plus a light isolated bucket; it is
    // useful parallelism without concurrent heavy Station builds.
    expect(maxObservedWeight).toBe(DEFAULT_E2E_CAPACITY);
  });

  it('runs every bucket after earlier buckets fail', async () => {
    const started = [];
    const results = await runBuckets(BUCKETS, {
      capacity: DEFAULT_E2E_CAPACITY,
      runBucket: async (bucket) => ({
        ...pass(bucket),
        ok: bucket.name !== 'product',
        verdict: bucket.name === 'product' ? 'FAIL' : 'PASS',
      }),
      onEvent: ({ type, bucket }) => {
        if (type === 'start') started.push(bucket.name);
      },
    });
    expect(started).toHaveLength(BUCKETS.length);
    expect(new Set(started)).toEqual(
      new Set(BUCKETS.map((bucket) => bucket.name)),
    );
    expect(results).toHaveLength(BUCKETS.length);
    expect(results.find((result) => result.name === 'product')?.verdict).toBe(
      'FAIL',
    );
  });

  it('reports completed buckets in canonical manifest order', async () => {
    const completed = [];
    const results = await runBuckets(BUCKETS, {
      capacity: 12,
      runBucket: async (bucket) => {
        // Reverse completion order without launching any browser process.
        await new Promise((resolve) => setTimeout(resolve, 7 - bucket.weight));
        completed.push(bucket.name);
        return pass(bucket);
      },
    });
    expect(completed).not.toEqual(BUCKETS.map((bucket) => bucket.name));
    expect(results.map((result) => result.name)).toEqual(
      BUCKETS.map((bucket) => bucket.name),
    );
  });

  it('emits buffered child output as non-interleaved canonical blocks', () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      writeBucketOutputs([
        { name: 'product', output: 'product output\n' },
        { name: 'extended', output: 'extended output\n' },
      ]);
      expect(write.mock.calls.map(([text]) => text)).toEqual([
        '\n──── e2e bucket: product ────\n',
        'product output\n',
        '\n──── e2e bucket: extended ────\n',
        'extended output\n',
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it('cancels active groups, does not admit pending buckets, and removes the abort handler', async () => {
    const selected = [
      { name: 'first', script: 'first', weight: 1 },
      { name: 'second', script: 'second', weight: 1 },
    ];
    const pending = deferred();
    const cancel = vi.fn(async () => {
      pending.resolve(pass(selected[0]));
    });
    const listeners = new Set();
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: vi.fn((_event, listener) => listeners.add(listener)),
      removeEventListener: vi.fn((_event, listener) =>
        listeners.delete(listener),
      ),
      abort(reason) {
        this.aborted = true;
        this.reason = reason;
        for (const listener of listeners) listener();
      },
    };
    const started = [];
    const resultsPromise = runBuckets(selected, {
      capacity: 1,
      signal,
      runBucket: (bucket) => {
        started.push(bucket.name);
        return { promise: pending.promise, cancel };
      },
      onEvent: ({ type }) => {
        if (type === 'start') signal.abort('SIGTERM');
      },
    });

    expect(started).toEqual(['first']);
    const results = await resultsPromise;

    expect(cancel).toHaveBeenCalledWith('SIGTERM');
    expect(started).toEqual(['first']);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({ verdict: 'FAIL', interrupted: true });
      expect(result.runnerError).toContain('SIGTERM');
    }
    expect(signal.removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
  });
});

describe('startup-heavy non-overlap', () => {
  // The buckets whose full-Station startup/build phase is heavy enough that two
  // together exceed the host budget. These must never run concurrently under
  // the default capacity.
  const STARTUP_HEAVY = new Set([
    'product',
    'first-run',
    'starter-clean-install',
    'extended',
    'android',
  ]);
  const bucketByName = (name) => BUCKETS.find((b) => b.name === name);

  // A bucket is admitted only when `weight + usedCapacity <= capacity`, so two
  // heavy buckets overlap only if their weights sum within capacity. Asserting
  // every heavy pair sums PAST the default is the structural non-overlap proof,
  // independent of the scheduler's completion order. This is the invariant the
  // android weight exists to satisfy.
  it('weights every startup-heavy pair past the default capacity', () => {
    const heavy = BUCKETS.filter((b) => STARTUP_HEAVY.has(b.name));
    // Guard against the heavy set drifting silently from the manifest.
    expect(heavy.map((b) => b.name).sort()).toEqual([...STARTUP_HEAVY].sort());
    for (let i = 0; i < heavy.length; i += 1) {
      for (let j = i + 1; j < heavy.length; j += 1) {
        expect(
          heavy[i].weight + heavy[j].weight,
          `${heavy[i].name}+${heavy[j].name}`,
        ).toBeGreaterThan(DEFAULT_E2E_CAPACITY);
      }
    }
  });

  // Pins the chosen constant: android is weight 5 because weight 4 would STILL
  // overlap first-run (4 + 2 = 6 <= 6) — the exact incident. Anything below 5
  // reintroduces two simultaneous full-Station startups under the default.
  it('classifies android as weight 5, the minimum that parts it from first-run', () => {
    const android = bucketByName('android');
    const firstRun = bucketByName('first-run');
    expect(android.weight).toBe(5);
    expect(android.weight + firstRun.weight).toBeGreaterThan(
      DEFAULT_E2E_CAPACITY,
    );
    expect(4 + firstRun.weight).toBeLessThanOrEqual(DEFAULT_E2E_CAPACITY);
  });

  it('classifies the clean-install Starter journey as startup-heavy', () => {
    const starterCleanInstall = bucketByName('starter-clean-install');
    expect(starterCleanInstall).toMatchObject({
      script: 'test:e2e:starter-clean-install',
      weight: 5,
    });
    expect(
      starterCleanInstall.weight + bucketByName('first-run').weight,
    ).toBeGreaterThan(DEFAULT_E2E_CAPACITY);
  });
});

describe('owned bucket lifecycle', () => {
  const bucket = { name: 'fixture', script: 'fixture-script', weight: 1 };

  it('terminates the complete owned group when captured output overflows', async () => {
    const execution = ownedExecutionFixture();
    const terminate = vi.fn(async () => {
      execution.settle({ status: null, signal: 'SIGTERM' });
      return { settled: true, errors: [] };
    });
    const runner = startBucket(bucket, {
      execute: () => execution,
      terminate,
      maxOutputBytes: 4,
    });

    execution.child.stdout.emit('data', Buffer.from('12345'));
    const result = await runner.promise;

    expect(terminate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      verdict: 'FAIL',
      interrupted: false,
      failureKind: 'overflow',
    });
    expect(result.runnerError).toContain('output exceeded 4 byte limit');
    expect(result.output).toContain('[output omitted');
  });

  it('cleans the owned group after a child-level runner error', async () => {
    const execution = ownedExecutionFixture();
    const terminate = vi.fn(async () => ({ settled: true, errors: [] }));
    const runner = startBucket(bucket, {
      execute: () => execution,
      terminate,
    });

    execution.settle({
      status: null,
      error: new Error('fixture spawn failed'),
    });
    const result = await runner.promise;

    expect(terminate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      verdict: 'FAIL',
      interrupted: false,
      failureKind: 'runner-error',
    });
    expect(result.runnerError).toContain('fixture spawn failed');
  });

  it('does not settle a failed bucket until its owned group cleanup settles', async () => {
    const execution = ownedExecutionFixture();
    const cleanup = deferred();
    const terminate = vi.fn(() => cleanup.promise);
    const runner = startBucket(bucket, {
      execute: () => execution,
      terminate,
    });
    let settled = false;
    void runner.promise.then(() => {
      settled = true;
    });

    execution.settle({ status: null, error: new Error('fixture crash') });
    await new Promise((resolve) => setImmediate(resolve));

    expect(terminate).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    cleanup.resolve({ settled: true, errors: [] });
    await expect(runner.promise).resolves.toMatchObject({ verdict: 'FAIL' });
  });

  it('settles cancellation after bounded cleanup even when the launcher never closes', async () => {
    const execution = ownedExecutionFixture();
    const terminate = vi.fn(async () => ({ settled: false, errors: [] }));
    const runner = startBucket(bucket, {
      execute: () => execution,
      terminate,
    });

    await runner.cancel('SIGINT');
    await expect(runner.promise).resolves.toMatchObject({
      verdict: 'FAIL',
      interrupted: true,
      failureKind: 'process-tree',
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('uses npm.cmd and only marks a Windows tree settled after taskkill succeeds', async () => {
    const execution = ownedExecutionFixture();
    const execute = vi.fn(() => execution);
    execution.terminate = vi.fn(async () => undefined);
    execution.forceTerminate = vi.fn(async () => undefined);
    const runner = startBucket(bucket, {
      execute,
      platform: 'win32',
    });

    const options = execute.mock.calls[0][4];
    expect(execute.mock.calls[0][0]).toBe('npm.cmd');
    expect(options).toMatchObject({ shell: false });
    expect(options.treeSettled()).toBe(false);
    await runner.cancel('SIGTERM');
    expect(options.treeSettled()).toBe(true);
    await expect(runner.promise).resolves.toMatchObject({
      failureKind: 'interrupted',
    });
  });

  it('keeps an ordinary process-tree cleanup failure distinct from interruption and overflow', async () => {
    const execution = ownedExecutionFixture();
    const terminate = vi.fn(async () => ({ settled: false, errors: [] }));
    const runner = startBucket(bucket, {
      execute: () => execution,
      terminate,
    });

    execution.isAlive = () => true;
    execution.settle({ status: 0, signal: null });
    const result = await runner.promise;
    expect(result).toMatchObject({
      verdict: 'FAIL',
      interrupted: false,
      failureKind: 'process-tree',
    });
    expect(result.runnerError).toContain('cleanup did not settle');
  });

  it('reports a settled cleanup escalation as dispatch failure, not non-settlement', async () => {
    const execution = ownedExecutionFixture();
    const terminate = vi.fn(async () => ({
      settled: true,
      errors: [new Error('SIGTERM failed before SIGKILL succeeded')],
    }));
    const runner = startBucket(bucket, {
      execute: () => execution,
      terminate,
    });

    execution.isAlive = () => true;
    execution.settle({ status: 0, signal: null });
    const result = await runner.promise;
    expect(result).toMatchObject({
      verdict: 'FAIL',
      failureKind: 'cleanup-dispatch',
    });
    expect(result.runnerError).toContain('cleanup required escalation');
    expect(result.runnerError).not.toContain('did not settle');
  });
});

describe('bucket filesystem isolation', () => {
  it('forbids fixed screenshot paths and invalid testInfo fixture destructuring repository-wide', () => {
    for (const path of listE2ESourceFiles()) {
      const source = readFileSync(path, 'utf8');
      expect(e2eArtifactPathErrors(path, source), path).toEqual([]);
      if (e2eManifest.some((entry) => entry.path === path))
        expect(source, path).not.toMatch(E2E_INVALID_TEST_INFO_PATTERN);
    }
    expect(readFileSync('playwright.config.ts', 'utf8')).toContain(
      "outputDir: process.env.STATION_E2E_OUTPUT_DIR || 'test-results'",
    );
    expect(readFileSync('scripts/run-e2e-suite.mjs', 'utf8')).toContain(
      'STATION_E2E_OUTPUT_DIR: outputRoot',
    );
    expect(readFileSync('scripts/run-e2e-suite.mjs', 'utf8')).toContain(
      "process.env.PLAYWRIGHT_BROWSERS_PATH ?? '0'",
    );
    const runner = readFileSync('scripts/run-e2e-suite.mjs', 'utf8');
    expect(
      runner
        .slice(runner.lastIndexOf('const cleanup = await cleanupE2ERun'))
        .indexOf('sweepRetainedE2ETestResults(process.cwd())'),
    ).toBeGreaterThan(0);
  });

  it('rejects Windows before admitting any E2E bucket', () => {
    expect(() => assertSupportedE2EPlatform('win32')).toThrow(
      'requires a POSIX host',
    );
    expect(() => assertSupportedE2EPlatform('darwin')).not.toThrow();
  });
});

describe('coverage arguments', () => {
  it('accepts one known --only list in canonical order', () => {
    expect(
      parseCoverageArgs(['--only=extended,screenshot']).map(
        (bucket) => bucket.name,
      ),
    ).toEqual(['extended', 'screenshot']);
  });

  it('fails closed for unknown, mixed, duplicate, and malformed arguments', () => {
    expect(() => parseCoverageArgs(['--only=missing'])).toThrow('Unknown E2E');
    expect(() => parseCoverageArgs(['--only=product', '--bogus'])).toThrow(
      'Unknown argument',
    );
    expect(() => parseCoverageArgs(['--only=product,product'])).toThrow(
      'more than once',
    );
    expect(() => parseCoverageArgs(['--only='])).toThrow('requires');
  });

  it('exits before spawning a bucket for unrecognized CLI arguments', () => {
    for (const argument of ['--only=unknown', '--only=product', '--bogus']) {
      const args =
        argument === '--only=product'
          ? ['scripts/run-e2e-coverage.mjs', argument, '--bogus']
          : ['scripts/run-e2e-coverage.mjs', argument];
      const result = spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Invalid E2E arguments');
      expect(result.stdout).not.toContain('e2e bucket:');
    }
  });

  it('uses the resolved file URL entry guard rather than a fragile string URL', () => {
    expect(readFileSync('scripts/run-e2e-coverage.mjs', 'utf8')).toContain(
      'pathToFileURL(resolve(process.argv[1])).href',
    );
  });
});

describe('E2E capacity configuration', () => {
  it('uses a conservative default and rejects malformed values', () => {
    expect(readCapacity(undefined)).toBe(DEFAULT_E2E_CAPACITY);
    expect(() => readCapacity('0')).toThrow('STATION_E2E_CAPACITY');
    expect(() => readCapacity('4.5')).toThrow('STATION_E2E_CAPACITY');
    expect(() => readCapacity('13')).toThrow('STATION_E2E_CAPACITY');
  });

  it('fails closed before launching a bucket when capacity cannot fit it', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-e2e-coverage.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, STATION_E2E_CAPACITY: '4' },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid E2E capacity');
    expect(result.stdout).not.toContain('e2e bucket:');
  });
});

describe('coverage contract', () => {
  it('runs every bucket the manifest assigns work to', () => {
    // The runner must cover the manifest's buckets, or coverage silently
    // narrows — the exact failure mode the && chain produced.
    const runner = readFileSync('scripts/run-e2e-coverage.mjs', 'utf8');
    const manifest = readFileSync('tests/e2e-manifest.mjs', 'utf8');
    const assigned = new Set(
      [...manifest.matchAll(/bucket:\s*'([a-z-]+)'/g)].map((m) => m[1]),
    );
    assigned.delete('pr-smoke'); // bounded pre-PR lane, not full coverage
    // Deliberately unrun (tests/e2e-manifest.mjs:236's own docblock, and the
    // manifest's `bucket === 'quarantine' && !entry.replacement` check that
    // requires every quarantined entry to name what it blocks on) — a spec
    // quarantined here is RED BY DESIGN until its `replacement` issue closes,
    // so admitting it to coverage would permanently red this gate for a
    // defect the spec exists to prove, not hide.
    assigned.delete('quarantine');
    for (const bucket of assigned) {
      expect(runner, `bucket ${bucket}`).toContain(`name: '${bucket}'`);
    }
  });

  it('does not chain buckets with && any more', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['verify:e2e:full']).not.toContain('&&');
  });
});
