import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAILY_DRIVER_PROFILES } from '../daily-driver-profiles.mjs';
import { runDailyDriverScenarioQualification } from '../daily-driver-scenario-qualification.mjs';
import { createDailyDriverScenarioObservation } from '../lib/daily-driver-scenario-observation.mjs';

const SOURCE_REVISION = 'b'.repeat(40);
const cleanCheckout = () => {};

function observationArtifact(sourceRevision = SOURCE_REVISION) {
  return createDailyDriverScenarioObservation({
    sourceRevision,
    observations: [
      ...DAILY_DRIVER_PROFILES.flatMap((profile) => [
        {
          profile: profile.id,
          surface: 'ui',
          scenario: 'conversation-agreement',
          capability: 'conversation-agreement',
          repetition: 1,
          completedTurns: 3,
          conversationStable: true,
          carryOverBound: true,
          continuationRouteUsed: true,
          distinctSessionCount: 3,
          terminalPredecessorCount: 2,
          terminalReuseRefused: true,
          persistedLineage: true,
          reloadExactlyOnce: true,
          settled: true,
          classification: 'context_carryover',
        },
        {
          profile: profile.id,
          surface: 'ui',
          scenario: 'liveness-settlement',
          capability: 'liveness-settlement',
          repetition: 1,
          answerRenderings: 1,
          liveRowsAfterResume: 0,
          failureRenderings: 1,
          failureBanners: 0,
          classification: 'settled_once',
        },
        {
          profile: profile.id,
          surface: 'ui',
          scenario: 'transcript-stability',
          capability: 'transcript-stability',
          repetition: 1,
          fixtureTurnCount: 10000,
          mountedRowCap: 200,
          maxMountedRows: 48,
          loadedRows: 420,
          orderStable: true,
          tailBound: true,
          restoreSamplesMs: [210, 190, 240],
          classification: 'structurally_bounded',
        },
        {
          profile: profile.id,
          surface: 'ui',
          scenario: 'performance-stress',
          capability: 'performance-stress',
          repetition: 1,
          scrollHeldDuringStream: true,
          taskSwitchStable: true,
          queueDrained: true,
          mountedRowsDuringStream: 80,
          loadedRows: 420,
          mountedRowCap: 200,
          settled: true,
          deltaPaintSamplesMs: [9, 14, 22, 11, 17],
          classification: 'stress_bounded',
        },
      ]),
      {
        profile: 'claude-default',
        surface: 'ui',
        scenario: 'agent-engine-handoff',
        capability: 'agent-engine-handoff',
        repetition: 1,
        targetProfile: 'codex-default',
        explicitRouteUsed: true,
        conversationStable: true,
        targetSessionDistinct: true,
        disclosureComplete: true,
        targetAgentApplied: true,
        persistedMarker: true,
        markerExactlyOnce: true,
      },
    ],
  });
}

