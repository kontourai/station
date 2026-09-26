/**
 * SDK barrel-aware related-test seeds (#2707), against an in-memory fixture
 * shaped like the real SDK: a root barrel with named and star re-exports, a
 * client barrel re-exporting every client with `export *`, and an
 * intermediate re-exporter (`hooks.ts`) that imports a client.
 *
 * The seeds replace a changed SDK module in `vitest related`, so "selected"
 * below means "is a seed": vitest then selects every test reaching a seed.
 * The repository-level counterpart, which drives `git` against the real
 * corpus, is `sdk-barrel-selection.repo.test.ts`.
 */
import { describe, expect, test } from 'vitest';
import {
  buildSdkImportGraph,
  refinedSeedsFor,
  refineSdkBarrelRelatedPaths,
  topLevelSideEffect,
} from '../lib/sdk-barrel-selection.mjs';
import { discoverRelatedTestFiles } from '../run-changed-verification.mjs';

const SCHEDULER = 'packages/sdk/src/client/scheduler.ts';
const BOARD = 'packages/sdk/src/client/board.ts';
const ROOT_BARREL = 'packages/sdk/src/index.ts';
const CLIENT_BARREL = 'packages/sdk/src/client/index.ts';

// Assembled, so the repo-scan walk heuristic (path-read-pin-boundary) does
// not read this fixture text as a glob walk of the real tree.
const IMPORT_META_GLOB = ['import', 'meta', 'glob'].join('.');

const SDK_SOURCES: Record<string, string> = {
  [ROOT_BARREL]: `
    export { SchedulerResponseError, listJobs } from './client/scheduler';
    export * from './client/index';
    export * from './hooks';
    export type { Job } from './client/scheduler';
    import { getBoard as readBoard } from './client/board';
    export { readBoard };
    export async function localHelper() {
      return (await import('./client/board')).getBoard();
    }
  `,
  [CLIENT_BARREL]: `
    export * from './board';
    export * from './scheduler';
  `,
  [BOARD]: `
    import { authenticatedFetch } from './http';
    export class BoardResponseError extends Error {}
    export async function fetchBoard() { return authenticatedFetch('/board'); }
    export async function getBoard() { return fetchBoard(); }
  `,
  [SCHEDULER]: `
    import { authenticatedFetch } from './http';
    export interface Job { id: string }
    export class SchedulerResponseError extends Error {
      static readonly code = 'scheduler';
    }
    export async function listJobs() { return authenticatedFetch('/jobs'); }
  `,
  'packages/sdk/src/client/http.ts': `
    export const DEFAULT_TIMEOUT = Object.freeze({ ms: 30_000 });
    export function authenticatedFetch(path: string) { return fetch(path); }
  `,
  'packages/sdk/src/hooks.ts': `
    import { listJobs } from './client/scheduler';
    export function useJobs() { return listJobs; }
    export function useNothing() { return null; }
  `,
  'packages/sdk/src/__tests__/publicBarrel.test.ts': `
    const barrel = await import('../index');
    const loaders = ${IMPORT_META_GLOB}('../query-domains/*.ts');
  `,
};

