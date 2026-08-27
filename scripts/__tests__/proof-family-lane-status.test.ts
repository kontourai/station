import { describe, expect, test } from 'vitest';
import {
  evaluateProofFamily,
  proofFamilyExitCode,
} from '../proof-family-lane.mjs';

const candidate = {
  id: 'architecture-boundaries',
  evidenceCheckId: 'architecture-boundaries',
  destination: 'station-proof-lane',
  owner: 'station-architecture',
  defaultDisposition: 'candidate',
  currentBlockingStatus: 'candidate',
  regressionSeverity: 'high',
  falsePositiveRisk: 'medium',
  expiryOrReviewTrigger: 'catch evidence',
};

describe('proof family status integrity', () => {
  test('an assertion-free candidate is NOT_VERIFIED, never passed', () => {
    const result = evaluateProofFamily(candidate);
    expect(result.status).toBe('NOT_VERIFIED');
    expect(proofFamilyExitCode([result])).toBe(2);
  });

  test('only evaluated required families can report pass', () => {
    expect(proofFamilyExitCode([{ status: 'pass' }])).toBe(0);
    expect(proofFamilyExitCode([{ status: 'fail' }])).toBe(1);
  });

  test('fails closed on empty, malformed, or future family result statuses', () => {
    const statusGetter = {};
    Object.defineProperty(statusGetter, 'status', {
      enumerable: true,
      get() {
        throw new Error('must not be read');
      },
    });

    for (const results of [
      [],
      [{}],
      [{ status: 'future' }],
      [Object.assign(Object.create(null), { status: 'pass' })],
      [statusGetter],
    ]) {
      expect(proofFamilyExitCode(results)).not.toBe(0);
    }
    expect(proofFamilyExitCode([])).toBe(2);
    expect(proofFamilyExitCode([{}])).toBe(1);
  });

  test('keeps fail dominant and NOT_VERIFIED only when every evaluated result is non-failing', () => {
    expect(
      proofFamilyExitCode([{ status: 'NOT_VERIFIED' }, { status: 'fail' }]),
    ).toBe(1);
    expect(
      proofFamilyExitCode([{ status: 'future' }, { status: 'NOT_VERIFIED' }]),
    ).toBe(1);
    expect(
      proofFamilyExitCode([{ status: 'pass' }, { status: 'NOT_VERIFIED' }]),
    ).toBe(2);
    expect(proofFamilyExitCode([{ status: 'pass' }, { status: 'pass' }])).toBe(
      0,
    );
  });
});
