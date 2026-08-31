import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  appendE2EStartupOutputTail,
  assertSupportedE2EPlatform,
  awaitOwnedCommandDeadline,
  canReclaimE2ELease,
  classifyStartFailure,
  cleanupE2ERun,
  discoverE2EDaemon,
  E2E_SUITE_PORTS,
  e2ePhaseOutputRoot,
  e2eTestResultsRoot,
  establishedUserPlaywrightEnv,
  extractE2EUiBootstrapToken,
  issueE2EBrowserSession,
  playwrightBrowsersDirectory,
  portBiasJitter,
  processIdentity,
  recoverInterruptedE2ELease,
  removeE2ETestResults,
  renderE2EStartupFailureTail,
  retainE2EBucketFailureEvidence,
  runE2EExecutionPhases,
  seedE2EEngineChoice,
  settleE2EExecution,
  startWithPortRetry,
  suiteStationE2EEnv,
  sweepInterruptedBuildDirs,
  sweepRetainedE2ETestResults,
  terminateExactStarter,
  waitForE2EBootstrapReady,
  writeE2ERunLease,
} from '../run-e2e-suite.mjs';

let cleanupRoot: string | undefined;
const execFileAsync = promisify(execFile);
afterEach(() => {
  if (cleanupRoot) rmSync(cleanupRoot, { recursive: true, force: true });
  cleanupRoot = undefined;
});

describe('playwrightBrowsersDirectory', () => {
  test('uses Playwright local browser storage by default and for path zero', () => {
    const expected = join(
      '/repo',
      'node_modules',
      'playwright-core',
      '.local-browsers',
    );
    expect(playwrightBrowsersDirectory('/repo', undefined)).toBe(expected);
    expect(playwrightBrowsersDirectory('/repo', '0')).toBe(expected);
  });

  test('honors an explicit shared browser cache', () => {
    expect(playwrightBrowsersDirectory('/repo', '/cache/ms-playwright')).toBe(
      '/cache/ms-playwright',
    );
  });
});

describe('E2E browser session bootstrap', () => {
  const token = 'b'.repeat(43);
  const sessionCredential = 'c'.repeat(43);

  test('extracts the exact launcher capability from bounded startup output', () => {
    expect(
      extractE2EUiBootstrapToken(
        `build output\n  ✓ UI: http://localhost:5274/#station-ui-bootstrap=${token}\n`,
      ),
    ).toBe(token);
    expect(() => extractE2EUiBootstrapToken('no capability')).toThrow(
      'did not publish exactly one UI bootstrap token',
    );
  });

  test('exchanges the launcher capability for the browser session cookie', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'set-cookie': `station-device=${sessionCredential}; Path=/; HttpOnly; SameSite=Strict`,
      }),
    });

    await expect(
      issueE2EBrowserSession({ uiPort: 5274, token, fetchImpl }),
    ).resolves.toBe(sessionCredential);
    // station#3876: the exchange lands on the UI PORT — the authority
    // `station start` prints — so the host fixture is minted over the journey
    // an operator actually takes, and a regression in the proxy's locality
    // attestation reddens that fixture instead of hiding behind a
    // direct-socket mint no user performs. The Origin stays the UI origin:
    // that is where the cookie will be presented.
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:5274/.well-known/station/v1/pairing/ui-bootstrap',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:5274',
        },
        body: JSON.stringify({ token }),
      },
    );
  });

  test('refuses an exchange with no UI port to land on', async () => {
    // The dialled authority is the loopback `Host` the proxy attests
    // upstream, so a missing port is not a formatting problem: it would
    // produce a URL that either fails to parse or names some other service,
    // and the published credential would quietly stop being one a spec can
    // present alone to be the host.
    const fetchImpl = vi.fn();
    await expect(issueE2EBrowserSession({ token, fetchImpl })).rejects.toThrow(
      'E2E UI port is invalid',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('fails closed when the exchange omits a valid cookie', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
    await expect(
      issueE2EBrowserSession({ uiPort: 5274, token, fetchImpl }),
    ).rejects.toThrow('omitted a valid session cookie');
  });
});

describe('runE2EExecutionPhases', () => {
  test('runs every phase after an earlier red and reports the aggregate failure', async () => {
    const calls: string[] = [];
    const parallelError = new Error('parallel red');
    const exclusiveError = new Error('exclusive red');
    const failure = await runE2EExecutionPhases(
      [{ name: 'parallel-safe' }, { name: 'shared-instance-exclusive' }],
      async (phase) => {
        calls.push(phase.name);
        if (phase.name === 'parallel-safe') throw parallelError;
        throw exclusiveError;
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      parallelError,
      exclusiveError,
    ]);
    expect((failure as Error).message).toContain('parallel-safe: parallel red');
    expect((failure as Error).message).toContain(
      'shared-instance-exclusive: exclusive red',
    );
    expect(calls).toEqual(['parallel-safe', 'shared-instance-exclusive']);
  });

  test('gives product phases distinct nested roots and leaves other suites flat', () => {
    expect(e2ePhaseOutputRoot('/results/run', 'product', 'parallel-safe')).toBe(
      '/results/run/parallel-safe',
    );
    expect(
      e2ePhaseOutputRoot(
        '/results/run',
        'product',
        'shared-instance-exclusive',
      ),
    ).toBe('/results/run/shared-instance-exclusive');
    expect(e2ePhaseOutputRoot('/results/run', 'extended', 'extended')).toBe(
      '/results/run',
    );
  });
});

