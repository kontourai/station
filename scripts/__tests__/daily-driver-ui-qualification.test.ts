import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAILY_DRIVER_PROFILES } from '../daily-driver-profiles.mjs';
import { runDailyDriverUiQualification } from '../daily-driver-ui-qualification.mjs';
import { createDailyDriverUiObservation } from '../lib/daily-driver-ui-observation.mjs';

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
        temporaryDirectory = '/tmp/station-daily-driver-ui-wrapper-test';
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
          '/tmp/station-daily-driver-ui-wrapper-test/observation.json',
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
        makeTemp: () => '/tmp/station-daily-driver-ui-missing-test',
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: () => ({ status: 0 }),
        fileExists: () => false,
      }),
    ).rejects.toThrow(/wrote no observation/);
  });

  it('does not expose a caller-supplied observation path through its public executable', () => {
    const source = readFileSync(
      new URL('../daily-driver-ui-qualification.mjs', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('process.argv');
    expect(source).toContain("join(directory, 'observation.json')");
    expect(source).toContain("'scripts/run-e2e-suite.mjs'");
    expect(source).toContain('`--suite=$' + '{PRODUCT_SUITE}`');
    expect(source).toContain('const { PW_BASE_URL: _inheritedBaseUrl');
    expect(source).not.toContain('node_modules/@playwright/test/cli.js');
    expect(source).toContain("stdio: 'inherit'");
    expect(source).toContain('timeout: timeoutMs');
    expect(source).toContain("killSignal: 'SIGTERM'");
  });

  it('fails closed when the checkout revision changes during its isolated run', async () => {
    let revisionChecks = 0;
    await expect(
      runDailyDriverUiQualification({
        makeTemp: () => '/tmp/station-daily-driver-ui-revision-test',
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
        makeTemp: () => '/tmp/station-daily-driver-ui-provenance-test',
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
        makeTemp: () => '/tmp/station-daily-driver-ui-dirty-before-test',
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
        makeTemp: () => '/tmp/station-daily-driver-ui-dirty-after-test',
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
        makeTemp: () => '/tmp/station-daily-driver-ui-timeout-test',
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
