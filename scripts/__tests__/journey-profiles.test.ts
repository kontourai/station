import { expect, test } from 'vitest';
import {
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
