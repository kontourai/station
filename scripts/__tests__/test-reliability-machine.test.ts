import { cpus } from 'node:os';
import { describe, expect, test } from 'vitest';
import {
  collectWorkspaceProvenance,
  machineConditions,
} from '../lib/test-reliability.mjs';

/**
 * Reliability receipts recorded the tree and the runtime but nothing about
 * contention, which is why a whole round of flake measurement had to be
 * discarded (#844): the numbers looked like a flaky suite and were actually a
 * saturated machine, and nothing in the receipt said so. These assert the
 * conditions travel with the measurement, so a contaminated run stays
 * identifiable rather than silently comparable with a clean one.
 */
describe('machineConditions', () => {
  test('reports the load average and core count', () => {
    const conditions = machineConditions();
    expect(conditions.cpuCount).toBe(cpus().length);
    expect(conditions.totalMemoryBytes).toBeGreaterThan(0);
    for (const window of [1, 5, 15] as const) {
      expect(conditions.loadAverage[window]).toBeGreaterThanOrEqual(0);
    }
  });

  test('expresses load per core, so two machines are comparable', () => {
    const conditions = machineConditions();
    // A ratio is the comparable quantity: load 11 means something different on
    // 4 cores than on 15, which is exactly how #844's numbers misled.
    expect(conditions.loadPerCpu).toBe(
      Math.round((conditions.loadPerCpu ?? 0) * 100) / 100,
    );
    // Both published values are independently rounded to two decimals. Their
    // ratio may therefore differ by one half-unit from each rounding, even
    // though both came from the same raw load sample.
    const maximumDoubleRoundingError =
      0.005 + 0.005 / conditions.cpuCount + 1e-12;
    expect(
      Math.abs(
        (conditions.loadPerCpu ?? 0) -
          conditions.loadAverage[1] / conditions.cpuCount,
      ),
    ).toBeLessThanOrEqual(maximumDoubleRoundingError);
  });

  test('does not pass judgement on the run', () => {
    // Deliberately no saturated/clean verdict: #844's contaminated round was
    // ~0.78 load per core, which a "load > cores" rule would have waved
    // through. Recording the number beats inventing a threshold.
    expect(machineConditions()).not.toHaveProperty('saturated');
  });
});

describe('collectWorkspaceProvenance', () => {
  test('carries machine conditions alongside the tree identity', () => {
    const provenance = collectWorkspaceProvenance();
    expect(provenance.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.machine.cpuCount).toBeGreaterThan(0);
    expect(provenance.machine.loadPerCpu).not.toBeNull();
  });
});
