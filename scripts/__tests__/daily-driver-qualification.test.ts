import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import schema from '../../schemas/daily-driver-qualification.schema.json' with {
  type: 'json',
};
import { DAILY_DRIVER_PROFILES } from '../daily-driver-profiles.mjs';
import {
  assertDailyDriverQualificationSemantics,
  calculateTiming,
  classifyExactConfirmation,
  createDailyDriverQualificationReport,
  EXACT_CONFIRMATION,
  runControlledTimeoutLifecycle,
} from '../lib/daily-driver-qualification.mjs';
import {
  assertDailyDriverScenarioObservationSemantics,
  createDailyDriverScenarioObservation,
  mergeDailyDriverScenarioObservations,
} from '../lib/daily-driver-scenario-observation.mjs';
import {
  assertDailyDriverUiObservationSemantics,
  createDailyDriverUiObservation,
} from '../lib/daily-driver-ui-observation.mjs';

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const SOURCE_REVISION = 'a'.repeat(40);

function uiObservationRows(overrides = {}) {
  return DAILY_DRIVER_PROFILES.map((profile) => ({
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
    ...overrides,
  }));
}

function uiObservation(overrides = {}) {
  return createDailyDriverUiObservation({
    sourceRevision: SOURCE_REVISION,
    observations: uiObservationRows(),
    ...overrides,
  });
}

function scenarioObservationRows(overrides: Record<string, unknown> = {}) {
  return DAILY_DRIVER_PROFILES.flatMap((profile) => [
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
      ...overrides,
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
      maxMountedRows: 64,
      loadedRows: 420,
      orderStable: true,
      tailBound: true,
      restoreSamplesMs: [180, 220, 205],
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
      mountedRowsDuringStream: 72,
      loadedRows: 420,
      mountedRowCap: 200,
      settled: true,
      deltaPaintSamplesMs: [12, 30, 24, 41, 18],
      classification: 'stress_bounded',
    },
  ]);
}

function scenarioObservation(observations = scenarioObservationRows()) {
  return createDailyDriverScenarioObservation({
    sourceRevision: SOURCE_REVISION,
    observations,
  });
}

function handoffObservation(overrides: Record<string, unknown> = {}) {
  return createDailyDriverScenarioObservation({
    sourceRevision: SOURCE_REVISION,
    observations: [
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
        ...overrides,
      },
    ],
  });
}