describe('full-run failure evidence retention', () => {
  test('routes both post-start test and cleanup failures through retention before rethrow', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../run-e2e-suite.mjs'),
      'utf8',
    );
    const finalizer = source.slice(
      source.indexOf('  } finally {', source.indexOf('await run(')),
    );
    expect(finalizer).toContain(
      'if (runFailure && process.env.STATION_E2E_EVIDENCE_ROOT)',
    );
    expect(finalizer).toContain('if (cleanup.errors.length > 0)');
    expect(finalizer.match(/retainE2EBucketFailureEvidence\(/g)).toHaveLength(
      2,
    );
  });

  test('copies both product phase failures without retaining Playwright bookkeeping', () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'station-e2e-retain-'));
    const resultRoot = join(cleanupRoot, 'test-results', 'e2e-product-fixture');
    const evidenceRoot = join(cleanupRoot, 'evidence');
    mkdirSync(join(resultRoot, 'parallel-safe', 'trace'), { recursive: true });
    mkdirSync(join(resultRoot, 'shared-instance-exclusive'), {
      recursive: true,
    });
    writeFileSync(
      join(resultRoot, 'parallel-safe', '.last-run.json'),
      '{"status":"failed"}',
    );
    writeFileSync(
      join(resultRoot, 'shared-instance-exclusive', '.last-run.json'),
      '{"status":"failed"}',
    );
    writeFileSync(
      join(resultRoot, 'parallel-safe', 'trace', 'failure.zip'),
      'parallel trace',
    );
    writeFileSync(
      join(resultRoot, 'shared-instance-exclusive', 'failure.png'),
      'exclusive screen',
    );
    expect(
      retainE2EBucketFailureEvidence({
        testResultsRoot: resultRoot,
        evidenceRoot,
        suite: 'product',
      }),
    ).toBe(true);
    expect(
      existsSync(
        join(
          evidenceRoot,
          'buckets',
          'product',
          'parallel-safe',
          '.last-run.json',
        ),
      ),
    ).toBe(false);
    expect(
      readFileSync(
        join(
          evidenceRoot,
          'buckets',
          'product',
          'shared-instance-exclusive',
          'failure.png',
        ),
        'utf8',
      ),
    ).toBe('exclusive screen');
    expect(
      readFileSync(
        join(
          evidenceRoot,
          'buckets',
          'product',
          'parallel-safe',
          'trace',
          'failure.zip',
        ),
        'utf8',
      ),
    ).toBe('parallel trace');
  });

  test('does not hide a non-file that uses the Playwright bookkeeping name', () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'station-e2e-retain-'));
    const resultRoot = join(cleanupRoot, 'test-results', 'e2e-product-fixture');
    mkdirSync(join(resultRoot, '.last-run.json'), { recursive: true });
    expect(() =>
      retainE2EBucketFailureEvidence({
        testResultsRoot: resultRoot,
        evidenceRoot: join(cleanupRoot, 'evidence'),
        suite: 'product',
      }),
    ).toThrow('ignored entry is not a regular file');
  });
});

describe('settleE2EExecution', () => {
  test('accepts a cleanly settled owned process result', async () => {
    await expect(
      settleE2EExecution(
        { completion: Promise.resolve({ status: 0 }), isAlive: () => false },
        'fixture E2E process',
      ),
    ).resolves.toEqual({ status: 0 });
  });

  test('fails closed when an owned descendant survives launcher completion', async () => {
    const terminate = vi.fn().mockResolvedValue({ settled: false, errors: [] });
    await expect(
      settleE2EExecution(
        { completion: Promise.resolve({ status: 0 }), isAlive: () => true },
        'fixture E2E process',
        { terminate, waitForSettlement: vi.fn() },
      ),
    ).rejects.toThrow('left an owned process group alive');
    expect(terminate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ processLabel: 'fixture E2E process' }),
    );
  });

  test('treats a settled cleanup with reported errors as non-settled', async () => {
    await expect(
      settleE2EExecution(
        { completion: Promise.resolve({ status: 0 }), isAlive: () => true },
        'fixture E2E process',
        {
          terminate: vi.fn().mockResolvedValue({
            settled: true,
            errors: [{ message: 'SIGTERM dispatch failed' }],
          }),
          waitForSettlement: vi.fn(),
        },
      ),
    ).rejects.toThrow('left an owned process group alive');
  });

  test('propagates a cleanup dispatch failure rather than releasing a possibly-live run', async () => {
    const terminate = vi
      .fn()
      .mockRejectedValue(new Error('SIGTERM dispatch did not settle'));
    await expect(
      settleE2EExecution(
        { completion: Promise.resolve({ status: 1 }), isAlive: () => true },
        'fixture E2E process',
        { terminate, waitForSettlement: vi.fn() },
      ),
    ).rejects.toThrow('SIGTERM dispatch did not settle');
  });
});

describe('awaitOwnedCommandDeadline', () => {
  test('returns a completed exact owned command and clears its deadline timer', async () => {
    const clearTimer = vi.fn();
    const result = await awaitOwnedCommandDeadline(
      { completion: Promise.resolve({ status: 0 }), isAlive: () => false },
      'fixture command',
      {
        deadlineMs: 120_000,
        setTimer: vi.fn(() => 41),
        clearTimer,
      },
    );
    expect(result).toEqual({ status: 0 });
    expect(clearTimer).toHaveBeenCalledWith(41);
  });

  test('times out through soft then forced exact-process-group termination', async () => {
    let alive = true;
    const softTerminate = vi.fn().mockResolvedValue(undefined);
    const forceTerminate = vi.fn().mockImplementation(async () => {
      alive = false;
    });
    const execution = {
      completion: new Promise(() => {}),
      isAlive: () => alive,
      terminate: softTerminate,
      forceTerminate,
    };
    await expect(
      awaitOwnedCommandDeadline(execution, 'fixture command', {
        deadlineMs: 120_000,
        terminationGraceMs: 7_500,
        terminationForceMs: 7_500,
        waitForSettlement: vi
          .fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
        setTimer: (callback) => {
          queueMicrotask(callback);
          return 42;
        },
      }),
    ).rejects.toThrow(/timed out after 120000ms.*SIGTERM and SIGKILL/);
    expect(softTerminate).toHaveBeenCalledOnce();
    expect(forceTerminate).toHaveBeenCalledOnce();
  });

  test('fails closed and names retained diagnostics when an exact group will not settle', async () => {
    const terminate = vi.fn().mockResolvedValue({
      settled: false,
      escalated: true,
      errors: [{ signal: 'SIGKILL', message: 'still alive' }],
    });
    await expect(
      awaitOwnedCommandDeadline(
        { completion: new Promise(() => {}), isAlive: () => true },
        'fixture command',
        {
          deadlineMs: 15_000,
          terminate,
          setTimer: (callback) => {
            queueMicrotask(callback);
            return 43;
          },
        },
      ),
    ).rejects.toThrow(/did not settle, retaining diagnostics and lease/);
  });
});

