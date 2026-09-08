import { describe, expect, test, vi } from 'vitest';
import {
  reviewScreens,
  summarizeJourneys,
  validateVisualReview,
} from '../usability-feedback.mjs';

const goodWalk = {
  routes: ['/'],
  failures: [],
  blockingFindings: [],
  expectedFailures: [],
};
describe('usability feedback coverage and reviewer failures', () => {
  test('a green job with unexercised real chat stays NOT_VERIFIED', () => {
    const checks = summarizeJourneys(goodWalk, {
      results: [
        { id: 'chat', status: 'not-exercised', notes: ['Claude absent'] },
        { id: 'pair', status: 'passed', notes: [] },
      ],
    });
    expect(checks.map((c) => c.status)).toEqual([
      'PASS',
      'NOT_VERIFIED',
      'PASS',
    ]);
  });
  test('missing and empty receipts never pass', () => {
    expect(
      summarizeJourneys(null, { results: [] }).every(
        (c) => c.status === 'NOT_VERIFIED',
      ),
    ).toBe(true);
    expect(summarizeJourneys({ ...goodWalk, routes: [] }, null)[0].status).toBe(
      'NOT_VERIFIED',
    );
  });
  test('real failures and expected failures are not swallowed', () => {
    expect(
      summarizeJourneys({ ...goodWalk, failures: ['menu offscreen'] }, null)[0]
        .status,
    ).toBe('FAIL');
    expect(
      summarizeJourneys({ ...goodWalk, expectedFailures: ['plugin'] }, null)[0]
        .status,
    ).toBe('NOT_VERIFIED');
  });
  test('missing image, duplicate acknowledgement, and invented source are refused', () => {
    expect(() =>
      validateVisualReview({ reviewed: ['a'], findings: [] }, ['a', 'b']),
    ).toThrow();
    expect(() =>
      validateVisualReview({ reviewed: ['a', 'a'], findings: [] }, ['a', 'b']),
    ).toThrow();
    expect(() =>
      validateVisualReview(
        {
          reviewed: ['a'],
          findings: [
            {
              screen: 'invented',
              severity: 'high',
              confidence: 'visible',
              title: 'bad',
              evidence: 'bad',
            },
          ],
        },
        ['a'],
      ),
    ).toThrow();
  });
  test('missing credentials never call a provider or imply review', async () => {
    const fetchImpl = vi.fn();
    expect((await reviewScreens([], { fetchImpl, model: 'test' })).status).toBe(
      'NOT_VERIFIED',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('provider failure retains a coverage gap', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const result = await reviewScreens(
      [{ id: 'a', bytes: Buffer.from('png') }],
      { apiKey: 'test', model: 'test', fetchImpl },
    );
    expect(result.status).toBe('NOT_VERIFIED');
    expect(result.detail).toContain('429');
  });
  test('visible issue is actionable while valid empty review passes', async () => {
    for (const findings of [
      [],
      [
        {
          screen: 'a',
          severity: 'high',
          confidence: 'visible',
          title: 'Clipped menu',
          evidence: 'Close control is above the viewport',
        },
      ],
    ]) {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({ reviewed: ['a'], findings }),
                },
              ],
            },
          ],
        }),
      });
      const result = await reviewScreens(
        [{ id: 'a', bytes: Buffer.from('png') }],
        { apiKey: 'test', model: 'test', fetchImpl },
      );
      expect(result.status).toBe(findings.length ? 'FAIL' : 'PASS');
      expect(result.reviewed).toEqual(['a']);
    }
  });
});
