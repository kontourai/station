/**
 * SDK barrel-aware seeds (#2707) against the REAL repository: the graph is
 * built by the same `git ls-files`/`git grep` enumeration the changed lane
 * uses, over the real SDK barrels and their real importers. The fixture
 * suite (`sdk-barrel-selection.test.ts`) owns the individual rules; this file
 * proves they hold on the corpus that overran the fast lane.
 *
 * Real paths are named deliberately. If one moves, update the pin to an
 * equivalent importer rather than deleting the case.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  loadSdkImportGraph,
  refinedSeedsFor,
} from '../lib/sdk-barrel-selection.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCHEDULER = 'packages/sdk/src/client/scheduler.ts';
// `import { SchedulerResponseError } from '@kontourai/station-sdk'` — the
// root barrel's named re-export of scheduler.ts. schedule-utils.test.ts
// reaches scheduler.ts only through this module.
const SCHEDULER_ERROR_IMPORTER = 'src-ui/src/views/schedule/utils.ts';
// `import { updateAgentRaw, ... } from '@kontourai/station-sdk/client'` — the
// client barrel, names declared in client/agents.ts only.
const AGENTS_ONLY_IMPORTER = 'src-ui/src/__tests__/agents-view-utils.test.ts';

let graph: ReturnType<typeof loadSdkImportGraph>;
beforeAll(() => {
  graph = loadSdkImportGraph(ROOT);
});

describe('SDK barrel selection on the real corpus', () => {
  test('a root-barrel importer of { SchedulerResponseError } is a scheduler.ts seed', () => {
    expect(refinedSeedsFor(graph, SCHEDULER).seeds).toContain(
      SCHEDULER_ERROR_IMPORTER,
    );
  });

  test('the barrel suite is a seed for every barrel-reachable client', () => {
    for (const client of [SCHEDULER, 'packages/sdk/src/client/agents.ts'])
      expect(refinedSeedsFor(graph, client).seeds).toContain(
        'packages/sdk/src/__tests__/publicBarrel.test.ts',
      );
  });

  test('an importer of unrelated client names is not a scheduler.ts seed, but is its own client’s', () => {
    expect(refinedSeedsFor(graph, SCHEDULER).seeds).not.toContain(
      AGENTS_ONLY_IMPORTER,
    );
    expect(
      refinedSeedsFor(graph, 'packages/sdk/src/client/agents.ts').seeds,
    ).toContain(AGENTS_ONLY_IMPORTER);
  });

  test('before/after: resolving named imports narrows a single-client edit', () => {
    const refined = refinedSeedsFor(graph, SCHEDULER).seeds;
    // The old behaviour: every barrel import depends on the whole barrel.
    const whole = refinedSeedsFor(
      { ...graph, resolveBarrelName: (barrel: string) => [barrel] },
      SCHEDULER,
    ).seeds;
    const wholeSet = new Set(whole);
    expect(refined.filter((seed) => !wholeSet.has(seed))).toEqual([]);
    expect(whole).toContain(AGENTS_ONLY_IMPORTER);
    // Measured 2026-09-26: 322 refined seeds against 672 whole-barrel seeds.
    // The bound is loose on purpose; the subset and the named control above
    // are what pin the direction.
    expect(refined.length).toBeLessThan(whole.length * 0.75);
  });
});