const OUTSIDE_SOURCES: Record<string, string> = {
  'src-ui/src/__tests__/scheduler-error.test.ts': `
    import { SchedulerResponseError } from '@kontourai/station-sdk';
  `,
  'src-ui/src/__tests__/board.test.ts': `
    import { fetchBoard } from '@kontourai/station-sdk';
  `,
  'src-ui/src/__tests__/board-client.test.ts': `
    import { fetchBoard } from '@kontourai/station-sdk/client';
  `,
  'src-ui/src/__tests__/board-renamed.test.ts': `
    import { readBoard } from '@kontourai/station-sdk';
  `,
  'src-ui/src/__tests__/hooks.test.ts': `
    import { useJobs } from '@kontourai/station-sdk';
  `,
  'src-ui/src/__tests__/hooks-unrelated.test.ts': `
    import { useNothing } from '@kontourai/station-sdk';
  `,
  'src-ui/src/__tests__/namespace.test.ts': `
    import * as sdk from '@kontourai/station-sdk';
  `,
  'src-ui/src/__tests__/mocked.test.ts': `
    import { fetchBoard } from '@kontourai/station-sdk';
    vi.mock('@kontourai/station-sdk', () => ({ fetchBoard: vi.fn() }));
  `,
  'src-ui/src/__tests__/mocked-client.test.ts': `
    vi.mock('../../../packages/sdk/src/client/index.js');
  `,
  'src-ui/src/__tests__/dynamic.test.ts': `
    const sdk = await import('@kontourai/station-sdk');
  `,
  'src-ui/src/__tests__/side-effect-import.test.ts': `
    import '@kontourai/station-sdk/client';
  `,
  'src-ui/src/__tests__/type-only.test.ts': `
    import type { SchedulerResponseError } from '@kontourai/station-sdk';
    import { type Job } from '@kontourai/station-sdk';
  `,
  'src-ui/src/__tests__/local-helper.test.ts': `
    import { localHelper } from '@kontourai/station-sdk';
  `,
  'src-ui/src/__tests__/deep-relative.test.ts': `
    import { listJobs } from '../../../packages/sdk/src/client/scheduler.js';
  `,
  'src-ui/src/__tests__/unexported-subpath.test.ts': `
    import { anything } from '@kontourai/station-sdk/not-exported';
  `,
  // Transitive: a test reaches the client through a local module. The local
  // module is the seed; vitest related selects the test that imports it.
  'src-ui/src/views/schedule/utils.ts': `
    import { SchedulerResponseError } from '@kontourai/station-sdk';
    export const isSchedulerError = (error: unknown) =>
      error instanceof SchedulerResponseError;
  `,
  'src-ui/src/views/board/utils.ts': `
    import { getBoard } from '@kontourai/station-sdk';
    export const boardOf = () => getBoard();
  `,
  'src-ui/src/lib/sdk-reexport.ts': `
    export * from '@kontourai/station-sdk';
  `,
};

function fixtureGraph(overrides: Record<string, string> = {}) {
  const sources = new Map(
    Object.entries({ ...SDK_SOURCES, ...OUTSIDE_SOURCES, ...overrides }),
  );
  return buildSdkImportGraph({
    sources,
    fileSet: [...sources.keys()].filter((path) =>
      path.startsWith('packages/sdk/'),
    ),
    sdkExports: {
      '.': './src/index.ts',
      './client': './src/client/index.ts',
    },
  });
}

function seedsFor(changed: string, overrides?: Record<string, string>) {
  return refinedSeedsFor(fixtureGraph(overrides), changed).seeds;
}

// The old behaviour, as a control: every barrel import depends on the whole
// barrel. Used to prove the refinement is what narrows the fixture.
function wholeBarrelSeedsFor(changed: string) {
  const graph = fixtureGraph();
  return refinedSeedsFor(
    { ...graph, resolveBarrelName: (barrel: string) => [barrel] },
    changed,
  ).seeds;
}

describe('named barrel imports resolve to the declaring module', () => {
  test('a UI test importing { SchedulerResponseError } from the root barrel is selected for scheduler.ts', () => {
    expect(seedsFor(SCHEDULER)).toContain(
      'src-ui/src/__tests__/scheduler-error.test.ts',
    );
  });

  test('a test importing only { fetchBoard } is not selected for scheduler.ts, and is for board.ts', () => {
    const scheduler = seedsFor(SCHEDULER);
    const board = seedsFor(BOARD);
    for (const path of [
      'src-ui/src/__tests__/board.test.ts',
      'src-ui/src/__tests__/board-client.test.ts',
    ]) {
      expect(scheduler).not.toContain(path);
      expect(board).toContain(path);
    }
  });

  test('a name re-exported through an import binding resolves to its declaring module', () => {
    expect(seedsFor(SCHEDULER)).not.toContain(
      'src-ui/src/__tests__/board-renamed.test.ts',
    );
    expect(seedsFor(BOARD)).toContain(
      'src-ui/src/__tests__/board-renamed.test.ts',
    );
  });

  test('transitive: test -> local module -> barrel named import -> client', () => {
    expect(seedsFor(SCHEDULER)).toContain('src-ui/src/views/schedule/utils.ts');
    expect(seedsFor(SCHEDULER)).not.toContain(
      'src-ui/src/views/board/utils.ts',
    );
    expect(seedsFor(BOARD)).toContain('src-ui/src/views/board/utils.ts');
  });

  test('an intermediate SDK module that imports the client carries it to its importers', () => {
    const seeds = seedsFor(SCHEDULER);
    expect(seeds).toContain('src-ui/src/__tests__/hooks.test.ts');
    // Same intermediate module, a name that does not depend on it: the
    // declaring module is hooks.ts either way, which imports scheduler.ts.
    expect(seeds).toContain('src-ui/src/__tests__/hooks-unrelated.test.ts');
  });

  test('a deep relative import of the client is a direct edge', () => {
    expect(seedsFor(SCHEDULER)).toContain(
      'src-ui/src/__tests__/deep-relative.test.ts',
    );
  });

  test('type-only imports are erased and select nothing', () => {
    expect(seedsFor(SCHEDULER)).not.toContain(
      'src-ui/src/__tests__/type-only.test.ts',
    );
  });

  test('the refinement is what narrows the selection (control: whole-barrel resolution)', () => {
    const refined = seedsFor(SCHEDULER);
    const whole = wholeBarrelSeedsFor(SCHEDULER);
    expect(whole).toContain('src-ui/src/__tests__/board.test.ts');
    expect(refined.length).toBeLessThan(whole.length);
    for (const seed of refined) expect(whole).toContain(seed);
  });
});

