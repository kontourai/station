import { describe, expect, test } from 'vitest';
import { evaluateCriticalBrowserEvidence } from '../critical-browser-reporter.mjs';

const contract = {
  journeys: [{ path: 'tests/mobile.spec.ts' }],
  requiredObservations: [
    { path: 'tests/mobile.spec.ts', title: 'primary project switching' },
  ],
};
const passed = {
  file: 'tests/mobile.spec.ts',
  title: 'primary project switching',
  expectedStatus: 'passed',
  results: ['passed'],
};
describe('critical browser evidence requires executed outcomes', () => {
  test('accepts a real successful observation', () =>
    expect(
      evaluateCriticalBrowserEvidence([passed], 'passed', contract).status,
    ).toBe('PASS'));
  test.each([
    { ...passed, results: ['skipped'] },
    { ...passed, expectedStatus: 'failed', results: ['failed'] },
    { ...passed, results: ['failed', 'passed'] },
    { ...passed, results: [] },
  ])(
    'rejects skipped, expected-red, retried, and absent results even with green suite status',
    (observation) => {
      expect(
        evaluateCriticalBrowserEvidence([observation], 'passed', contract)
          .status,
      ).toBe('FAIL');
    },
  );
  test('does not substitute an adjacent or duplicated test for the required journey', () => {
    expect(
      evaluateCriticalBrowserEvidence(
        [{ ...passed, title: 'another test' }],
        'passed',
        contract,
      ).status,
    ).toBe('NOT_VERIFIED');
    expect(
      evaluateCriticalBrowserEvidence([passed, passed], 'passed', contract)
        .status,
    ).toBe('NOT_VERIFIED');
    expect(evaluateCriticalBrowserEvidence([], 'passed', contract).status).toBe(
      'NOT_VERIFIED',
    );
  });
});

test('rejects wrong, stale, or dirty CI source evidence', () => {
  const source = {
    head: 'a'.repeat(40),
    trackedDiffSha256: 'b'.repeat(64),
    clean: true,
  };
  const evaluate = (
    identity: Parameters<typeof evaluateCriticalBrowserEvidence>[3],
  ) =>
    evaluateCriticalBrowserEvidence([passed], 'passed', contract, identity)
      .status;
  expect(
    evaluate({
      before: source,
      after: source,
      expected: source.head,
      requireClean: true,
    }),
  ).toBe('PASS');
  expect(
    evaluate({
      before: source,
      after: source,
      expected: 'c'.repeat(40),
      requireClean: true,
    }),
  ).toBe('NOT_VERIFIED');
  expect(
    evaluate({
      before: source,
      after: { ...source, trackedDiffSha256: 'd'.repeat(64) },
      expected: source.head,
    }),
  ).toBe('NOT_VERIFIED');
  expect(
    evaluate({
      before: source,
      after: { ...source, clean: false },
      expected: source.head,
      requireClean: true,
    }),
  ).toBe('NOT_VERIFIED');
});