describe('daily-driver scenario qualification wrapper', () => {
  it('owns a fresh producer directory, merges its artifacts, and reports scenario rows', async () => {
    let temporaryDirectory = '';
    let revisionChecks = 0;
    let cleanlinessChecks = 0;
    const artifact = observationArtifact();
    const report = await runDailyDriverScenarioQualification({
      makeTemp: () => {
        temporaryDirectory = '/tmp/station-daily-driver-scenarios-wrapper-test';
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
      listFiles: () => ['conversation-agreement.json'],
      readFile: () => JSON.stringify(artifact),
      execute: ({ observationDir, revision, timeoutMs }) => {
        expect(observationDir).toBe(
          '/tmp/station-daily-driver-scenarios-wrapper-test',
        );
        expect(revision).toBe(SOURCE_REVISION);
        expect(timeoutMs).toBe(900_000);
        return { status: 0 };
      },
    });
    expect(temporaryDirectory).toBe('');
    expect(revisionChecks).toBe(2);
    expect(cleanlinessChecks).toBe(2);
    const scenarioRows = report.rows.filter(
      (row: { surface: string; status: string }) =>
        row.surface === 'ui' && row.status === 'PASS',
    );
    expect(scenarioRows).toHaveLength(9);
    expect(report.timing.reasonCode).toBe('PRODUCT_TIMING_PARTIALLY_MEASURED');
    expect(report.timing.aggregates).toHaveLength(4);
    expect(report.promotion.status).toBe('NOT_VERIFIED');
  });

  it('fails closed when the producer writes no observations', async () => {
    await expect(
      runDailyDriverScenarioQualification({
        makeTemp: () => '/tmp/station-daily-driver-scenarios-missing-test',
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: () => ({ status: 0 }),
        listFiles: () => [],
      }),
    ).rejects.toThrow(/wrote no observations/);
  });

  it('fails closed when the producer omits the required handoff artifact', async () => {
    const artifact = structuredClone(observationArtifact());
    artifact.observations = artifact.observations.filter(
      (observation) => observation.scenario !== 'agent-engine-handoff',
    );
    await expect(
      runDailyDriverScenarioQualification({
        makeTemp: () => '/tmp/station-daily-driver-scenarios-no-handoff-test',
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: () => ({ status: 0 }),
        listFiles: () => ['legacy-scenarios.json'],
        readFile: () => JSON.stringify(artifact),
      }),
    ).rejects.toThrow(/missing required coverage.*agent-engine-handoff/);
  });

  it('fails closed when the handoff artifact carries a valid failing verdict', async () => {
    const observations = observationArtifact().observations.map(
      ({
        digest: _digest,
        expectationMet: _met,
        classification: _class,
        ...item
      }) =>
        item.scenario === 'agent-engine-handoff'
          ? { ...item, persistedMarker: false }
          : item,
    );
    const artifact = createDailyDriverScenarioObservation({
      sourceRevision: SOURCE_REVISION,
      observations,
    });
    await expect(
      runDailyDriverScenarioQualification({
        makeTemp: () => '/tmp/station-daily-driver-scenarios-bad-handoff-test',
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: () => ({ status: 0 }),
        listFiles: () => ['all-scenarios.json'],
        readFile: () => JSON.stringify(artifact),
      }),
    ).rejects.toThrow(
      /did not prove the required Claude Code to Codex handoff/,
    );
  });

  it('fails closed when the required handoff artifact digest is tampered', async () => {
    const artifact = structuredClone(observationArtifact());
    const handoff = artifact.observations.find(
      (observation) => observation.scenario === 'agent-engine-handoff',
    );
    if (!handoff) throw new Error('expected a handoff observation');
    handoff.digest = '0'.repeat(64);
    await expect(
      runDailyDriverScenarioQualification({
        makeTemp: () => '/tmp/station-daily-driver-scenarios-tamper-test',
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: () => ({ status: 0 }),
        listFiles: () => ['all-scenarios.json'],
        readFile: () => JSON.stringify(artifact),
      }),
    ).rejects.toThrow(/tampered digest/);
  });

  it('fails closed when an artifact does not bind to the launched revision', async () => {
    await expect(
      runDailyDriverScenarioQualification({
        makeTemp: () => '/tmp/station-daily-driver-scenarios-provenance-test',
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: () => ({ status: 0 }),
        listFiles: () => ['transcript-stability.json'],
        readFile: () => JSON.stringify(observationArtifact('c'.repeat(40))),
      }),
    ).rejects.toThrow(/did not bind to the launched checkout revision/);
  });

  it('fails closed when the checkout revision changes during its isolated run', async () => {
    let revisionChecks = 0;
    await expect(
      runDailyDriverScenarioQualification({
        makeTemp: () => '/tmp/station-daily-driver-scenarios-revision-test',
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => {
          revisionChecks += 1;
          return revisionChecks === 1 ? SOURCE_REVISION : 'c'.repeat(40);
        },
        execute: () => ({ status: 0 }),
        listFiles: () => ['performance-stress.json'],
        readFile: () =>
          JSON.stringify(
            createDailyDriverScenarioObservation({
              // Bound to check #1's revision so binding passes and the
              // revision-drift check is the one that fires.
              sourceRevision: SOURCE_REVISION,
              observations: observationArtifact().observations.map(
                ({ digest: _digest, expectationMet: _met, ...item }) => item,
              ),
            }),
          ),
      }),
    ).rejects.toThrow(/checkout revision changed/);
  });

  it('fails before launch when the checkout is dirty', async () => {
    let executed = false;
    await expect(
      runDailyDriverScenarioQualification({
        makeTemp: () => '/tmp/station-daily-driver-scenarios-dirty-test',
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

  it('fails closed with a distinct error when the owned public runner times out', async () => {
    await expect(
      runDailyDriverScenarioQualification({
        makeTemp: () => '/tmp/station-daily-driver-scenarios-timeout-test',
        removeTemp() {},
        assertCheckoutClean: cleanCheckout,
        resolveRevision: () => SOURCE_REVISION,
        execute: () => ({
          status: null,
          signal: 'SIGTERM',
          error: Object.assign(new Error('child timed out'), {
            code: 'ETIMEDOUT',
          }),
        }),
      }),
    ).rejects.toThrow(/timed out after 900000ms/);
  });

  it('does not expose a caller-supplied observation path through its public executable', () => {
    const source = readFileSync(
      new URL('../daily-driver-scenario-qualification.mjs', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('process.argv');
    expect(source).toContain("'scripts/run-e2e-suite.mjs'");
    expect(source).toContain('`--suite=$' + '{PRODUCT_SUITE}`');
    expect(source).toContain('for (const run of QUALIFICATION_RUNS)');
    expect(source).toContain('`--spec=$' + '{run.spec}`');
    expect(source).toContain('`--grep=$' + '{run.grep}`');
    expect(source).toContain("grep: 'daily-driver scenario qualification'");
    expect(source).toContain(
      "grep: 'Agent handoff uses the Continue-with dialog'",
    );
    expect(source).toContain('const { PW_BASE_URL: _inheritedBaseUrl');
    expect(source).not.toContain('node_modules/@playwright/test/cli.js');
    expect(source).toContain("stdio: 'inherit'");
    expect(source).toContain('timeout: remainingMs');
    expect(source).toContain("killSignal: 'SIGTERM'");
  });
});