describe('forms that depend on the whole barrel stay selected', () => {
  const unrelated = BOARD; // none of these name a board export specifically

  test.each([
    ['namespace import', 'src-ui/src/__tests__/namespace.test.ts'],
    ['dynamic import', 'src-ui/src/__tests__/dynamic.test.ts'],
    ['side-effect import', 'src-ui/src/__tests__/side-effect-import.test.ts'],
    ['export * from the barrel', 'src-ui/src/lib/sdk-reexport.ts'],
    [
      'a name the barrel declares itself',
      'src-ui/src/__tests__/local-helper.test.ts',
    ],
    [
      'an unexported SDK subpath',
      'src-ui/src/__tests__/unexported-subpath.test.ts',
    ],
    [
      'the barrel suite: a dynamic import and an import-meta file pattern',
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
    ],
  ])('%s', (_form, path) => {
    expect(seedsFor(SCHEDULER)).toContain(path);
    expect(seedsFor(unrelated)).toContain(path);
  });

  test('vi.mock of the root barrel, even with a named import of an unrelated name', () => {
    expect(seedsFor(SCHEDULER)).toContain(
      'src-ui/src/__tests__/mocked.test.ts',
    );
  });

  test('vi.mock of any specifier resolving to a barrel (relative client barrel)', () => {
    expect(seedsFor(SCHEDULER)).toContain(
      'src-ui/src/__tests__/mocked-client.test.ts',
    );
  });

  test.each([
    ['vi.doMock', "vi.doMock('@kontourai/station-sdk', () => ({}));"],
    ['vi.importActual', "await vi.importActual('@kontourai/station-sdk');"],
    ['require', "const sdk = require('@kontourai/station-sdk');"],
  ])('%s of the barrel', (_form, body) => {
    const path = 'src-ui/src/__tests__/extra-form.test.ts';
    expect(seedsFor(SCHEDULER, { [path]: body })).toContain(path);
  });

  test('a name found in two star re-exports is ambiguous and keeps the whole barrel', () => {
    const path = 'src-ui/src/__tests__/ambiguous.test.ts';
    const overrides = {
      [SCHEDULER]: `${SDK_SOURCES[SCHEDULER]}\nexport function fetchBoard() {}`,
      [path]: "import { fetchBoard } from '@kontourai/station-sdk/client';",
    };
    // Checked from the SECOND provider in star order: picking the first
    // match (board.ts) would silently drop it here.
    expect(seedsFor(SCHEDULER, overrides)).toContain(path);
    expect(seedsFor(BOARD, overrides)).toContain(path);
  });

  test('a name no module provides keeps the whole barrel', () => {
    const path = 'src-ui/src/__tests__/missing-name.test.ts';
    expect(
      seedsFor(SCHEDULER, {
        [path]: "import { noSuchExport } from '@kontourai/station-sdk';",
      }),
    ).toContain(path);
  });

  test('a computed dynamic import in a file that references the SDK is opaque', () => {
    const path = 'src-ui/src/__tests__/computed.test.ts';
    expect(
      seedsFor(SCHEDULER, {
        [path]:
          "import { fetchBoard } from '@kontourai/station-sdk';\nconst m = await import('./' + name);",
      }),
    ).toContain(path);
  });
});

