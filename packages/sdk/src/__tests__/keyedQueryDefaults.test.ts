/**
 * station#3092 — the SDK's project/bundle-keyed queries default to holding
 * previous data across a key change (`keepPreviousData`), but this must
 * stay a per-hook opt-in, never a client-wide default. This file pins the
 * exact hooks that opt in, and proves a caller can still opt out.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  getApiBase: vi.fn(),
  useApiQuery: vi.fn(),
}));

vi.mock('../api', () => ({ _getApiBase: mocks.getApiBase }));
vi.mock('../client/http', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));
vi.mock('../query-core', () => ({
  useApiQuery: mocks.useApiQuery,
  useApiMutation: vi.fn(),
}));

import {
  useTrustBundlesQuery,
  useTrustReportQuery,
} from '../query-domains/trustBundles';
import { useReadinessQuery } from '../query-domains/veritasReadiness';

describe('project-keyed SDK query keepPreviousData defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiBase.mockResolvedValue('https://station.example.test');
    mocks.useApiQuery.mockReturnValue({ data: undefined });
  });

  test('useReadinessQuery', () => {
    useReadinessQuery('proj-a');
    const config = mocks.useApiQuery.mock.calls[0]?.[2];
    expect(config?.keepPreviousData).toBe(true);
  });

  test('useReadinessQuery: caller can still opt out', () => {
    useReadinessQuery('proj-a', { keepPreviousData: false });
    const config = mocks.useApiQuery.mock.calls[0]?.[2];
    expect(config?.keepPreviousData).toBe(false);
  });

  test('useTrustBundlesQuery', () => {
    useTrustBundlesQuery('proj-a');
    const config = mocks.useApiQuery.mock.calls[0]?.[2];
    expect(config?.keepPreviousData).toBe(true);
  });

  test('useTrustReportQuery does NOT default it on — its key carries a nullable selection', () => {
    // Deliberate asymmetry with the two hooks above, found in review.
    // This key includes `bundleId`, which is legitimately null (the panel
    // collapses) and legitimately belongs to the OUTGOING project during a
    // switch. Defaulting the hold on broke two ways:
    //
    //  1. A caller deriving the selection from a held bundle list issued a
    //     real request for project B's slug with project A's bundle id.
    //  2. TanStack applies placeholderData without an `enabled` check, and a
    //     disabled query stays `pending` forever — so `isPlaceholderData`
    //     never cleared and the aria-busy derived from it stuck on after the
    //     panel was collapsed.
    //
    // A caller that genuinely wants the hold still passes it explicitly.
    useTrustReportQuery('proj-a', 'bundle-1');
    const config = mocks.useApiQuery.mock.calls[0]?.[2];
    expect(config?.keepPreviousData).toBeUndefined();
  });

  test('useTrustReportQuery still honours an explicit opt-in', () => {
    useTrustReportQuery('proj-a', 'bundle-1', { keepPreviousData: true });
    const config = mocks.useApiQuery.mock.calls[0]?.[2];
    expect(config?.keepPreviousData).toBe(true);
  });
});

describe('the opt-in set itself is pinned (station#3092)', () => {
  test('exactly these query-domain files opt in — adding a fourth must be deliberate', async () => {
    // `query-core.ts`'s docblock states an invariant: a hook that sets
    // keepPreviousData without its consuming component branching on
    // `isPlaceholderData` to mark the render is a defect. This test does
    // NOT enforce that invariant — it enforces something narrower and
    // producer-side only: the SET of query-domain FILES (top-level of this
    // directory, not recursive) that mention keepPreviousData at all. A new
    // hook inside an already-listed file is invisible here, a direct
    // `useApiQuery(..., { keepPreviousData: true })` call outside
    // query-domains/ is invisible here, and — decisively — whether the
    // CONSUMING component actually marks the held render is invisible here.
    // That gap shipped once (station#3169: CodingInspectorPanel consumed
    // two opted-in hooks with no marking and no opt-out); this pin did not
    // and could not catch it. The consumer-side half is enforced instead by
    // src-ui/src/__tests__/keepPreviousDataConsumers.test.ts. What this
    // test buys: opting a new FILE in still costs a deliberate edit here,
    // which is where a reader meets the rule.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = new URL('../query-domains/', import.meta.url).pathname;

    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    const optedIn: string[] = [];
    for (const file of files) {
      const source = await readFile(join(dir, file), 'utf8');
      if (/keepPreviousData:\s*(true|config\?\.|options\?\.)/.test(source)) {
        optedIn.push(file);
      }
    }

    expect(optedIn.sort()).toEqual(['trustBundles.ts', 'veritasReadiness.ts']);
  });
});