describe('E2E startup output', () => {
  test('retains only a bounded tail instead of replaying a build transcript', () => {
    const output = appendE2EStartupOutputTail(
      '',
      `first-line\n${'x'.repeat(20_000)}\nlast-line`,
      256,
    );
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(256);
    expect(output).toContain('last-line');
    expect(output).not.toContain('first-line');
  });

  test('renders a bounded useful startup failure tail and the server log pointer', () => {
    const rendered = renderE2EStartupFailureTail(
      `early\n${'x'.repeat(10_000)}\nrequested ports overlap another live Station instance`,
      '/tmp/e2e.log',
      300,
    );
    expect(Buffer.byteLength(rendered)).toBeLessThan(500);
    expect(rendered).toContain('requested ports overlap');
    expect(rendered).toContain('Server log: /tmp/e2e.log');
    expect(rendered).not.toContain('early');
  });
});

describe('E2E Playwright output roots', () => {
  test('rejects native Windows before starting Station', () => {
    expect(() => assertSupportedE2EPlatform('win32')).toThrow(
      'requires a POSIX host',
    );
    expect(() => assertSupportedE2EPlatform('linux')).not.toThrow();
  });

  test('gives every runner instance a distinct nested test-results root', () => {
    const root = '/tmp/station-e2e-root';
    const product = e2eTestResultsRoot(root, 'e2e-product-one');
    const extended = e2eTestResultsRoot(root, 'e2e-extended-two');
    expect(product).toBe(join(root, 'test-results', 'e2e-product-one'));
    expect(extended).toBe(join(root, 'test-results', 'e2e-extended-two'));
    expect(product).not.toBe(extended);
  });

  test('bounds completed result retention while preserving active leased roots', () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'station-e2e-results-'));
    const instances = ['e2e-product-a', 'e2e-product-b', 'e2e-product-c'];
    for (const [index, instance] of instances.entries()) {
      const resultRoot = e2eTestResultsRoot(cleanupRoot, instance);
      mkdirSync(resultRoot, { recursive: true });
      utimesSync(resultRoot, new Date(index + 1), new Date(index + 1));
    }
    const active = 'e2e-product-active';
    mkdirSync(e2eTestResultsRoot(cleanupRoot, active), { recursive: true });
    writeE2ERunLease(cleanupRoot, active, [
      `dist-server-${active}`,
      `dist-ui-${active}`,
    ]);

    expect(sweepRetainedE2ETestResults(cleanupRoot, { maxRetained: 2 })).toBe(
      1,
    );
    expect(existsSync(e2eTestResultsRoot(cleanupRoot, instances[0]))).toBe(
      false,
    );
    expect(existsSync(e2eTestResultsRoot(cleanupRoot, instances[1]))).toBe(
      true,
    );
    expect(existsSync(e2eTestResultsRoot(cleanupRoot, instances[2]))).toBe(
      true,
    );
    expect(existsSync(e2eTestResultsRoot(cleanupRoot, active))).toBe(true);
  });

  test('converges parallel completed failures to the retention bound after leases release', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'station-e2e-results-race-'));
    const completed = Array.from(
      { length: 36 },
      (_, index) => `e2e-product-completed-${index}`,
    );
    const active = Array.from(
      { length: 3 },
      (_, index) => `e2e-product-active-${index}`,
    );
    for (const instance of [...completed, ...active]) {
      mkdirSync(e2eTestResultsRoot(cleanupRoot, instance), { recursive: true });
    }
    for (const instance of active) {
      writeE2ERunLease(cleanupRoot, instance, [
        `dist-server-${instance}`,
        `dist-ui-${instance}`,
      ]);
    }

    const runnerUrl = pathToFileURL(resolve('scripts/run-e2e-suite.mjs')).href;
    const runConcurrentSweeps = () =>
      Promise.all(
        Array.from({ length: 8 }, () =>
          execFileAsync(process.execPath, [
            '--input-type=module',
            '--eval',
            `import { sweepRetainedE2ETestResults as sweep } from ${JSON.stringify(runnerUrl)}; sweep(${JSON.stringify(cleanupRoot)});`,
          ]),
        ),
      );

    await runConcurrentSweeps();
    expect(
      active.every((instance) =>
        existsSync(e2eTestResultsRoot(cleanupRoot, instance)),
      ),
    ).toBe(true);

    for (const instance of active) {
      rmSync(join(cleanupRoot, '.kontourai', 'e2e-runs', `${instance}.json`));
    }
    await runConcurrentSweeps();
    expect(
      readdirSync(join(cleanupRoot, 'test-results')).filter((name) =>
        name.startsWith('e2e-'),
      ),
    ).toHaveLength(12);
  });

  test('removes only a validated instance result root', () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'station-e2e-result-remove-'));
    const instance = 'e2e-product-finished';
    mkdirSync(e2eTestResultsRoot(cleanupRoot, instance), { recursive: true });
    removeE2ETestResults(cleanupRoot, instance);
    expect(existsSync(e2eTestResultsRoot(cleanupRoot, instance))).toBe(false);
    expect(() => removeE2ETestResults(cleanupRoot, '../outside')).toThrow(
      'unsafe E2E result instance',
    );
  });
});