describe('refineSdkBarrelRelatedPaths decisions', () => {
  const graph = fixtureGraph();
  const refine = (
    paths: string[],
    {
      base = 'merge-base',
      baseSources = {} as Record<string, string | null>,
    } = {},
  ) =>
    refineSdkBarrelRelatedPaths('/repo', paths, {
      base,
      loadGraph: () => graph,
      readBase: (_root: string, _base: string, path: string) =>
        path in baseSources ? baseSources[path] : (SDK_SOURCES[path] ?? null),
    });

  test('a barrel edit is never refined: every barrel importer stays selected', () => {
    for (const barrel of [ROOT_BARREL, CLIENT_BARREL]) {
      const result = refine([barrel]);
      expect(result.paths).toEqual([barrel]);
      expect(result.decisions).toEqual([]);
    }
  });

  test('a pure client module is replaced by its seeds; other paths pass through', () => {
    const result = refine([SCHEDULER, 'src-server/index.ts']);
    expect(result.paths).not.toContain(SCHEDULER);
    expect(result.paths).toContain('src-server/index.ts');
    expect(result.paths).toContain(
      'src-ui/src/__tests__/scheduler-error.test.ts',
    );
    expect(result.decisions).toEqual([
      { path: SCHEDULER, disposition: 'refined', seeds: expect.any(Number) },
    ]);
  });

  test('without a base nothing is refined', () => {
    const result = refineSdkBarrelRelatedPaths('/repo', [SCHEDULER], {
      loadGraph: () => {
        throw new Error('must not load');
      },
    });
    expect(result).toEqual({ paths: [SCHEDULER], decisions: [] });
  });

  test('a module with a top-level side effect at the head keeps whole-barrel selection', () => {
    const impure = fixtureGraph({
      [SCHEDULER]: `${SDK_SOURCES[SCHEDULER]}\nglobalThis.scheduler = true;`,
    });
    const result = refineSdkBarrelRelatedPaths('/repo', [SCHEDULER], {
      base: 'merge-base',
      loadGraph: () => impure,
      readBase: () => SDK_SOURCES[SCHEDULER],
    });
    expect(result.paths).toEqual([SCHEDULER]);
    expect(result.decisions[0]).toMatchObject({
      disposition: 'whole-barrel',
      reason: expect.stringMatching(/side effect at head/),
    });
  });

  test('a side effect the change REMOVED still keeps whole-barrel selection', () => {
    const result = refine([SCHEDULER], {
      baseSources: {
        [SCHEDULER]: `${SDK_SOURCES[SCHEDULER]}\nregisterScheduler();`,
      },
    });
    expect(result.paths).toEqual([SCHEDULER]);
    expect(result.decisions[0].reason).toMatch(/side effect at base/);
  });

  test('base content that git cannot produce keeps whole-barrel selection', () => {
    const result = refineSdkBarrelRelatedPaths('/repo', [SCHEDULER], {
      base: 'merge-base',
      loadGraph: () => graph,
      readBase: () => {
        throw new Error('bad object');
      },
    });
    expect(result.paths).toEqual([SCHEDULER]);
    expect(result.decisions[0].reason).toMatch(/base content unavailable/);
  });

  test('an unavailable import graph keeps whole-barrel selection', () => {
    const result = refineSdkBarrelRelatedPaths('/repo', [SCHEDULER], {
      base: 'merge-base',
      loadGraph: () => {
        throw new Error('git grep failed');
      },
    });
    expect(result.paths).toEqual([SCHEDULER]);
    expect(result.decisions[0].reason).toMatch(/import graph unavailable/);
  });

  test('a new module (absent at base) is refined on its head content', () => {
    const result = refine([SCHEDULER], { baseSources: { [SCHEDULER]: null } });
    expect(result.decisions[0].disposition).toBe('refined');
  });

  test('importers of a name the module exported at the base are still selected', () => {
    // The change moved cancelJob from scheduler.ts to board.ts: at the head
    // the name resolves to board.ts, but its importer's binding changed
    // because of the scheduler.ts edit.
    const path = 'src-ui/src/__tests__/moved-name.test.ts';
    const relocated = fixtureGraph({
      [BOARD]: `${SDK_SOURCES[BOARD]}\nexport async function cancelJob() {}`,
      [path]: "import { cancelJob } from '@kontourai/station-sdk';",
    });
    const refineWithBase = (baseSource: string) =>
      refineSdkBarrelRelatedPaths('/repo', [SCHEDULER], {
        base: 'merge-base',
        loadGraph: () => relocated,
        readBase: () => baseSource,
      });
    expect(
      refineWithBase(
        `${SDK_SOURCES[SCHEDULER]}\nexport async function cancelJob() {}`,
      ).paths,
    ).toContain(path);
    // Control: when scheduler.ts never exported it, the importer is board's.
    expect(refineWithBase(SDK_SOURCES[SCHEDULER]).paths).not.toContain(path);
  });
});

