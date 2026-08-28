import { describe, expect, test } from 'vitest';
import { describeCostCoverage } from '../components/usage-stats/UsageSummaryCards';

/**
 * archive#3245: a lifetime cost is summed over the engine sessions that
 * reported a cost, and the surface has to say so — otherwise a partial sum
 * reads as a complete one, which is archive#3201's fabrication reintroduced
 * one layer up.
 */
describe('describeCostCoverage', () => {
  test('says nothing when there is nothing to disclose', () => {
    // No engine sessions: every figure is Station's own accounting, where an
    // absent cost is a recorded zero rather than an unasked question.
    expect(describeCostCoverage(undefined)).toBeNull();
    expect(
      describeCostCoverage({
        sessions: 0,
        sessionsReportingTokens: 0,
        sessionsReportingCost: 0,
      }),
    ).toBeNull();
    // Full coverage: the total IS complete, so it must not gain a caveat.
    expect(
      describeCostCoverage({
        sessions: 4,
        sessionsReportingTokens: 4,
        sessionsReportingCost: 4,
      }),
    ).toBeNull();
  });

  test('names the numerator and the denominator on a partial sum', () => {
    expect(
      describeCostCoverage({
        sessions: 5,
        sessionsReportingTokens: 4,
        sessionsReportingCost: 1,
      }),
    ).toBe('Measured on 1 of 5 engine sessions; the rest reported no cost.');
  });

  test('a total with no reported cost at all says exactly that', () => {
    // The dangerous case: `$0.00` beside no caption reads as "you spent
    // nothing", when the truth is that nobody was asked.
    expect(
      describeCostCoverage({
        sessions: 3,
        sessionsReportingTokens: 3,
        sessionsReportingCost: 0,
      }),
    ).toBe('None of the 3 engine sessions in this total reported a cost.');
    expect(
      describeCostCoverage({
        sessions: 1,
        sessionsReportingTokens: 1,
        sessionsReportingCost: 0,
      }),
    ).toBe('The 1 engine session in this total reported no cost.');
  });
});
