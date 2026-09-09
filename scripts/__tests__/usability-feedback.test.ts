import { describe, expect, test, vi } from 'vitest';
import {
  reviewScreens,
  summarizeGallery,
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
              kind: 'defect',
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
  test('gallery-only coverage rejects missing, duplicate, and failed captures', () => {
    const capture = {
      schemaVersion: 1,
      expected: 2,
      selection: ['one'],
      screens: [{ name: 'one', file: 'one.png', ok: true }],
    };
    expect(summarizeGallery(capture, ['one.png']).status).toBe('PASS');
    expect(summarizeGallery(capture, []).status).toBe('FAIL');
    expect(
      summarizeGallery(
        {
          ...capture,
          selection: null,
          screens: [
            { name: 'one', file: 'one.png', ok: true },
            { name: 'two', file: 'one.png', ok: true },
          ],
        },
        ['one.png', 'two.png'],
      ).status,
    ).toBe('FAIL');
    expect(
      summarizeGallery({ ...capture, selection: null }, ['one.png']).status,
    ).toBe('FAIL');
    expect(
      summarizeGallery(
        { ...capture, screens: [{ name: 'one', file: 'one.png', ok: false }] },
        ['one.png'],
      ).status,
    ).toBe('FAIL');
    expect(summarizeGallery(null, []).status).toBe('NOT_VERIFIED');
  });
  test('missing credentials never call a provider or imply review', async () => {
    const fetchImpl = vi.fn();
    expect((await reviewScreens([], { fetchImpl, model: 'test' })).status).toBe(
      'NOT_VERIFIED',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('provider failure retains a coverage gap', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 'insufficient_quota' } }),
    });
    const result = await reviewScreens(
      [{ id: 'a', bytes: Buffer.from('png') }],
      { apiKey: 'test', model: 'test', fetchImpl },
    );
    expect(result.status).toBe('NOT_VERIFIED');
    expect(result.detail).toContain('429');
  });
  test('a later provider failure cannot erase an already observed defect', async () => {
    const finding = {
      screen: 'a',
      kind: 'defect',
      severity: 'high',
      confidence: 'visible',
      title: 'Clipped approval control',
      evidence: 'The approval action is outside the modal.',
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    reviewed: ['a', 'b', 'c', 'd'],
                    findings: [finding],
                  }),
                },
              ],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({}),
      });
    const result = await reviewScreens(
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({
        id,
        bytes: Buffer.from('png'),
      })),
      { apiKey: 'test', model: 'test', fetchImpl },
    );
    expect(result.status).toBe('FAIL');
    expect(result.findings).toEqual([finding]);
    expect(result.reviewed).toEqual(['a', 'b', 'c', 'd']);
    expect(result.detail).toContain('batch 2 incomplete');
  });
  test('visible issue is actionable while valid empty review passes', async () => {
    for (const findings of [
      [],
      [
        {
          screen: 'a',
          kind: 'defect',
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