describe('topLevelSideEffect', () => {
  test.each([
    ['a declaration-only module', SDK_SOURCES[SCHEDULER]],
    [
      'frozen constants and allowlisted constructors',
      "export const A = Object.freeze({ a: [1, 2] });\nconst e = new TextEncoder();\nconst s = new Set(['a']);",
    ],
    [
      'type declarations and directives',
      "'use strict';\nexport type A = string;\nexport interface B {}\ndeclare const g: number;",
    ],
    [
      'a class extending an imported base',
      "import { Base } from './b';\nexport class A extends Base { static k = 'a'; }",
    ],
    [
      'a const enum-like object and arrow functions',
      'export const K = { a: 1 } as const;\nexport const f = () => globalThis.fetch;',
    ],
  ])('%s is pure', (_label, source) => {
    expect(topLevelSideEffect('m.ts', source)).toBeNull();
  });

  test.each([
    ['a bare call', 'register();'],
    ['a call in an initializer', 'export const client = createClient();'],
    ['a global assignment', 'globalThis.x = 1;'],
    ['a side-effect import', "import './style.css';"],
    ['a registry instance', 'export const registry = new Registry();'],
    ['a static block', 'export class A { static { init(); } }'],
    ['an impure static initializer', 'export class A { static x = load(); }'],
    [
      'a destructured import',
      "import { cfg } from './c';\nexport const { a } = cfg;",
    ],
    ['a top-level await', 'await ready;'],
    ['a tagged template', 'export const q = gql`query`;'],
  ])('%s is a side effect', (_label, source) => {
    expect(topLevelSideEffect('m.ts', source)).not.toBeNull();
  });
});

describe('discoverRelatedTestFiles hands the refined seeds to vitest', () => {
  test('the child receives the seeds, not the changed module', async () => {
    let argv: string[] = [];
    const files = await discoverRelatedTestFiles('/repo', [SCHEDULER], {
      base: 'merge-base',
      refine: () => ({
        paths: ['src-ui/src/views/schedule/utils.ts'],
        decisions: [{ path: SCHEDULER, disposition: 'refined', seeds: 1 }],
      }),
      reportRefinement: () => {},
      run: async (_command: string, args: string[]) => {
        argv = args;
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify(['src-ui/src/views/schedule/utils.test.ts']),
          stderr: '',
          launch: { attempted: true, started: true },
          cleanup: { status: 'passed', survivingOwnedChildren: 0 },
          error: undefined,
        };
      },
    });
    expect(files).toEqual(['src-ui/src/views/schedule/utils.test.ts']);
    expect(argv.at(-1)).toBe('/repo/src-ui/src/views/schedule/utils.ts');
    expect(argv.join(' ')).not.toContain('client/scheduler.ts');
  });

  test('a refinement with no seeds is an empty discovery without a child', async () => {
    const files = await discoverRelatedTestFiles('/repo', [SCHEDULER], {
      base: 'merge-base',
      refine: () => ({ paths: [], decisions: [] }),
      run: async () => {
        throw new Error('must not spawn');
      },
    });
    expect(files).toEqual([]);
  });
});
