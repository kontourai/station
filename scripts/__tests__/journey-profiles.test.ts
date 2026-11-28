import { expect, test } from 'vitest';
import {
  main,
  summarizeJourneyProfiles,
  validateJourneyProfile,
} from '../run-journey-profiles.mjs';

const profile = {
  id: 'home-history',
  sourceRevision: 'sha',
  outcome: 'passed',
  cpuSamples: 10,
  elapsedMs: 20,
  counters: { commits: 2, storageReads: 1, storageWrites: 0 },
  metricsMs: {
    ScriptDuration: 5,
    LayoutDuration: 1,
    TaskDuration: 8,
    RecalcStyleDuration: 1,
  },
  sampledAllocationBytes: 100,
};
test('refuses empty or unregistered spec selections before running a capture', async () => {
  for (const args of [
    ['--spec='],
    ['--spec=tests/missing.spec.ts'],
    ['--group='],
    ['--group=missing'],
    ['--group=home-history', '--spec=tests/mobile-chat-composer.spec.ts'],
  ])
    await expect(main(args)).rejects.toThrow('Usage:');
});
test('rejects missing work, invalid counters and mismatched identity', () => {
  expect(validateJourneyProfile(profile, 'home-history', 'sha')).toEqual([]);
  for (const changed of [
    { outcome: 'failed' },
    { cpuSamples: 0 },
    { counters: { commits: 0 } },
    { sourceRevision: 'other' },
    { sampledAllocationBytes: NaN },
  ])
    expect(
      validateJourneyProfile({ ...profile, ...changed }, 'home-history', 'sha')
        .length,
    ).toBeGreaterThan(0);
});
test('reports per-journey medians without converting timing into a verdict', () => {
  expect(
    summarizeJourneyProfiles([
      profile,
      { ...profile, elapsedMs: 100 },
      { ...profile, elapsedMs: 30 },
    ])['home-history'],
  ).toMatchObject({ samples: 3, elapsedMedianMs: 30, commitsMedian: 2 });
});

test('a clean profile run rejects a dirty per-journey receipt', () => {
  expect(
    validateJourneyProfile(
      { ...profile, dirty: true },
      'home-history',
      'sha',
      false,
    ),
  ).toContain('workspace changed during profiling');
});

test('UI-only captures require production assets and actual browser provenance', () => {
  const captured = {
    ...profile,
    buildMode: 'production',
    buildProvenanceSha256: 'build-digest',
    viewport: { width: 390, height: 844 },
    device: { userAgent: 'Chromium', devicePixelRatio: 1 },
    inputTiming: {
      supported: true,
      scope: 'final-document',
      durationThresholdMs: 16,
      observedEventCount: 0,
      observedInteractionCount: 0,
      worstObservedInteractionMs: null,
      events: [],
    },
    responsiveness: {
      scope: 'final-document',
      phaseStartMs: 0,
      phaseEndMs: 200,
      longTaskCount: 2,
      longestTaskMs: 90,
      blockingOver50Ms: 60,
      longTasks: [
        { startTime: 10, duration: 70 },
        { startTime: 100, duration: 90 },
      ],
    },
  };
  expect(
    validateJourneyProfile(captured, 'home-history', 'sha', undefined, {
      uiOnly: true,
      buildProvenanceSha256: 'build-digest',
    }),
  ).toEqual([]);
  for (const changed of [
    { buildMode: 'development' },
    { buildProvenanceSha256: undefined },
    { buildProvenanceSha256: 'another-build' },
    { viewport: null },
    { device: null },
    { inputTiming: null },
    {
      inputTiming: {
        ...captured.inputTiming,
        worstObservedInteractionMs: 0,
      },
    },
    { responsiveness: null },
    { responsiveness: { ...captured.responsiveness, phaseStartMs: 11 } },
    { responsiveness: { ...captured.responsiveness, phaseEndMs: 180 } },
    {
      responsiveness: {
        longTasks: [],
        longTaskCount: 1,
        longestTaskMs: 0,
        blockingOver50Ms: 0,
      },
    },
  ])
    expect(
      validateJourneyProfile(
        { ...captured, ...changed },
        'home-history',
        'sha',
        undefined,
        { uiOnly: true, buildProvenanceSha256: 'build-digest' },
      ).length,
    ).toBeGreaterThan(0);
  expect(
    validateJourneyProfile(captured, 'home-history', 'sha', undefined, {
      uiOnly: true,
    }),
  ).toContain('missing/mismatched production build provenance');
  const event = {
    name: 'keydown',
    startTime: 10,
    duration: 16,
    processingStart: 11,
    processingEnd: 27,
    interactionId: 7,
  };
  const observed = {
    ...captured.inputTiming,
    observedEventCount: 1,
    observedInteractionCount: 1,
    worstObservedInteractionMs: 16,
    events: [event],
  };
  const validateInput = (inputTiming: object) =>
    validateJourneyProfile(
      { ...captured, inputTiming },
      'home-history',
      'sha',
      undefined,
      { uiOnly: true, buildProvenanceSha256: 'build-digest' },
    );
  expect(validateInput(observed)).toEqual([]);
  expect(validateInput({ ...captured.inputTiming, supported: false })).toEqual(
    [],
  );
  expect(
    validateInput({
      ...observed,
      observedEventCount: 2,
      worstObservedInteractionMs: 24,
      events: [event, { ...event, name: 'keyup', duration: 24 }],
    }),
  ).toEqual([]);
  for (const inputTiming of [
    { ...observed, supported: false },
    { ...observed, observedEventCount: 0 },
    { ...observed, observedInteractionCount: 2 },
    { ...observed, worstObservedInteractionMs: 32 },
    { ...observed, events: [{ ...event, interactionId: 0 }] },
    { ...observed, events: [{ ...event, duration: 8 }] },
    { ...observed, events: [{ ...event, startTime: -1 }] },
    { ...observed, events: [{ ...event, processingStart: 9 }] },
    { ...observed, events: [{ ...event, processingEnd: 201 }] },
    { ...observed, events: [{ ...event, processingEnd: 9 }] },
    { ...observed, events: [{ ...event, processingEnd: NaN }] },
  ])
    expect(validateInput(inputTiming)).toContain(
      'missing/invalid input timing observation',
    );
});
