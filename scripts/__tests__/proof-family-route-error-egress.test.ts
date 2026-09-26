import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

// Detection is proven against real sources in route-error-egress-gate.test.ts.
// This file proves only the default wiring: the governance family must call
// the whole-tree collector on the repository root and block on what it finds.
const collector = vi.hoisted(() => ({
  calls: [] as unknown[],
  finding:
    'Unreviewed direct outward .message serialization: src-server/routes/fixture.ts :: route POST /fixture :: error.message :: 1.',
}));

vi.mock('../route-error-egress-gate.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../route-error-egress-gate.mjs')>()),
  collectRouteErrorEgressFindings: (options: unknown) => {
    collector.calls.push(options);
    return [collector.finding];
  },
}));

const { evaluateProofFamily } = await import('../proof-family-lane.mjs');

describe('repo-governance route error egress proof', () => {
  test('default wiring runs the whole-tree collector and blocks on its findings', () => {
    const result = evaluateProofFamily({
      id: 'repo-governance',
      evidenceCheckId: 'repo-governance',
      destination: 'required',
      owner: 'station',
      defaultDisposition: 'required',
      currentBlockingStatus: 'blocking',
      regressionSeverity: 'high',
      falsePositiveRisk: 'low',
      expiryOrReviewTrigger: 'never',
    });

    expect(collector.calls).toEqual([
      { rootDir: resolve(import.meta.dirname, '../..') },
    ]);
    expect(result.status).toBe('fail');
    expect(result.findings).toContainEqual({
      id: 'route-error-egress',
      message: collector.finding,
      severity: 'block',
    });
  });
});
