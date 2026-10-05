import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DAILY_DRIVER_PROFILES } from '../daily-driver-profiles.mjs';
import { runDailyDriverUiQualification } from '../daily-driver-ui-qualification.mjs';
import { createDailyDriverUiObservation } from '../lib/daily-driver-ui-observation.mjs';

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync,
}));

const SOURCE_REVISION = 'b'.repeat(40);
const cleanCheckout = () => {};

function observation() {
  return createDailyDriverUiObservation({
    sourceRevision: SOURCE_REVISION,
    observations: DAILY_DRIVER_PROFILES.map((profile) => ({
      profile: profile.id,
      surface: 'ui',
      scenario: 'exact-confirmation',
      capability: 'exact-confirmation',
      repetition: 1,
      assistantMessageCount: 1,
      terminal: true,
      workingCleared: true,
      workingStable: true,
      commandBinding: true,
      identityBinding: true,
      projectBinding: true,
      classification: 'exact_match',
    })),
  });
}

describe('daily-driver UI qualification wrapper', () => {
  it('owns a fresh producer path, ingests it, and removes it after report creation', async () => {
    let temporaryDirectory = '';
    let revisionChecks = 0;
    let cleanlinessChecks = 0;
    const report = await runDailyDriverUiQualification({
      makeTemp: () => {
        temporaryDirectory = join(
          tmpdir(),
          'station-daily-driver-ui-wrapper-test',
        );
        return temporaryDirectory;
      },
      removeTemp: () => {
        temporaryDirectory = '';
      },
      resolveRevision: () => {
        revisionChecks += 1;
        return SOURCE_REVISION;
      },
      assertCheckoutClean: () => {
        cleanlinessChecks += 1;
      },
      fileExists: () => true,
      readFile: () => JSON.stringify(observation()),
      execute: ({ observationPath, revision, timeoutMs }) => {
        expect(observationPath).toBe(
          join(
            tmpdir(),
            'station-daily-driver-ui-wrapper-test',
            'observation.json',
          ),
        );
        expect(revision).toBe(SOURCE_REVISION);
        expect(timeoutMs).toBe(180_000);
        return { status: 0 };
      },
    });
    expect(temporaryDirectory).toBe('');
    expect(revisionChecks).toBe(2);
    expect(cleanlinessChecks).toBe(2);
    expect(
      report.rows.filter(
        (row) => row.surface === 'ui' && row.status === 'PASS',
      ),
    ).toHaveLength(2);
    expect(report.promotion.status).toBe('NOT_VERIFIED');
  });

  it('fails closed when the owned Playwright producer writes no observation', async () => {
    await expect(
      runDailyDriverUiQualification({
        makeTemp: () => join(tmpdir(), 'station-daily-driver-ui-missing-test'),
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: () => ({ status: 0 }),
        fileExists: () => false,
      }),
    ).rejects.toThrow(/wrote no observation/);
  });

  it('launches the focused product run against the owned observation path', async () => {
    const root = resolve('qualification-checkout');
    vi.stubEnv('PW_BASE_URL', 'http://inherited.example');
    spawnSync.mockReturnValue({ status: 0, signal: null });
    try {
      await runDailyDriverUiQualification({
        root,
        makeTemp: () => join(tmpdir(), 'station-daily-driver-ui-spawn-test'),
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        fileExists: () => true,
        readFile: () => JSON.stringify(observation()),
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(spawnSync).toHaveBeenCalledOnce();
    const [command, args, options] = spawnSync.mock.calls[0];
    expect([command, args]).toEqual([
      process.execPath,
      [
        resolve(root, 'scripts/run-e2e-suite.mjs'),
        '--suite=product',
        '--spec=tests/cross-runtime-chat-switching.spec.ts',
        '--grep=keeps deterministic Claude and Codex browser turns exact, settled, and project-bound',
      ],
    ]);
    expect(options).toMatchObject({
      cwd: root,
      stdio: 'inherit',
      timeout: 180_000,
      killSignal: 'SIGTERM',
    });
    expect(options.env).not.toHaveProperty('PW_BASE_URL');
    expect(options.env).toMatchObject({
      STATION_DAILY_DRIVER_UI_OBSERVATION_PATH: join(
        tmpdir(),
        'station-daily-driver-ui-spawn-test',
        'observation.json',
      ),
      STATION_DAILY_DRIVER_UI_SOURCE_REVISION: SOURCE_REVISION,
    });
  });

  it('does not expose a caller-supplied observation path through its public executable', () => {
    const source = readFileSync(
      new URL('../daily-driver-ui-qualification.mjs', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('process.argv');
  });

  it('fails closed when the checkout revision changes during its isolated run', async () => {
    let revisionChecks = 0;
    await expect(
      runDailyDriverUiQualification({
        makeTemp: () => join(tmpdir(), 'station-daily-driver-ui-revision-test'),
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => {
          revisionChecks += 1;
          return revisionChecks === 1 ? SOURCE_REVISION : 'c'.repeat(40);
        },
        execute: () => ({ status: 0 }),
        fileExists: () => true,
        readFile: () => JSON.stringify(observation()),
      }),
    ).rejects.toThrow(/checkout revision changed/);
  });

  it('fails closed when a producer artifact does not bind to the launched revision', async () => {
    const artifact = createDailyDriverUiObservation({
      sourceRevision: 'c'.repeat(40),
      observations: observation().observations.map(
        ({ digest: _digest, ...item }) => item,
      ),
    });
    await expect(
      runDailyDriverUiQualification({
        makeTemp: () =>
          join(tmpdir(), 'station-daily-driver-ui-provenance-test'),
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: () => ({ status: 0 }),
        fileExists: () => true,
        readFile: () => JSON.stringify(artifact),
      }),
    ).rejects.toThrow(/did not bind to the launched checkout revision/);
  });

  it('fails before launch when the checkout is dirty', async () => {
    let executed = false;
    await expect(
      runDailyDriverUiQualification({
        makeTemp: () =>
          join(tmpdir(), 'station-daily-driver-ui-dirty-before-test'),
        removeTemp() {},
        assertCheckoutClean: () => {
          throw new Error('checkout contains uncommitted changes');
        },
        execute: () => {
          executed = true;
          return { status: 0 };
        },
      }),
    ).rejects.toThrow(/uncommitted changes/);
    expect(executed).toBe(false);
  });

  it('fails after the isolated run when the checkout becomes dirty', async () => {
    let cleanlinessChecks = 0;
    let executed = false;
    await expect(
      runDailyDriverUiQualification({
        makeTemp: () =>
          join(tmpdir(), 'station-daily-driver-ui-dirty-after-test'),
        removeTemp() {},
        assertCheckoutClean: () => {
          cleanlinessChecks += 1;
          if (cleanlinessChecks === 2)
            throw new Error('checkout contains uncommitted changes');
        },
        resolveRevision: () => SOURCE_REVISION,
        execute: () => {
          executed = true;
          return { status: 0 };
        },
      }),
    ).rejects.toThrow(/uncommitted changes/);
    expect(cleanlinessChecks).toBe(2);
    expect(executed).toBe(true);
  });

  it('fails closed with a distinct error when the owned public runner times out', async () => {
    let requestedTimeoutMs = 0;
    await expect(
      runDailyDriverUiQualification({
        makeTemp: () => join(tmpdir(), 'station-daily-driver-ui-timeout-test'),
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: ({ timeoutMs }) => {
          requestedTimeoutMs = timeoutMs;
          const error = Object.assign(new Error('child timed out'), {
            code: 'ETIMEDOUT',
          });
          return { status: null, signal: 'SIGTERM', error };
        },
      }),
    ).rejects.toThrow(/timed out after 180000ms/);
    expect(requestedTimeoutMs).toBe(180_000);
  });

  it('keeps an actual temporary producer observation bounded', () => {
    const artifact = observation();
    const serialized = JSON.stringify(artifact);
    for (const forbidden of [
      'STATION_SMOKE_OK',
      'prompt',
      'credential',
      'sessionId',
      '/Users/',
      'C:\\Users\\',
    ])
      expect(serialized).not.toContain(forbidden);
  });
});