describe('E2E daemon lease settlement', () => {
  const lease = {
    outputDirs: ['dist-server-e2e-fixture', 'dist-ui-e2e-fixture'],
    daemon: {
      server: { pid: 41, processStart: 'server-start', pgid: 41 },
      ui: { pid: 42, processStart: 'ui-start', pgid: 42 },
    },
  };

  test('retains outputs when a dead runner left either long-lived daemon alive', () => {
    expect(
      canReclaimE2ELease(lease, (pid: number) =>
        pid === 42 ? { pid, processStart: 'ui-start', pgid: 42 } : null,
      ),
    ).toBe(false);
  });

  test('permits reclamation only after both server and UI exact identities settle', () => {
    expect(canReclaimE2ELease(lease, () => null)).toBe(true);
  });

  test('a pre-daemon starting lease is never auto-reclaimed after its runner exits', () => {
    expect(
      canReclaimE2ELease(
        {
          outputDirs: ['dist-server-e2e-fixture'],
          runner: { pid: 43, processStart: 'runner-start', pgid: 43 },
        },
        () => null,
      ),
    ).toBe(false);
  });

  test('cleans a same-runner pre-daemon build failure and only its recorded outputs', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-starting-cleanup-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const runner = { pid: 41, processStart: 'runner-start', pgid: 41 };
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    mkdirSync(join(cleanupRoot, 'dist-ui-e2e-unowned'));
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        version: 2,
        root: resolve(cleanupRoot),
        instance,
        state: 'starting',
        runner,
        daemon: null,
        outputDirs: outputs,
      })}\n`,
    );
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    const stopInstance = vi.fn().mockResolvedValue(undefined);

    await expect(
      cleanupE2ERun({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance,
        runnerIdentity: runner,
      }),
    ).resolves.toEqual({ settled: true, errors: [] });

    expect(stopInstance).toHaveBeenCalledOnce();
    expect(existsSync(leasePath)).toBe(false);
    for (const output of outputs)
      expect(existsSync(join(cleanupRoot, output))).toBe(false);
    expect(existsSync(join(cleanupRoot, 'dist-ui-e2e-unowned'))).toBe(true);
  });

  test('retains a starting lease when its runner identity does not match', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-starting-retained-'));
    const instance = 'e2e-fixture';
    const output = `dist-ui-${instance}`;
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    mkdirSync(join(cleanupRoot, output));
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        version: 2,
        root: resolve(cleanupRoot),
        instance,
        state: 'starting',
        runner: { pid: 41, processStart: 'runner-start', pgid: 41 },
        daemon: null,
        outputDirs: [`dist-server-${instance}`, output],
      })}\n`,
    );
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));

    await expect(
      cleanupE2ERun({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance: vi.fn().mockResolvedValue(undefined),
        runnerIdentity: { pid: 42, processStart: 'successor', pgid: 42 },
      }),
    ).resolves.toEqual({
      settled: false,
      errors: ['E2E daemon did not prove settled; retaining lease and outputs'],
    });

    expect(existsSync(leasePath)).toBe(true);
    expect(existsSync(join(cleanupRoot, output))).toBe(true);
  });

  test('retains outputs when a same-instance successor replaced the lease', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-starting-successor-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    const runner = { pid: 41, processStart: 'runner-start', pgid: 41 };
    const original = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner,
      daemon: null,
      outputDirs: outputs,
    };
    writeFileSync(leasePath, `${JSON.stringify(original)}\n`);
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        ...original,
        runner: { pid: 42, processStart: 'successor', pgid: 42 },
      })}\n`,
    );

    const stopInstance = vi.fn().mockResolvedValue(undefined);
    await expect(
      cleanupE2ERun({
        root: cleanupRoot,
        leasePath,
        lease: original,
        stopInstance,
        runnerIdentity: runner,
      }),
    ).resolves.toEqual({
      settled: false,
      errors: ['E2E lease changed before cleanup; retaining lease and outputs'],
    });

    expect(stopInstance).not.toHaveBeenCalled();
    expect(existsSync(leasePath)).toBe(true);
    for (const output of outputs)
      expect(existsSync(join(cleanupRoot, output))).toBe(true);
  });

  test('retains a dead owner lock rather than auto-transferring it', () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-stale-lock-transfer-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leases = join(cleanupRoot, '.kontourai', 'e2e-runs');
    const lockPath = join(leases, `.${instance}.lock`);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({
        version: 1,
        kind: 'writer',
        token: 'dead-owner',
        process: { pid: 999_999, processStart: 'never', pgid: 999_999 },
      })}\n`,
    );

    expect(() => writeE2ERunLease(cleanupRoot!, instance, outputs)).toThrow(
      'E2E run is locked',
    );
    expect(
      JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')),
    ).toMatchObject({ token: 'dead-owner' });
    expect(existsSync(join(leases, `${instance}.json`))).toBe(false);
  });

  test('two contenders retain the same stale lock without an ABA ownership transfer', () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-stale-lock-contenders-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leases = join(cleanupRoot, '.kontourai', 'e2e-runs');
    const lockPath = join(leases, `.${instance}.lock`);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({
        version: 1,
        kind: 'writer',
        token: 'dead-owner',
        process: { pid: 999_999, processStart: 'never', pgid: 999_999 },
      })}\n`,
    );
    expect(() => writeE2ERunLease(cleanupRoot!, instance, outputs)).toThrow(
      'E2E run is locked',
    );
    expect(() => writeE2ERunLease(cleanupRoot!, instance, outputs)).toThrow(
      'E2E run is locked',
    );

    expect(
      JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')),
    ).toMatchObject({ token: 'dead-owner' });
    expect(existsSync(join(leases, `${instance}.json`))).toBe(false);
  });

  test('sweep does not delete outputs while an exact writer lock is held', () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-sweep-lock-boundary-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leases = join(cleanupRoot, '.kontourai', 'e2e-runs');
    const output = join(cleanupRoot, outputs[0]);
    mkdirSync(output, { recursive: true });
    const old = new Date(Date.now() - 24 * 3600_000);
    utimesSync(output, old, old);
    mkdirSync(leases, { recursive: true });
    writeFileSync(
      join(leases, `${instance}.json`),
      `${JSON.stringify({
        version: 2,
        root: resolve(cleanupRoot),
        instance,
        state: 'running',
        outputDirs: outputs,
        daemon: {
          server: { pid: 999_999, processStart: 'never', pgid: 999_999 },
          ui: { pid: 999_998, processStart: 'never', pgid: 999_998 },
        },
      })}\n`,
    );
    const owner = processIdentity(process.pid);
    expect(owner).not.toBeNull();
    const lockPath = join(leases, `.${instance}.lock`);
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({ version: 1, kind: 'writer', token: 'live', process: owner })}\n`,
    );

    expect(sweepInterruptedBuildDirs(cleanupRoot)).toBe(0);
    expect(existsSync(output)).toBe(true);
    expect(existsSync(join(leases, `${instance}.json`))).toBe(true);
  });

  test('retains a launcher-null crash window even while planned ports are free', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-crash-recovery-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    const lease = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      start: {
        serverPort: 43242,
        uiPort: 45274,
        launcher: null,
        groupMembers: [],
      },
      outputDirs: outputs,
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);
    const stopInstance = vi.fn();

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance,
        processIdentityFn: () => null,
        portAvailable: async () => true,
      }),
    ).resolves.toEqual({ reclaimed: false, removedOutputs: false });

    expect(stopInstance).not.toHaveBeenCalled();
    expect(existsSync(leasePath)).toBe(true);
    for (const output of outputs)
      expect(existsSync(join(cleanupRoot, output))).toBe(true);
  });

  test('settles the exact recorded starter and named instance before crash recovery', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-starter-recovery-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    const launcher = { pid: 42, processStart: 'starter', pgid: 42 };
    const lease = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      start: {
        serverPort: 43242,
        uiPort: 45274,
        launcher,
        groupMembers: [launcher],
      },
      outputDirs: outputs,
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);
    let starterLive = true;
    const terminateStarter = vi.fn(async () => {
      starterLive = false;
      return true;
    });
    const stopInstance = vi.fn().mockResolvedValue(undefined);

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance,
        processIdentityFn: (pid: number) =>
          pid === launcher.pid && starterLive ? launcher : null,
        portAvailable: async () => true,
        starterGroupIsLive: () => starterLive,
        terminateStarter,
      }),
    ).resolves.toEqual({ reclaimed: true, removedOutputs: true });

    expect(terminateStarter).toHaveBeenCalledWith(
      lease.start,
      expect.any(Function),
    );
    expect(stopInstance).toHaveBeenCalledWith(instance);
    expect(existsSync(leasePath)).toBe(false);
  });

  test('recovers a detached starter group after its leader exits but a descendant owns a planned port', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-detached-group-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    const launcher = { pid: 42, processStart: 'exited-leader', pgid: 42 };
    const lease = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      start: {
        serverPort: 43242,
        uiPort: 45274,
        launcher,
        groupMembers: [{ pid: 43, processStart: 'descendant', pgid: 42 }],
      },
      outputDirs: outputs,
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);
    const descendant = lease.start.groupMembers[0];
    let groupLive = true;
    const kill = vi.fn((_target: number, signal: number | NodeJS.Signals) => {
      if (signal === 'SIGTERM') groupLive = false;
      return true;
    });
    const stopInstance = vi.fn().mockResolvedValue(undefined);

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance,
        // The leader's PID is gone, but a recorded detached descendant still
        // proves the group belongs to this interrupted run.
        processIdentityFn: (pid: number) =>
          pid === descendant.pid && groupLive ? descendant : null,
        portAvailable: async () => !groupLive,
        terminateStarter: (start, processIdentityFn) =>
          terminateExactStarter(start, processIdentityFn, kill, async () => {}),
      }),
    ).resolves.toEqual({ reclaimed: true, removedOutputs: true });

    expect(kill).toHaveBeenCalledWith(-launcher.pgid, 'SIGTERM');
    expect(stopInstance).toHaveBeenCalledWith(instance);
    expect(existsSync(leasePath)).toBe(false);
    for (const output of outputs)
      expect(existsSync(join(cleanupRoot, output))).toBe(false);
  });

  test('refuses a leaderless numeric PGID without a matching persisted member', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-foreign-pgid-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    const launcher = { pid: 42, processStart: 'exited-leader', pgid: 42 };
    const lease = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      start: {
        serverPort: 43242,
        uiPort: 45274,
        launcher,
        groupMembers: [launcher],
      },
      outputDirs: outputs,
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);
    const kill = vi.fn((_target: number, _signal: number | NodeJS.Signals) => {
      throw new Error('foreign PGID must not receive a signal');
    });
    const stopInstance = vi.fn();

    await expect(
      terminateExactStarter(
        lease.start,
        () => null,
        kill,
        async () => {},
      ),
    ).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance,
        processIdentityFn: () => null,
        // A listener remains, but it may be in a reused/foreign PGID.
        portAvailable: async () => false,
        terminateStarter: (start, processIdentityFn) =>
          terminateExactStarter(start, processIdentityFn, kill, async () => {}),
      }),
    ).resolves.toEqual({ reclaimed: false, removedOutputs: false });

    expect(stopInstance).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(leasePath)).toBe(true);
    for (const output of outputs)
      expect(existsSync(join(cleanupRoot, output))).toBe(true);
  });

  test('blocks a successor writer during named-stop recovery until cleanup finishes', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-recovery-window-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    const launcher = { pid: 42, processStart: 'starter', pgid: 42 };
    const lease = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      start: {
        serverPort: 43242,
        uiPort: 45274,
        launcher,
        groupMembers: [launcher],
      },
      outputDirs: outputs,
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);
    let starterLive = true;
    let successorWriteError: unknown;
    const terminateStarter = vi.fn(async () => {
      starterLive = false;
      return true;
    });
    const stopInstance = vi.fn(async () => {
      // Deterministic mutation-window barrier: a successor cannot publish its
      // lease (and therefore must not begin its owned process) while recovery
      // holds the shared lock across named stop and group settlement.
      try {
        writeE2ERunLease(cleanupRoot!, instance, outputs);
      } catch (error) {
        successorWriteError = error;
      }
    });

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance,
        processIdentityFn: (pid: number) =>
          pid === launcher.pid && starterLive ? launcher : null,
        portAvailable: async () => !starterLive,
        terminateStarter,
      }),
    ).resolves.toEqual({ reclaimed: true, removedOutputs: true });

    expect(stopInstance).toHaveBeenCalledWith(instance);
    expect(terminateStarter).toHaveBeenCalledOnce();
    expect(successorWriteError).toBeInstanceOf(Error);
    expect((successorWriteError as Error).message).toContain(
      'E2E run is locked',
    );
    for (const output of outputs)
      expect(existsSync(join(cleanupRoot, output))).toBe(false);

    const successorLeasePath = writeE2ERunLease(cleanupRoot, instance, outputs);
    expect(existsSync(successorLeasePath)).toBe(true);
  });

  test('release cannot overwrite a writer that races a non-destructive recovery', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-recovery-release-race-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    const launcher = { pid: 42, processStart: 'exited', pgid: 42 };
    const lease = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      start: {
        serverPort: 43242,
        uiPort: 45274,
        launcher,
        groupMembers: [launcher],
      },
      outputDirs: outputs,
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);
    let writerError: unknown;

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance: vi.fn(),
        processIdentityFn: () => null,
        // Barrier at the release path: the writer has already reached its
        // publication call before recovery restores the stale lease.
        portAvailable: async () => {
          try {
            writeE2ERunLease(cleanupRoot!, instance, outputs);
          } catch (error) {
            writerError = error;
          }
          return false;
        },
      }),
    ).resolves.toEqual({ reclaimed: false, removedOutputs: false });

    expect(writerError).toBeInstanceOf(Error);
    expect((writerError as Error).message).toContain('E2E run is locked');
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toEqual(lease);
    for (const output of outputs)
      expect(existsSync(join(cleanupRoot, output))).toBe(true);

    const successorLeasePath = writeE2ERunLease(cleanupRoot, instance, outputs);
    expect(existsSync(successorLeasePath)).toBe(true);
  });

  test('recovery retains outputs when its lock is lost at the port-to-delete boundary', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-recovery-delete-boundary-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    const lockPath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `.${instance}.lock`,
    );
    const claimPath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `.${instance}.recovery.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    const launcher = { pid: 42, processStart: 'exited', pgid: 42 };
    const lease = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      start: {
        serverPort: 43242,
        uiPort: 45274,
        launcher,
        groupMembers: [launcher],
      },
      outputDirs: outputs,
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);
    let successorPublished = false;

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance: vi.fn(),
        processIdentityFn: () => null,
        portAvailable: async () => {
          if (!successorPublished) {
            successorPublished = true;
            // An adversarial lock loss is outside the cooperative protocol,
            // but must still turn deletion into a fail-closed retain.
            rmSync(lockPath, { recursive: true, force: true });
            rmSync(claimPath, { force: true });
            writeE2ERunLease(cleanupRoot!, instance, outputs);
          }
          return true;
        },
      }),
    ).resolves.toEqual({ reclaimed: false, removedOutputs: false });

    expect(successorPublished).toBe(true);
    expect(existsSync(leasePath)).toBe(true);
    for (const output of outputs)
      expect(existsSync(join(cleanupRoot, output))).toBe(true);
  });

  test('refuses recovery when a same-instance successor replaced the stale lease', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-recovery-successor-'));
    const instance = 'e2e-fixture';
    const outputs = [`dist-server-${instance}`, `dist-ui-${instance}`];
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    for (const output of outputs) mkdirSync(join(cleanupRoot, output));
    const lease = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      start: {
        serverPort: 43242,
        uiPort: 45274,
        launcher: null,
        groupMembers: [],
      },
      outputDirs: outputs,
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        ...lease,
        runner: { pid: 42, processStart: 'successor', pgid: 42 },
      })}\n`,
    );

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance: vi.fn(),
        processIdentityFn: () => null,
        portAvailable: async () => true,
      }),
    ).resolves.toEqual({ reclaimed: false, removedOutputs: false });

    expect(existsSync(leasePath)).toBe(true);
    for (const output of outputs)
      expect(existsSync(join(cleanupRoot, output))).toBe(true);
  });

  test('refuses recovery for a lease rooted in another worktree', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-recovery-foreign-'));
    const instance = 'e2e-fixture';
    const output = `dist-ui-${instance}`;
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    mkdirSync(join(cleanupRoot, output));
    const lease = {
      version: 2,
      root: '/another/worktree',
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      start: {
        serverPort: 43242,
        uiPort: 45274,
        launcher: null,
        groupMembers: [],
      },
      outputDirs: [`dist-server-${instance}`, output],
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);
    const stopInstance = vi.fn();

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance,
        processIdentityFn: () => null,
        portAvailable: async () => true,
      }),
    ).resolves.toEqual({ reclaimed: false, removedOutputs: false });

    expect(stopInstance).not.toHaveBeenCalled();
    expect(existsSync(leasePath)).toBe(true);
    expect(existsSync(join(cleanupRoot, output))).toBe(true);
  });

  test('removes a legacy dead starting lease only when both recorded outputs are absent', async () => {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-legacy-lease-'));
    const instance = 'e2e-fixture';
    const leasePath = join(
      cleanupRoot,
      '.kontourai',
      'e2e-runs',
      `${instance}.json`,
    );
    mkdirSync(join(cleanupRoot, '.kontourai', 'e2e-runs'), { recursive: true });
    const lease = {
      version: 2,
      root: resolve(cleanupRoot),
      instance,
      state: 'starting',
      runner: { pid: 41, processStart: 'dead-runner', pgid: 41 },
      daemon: null,
      outputDirs: [`dist-server-${instance}`, `dist-ui-${instance}`],
    };
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`);

    await expect(
      recoverInterruptedE2ELease({
        root: cleanupRoot,
        leasePath,
        lease,
        stopInstance: vi.fn(),
        processIdentityFn: () => null,
      }),
    ).resolves.toEqual({ reclaimed: true, removedOutputs: false });

    expect(existsSync(leasePath)).toBe(false);
  });
});

describe('discoverE2EDaemon', () => {
  const operatorCredential = 'a'.repeat(43);
  const registry = {
    serverPid: 41,
    uiPid: 42,
    bootId: 'boot-1',
    serverFingerprint: { pid: 41, startToken: 's' },
    uiFingerprint: { pid: 42, startToken: 'u' },
  };
  const identity = (pid: number) => ({
    pid,
    processStart: `start-${pid}`,
    pgid: pid,
  });

  function writeDaemonIdentityFixture(credentialRecord: unknown) {
    cleanupRoot = mkdtempSync(join(tmpdir(), 'e2e-daemon-identity-'));
    const instance = 'e2e-fixture';
    const home = join(cleanupRoot, 'station-home');
    mkdirSync(join(cleanupRoot, '.station', 'instances'), { recursive: true });
    mkdirSync(join(home, 'security'), { recursive: true });
    writeFileSync(
      join(cleanupRoot, '.station', 'instances', `${instance}.json`),
      JSON.stringify({ ...registry, baseDir: home }),
    );
    writeFileSync(
      join(home, 'security', 'environment.json'),
      JSON.stringify(credentialRecord),
    );
    return { root: cleanupRoot, instance };
  }

  test('authenticates the protected server identity from the exact disposable Station home', async () => {
    const fixture = writeDaemonIdentityFixture({
      credential: operatorCredential,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instanceId: 'e2e-fixture', bootId: 'boot-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instanceId: 'e2e-fixture', bootId: 'boot-1' }),
      });
    await expect(
      discoverE2EDaemon({
        ...fixture,
        serverPort: 3242,
        uiPort: 5274,
        fetchImpl,
        processIdentityFn: identity,
      }),
    ).resolves.toMatchObject({
      bootId: 'boot-1',
      server: { pid: 41 },
      ui: { pid: 42 },
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3242/api/system/identity',
      { headers: { Authorization: `Bearer ${operatorCredential}` } },
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'http://localhost:5274/__station/identity',
    );
  });

  test.each([
    ['missing', {}],
    ['malformed', { credential: 'not-a-valid-operator-credential' }],
  ])(
    'fails closed for a %s persisted operator credential before identity fetch',
    async (_label, credentialRecord) => {
      const fixture = writeDaemonIdentityFixture(credentialRecord);
      const fetchImpl = vi.fn();

      await expect(
        discoverE2EDaemon({
          ...fixture,
          serverPort: 3242,
          uiPort: 5274,
          fetchImpl,
          processIdentityFn: identity,
        }),
      ).rejects.toThrow('did not publish a valid operator credential');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test('binds both server and UI identity surfaces before recording the daemon', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instanceId: 'e2e-fixture', bootId: 'boot-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instanceId: 'e2e-fixture', bootId: 'boot-1' }),
      });
    await expect(
      discoverE2EDaemon({
        root: '/fixture',
        instance: 'e2e-fixture',
        serverPort: 3242,
        uiPort: 5274,
        fetchImpl,
        readRegistry: () => registry,
        readOperatorCredential: () => operatorCredential,
        processIdentityFn: identity,
      }),
    ).resolves.toMatchObject({
      bootId: 'boot-1',
      server: { pid: 41 },
      ui: { pid: 42 },
    });
  });

  test('rejects a UI boot identity mismatch', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instanceId: 'e2e-fixture', bootId: 'boot-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ instanceId: 'e2e-fixture', bootId: 'other' }),
      });
    await expect(
      discoverE2EDaemon({
        root: '/fixture',
        instance: 'e2e-fixture',
        serverPort: 3242,
        uiPort: 5274,
        fetchImpl,
        readRegistry: () => registry,
        readOperatorCredential: () => operatorCredential,
        processIdentityFn: identity,
      }),
    ).rejects.toThrow('registry and daemon boot identity differ');
  });
});

// station#1177: concurrent sessions' e2e runners shared fixed preferred
// ports; a TOCTOU loss past the free-port check surfaced as a FATAL abort
// ('managed boot identity mismatch' / identity 'fetch failed') instead of a
// retry, and every session herded onto the same starting block.
describe('classifyStartFailure (#1177)', () => {
  test("the CLI's registry-overlap rejection retries (pre-existing behavior)", () => {
    expect(
      classifyStartFailure(
        'error: requested ports overlap another live Station instance (agent-smoke)',
      ),
    ).toBe('port-overlap');
  });

  test('a boot-identity mismatch is a retryable port race, not fatal', () => {
    expect(
      classifyStartFailure(
        'Failed to start instance e2e-product-1785290894336-78jx3f. ' +
          'Timed out waiting for http://localhost:3242/api/system/identity (managed boot identity mismatch)',
      ),
    ).toBe('boot-race');
  });

  test('an identity wait that never got an answer is a retryable port race too', () => {
    expect(
      classifyStartFailure(
        'Timed out waiting for http://localhost:3542/api/system/identity (fetch failed)',
      ),
    ).toBe('boot-race');
  });

  test('a UI-port identity race is retryable too (review MED-2)', () => {
    expect(
      classifyStartFailure(
        'Timed out waiting for http://localhost:5574/__station/identity (managed boot identity mismatch)',
      ),
    ).toBe('boot-race');
  });

  test('the selected runtime port becoming unavailable is a retryable bind race', () => {
    expect(
      classifyStartFailure(
        'Failed to start server: Port 3572 is already in use or unavailable.',
        3572,
      ),
    ).toBe('boot-race');
    expect(
      classifyStartFailure(
        'Failed to start server: Port 3572 is already in use or unavailable.',
        3602,
      ),
    ).toBe('fatal');
  });

  test('anything else stays fatal — a broken boot must abort loudly', () => {
    expect(
      classifyStartFailure('TypeError: cannot read properties of undefined'),
    ).toBe('fatal');
    expect(
      classifyStartFailure('Build failed: esbuild exited with code 1'),
    ).toBe('fatal');
  });
});

describe('portBiasJitter (#1177)', () => {
  test('is a whole number of 30-port blocks within the bounded band', () => {
    for (const seed of [0, 0.1, 0.5, 0.99, 0.999999]) {
      const jitter = portBiasJitter(() => seed);
      expect(jitter % 30).toBe(0);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThanOrEqual(16 * 30);
    }
  });

  test('is seedable and deterministic for a fixed random source', () => {
    expect(portBiasJitter(() => 0)).toBe(0);
    expect(portBiasJitter(() => 0.5)).toBe(240);
  });

  test('distinct sessions with distinct randomness get distinct blocks', () => {
    expect(portBiasJitter(() => 0.1)).not.toBe(portBiasJitter(() => 0.9));
  });
});

describe('seedE2EEngineChoice', () => {
  const operatorCredential = 'a'.repeat(43);

  test('persists explicit Station for ordinary ready-suite homes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    await seedE2EEngineChoice(
      'http://localhost:3242',
      operatorCredential,
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3242/config/app', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${operatorCredential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ builtinAgentEngineConnectionId: null }),
    });
  });

  test('fails before Playwright when the engine choice cannot be seeded', async () => {
    await expect(
      seedE2EEngineChoice(
        'http://localhost:3242',
        operatorCredential,
        vi.fn().mockResolvedValue({ ok: false, status: 500 }),
      ),
    ).rejects.toThrow('HTTP 500');
  });

  test('fails closed before config mutation when the credential is missing', async () => {
    const fetchImpl = vi.fn();
    await expect(
      seedE2EEngineChoice('http://localhost:3242', undefined, fetchImpl),
    ).rejects.toThrow('operator credential is missing or malformed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('waitForE2EBootstrapReady', () => {
  const operatorCredential = 'a'.repeat(43);

  test('authenticates protected readiness calls and leaves UI readiness credential-free', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    await waitForE2EBootstrapReady({
      serverPort: 3242,
      uiPort: 5274,
      operatorCredential,
      fetchImpl,
    });

    expect(fetchImpl.mock.calls).toEqual([
      [
        'http://localhost:3242/api/system/status',
        { headers: { Authorization: `Bearer ${operatorCredential}` } },
      ],
      [
        'http://localhost:3242/config/app',
        { headers: { Authorization: `Bearer ${operatorCredential}` } },
      ],
      ['http://localhost:5274/'],
    ]);
  });

  test.each([undefined, 'not-a-valid-operator-credential'])(
    'fails closed before readiness fetch for invalid credential %s',
    async (operatorCredential) => {
      const fetchImpl = vi.fn();
      await expect(
        waitForE2EBootstrapReady({
          serverPort: 3242,
          uiPort: 5274,
          operatorCredential,
          fetchImpl,
        }),
      ).rejects.toThrow('operator credential is missing or malformed');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

describe('establishedUserPlaywrightEnv', () => {
  test('marks ordinary suites as established browser profiles', () => {
    expect(establishedUserPlaywrightEnv('product')).toEqual({
      STATION_E2E_ESTABLISHED_USER: '1',
    });
    expect(establishedUserPlaywrightEnv('extended')).toEqual({
      STATION_E2E_ESTABLISHED_USER: '1',
    });
  });

  test('leaves clean-install suites without established browser state', () => {
    expect(establishedUserPlaywrightEnv('first-run')).toEqual({});
    expect(establishedUserPlaywrightEnv('starter-clean-install')).toEqual({});
  });
});

describe('suiteStationE2EEnv', () => {
  test('gives the Starter clean-install journey a fresh first-run environment with telemetry disabled', () => {
    expect(suiteStationE2EEnv('starter-clean-install')).toEqual({
      STATION_E2E_FIRST_RUN: '1',
      STATION_TELEMETRY_ENABLED: 'false',
      STATION_TELEMETRY_ENDPOINT: '',
      STATION_USAGE_TELEMETRY_KEY: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      STATION_TELEMETRY_API_KEY: '',
    });
  });

  test('does not weaken ordinary or existing first-run suite setup', () => {
    expect(suiteStationE2EEnv('first-run')).toEqual({
      STATION_E2E_FIRST_RUN: '1',
    });
    expect(suiteStationE2EEnv('product')).toEqual({
      STATION_E2E_SYSTEM_STATUS_READY: '1',
    });
  });

  // #550: the muse real-turn journey needs muse's own `echo` provider, which
  // Station only reaches when this variable names it.
  test('gives the smoke-live server muse’s echo provider, and only that suite', () => {
    expect(suiteStationE2EEnv('smoke-live')).toEqual({
      STATION_E2E_SYSTEM_STATUS_READY: '1',
      STATION_E2E_MUSE_PROVIDER: 'echo',
    });

    // station#4464: the key must be PRESENT-and-undefined in every other
    // branch, not absent. Both consumers spread this object after
    // `...process.env`, so an absent key lets a stray inherited
    // STATION_E2E_MUSE_PROVIDER reach a suite that never asked for it, while
    // an explicit `undefined` overrides it and is then dropped by `spawn`.
    //
    // Asserting presence is what makes this discriminate. Neither
    // `not.toHaveProperty(...)` nor `toEqual` can: the first is SATISFIED by
    // the omission it is meant to catch, and `toEqual` ignores
    // undefined-valued properties, so both stay green on the leaking shape.
    for (const suite of [
      'product',
      'extended',
      'first-run',
      'starter-clean-install',
      'screenshot',
      'android',
    ]) {
      const env = suiteStationE2EEnv(suite);
      expect(
        Object.keys(env),
        `${suite} must set STATION_E2E_MUSE_PROVIDER explicitly, so a stray inherited value cannot survive into it`,
      ).toContain('STATION_E2E_MUSE_PROVIDER');
      expect(
        env.STATION_E2E_MUSE_PROVIDER,
        `${suite} must not carry the muse echo override`,
      ).toBeUndefined();
    }
  });
});

describe('Starter clean-install suite routing', () => {
  test('reserves a dedicated preferred port pair for its fresh temp-home instance', () => {
    expect(E2E_SUITE_PORTS['starter-clean-install']).toEqual({
      server: 3342,
      ui: 5374,
    });
    const otherPorts = Object.entries(E2E_SUITE_PORTS).filter(
      ([suite]) => suite !== 'starter-clean-install',
    );
    for (const [, ports] of otherPorts) {
      expect(ports.server).not.toBe(3342);
      expect(ports.ui).not.toBe(5374);
    }
  });
});

// Review LOW: pin the loop behavior itself, not just the classifier —
// advancement, cleanup, fatal termination, and exhaustion diagnostics.
describe('startWithPortRetry (#1177 review round 1)', () => {
  function harness(outputs: Array<{ code: number; output: string }>) {
    const calls: Array<{ serverPort: number; uiPort: number }> = [];
    const stops: number[] = [];
    const warnings: string[] = [];
    let index = 0;
    return {
      calls,
      stops,
      warnings,
      deps: {
        label: 'e2e-test-instance',
        logPath: '/tmp/e2e-test-instance.log',
        preferredPorts: { server: 3242, ui: 5274 },
        maxAttempts: 3,
        pickServerPort: async (bias: number) => bias,
        pickUiPort: async (bias: number) => bias,
        startInstance: async (serverPort: number, uiPort: number) => {
          calls.push({ serverPort, uiPort });
          return outputs[Math.min(index++, outputs.length - 1)];
        },
        stopInstance: async () => {
          stops.push(index);
        },
        warn: (message: string) => {
          warnings.push(message);
        },
      },
    };
  }

  test('a boot-race advances to the next +30 block, cleans up, and succeeds', async () => {
    const { deps, calls, stops } = harness([
      {
        code: 1,
        output:
          'Timed out waiting for http://localhost:3242/api/system/identity (managed boot identity mismatch)',
      },
      { code: 0, output: '' },
    ]);
    const result = await startWithPortRetry(deps);
    expect(calls.map((call) => call.serverPort)).toEqual([3242, 3272]);
    expect(stops).toHaveLength(1);
    expect(result).toEqual({ serverPort: 3272, uiPort: 5304 });
  });

  test('an exact selected-port bind race advances and cleans up', async () => {
    const { deps, calls, stops } = harness([
      {
        code: 1,
        output:
          'Failed to start server: Port 3242 is already in use or unavailable.',
      },
      { code: 0, output: '' },
    ]);
    const result = await startWithPortRetry(deps);
    expect(calls.map((call) => call.serverPort)).toEqual([3242, 3272]);
    expect(stops).toHaveLength(1);
    expect(result).toEqual({ serverPort: 3272, uiPort: 5304 });
  });

  test('a fatal failure aborts immediately without cleanup retries', async () => {
    const { deps, calls, stops } = harness([
      { code: 2, output: 'Build failed: esbuild exited with code 1' },
    ]);
    await expect(startWithPortRetry(deps)).rejects.toThrow(
      /for e2e-test-instance \(exit 2\) — not a port collision/,
    );
    expect(calls).toHaveLength(1);
    expect(stops).toHaveLength(0);
  });

  test('exhaustion reports the last classified failure with its output tail (review MED-1)', async () => {
    const { deps } = harness([
      {
        code: 1,
        output:
          'Timed out waiting for http://localhost:3242/api/system/identity (fetch failed)',
      },
    ]);
    await expect(startWithPortRetry(deps)).rejects.toThrow(
      /last failure was 'boot-race'[\s\S]*fetch failed/,
    );
  });
});