describe('daily-driver qualification', () => {
  it('uses exact trimmed confirmation and rejects every near match', () => {
    expect(classifyExactConfirmation(`  ${EXACT_CONFIRMATION}\n`)).toBe(
      'exact_match',
    );
    for (const value of [
      null,
      '',
      `\`${EXACT_CONFIRMATION}\``,
      `prefix ${EXACT_CONFIRMATION}`,
      `${EXACT_CONFIRMATION} suffix`,
    ])
      expect(classifyExactConfirmation(value)).toBe('rejected');
  });

  it('creates an honest deterministic report for both profiles', async () => {
    const report = await createDailyDriverQualificationReport({
      repetitions: 2,
      timeoutMs: 1,
    });

    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(report.profiles.map((profile) => profile.id)).toEqual([
      'codex-default',
      'claude-default',
    ]);
    expect(report.scenarios).toHaveLength(9);
    expect(report.run.harnessStatus).toBe('PASS');
    expect(report.promotion).toEqual({
      status: 'NOT_VERIFIED',
      reasonCodes: ['REQUIRED_LIVE_ROWS_NOT_VERIFIED'],
    });

    const harnessExactRows = report.rows.filter(
      (row) =>
        row.surface === 'deterministic-harness' &&
        row.scenario === 'exact-confirmation',
    );
    expect(harnessExactRows).toHaveLength(4);
    expect(harnessExactRows.every((row) => row.status === 'PASS')).toBe(true);
    expect(
      harnessExactRows.flatMap((row) =>
        row.evidence.observations.map((item) => item.outcome),
      ),
    ).toContain('timeout');
    expect(report.rows).toHaveLength(144);
    for (const surface of ['deterministic-harness', 'ui', 'cli', 'phone'])
      expect(report.rows.filter((row) => row.surface === surface)).toHaveLength(
        36,
      );
    expect(
      report.rows.filter((row) => row.status === 'NOT_VERIFIED'),
    ).toHaveLength(140);

    const agreementRows = report.rows.filter(
      (row) =>
        row.surface === 'deterministic-harness' &&
        row.scenario === 'conversation-agreement',
    );
    expect(agreementRows).toHaveLength(4);
    for (const row of agreementRows) {
      expect(row.status).toBe('NOT_VERIFIED');
      expect(row.reasonCode).toBe(
        'REAL_LIFECYCLE_ROUTE_QUALIFICATION_REQUIRED',
      );
      expect(row.evidence.observations).toEqual([]);
    }
    const handoffRows = report.rows.filter(
      (row) =>
        row.surface === 'deterministic-harness' &&
        row.scenario === 'agent-engine-handoff',
    );
    expect(handoffRows).toHaveLength(4);
    for (const row of handoffRows)
      expect(row).toMatchObject({
        status: 'NOT_VERIFIED',
        reasonCode: 'SCENARIO_NOT_IMPLEMENTED_IN_HARNESS',
        evidence: { observations: [] },
      });
    const browserOnlyRows = report.rows.filter(
      (row) =>
        row.surface === 'deterministic-harness' &&
        ['transcript-stability', 'performance-stress'].includes(row.scenario),
    );
    expect(browserOnlyRows).toHaveLength(8);
    for (const row of browserOnlyRows)
      expect(row).toMatchObject({
        status: 'NOT_VERIFIED',
        reasonCode: 'SCENARIO_REQUIRES_BROWSER_SURFACE',
        evidence: { observations: [] },
      });
    expect(report.timing).toEqual({
      budgetVersion: 'daily-driver-v1',
      status: 'NOT_VERIFIED',
      reasonCode: 'PRODUCT_TIMING_NOT_MEASURED',
      aggregates: [],
    });
    expect(JSON.stringify(report)).not.toContain('durationMs');
  });

  it('calculates median, nearest-rank P95, and maximum without sorting samples in place', () => {
    const samples = [30, 10, 20, 100, 40];
    expect(calculateTiming(samples)).toEqual({
      samplesMs: [30, 10, 20, 100, 40],
      medianMs: 30,
      p95Ms: 100,
      maxMs: 100,
    });
    expect(samples).toEqual([30, 10, 20, 100, 40]);
  });

  it('classifies selected fake outcomes but fails an incomplete exact matrix', async () => {
    const report = await createDailyDriverQualificationReport({
      timeoutMs: 1,
      exactOutcomes: [{ outcome: 'empty', response: '' }],
    });
    const exactRow = report.rows.find(
      (row) => row.scenario === 'exact-confirmation',
    );
    expect(exactRow?.status).toBe('FAIL');
    expect(report.run.harnessStatus).toBe('FAIL');
    expect(exactRow?.evidence.observations).toEqual([
      expect.objectContaining({
        outcome: 'empty',
        classification: 'rejected',
        expectationMet: true,
      }),
    ]);
  });

  it('fails closed when a configured outcome contradicts its expected classification', async () => {
    const report = await createDailyDriverQualificationReport({
      exactOutcomes: [{ outcome: 'empty', response: EXACT_CONFIRMATION }],
    });
    expect(report.run.harnessStatus).toBe('FAIL');
    expect(
      report.rows.filter((row) => row.scenario === 'exact-confirmation'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'FAIL',
          reasonCode: 'EXACT_CONFIRMATION_HARNESS_FAILED',
        }),
      ]),
    );
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(() => assertDailyDriverQualificationSemantics(report)).not.toThrow();
  });

  it('fails closed when the timeout fixture completes before its deadline', async () => {
    const report = await createDailyDriverQualificationReport({
      exactOutcomes: [{ outcome: 'timeout' }],
      timeoutRunner: async () => ({ timedOut: false }),
    });
    expect(report.run.harnessStatus).toBe('FAIL');
    expect(report.rows[0].evidence.observations[0]).toMatchObject({
      classification: 'completed_before_timeout',
      expectationMet: false,
    });
  });

  it('refuses a required capability without exactly one scenario', async () => {
    const profiles = structuredClone(DAILY_DRIVER_PROFILES);
    const [profile] = profiles;
    if (!profile)
      throw new Error('expected a default engine qualification profile');
    profile.requiredCapabilities.push('future-required');
    await expect(
      createDailyDriverQualificationReport({ profiles }),
    ).rejects.toThrow(/future-required.*has no scenario/);
  });

  it('rejects evidence-free PASS claims in schema and runtime semantics', async () => {
    const report = await createDailyDriverQualificationReport();
    const exact = report.rows.find(
      (row) => row.scenario === 'exact-confirmation',
    );
    if (!exact) throw new Error('expected an exact-confirmation row');
    exact.evidence.observations = [];
    expect(validate(report)).toBe(false);
    expect(() => assertDailyDriverQualificationSemantics(report)).toThrow(
      /has no observations/,
    );
  });

  it('rejects a tampered deterministic harness observation digest', async () => {
    const report = await createDailyDriverQualificationReport();
    const row = report.rows.find(
      (candidate) =>
        candidate.surface === 'deterministic-harness' &&
        candidate.scenario === 'exact-confirmation',
    );
    if (!row)
      throw new Error('expected a deterministic exact-confirmation row');
    row.evidence.observations[0]!.digest = '0'.repeat(64);

    expect(() => assertDailyDriverQualificationSemantics(report)).toThrow(
      /false evidence/,
    );
  });

  it('rejects live promotion until live matrix semantics exist', async () => {
    const report = await createDailyDriverQualificationReport();
    report.run.mode = 'live';
    report.promotion.status = 'PASS';
    report.timing.status = 'PASS';
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(() => assertDailyDriverQualificationSemantics(report)).toThrow(
      /live qualification report semantics are not implemented/,
    );
  });

  it('uses injected timeout outcomes concurrently without timer scheduling', async () => {
    let calls = 0;
    const reports = await Promise.all(
      Array.from({ length: 32 }, () =>
        createDailyDriverQualificationReport({
          repetitions: 2,
          timeoutRunner: async () => {
            calls += 1;
            return { timedOut: true };
          },
        }),
      ),
    );
    expect(calls).toBe(128);
    expect(reports.every((report) => report.run.harnessStatus === 'PASS')).toBe(
      true,
    );
  });

  it('proves the generic lifecycle timeout integration without a timer race', async () => {
    await expect(runControlledTimeoutLifecycle()).resolves.toMatchObject({
      timedOut: true,
    });
  });

  it('does not serialize confirmation text, credentials, prompts, paths, or session identifiers', async () => {
    const serialized = JSON.stringify(
      await createDailyDriverQualificationReport({ timeoutMs: 1 }),
    );
    for (const forbidden of [
      EXACT_CONFIRMATION,
      'prompt',
      'credential',
      'sessionId',
      '/Users/',
      'C:\\Users\\',
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it('makes every unexercised product surface explicit in the default matrix', async () => {
    const report = await createDailyDriverQualificationReport();
    for (const surface of ['ui', 'cli', 'phone']) {
      const rows = report.rows.filter((row) => row.surface === surface);
      expect(rows).toHaveLength(18);
      expect(
        rows.every(
          (row) =>
            row.status === 'NOT_VERIFIED' &&
            row.reasonCode === 'PRODUCT_SURFACE_NOT_EXERCISED' &&
            row.evidence.observations.length === 0,
        ),
      ).toBe(true);
    }
  });

  it('replaces exactly two UI exact-confirmation placeholders with bounded PASS rows', async () => {
    const report = await createDailyDriverQualificationReport({
      uiObservation: uiObservation(),
    });
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    const uiRows = report.rows.filter((row) => row.surface === 'ui');
    const productPassRows = report.rows.filter(
      (row) =>
        ['ui', 'cli', 'phone'].includes(row.surface) && row.status === 'PASS',
    );
    expect(uiRows).toHaveLength(18);
    expect(productPassRows).toHaveLength(2);
    expect(productPassRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: 'codex-default',
          scenario: 'exact-confirmation',
          status: 'PASS',
          reasonCode: 'UI_EXACT_CONFIRMATION_PASS',
        }),
        expect.objectContaining({
          profile: 'claude-default',
          scenario: 'exact-confirmation',
          status: 'PASS',
          reasonCode: 'UI_EXACT_CONFIRMATION_PASS',
        }),
      ]),
    );
    expect(uiRows.filter((row) => row.status === 'NOT_VERIFIED')).toHaveLength(
      16,
    );
    for (const row of report.rows.filter(
      (row) => row.status === 'NOT_VERIFIED',
    ))
      expect(row).toMatchObject({
        reasonCode:
          row.surface === 'deterministic-harness'
            ? row.scenario === 'conversation-agreement'
              ? 'REAL_LIFECYCLE_ROUTE_QUALIFICATION_REQUIRED'
              : [
                    'liveness-settlement',
                    'transcript-stability',
                    'performance-stress',
                  ].includes(row.scenario)
                ? 'SCENARIO_REQUIRES_BROWSER_SURFACE'
                : 'SCENARIO_NOT_IMPLEMENTED_IN_HARNESS'
            : 'PRODUCT_SURFACE_NOT_EXERCISED',
        evidence: { observations: [] },
      });
    expect(report.promotion.status).toBe('NOT_VERIFIED');
    expect(report.timing.status).toBe('NOT_VERIFIED');
  });

  it('fails closed for missing, duplicate, or tampered product matrix rows', async () => {
    const report = await createDailyDriverQualificationReport();
    const missing = structuredClone(report);
    missing.rows.splice(
      missing.rows.findIndex((row) => row.surface === 'cli'),
      1,
    );
    expect(() => assertDailyDriverQualificationSemantics(missing)).toThrow(
      /row count/,
    );

    const duplicate = structuredClone(report);
    duplicate.rows[0] = structuredClone(duplicate.rows[1]);
    expect(() => assertDailyDriverQualificationSemantics(duplicate)).toThrow(
      /matrix row keys/,
    );

    const tampered = structuredClone(report);
    const phone = tampered.rows.find((row) => row.surface === 'phone');
    if (!phone) throw new Error('expected a phone placeholder row');
    phone.status = 'PASS';
    expect(() => assertDailyDriverQualificationSemantics(tampered)).toThrow(
      /product row.*NOT_VERIFIED/,
    );
  });

  it('fails closed for malformed, incomplete, or tampered UI observations', () => {
    const cases = [
      () => {
        const artifact = uiObservation();
        artifact.observations.pop();
        assertDailyDriverUiObservationSemantics(
          artifact,
          DAILY_DRIVER_PROFILES,
        );
      },
      () => {
        const artifact = uiObservation();
        artifact.observations.push(structuredClone(artifact.observations[0]!));
        assertDailyDriverUiObservationSemantics(
          artifact,
          DAILY_DRIVER_PROFILES,
        );
      },
      () => {
        const artifact = uiObservation();
        artifact.observations[0]!.profile = 'unknown-default';
        assertDailyDriverUiObservationSemantics(
          artifact,
          DAILY_DRIVER_PROFILES,
        );
      },
      ...[
        { classification: 'rejected' },
        { assistantMessageCount: 2 },
        { terminal: false },
        { workingCleared: false },
        { workingStable: false },
        { commandBinding: false },
        { identityBinding: false },
        { projectBinding: false },
      ].map(
        (overrides) => () =>
          assertDailyDriverUiObservationSemantics(
            uiObservation({ observations: uiObservationRows(overrides) }),
            DAILY_DRIVER_PROFILES,
          ),
      ),
      () => {
        const artifact = uiObservation();
        artifact.observations[0]!.digest = '0'.repeat(64);
        assertDailyDriverUiObservationSemantics(
          artifact,
          DAILY_DRIVER_PROFILES,
        );
      },
      () => {
        const artifact = uiObservation();
        artifact.sourceRevision = 'c'.repeat(40);
        assertDailyDriverUiObservationSemantics(
          artifact,
          DAILY_DRIVER_PROFILES,
        );
      },
      () => {
        const artifact = uiObservation();
        artifact.observations[0]!.prompt = 'forbidden';
        assertDailyDriverUiObservationSemantics(
          artifact,
          DAILY_DRIVER_PROFILES,
        );
      },
    ];
    for (const attempt of cases) expect(attempt).toThrow();
  });

  it('keeps UI artifacts bounded and redacted', () => {
    const serialized = JSON.stringify(uiObservation());
    for (const forbidden of [
      EXACT_CONFIRMATION,
      'prompt',
      'output',
      'credential',
      'sessionId',
      '/Users/',
      'C:\\Users\\',
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it('fails closed when a standalone UI report row loses bounded evidence or provenance integrity', async () => {
    const report = await createDailyDriverQualificationReport({
      uiObservation: uiObservation(),
    });
    const row = report.rows.find((candidate) => candidate.surface === 'ui');
    if (!row) throw new Error('expected a UI qualification row');
    const observation = row.evidence.observations[0]!;
    observation.workingStable = false;
    expect(() => assertDailyDriverQualificationSemantics(report)).toThrow(
      /false evidence/,
    );

    observation.workingStable = true;
    observation.sourceRevision = 'f'.repeat(40);
    expect(() => assertDailyDriverQualificationSemantics(report)).toThrow(
      /false evidence/,
    );
  });

  it('does not let a canned history engine qualify real conversation lifecycle', async () => {
    const report = await createDailyDriverQualificationReport({
      agreementOutcomes: [
        {
          outcome: 'carryover',
          engine: async () => `recall ${SOURCE_REVISION}`,
        },
        { outcome: 'history-blind', engine: async () => 'nothing recalled' },
      ],
    });
    const row = report.rows.find(
      (candidate) =>
        candidate.surface === 'deterministic-harness' &&
        candidate.scenario === 'conversation-agreement',
    );
    expect(row).toMatchObject({
      status: 'NOT_VERIFIED',
      reasonCode: 'REAL_LIFECYCLE_ROUTE_QUALIFICATION_REQUIRED',
      evidence: { observations: [] },
    });
    expect(() => assertDailyDriverQualificationSemantics(report)).not.toThrow();
  });

  it('rejects a fabricated deterministic conversation-agreement verdict', async () => {
    const report = await createDailyDriverQualificationReport();
    const row = report.rows.find(
      (candidate) =>
        candidate.surface === 'deterministic-harness' &&
        candidate.scenario === 'conversation-agreement',
    );
    if (!row) throw new Error('expected an agreement row');
    const tampered = structuredClone(report);
    const tamperedRow = tampered.rows.find(
      (candidate) =>
        candidate.surface === 'deterministic-harness' &&
        candidate.scenario === 'conversation-agreement',
    );
    tamperedRow!.status = 'PASS';
    tamperedRow!.reasonCode = 'CONVERSATION_AGREEMENT_HARNESS_PASS';
    expect(() => assertDailyDriverQualificationSemantics(tampered)).toThrow(
      /false verdict/,
    );
  });

  it('replaces UI scenario placeholders with PASS rows and honest partial timing', async () => {
    const report = await createDailyDriverQualificationReport({
      uiObservation: uiObservation(),
      uiScenarioObservation: scenarioObservation(),
    });
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    const uiScenarioRows = report.rows.filter(
      (row) =>
        row.surface === 'ui' &&
        [
          'conversation-agreement',
          'transcript-stability',
          'performance-stress',
        ].includes(row.scenario),
    );
    expect(uiScenarioRows).toHaveLength(6);
    expect(uiScenarioRows.every((row) => row.status === 'PASS')).toBe(true);
    expect(new Set(uiScenarioRows.map((row) => row.reasonCode))).toEqual(
      new Set([
        'UI_CONVERSATION_AGREEMENT_PASS',
        'UI_TRANSCRIPT_STABILITY_STRUCTURE_PASS',
        'UI_PERFORMANCE_STRESS_STRUCTURE_PASS',
      ]),
    );
    expect(report.timing.status).toBe('NOT_VERIFIED');
    expect(report.timing.reasonCode).toBe('PRODUCT_TIMING_PARTIALLY_MEASURED');
    expect(report.timing.aggregates).toHaveLength(4);
    const stability = report.timing.aggregates.find(
      (aggregate) =>
        aggregate.scenario === 'transcript-stability' &&
        aggregate.profile === 'codex-default',
    );
    expect(stability).toMatchObject({
      surface: 'ui',
      samplesMs: [180, 220, 205],
      medianMs: 205,
      p95Ms: 220,
      maxMs: 220,
      budgetMs: 750,
      budgetStatus: 'PASS',
      budgetVersion: 'daily-driver-v1',
    });
    expect(report.promotion.status).toBe('NOT_VERIFIED');
  });

  it('replaces only the observed handoff UI row and rejects evidence or digest tampering', async () => {
    const observation = handoffObservation();
    const report = await createDailyDriverQualificationReport({
      uiScenarioObservation: observation,
    });
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(
      report.rows.find(
        (row) =>
          row.profile === 'claude-default' &&
          row.surface === 'ui' &&
          row.scenario === 'agent-engine-handoff',
      ),
    ).toMatchObject({
      status: 'PASS',
      reasonCode: 'UI_AGENT_ENGINE_HANDOFF_PASS',
      evidence: {
        observations: [
          expect.objectContaining({
            targetProfile: 'codex-default',
            expectationMet: true,
          }),
        ],
      },
    });
    expect(
      report.rows.find(
        (row) =>
          row.profile === 'codex-default' &&
          row.surface === 'ui' &&
          row.scenario === 'agent-engine-handoff',
      ),
    ).toMatchObject({
      status: 'NOT_VERIFIED',
      reasonCode: 'PRODUCT_SURFACE_NOT_EXERCISED',
    });

    const evidenceTamper = structuredClone(report);
    const evidence = evidenceTamper.rows.find(
      (row) =>
        row.profile === 'claude-default' &&
        row.surface === 'ui' &&
        row.scenario === 'agent-engine-handoff',
    )!.evidence.observations[0]!;
    evidence.persistedMarker = false;
    expect(() =>
      assertDailyDriverQualificationSemantics(evidenceTamper),
    ).toThrow(/false evidence/);

    const digestTamper = structuredClone(report);
    digestTamper.rows.find(
      (row) =>
        row.profile === 'claude-default' &&
        row.surface === 'ui' &&
        row.scenario === 'agent-engine-handoff',
    )!.evidence.observations[0]!.digest = '0'.repeat(64);
    expect(() => assertDailyDriverQualificationSemantics(digestTamper)).toThrow(
      /false evidence/,
    );
  });

  it('reports FAIL rows and over-budget aggregates instead of hiding a failing scenario', async () => {
    const rows = scenarioObservationRows();
    const stability = rows.find(
      (row) =>
        row.scenario === 'transcript-stability' &&
        row.profile === 'claude-default',
    ) as Record<string, unknown>;
    stability.maxMountedRows = 9000;
    stability.classification = 'unbounded';
    stability.restoreSamplesMs = [800, 900, 1200];
    const report = await createDailyDriverQualificationReport({
      uiScenarioObservation: scenarioObservation(rows),
    });
    const failRow = report.rows.find(
      (row) =>
        row.surface === 'ui' &&
        row.scenario === 'transcript-stability' &&
        row.profile === 'claude-default',
    );
    expect(failRow).toMatchObject({
      status: 'FAIL',
      reasonCode: 'UI_TRANSCRIPT_STABILITY_FAILED',
    });
    const aggregate = report.timing.aggregates.find(
      (candidate) =>
        candidate.scenario === 'transcript-stability' &&
        candidate.profile === 'claude-default',
    );
    expect(aggregate).toMatchObject({ p95Ms: 1200, budgetStatus: 'FAIL' });
    expect(report.run.harnessStatus).toBe('FAIL');
    expect(() => assertDailyDriverQualificationSemantics(report)).not.toThrow();

    const falsePass = structuredClone(report);
    falsePass.run.harnessStatus = 'PASS';
    expect(() => assertDailyDriverQualificationSemantics(falsePass)).toThrow(
      /harnessStatus does not match/,
    );
  });

  it('rejects tampered UI scenario evidence and false timing derivations', async () => {
    const report = await createDailyDriverQualificationReport({
      uiScenarioObservation: scenarioObservation(),
    });

    const tamperedExpectation = structuredClone(report);
    const scenarioRow = tamperedExpectation.rows.find(
      (row) =>
        row.surface === 'ui' && row.scenario === 'conversation-agreement',
    );
    scenarioRow!.evidence.observations[0]!.carryOverBound = false;
    expect(() =>
      assertDailyDriverQualificationSemantics(tamperedExpectation),
    ).toThrow(/false evidence/);

    const tamperedTiming = structuredClone(report);
    tamperedTiming.timing.aggregates[0]!.p95Ms = 1;
    expect(() =>
      assertDailyDriverQualificationSemantics(tamperedTiming),
    ).toThrow(/false derivation/);

    const orphanTiming = structuredClone(report);
    orphanTiming.timing.aggregates[0]!.profile = 'unknown-default';
    expect(() => assertDailyDriverQualificationSemantics(orphanTiming)).toThrow(
      /not backed by a UI scenario row/,
    );

    const fabricatedTiming = await createDailyDriverQualificationReport();
    fabricatedTiming.timing.reasonCode = 'PRODUCT_TIMING_PARTIALLY_MEASURED';
    expect(() =>
      assertDailyDriverQualificationSemantics(fabricatedTiming),
    ).toThrow(/must carry aggregates/);
  });

  it('fails closed for malformed, duplicated, or stamped scenario observations', () => {
    const {
      persistedLineage: _missingPersistedLineage,
      ...missingPersistedLineage
    } = scenarioObservationRows()[0]!;
    expect(() =>
      createDailyDriverScenarioObservation({
        sourceRevision: SOURCE_REVISION,
        observations: [missingPersistedLineage],
      }),
    ).toThrow(
      /invalid daily-driver scenario observation|evidence does not support/,
    );
    for (const field of [
      'continuationRouteUsed',
      'terminalReuseRefused',
      'persistedLineage',
      'reloadExactlyOnce',
    ])
      expect(() =>
        createDailyDriverScenarioObservation({
          sourceRevision: SOURCE_REVISION,
          observations: [
            {
              ...scenarioObservationRows()[0]!,
              [field]: false,
              expectationMet: true,
            },
          ],
        }),
      ).toThrow(/its evidence does not (derive|support)/);
    expect(() =>
      createDailyDriverScenarioObservation({
        sourceRevision: SOURCE_REVISION,
        observations: [
          {
            ...scenarioObservationRows()[0]!,
            // A producer may not stamp an expectation its evidence does not
            // derive: carryOverBound=false contradicts expectationMet=true.
            // The classification it also carries is refused first, which is
            // the same fail-closed answer one field earlier.
            carryOverBound: false,
            expectationMet: true,
          },
        ],
      }),
    ).toThrow(/its evidence does not (derive|support)/);

    // Expectation-only tamper, with no classification supplied: the
    // expectation check is what must refuse it.
    expect(() =>
      createDailyDriverScenarioObservation({
        sourceRevision: SOURCE_REVISION,
        observations: [
          {
            ...scenarioObservationRows()[0]!,
            classification: undefined,
            carryOverBound: false,
            expectationMet: true,
          },
        ],
      }),
    ).toThrow(/its evidence does not derive/);

    const artifact = scenarioObservation();
    const duplicated = structuredClone(artifact);
    duplicated.observations.push(structuredClone(duplicated.observations[0]!));
    expect(() =>
      assertDailyDriverScenarioObservationSemantics(
        duplicated,
        DAILY_DRIVER_PROFILES,
      ),
    ).toThrow(/duplicate coverage/);

    const tampered = structuredClone(artifact);
    tampered.observations[0]!.digest = '0'.repeat(64);
    expect(() =>
      assertDailyDriverScenarioObservationSemantics(
        tampered,
        DAILY_DRIVER_PROFILES,
      ),
    ).toThrow(/tampered digest/);

    const foreign = structuredClone(artifact);
    foreign.observations[0]!.profile = 'unknown-default';
    expect(() =>
      assertDailyDriverScenarioObservationSemantics(
        foreign,
        DAILY_DRIVER_PROFILES,
      ),
    ).toThrow(/unknown profile/);

    const divergent = structuredClone(artifact);
    divergent.sourceRevision = 'b'.repeat(40);
    expect(() =>
      mergeDailyDriverScenarioObservations([artifact, divergent]),
    ).toThrow(/disagree on producer provenance/);
  });

  it('keeps scenario observation artifacts bounded and redacted', () => {
    const serialized = JSON.stringify(scenarioObservation());
    for (const forbidden of [
      EXACT_CONFIRMATION,
      'CARRY-',
      'prompt',
      'credential',
      '/Users/',
      'C:\\Users\\',
    ])
      expect(serialized).not.toContain(forbidden);
  });
});
