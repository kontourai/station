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
  topLevelUseAnalysis,
} from '../lib/sdk-barrel-selection.mjs';
import { discoverRelatedTestFiles } from '../run-changed-verification.mjs';

// A template-literal span in fixture source, spelled without a literal
// `${` in this file's own strings.
const span = (name: string) => `$\{${name}}`;

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

  test('a renamed re-export resolves the SOURCE name, not the exported one', () => {
    // The barrel exports mid's `a` under the name `b`; mid also exports a
    // different `b`. An importer of `b` depends on x.ts, never y.ts.
    const importer = 'src-ui/src/__tests__/renamed.test.ts';
    const overrides = {
      [ROOT_BARREL]: `${SDK_SOURCES[ROOT_BARREL]}\nexport { a as b } from './mid';`,
      'packages/sdk/src/mid.ts':
        "export { a } from './x';\nexport { b } from './y';",
      'packages/sdk/src/x.ts': 'export const a = 1;',
      'packages/sdk/src/y.ts': 'export const b = 2;',
      [importer]: "import { b } from '@kontourai/station-sdk';",
    };
    expect(seedsFor('packages/sdk/src/x.ts', overrides)).toContain(importer);
    expect(seedsFor('packages/sdk/src/y.ts', overrides)).not.toContain(
      importer,
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

  test('automock: vi.mock of a barrel specifier with no factory (relative client barrel)', () => {
    expect(seedsFor(SCHEDULER)).toContain(
      'src-ui/src/__tests__/mocked-client.test.ts',
    );
  });

  test.each([
    ['vi.doMock automock', "vi.doMock('@kontourai/station-sdk');"],
    ['vi.unmock', "vi.unmock('@kontourai/station-sdk');"],
    ['vi.importActual', "await vi.importActual('@kontourai/station-sdk');"],
    ['vi.importMock', "await vi.importMock('@kontourai/station-sdk');"],
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

describe('factory mocks evaluate nothing real unless they can reach the original', () => {
  const path = 'src-ui/src/__tests__/factory-mock.test.ts';
  const withFactory = (body: string) =>
    `import { fetchBoard } from '@kontourai/station-sdk';\n${body}`;
  const selectedFor = (changed: string, body: string) =>
    seedsFor(changed, { [path]: withFactory(body) }).includes(path);

  test.each([
    [
      'vi.mock',
      "vi.mock('@kontourai/station-sdk', () => ({ fetchBoard: vi.fn() }));",
    ],
    [
      'vi.doMock',
      "vi.doMock('@kontourai/station-sdk', () => ({ fetchBoard: vi.fn() }));",
    ],
    [
      'a factory using a third-party import',
      "import React from 'react';\nvi.mock('@kontourai/station-sdk', () => ({ Box: () => React.createElement('div') }));",
    ],
  ])(
    'a factory-only %s is NOT selected for an unrelated module, and its named imports still resolve',
    (_form, body) => {
      expect(selectedFor(SCHEDULER, body)).toBe(false);
      expect(selectedFor(BOARD, body)).toBe(true);
    },
  );

  test.each([
    [
      'an importOriginal factory',
      "vi.mock('@kontourai/station-sdk', async (importOriginal) => ({ ...(await importOriginal()), fetchBoard: vi.fn() }));",
    ],
    [
      // Named differently, so only the parameter itself gives it away.
      'a factory taking the original under another name',
      "vi.mock('@kontourai/station-sdk', async (original) => ({ ...(await original()), fetchBoard: vi.fn() }));",
    ],
    [
      'a factory plus vi.importActual elsewhere in the file',
      "vi.mock('@kontourai/station-sdk', () => ({ fetchBoard: vi.fn() }));\nconst real = () => vi.importActual('./anything');",
    ],
    [
      'a factory calling an imported repository helper',
      "import { sdkMock } from './helpers/sdk-mock';\nvi.mock('@kontourai/station-sdk', () => sdkMock());",
    ],
    [
      'a factory calling a local wrapper around an imported helper',
      "import { sdkMock } from '@/test-utils/sdk-mock';\nconst build = () => ({ ...sdkMock() });\nvi.mock('@kontourai/station-sdk', () => build());",
    ],
    [
      'a factory loading a helper module dynamically',
      "vi.mock('@kontourai/station-sdk', async () => (await import('./helpers/sdk-mock')).sdkMock());",
    ],
    [
      'a factory passed by reference',
      "const factory = () => ({ fetchBoard: vi.fn() });\nvi.mock('@kontourai/station-sdk', factory);",
    ],
    [
      'a factory reading `arguments`',
      "vi.mock('@kontourai/station-sdk', function () { return { ...arguments[0] }; });",
    ],
  ])('%s keeps the whole barrel', (_form, body) => {
    expect(selectedFor(SCHEDULER, body)).toBe(true);
  });

  test.each([
    [
      'element access on vi',
      "vi.mock('@kontourai/station-sdk', () => ({ fetchBoard: vi.fn() }));\nconst load = vi['import' + 'Actual'];",
    ],
    [
      'an aliased vi import',
      "import { vi as v } from 'vitest';\nv.mock('@kontourai/station-sdk');",
    ],
    [
      'a namespace vitest import',
      "import * as vitest from 'vitest';\nvitest.vi.mock('@kontourai/station-sdk');",
    ],
    [
      'vi handed to a helper',
      "import { vi } from 'vitest';\nvi.mock('@kontourai/station-sdk', () => ({ fetchBoard: vi.fn() }));\ninstallMocks(vi);",
    ],
  ])(
    'mock detection cannot see through %s, so the file keeps the whole SDK',
    (_form, body) => {
      expect(selectedFor(SCHEDULER, body)).toBe(true);
    },
  );

  test.each([
    [
      'element access',
      "const sdk = await vi['importActual']('@kontourai/station-sdk');",
    ],
    [
      'an aliased vi',
      "import { vi as v } from 'vitest';\nconst sdk = await v.importActual('@kontourai/station-sdk');",
    ],
  ])(
    'a vi escape through %s selects the file even with no static SDK import',
    (_form, body) => {
      const only = 'src-ui/src/__tests__/escape-only.test.ts';
      expect(seedsFor(SCHEDULER, { [only]: body })).toContain(only);
    },
  );

  test('vi in a type position or as a direct property access is not an escape (control)', () => {
    const body =
      "import { vi } from 'vitest';\nvi.mock('@kontourai/station-sdk', () => ({ fetchBoard: vi.fn() }));\nlet m: ReturnType<typeof vi.fn>;";
    expect(selectedFor(SCHEDULER, body)).toBe(false);
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

  describe('changes a pure-statement scan cannot see', () => {
    const REGISTRY = 'packages/sdk/src/voice/session-registry.ts';
    const withRegistry = {
      [REGISTRY]:
        'export const voiceSessionAdapterRegistry = new VoiceSessionAdapterRegistry();',
    };
    const REGISTRATION = 'packages/sdk/src/registration.ts';
    const decide = (
      headOverrides: Record<string, string>,
      baseSource: string | null,
    ) =>
      refineSdkBarrelRelatedPaths('/repo', [SCHEDULER], {
        base: 'merge-base',
        loadGraph: () =>
          fixtureGraph({
            ...withRegistry,
            // A top-level use matters only in a module the barrel
            // evaluates, so the fixture's registration module is one.
            ...(REGISTRATION in headOverrides
              ? {
                  [ROOT_BARREL]: `${SDK_SOURCES[ROOT_BARREL]}\nexport * from './registration';`,
                }
              : {}),
            ...headOverrides,
          }),
        readBase: () => baseSource,
      });

    // #2782: an import change is refinable only when it moves an edge
    // between modules a barrel load evaluates anyway, and moving it cannot
    // be observed. Extra client modules, all barrel-reachable through the
    // client barrel unless noted.
    const IMPORT_FIXTURE = {
      [CLIENT_BARREL]: `${SDK_SOURCES[CLIENT_BARREL]}\nexport * from './impure';\nexport * from './wrapper';\nexport * from './loops-back';\nexport * from './outside';\nexport * from './ghost-loader';`,
      'packages/sdk/src/client/impure.ts':
        'export const registry = new Registry();',
      'packages/sdk/src/client/wrapper.ts':
        "import { registry } from './impure';\nexport const wrapped = () => registry;",
      'packages/sdk/src/client/loops-back.ts':
        "import { listJobs } from './scheduler';\nexport const again = () => listJobs;",
      'packages/sdk/src/client/outside.ts':
        "import { z } from 'zod';\nexport const schema = () => z;",
      'packages/sdk/src/client/ghost-loader.ts':
        "import { ghost } from './ghost';\nexport const g = () => ghost;",
      // Barrel-unreachable: only ever imported dynamically, or by nobody.
      'packages/sdk/src/client/lazy.ts': 'export const lazy = 1;',
      'packages/sdk/src/client/fresh.ts': 'export const fresh = 1;',
      [BOARD]: `${SDK_SOURCES[BOARD]}\nexport const later = () => import('./lazy');`,
    };
    const decideImports = (
      head: string,
      base: string,
      { overrides = {}, changed, baseOf = {} } = {} as {
        overrides?: Record<string, string>;
        changed?: string[];
        baseOf?: Record<string, string | null>;
      },
    ) => {
      const sources = new Map(
        Object.entries({
          ...SDK_SOURCES,
          ...OUTSIDE_SOURCES,
          ...IMPORT_FIXTURE,
          ...overrides,
          [SCHEDULER]: head,
        }),
      );
      const graph = buildSdkImportGraph({
        sources,
        // ghost.ts exists (so it resolves) but is never read.
        fileSet: [...sources.keys(), 'packages/sdk/src/client/ghost.ts'].filter(
          (path) => path.startsWith('packages/sdk/'),
        ),
        sdkExports: {
          '.': './src/index.ts',
          './client': './src/client/index.ts',
        },
      });
      return refineSdkBarrelRelatedPaths('/repo', [SCHEDULER], {
        base: 'merge-base',
        loadGraph: () => graph,
        changedSdkPaths: changed,
        readBase: (_root: string, _base: string, path: string) =>
          path === SCHEDULER
            ? base
            : path in baseOf
              ? baseOf[path]
              : (sources.get(path) ?? null),
      }).decisions[0];
    };
    const withImport = (line: string) => `${line}\n${SDK_SOURCES[SCHEDULER]}`;

    test.each([
      [
        'adds an import of a pure, barrel-reachable module',
        withImport("import { fetchBoard } from './board';"),
        SDK_SOURCES[SCHEDULER],
        null,
      ],
      [
        'removes an import of a module still barrel-reachable',
        SDK_SOURCES[SCHEDULER],
        withImport("import { getBoard } from './board';"),
        null,
      ],
      [
        'adds a type-only import (erased)',
        withImport("import type { Unused } from './fresh';"),
        SDK_SOURCES[SCHEDULER],
        null,
      ],
      [
        'adds an import of a reachable module with a top-level side effect',
        withImport("import { registry } from './impure';"),
        SDK_SOURCES[SCHEDULER],
        /client\/impure\.ts, loaded by .*impure\.ts, has a top-level side effect/,
      ],
      [
        'adds an import whose closure holds a side effect',
        withImport("import { wrapped } from './wrapper';"),
        SDK_SOURCES[SCHEDULER],
        /client\/impure\.ts, loaded by .*wrapper\.ts, has a top-level side effect/,
      ],
      [
        'adds an import of a module that is not barrel-reachable',
        withImport("import { fresh } from './fresh';"),
        SDK_SOURCES[SCHEDULER],
        /fresh\.ts is not barrel-reachable at the base/,
      ],
      [
        'adds a static import of a module only ever loaded dynamically',
        withImport("import { lazy } from './lazy';"),
        SDK_SOURCES[SCHEDULER],
        /lazy\.ts is not barrel-reachable at the base/,
      ],
      [
        'adds a barrel self-import (a cycle)',
        withImport("import { fetchBoard } from '../index';"),
        SDK_SOURCES[SCHEDULER],
        /loads .*scheduler\.ts \(a cycle\)|which loads .*scheduler\.ts/,
      ],
      [
        'adds an import of a module that loads it back (a cycle)',
        withImport("import { again } from './loops-back';"),
        SDK_SOURCES[SCHEDULER],
        /a cycle/,
      ],
      [
        'adds an import whose closure loads a module outside the SDK',
        withImport("import { schema } from './outside';"),
        SDK_SOURCES[SCHEDULER],
        /outside\.ts, loaded by .*, loads a module outside the SDK/,
      ],
      [
        'adds an import of a module outside the SDK',
        withImport("import { z } from 'zod';"),
        SDK_SOURCES[SCHEDULER],
        /zod is outside the SDK/,
      ],
      [
        'adds an import whose closure is unreadable',
        withImport("import { g } from './ghost-loader';"),
        SDK_SOURCES[SCHEDULER],
        /ghost\.ts, loaded by .*ghost-loader\.ts, is unreadable/,
      ],
      [
        'removes the only import of a module (no longer reachable)',
        SDK_SOURCES[SCHEDULER],
        withImport("import { fresh } from './fresh';"),
        /removed import .*fresh\.ts is no longer barrel-reachable/,
      ],
      [
        'adds an unresolvable import',
        withImport("import { nothing } from './missing';"),
        SDK_SOURCES[SCHEDULER],
        /does not resolve/,
      ],
    ])('a change that %s', (_label, head, base, blocker) => {
      const decision = decideImports(head, base);
      if (blocker === null) expect(decision.disposition).toBe('refined');
      else {
        expect(decision.disposition).toBe('whole-barrel');
        expect(decision.reason).toMatch(
          /^runtime imports differ from the base: /,
        );
        expect(decision.reason).toMatch(blocker);
      }
    });

    // #2782 review: an import move between already-evaluated pure modules is
    // still observable when the moved closure enters an import cycle at a
    // different module, or snapshots a binding its declarer reassigns while
    // other modules load. Runtime-verified shapes from the review.
    describe('order-sensitive closures', () => {
      const X = 'packages/sdk/src/client/x.ts';
      const decideMove = (
        files: Record<string, string>,
        xBase: string,
        xHead: string,
        changed: string[] = [X],
      ) => {
        const sources = new Map(Object.entries({ ...files, [X]: xHead }));
        const graph = buildSdkImportGraph({
          sources,
          fileSet: [...sources.keys()],
          sdkExports: { '.': './src/index.ts' },
        });
        return refineSdkBarrelRelatedPaths('/repo', [X], {
          base: 'merge-base',
          loadGraph: () => graph,
          changedSdkPaths: changed,
          readBase: (_root: string, _base: string, path: string) =>
            path === X ? xBase : (files[path] ?? null),
        }).decisions[0];
      };
      const liveFiles = (
        q: string,
        s = 'export let count = 0;\nexport function inc() { count++; }',
      ) => ({
        [ROOT_BARREL]:
          "export * from './client/index';\nexport * from './r';\nexport * from './q';",
        [CLIENT_BARREL]: "export * from './x';",
        'packages/sdk/src/s.ts': s,
        'packages/sdk/src/r.ts':
          "import { inc } from './s';\ninc();\nexport const rv = 1;",
        'packages/sdk/src/q.ts': q,
      });
      const qReadsCount =
        "import { count } from './s';\nexport const snap = count;";
      const xWithQ =
        "import { snap } from '../q';\nexport const xv = 1;\nexport function g() { return snap; }";
      const xAlone = 'export const xv = 1;';

      test('B: an added import moves a snapshot of a reassignable binding', () => {
        const decision = decideMove(liveFiles(qReadsCount), xAlone, xWithQ);
        expect(decision.reason).toMatch(
          /live binding: .*q\.ts, loaded by .*q\.ts, reads count, which .*s\.ts declares reassignable/,
        );
      });

      test('C: a removed import moves the same snapshot the other way', () => {
        const decision = decideMove(liveFiles(qReadsCount), xWithQ, xAlone);
        expect(decision.reason).toMatch(/live binding: .*reads count/);
      });

      test.each([
        [
          'through a re-export chain',
          "import { count } from './mid';\nexport const snap = count;",
          { 'packages/sdk/src/mid.ts': "export { count } from './s';" },
        ],
        [
          'only through a star re-export',
          "import { count } from './mid';\nexport const snap = count;",
          { 'packages/sdk/src/mid.ts': "export * from './s';" },
        ],
        [
          'declared by a renamed local export',
          qReadsCount,
          {
            'packages/sdk/src/s.ts':
              'let total = 0;\nexport function inc() { total++; }\nexport { total as count };',
          },
        ],
        [
          'of a function the module reassigns',
          "import { count } from './s';\nexport const snap = count;",
          {
            'packages/sdk/src/s.ts':
              'export function count() { return 0; }\nexport function inc() { count = () => 1; }',
          },
        ],
        [
          'of a function reassigned by destructuring',
          qReadsCount,
          {
            'packages/sdk/src/s.ts':
              'export function count() { return 0; }\nexport function inc() { [count] = [() => 1]; }',
          },
        ],
        [
          'of a function reassigned in a for-of head',
          qReadsCount,
          {
            'packages/sdk/src/s.ts':
              'export function count() { return 0; }\nexport function inc() { for (count of [() => 1]) {} }',
          },
        ],
        [
          // The rule counts every `export let`/`var`, even one the module never
          // visibly reassigns: the declaration says it may change.
          'of an `export let` with no visible reassignment',
          qReadsCount,
          {
            'packages/sdk/src/s.ts':
              'export let count = 0;\nexport function inc() { return count; }',
          },
        ],
      ])('B, %s', (_label, q, extra) => {
        const decision = decideMove(
          { ...liveFiles(q), ...extra },
          xAlone,
          xWithQ,
        );
        expect(decision.reason).toMatch(/live binding: .*reads count/);
      });

      test.each([
        ['a template span', `export const snap = \`${span('items')}\`;`],
        ['string concatenation', "export const snap = items + '';"],
        ['a relational comparison', 'export const snap = items > 0;'],
      ])(
        'coercing an imported mutable object in %s is a side effect of its own',
        (_label, snap) => {
          const decision = decideMove(
            liveFiles(
              `import { items } from './s';\n${snap}`,
              'export const items = [];\nexport function inc() { items.push(1); }',
            ),
            xAlone,
            xWithQ,
          );
          expect(decision.reason).toMatch(
            /q\.ts, loaded by .*q\.ts, has a top-level side effect/,
          );
        },
      );

      test('control: a snapshot of an imported `export const` still refines', () => {
        const decision = decideMove(
          liveFiles(
            qReadsCount,
            'export const count = 0;\nexport function inc() { return count; }',
          ),
          xAlone,
          xWithQ,
        );
        expect(decision.disposition).toBe('refined');
      });

      test.each([
        ['var', 'export var pv = 1;'],
        ['const', 'export const pv = 1;'],
      ])(
        'A: an added import enters a P/Q import cycle at P (%s)',
        (_kind, pv) => {
          const decision = decideMove(
            {
              [ROOT_BARREL]:
                "export * from './client/index';\nexport * from './q';\nexport * from './p';",
              [CLIENT_BARREL]: "export * from './x';",
              'packages/sdk/src/q.ts':
                "import { pv } from './p';\nexport const snap = [pv];",
              'packages/sdk/src/p.ts': `import { snap } from './q';\n${pv}\nexport function useSnap() { return snap; }`,
            },
            xAlone,
            "import { pv } from '../p';\nexport const xv = 1;\nexport function g() { return pv; }",
          );
          expect(decision.reason).toMatch(
            /import cycle: .*p\.ts, loaded by .*p\.ts, is in a cycle with .*q\.ts/,
          );
        },
      );

      test('a changed SDK exports map makes base reachability unknown', () => {
        const files = liveFiles(
          "import { fixed } from './s';\nexport const snap = fixed;",
          'export const fixed = 0;',
        );
        const decision = decideMove(files, xAlone, xWithQ, [
          X,
          'packages/sdk/package.json',
        ]);
        expect(decision.reason).toMatch(
          /base reachability is unknown \(packages\/sdk\/package\.json changed/,
        );
        // Control: the same change with the exports map unchanged refines.
        expect(decideMove(files, xAlone, xWithQ).disposition).toBe('refined');
      });
    });

    test('reachability is judged at the BASE: a target another changed file just exposed is new', () => {
      // At the head the client barrel re-exports fresh.ts, so it is
      // reachable there; at the base it was not.
      const head = withImport("import { fresh } from './fresh';");
      const barrelHead = `${IMPORT_FIXTURE[CLIENT_BARREL]}\nexport * from './fresh';`;
      const decision = decideImports(head, SDK_SOURCES[SCHEDULER], {
        overrides: { [CLIENT_BARREL]: barrelHead },
        changed: [SCHEDULER, CLIENT_BARREL],
        baseOf: { [CLIENT_BARREL]: IMPORT_FIXTURE[CLIENT_BARREL] },
      });
      expect(decision.reason).toMatch(
        /fresh\.ts is not barrel-reachable at the base/,
      );
      // Control: when the barrel already exported it at the base, it refines.
      expect(
        decideImports(head, SDK_SOURCES[SCHEDULER], {
          overrides: { [CLIENT_BARREL]: barrelHead },
          changed: [SCHEDULER, CLIENT_BARREL],
          baseOf: { [CLIENT_BARREL]: barrelHead },
        }).disposition,
      ).toBe('refined');
    });

    test('a target added in the same change (absent at the base) is new', () => {
      const decision = decideImports(
        withImport("import { fresh } from './fresh';"),
        SDK_SOURCES[SCHEDULER],
        {
          overrides: {
            [CLIENT_BARREL]: `${IMPORT_FIXTURE[CLIENT_BARREL]}\nexport * from './fresh';`,
          },
          changed: [SCHEDULER, 'packages/sdk/src/client/fresh.ts'],
          baseOf: { 'packages/sdk/src/client/fresh.ts': null },
        },
      );
      expect(decision.reason).toMatch(
        /fresh\.ts is not barrel-reachable at the base/,
      );
    });

    test('an unreadable changed set keeps whole-barrel for any added import', () => {
      const head = withImport("import { fetchBoard } from './board';");
      const graph = fixtureGraph({ [SCHEDULER]: head });
      const decide = (boardBase: () => string) =>
        refineSdkBarrelRelatedPaths('/repo', [SCHEDULER], {
          base: 'merge-base',
          loadGraph: () => graph,
          changedSdkPaths: [SCHEDULER, BOARD],
          readBase: (_root: string, _base: string, path: string) =>
            path === SCHEDULER ? SDK_SOURCES[SCHEDULER] : boardBase(),
        }).decisions[0];
      // The candidate's own base read succeeds; another changed file's does
      // not, so base reachability is unknown and the added edge stays whole.
      expect(
        decide(() => {
          throw new Error('git cannot read the base');
        }).reason,
      ).toMatch(
        /base reachability is unknown \(a changed SDK file is unreadable at the base: git cannot read the base\)/,
      );
      // Control: readable, the same change refines.
      expect(decide(() => SDK_SOURCES[BOARD]).disposition).toBe('refined');
    });

    test('the same imports, edited body: still refined (control)', () => {
      const result = decide(
        {
          [SCHEDULER]: `${SDK_SOURCES[SCHEDULER]}\nexport async function more() {}`,
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].disposition).toBe('refined');
    });

    test.each([
      [
        'directly',
        "import { listJobs } from './client/scheduler';\nregisterAll(listJobs);",
      ],
      [
        'through a barrel',
        "import { listJobs } from './index';\nexport const registered = register(listJobs);",
      ],
      [
        'through a renaming re-exporter that is not a barrel',
        "import { midJobs } from './mid';\nregistry.push(midJobs());",
      ],
      [
        'through a namespace import of that re-exporter',
        "import * as mid from './mid';\nregistry.push(mid.midJobs());",
      ],
    ])(
      'a barrel-graph module calling into it at top level %s keeps whole-barrel',
      (_label, source) => {
        const result = decide(
          {
            'packages/sdk/src/registration.ts': source,
            'packages/sdk/src/mid.ts':
              "export { listJobs as midJobs } from './client/scheduler';",
          },
          SDK_SOURCES[SCHEDULER],
        );
        expect(result.paths).toEqual([SCHEDULER]);
        expect(result.decisions[0].reason).toMatch(
          /registration\.ts line \d+ uses it in a top-level side effect/,
        );
      },
    );

    test.each([
      [
        'a namespace import of a star re-exporter',
        "export * from './client/scheduler';",
        "import * as m from './mid';\nregistry.push(m.listJobs());",
      ],
      [
        'a default import of a renamed default re-export',
        "export { listJobs as default } from './client/scheduler';",
        "import g from './mid';\nregistry.push(g());",
      ],
      [
        'a name behind a star next to an external star',
        "export * from './client/scheduler';\nexport * from 'some-package';",
        "import { listJobs } from './mid';\nregistry.push(listJobs());",
      ],
      [
        'a name behind a star next to an unresolvable star',
        "export * from './client/scheduler';\nexport * from './missing';",
        "import { listJobs } from './mid';\nregistry.push(listJobs());",
      ],
      [
        'a name only an unresolvable star could provide',
        "export * from './missing';",
        "import { listJobs } from './mid';\nregistry.push(listJobs());",
      ],
      [
        'a local const alias of an imported binding',
        "import { listJobs } from './client/scheduler';\nexport const g = listJobs;",
        "import { g } from './mid';\nregistry.push(g());",
      ],
    ])(
      'a top-level use through %s keeps whole-barrel',
      (_label, mid, registration) => {
        const result = decide(
          {
            'packages/sdk/src/mid.ts': mid,
            'packages/sdk/src/registration.ts': registration,
          },
          SDK_SOURCES[SCHEDULER],
        );
        expect(result.paths).toEqual([SCHEDULER]);
        expect(result.decisions[0].reason).toMatch(
          /registration\.ts line \d+ uses it in a top-level side effect/,
        );
      },
    );

    test('an `export default <expr>` re-exporter carries what its expression reads', () => {
      const result = decide(
        {
          'packages/sdk/src/mid.ts':
            "import { listJobs } from './client/scheduler';\nexport default [listJobs];",
          [REGISTRATION]: "import jobs from './mid';\nregistry.push(...jobs);",
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].reason).toMatch(
        /registration\.ts line \d+ uses it in a top-level side effect/,
      );
    });

    test('a module that resolves but cannot be read counts as providing', () => {
      const GHOST = 'packages/sdk/src/ghost.ts';
      const sources = new Map(
        Object.entries({
          ...SDK_SOURCES,
          ...OUTSIDE_SOURCES,
          ...withRegistry,
          [ROOT_BARREL]: `${SDK_SOURCES[ROOT_BARREL]}\nexport * from './registration';`,
          [REGISTRATION]:
            "import { thing } from './ghost';\nregistry.push(thing);",
        }),
      );
      const graph = buildSdkImportGraph({
        sources,
        // On disk (so it resolves) but never read into the graph.
        fileSet: [...sources.keys(), GHOST].filter((path) =>
          path.startsWith('packages/sdk/'),
        ),
        sdkExports: {
          '.': './src/index.ts',
          './client': './src/client/index.ts',
        },
      });
      const result = refineSdkBarrelRelatedPaths('/repo', [SCHEDULER], {
        base: 'merge-base',
        loadGraph: () => graph,
        readBase: () => SDK_SOURCES[SCHEDULER],
      });
      expect(result.decisions[0].reason).toMatch(
        /registration\.ts line \d+ uses it in a top-level side effect/,
      );
    });

    test('a module only a subpath evaluates is not a barrel importer’s concern; its own importers still are', () => {
      const SUBPATH_ONLY = 'packages/sdk/src/subpath-registration.ts';
      const importer = 'src-ui/src/__tests__/subpath-registration.test.ts';
      const result = decide(
        {
          [SUBPATH_ONLY]:
            "import { listJobs } from './client/scheduler';\nregistry.push(listJobs());",
          [importer]:
            "import '../../../packages/sdk/src/subpath-registration';",
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].disposition).toBe('refined');
      expect(result.paths).toContain(importer);
      // Control: the same module, evaluated by the barrel, is a use.
      const reachable = decide(
        {
          [REGISTRATION]:
            "import { listJobs } from './client/scheduler';\nregistry.push(listJobs());",
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(reachable.decisions[0].disposition).toBe('whole-barrel');
    });

    test('a function in a non-invoked position of an initializer is not read at load', () => {
      // The use only compares the value; handing it to a call would let the
      // callee call its methods (#2766), which a two-hop test pins below.
      const result = decide(
        {
          'packages/sdk/src/mid.ts':
            "import { listJobs } from './client/scheduler';\nexport const queries = { list: () => listJobs(), all: [function () { return listJobs; }] };",
          [REGISTRATION]:
            "import { queries } from './mid';\nregistry.ready = queries !== undefined;",
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].disposition).toBe('refined');
    });

    // Each initializer is pure at mid.ts itself (Array.from is allowlisted and
    // a function argument is a pure expression), so mid.ts is not a use of
    // its own: only reading the callback bodies at load finds scheduler.ts.
    test.each([
      [
        'a callback passed to a call',
        'export const all = Array.from([1], () => listJobs());',
      ],
      [
        'an IIFE inside that callback',
        'export const all = Array.from([1], () => (() => listJobs())());',
      ],
      [
        'a local helper called from that callback',
        'const helper = () => listJobs();\nexport const all = Array.from([1], () => helper());',
      ],
    ])('a function body that runs at load is read: %s', (_label, body) => {
      const mid = `import { listJobs } from './client/scheduler';\n${body}`;
      expect(topLevelSideEffect('mid.ts', mid)).toBeNull();
      const result = decide(
        {
          'packages/sdk/src/mid.ts': mid,
          [REGISTRATION]: "import { all } from './mid';\nregistry.push(all);",
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].reason).toMatch(
        /registration\.ts line \d+ uses it in a top-level side effect/,
      );
    });

    test.each([
      ['a top-level IIFE', 'export const all = (() => listJobs())();'],
      [
        'a callback passed to a constructor',
        'export const all = new Promise((resolve) => resolve(listJobs()));',
      ],
    ])(
      'an initializer that is itself a side effect is a use of its own module: %s',
      (_label, body) => {
        const result = decide(
          {
            'packages/sdk/src/mid.ts': `import { listJobs } from './client/scheduler';\n${body}`,
            [REGISTRATION]:
              "import { all } from './mid';\nexport const kept = all;",
          },
          SDK_SOURCES[SCHEDULER],
        );
        expect(result.decisions[0].reason).toMatch(
          /mid\.ts line \d+ uses it in a top-level side effect/,
        );
      },
    );

    test.each([
      [
        'a local subclass of an imported base, constructed (the ListenerManager shape)',
        "import { SchedulerResponseError } from './client/scheduler';\nclass Registry extends SchedulerResponseError {}\nexport const registry = new Registry();",
      ],
      [
        'a constructed local class whose constructor calls it',
        "import { listJobs } from './client/scheduler';\nclass Registry { constructor() { listJobs(); } }\nexport const registry = new Registry();",
      ],
      [
        'a constructed local class whose field initializer calls it',
        "import { listJobs } from './client/scheduler';\nclass Registry { jobs = listJobs(); }\nexport const registry = new Registry();",
      ],
      [
        'a local array holding it, pushed at top level',
        "import { listJobs } from './client/scheduler';\nconst list = [listJobs];\nregistry.push(list);",
      ],
    ])('a use site reading %s keeps whole-barrel', (_label, registration) => {
      const result = decide(
        { [REGISTRATION]: registration },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].reason).toMatch(
        /registration\.ts line \d+ uses it in a top-level side effect/,
      );
    });

    // mid.ts's initializers are pure at mid.ts (an allowlisted call with a
    // function argument, or a bare reference), so only the load-time read
    // of the class decides.
    test.each([
      [
        'constructed in a load-time callback: its field initializer runs',
        'class Registry { jobs = listJobs(); }\nexport const all = Array.from([1], () => new Registry());',
        'whole-barrel',
      ],
      [
        'constructed in a load-time callback: its constructor runs',
        'class Registry { constructor() { listJobs(); } }\nexport const all = Array.from([1], () => new Registry());',
        'whole-barrel',
      ],
      [
        'a class expression constructed in a load-time callback',
        'const Registry = class { jobs = listJobs(); };\nexport const all = Array.from([1], () => new Registry());',
        'whole-barrel',
      ],
      [
        // Only compared: handing it to any call, even inside an array,
        // could construct it (#2766).
        'never constructed: constructor and fields do not run',
        'class Registry { jobs = listJobs(); constructor() { listJobs(); } }\nexport const all = Registry;',
        'refined',
        'registry.ready = all !== undefined;',
      ],
      [
        'handed to an unknown call, which may construct it',
        'class Registry { constructor() { listJobs(); } }\nexport const all = Registry;',
        'whole-barrel',
      ],
      [
        'never constructed, but its heritage reads it at declaration',
        'class Registry extends SchedulerResponseError {}\nexport const all = Registry;',
        'whole-barrel',
        'registry.ready = all !== undefined;',
      ],
    ])(
      'a local class read through a re-exporter, %s',
      (_label, body, disposition, use = 'registry.push(all);') => {
        const mid = `import { listJobs, SchedulerResponseError } from './client/scheduler';\n${body}`;
        expect(topLevelSideEffect('mid.ts', mid)).toBeNull();
        const result = decide(
          {
            'packages/sdk/src/mid.ts': mid,
            [REGISTRATION]: `import { all } from './mid';\n${use}`,
          },
          SDK_SOURCES[SCHEDULER],
        );
        expect(result.decisions[0].disposition).toBe(disposition);
      },
    );

    // #2766: a module between the use site and the changed module. mid.ts's
    // statements are pure (it is not a use of its own), so only following
    // what the use site runs INTO mid.ts, and from there into the next
    // module, finds scheduler.ts.
    const twoHop = (mid: string, registration: string) => {
      const source = `import { listJobs, SchedulerResponseError } from './client/scheduler';\n${mid}`;
      expect(topLevelSideEffect('mid.ts', source)).toBeNull();
      const names = [
        'L',
        'C',
        'h',
        'v',
        'o',
        'm',
        'it',
        'queries',
        'thenable',
      ].filter((name) => new RegExp(`\\b${name}\\b`).test(registration));
      return decide(
        {
          'packages/sdk/src/mid.ts': source,
          [REGISTRATION]: `import { ${names.join(', ')} } from './mid';\n${registration}`,
        },
        SDK_SOURCES[SCHEDULER],
      );
    };
    const USE = /registration\.ts line \d+ uses it in a top-level side effect$/;

    test.each([
      [
        'a static getter read in an exported initializer',
        'class L0 { static get x() { return listJobs(); } }\nexport const v = L0.x;',
        'registry.push(v);',
      ],
      [
        'a static getter read at the use site',
        'export class L { static get x() { return listJobs(); } }',
        'registry.push(L.x);',
      ],
      [
        'a static method called at the use site',
        'export class L { static make() { return listJobs(); } }',
        'registry.push(L.make());',
      ],
      [
        'constructing an exported subclass of its class',
        'export class L extends SchedulerResponseError {}',
        'export const r = new L();',
      ],
      [
        'an exported subclass of its class, only read (its heritage)',
        'export class L extends SchedulerResponseError {}',
        'registry.ready = L !== undefined;',
      ],
      [
        'constructing an exported class whose constructor calls it',
        'export class L { constructor() { listJobs(); } }',
        'export const r = new L();',
      ],
      [
        'calling an exported arrow that calls it',
        'export const h = () => listJobs();',
        'registry.push(h());',
      ],
      [
        'calling an exported function declaration that calls it',
        'export function h() { return listJobs(); }',
        'registry.push(h());',
      ],
      [
        'calling a function it returns',
        'const inner = () => listJobs();\nexport const h = () => inner;',
        'registry.push(h()());',
      ],
      [
        'calling a method of an exported object',
        'export const queries = { list: () => listJobs() };',
        'registry.push(queries.list());',
      ],
      [
        'calling an export renamed from a local',
        'const inner = () => listJobs();\nexport { inner as h };',
        'registry.push(h());',
      ],
      // Handed to a call, which may call, construct, iterate or read the
      // members of anything it receives, nested values included.
      [
        'a function in an array handed to a call',
        'export const h = () => listJobs();',
        'registry.push([h]);',
      ],
      [
        'a function in an object handed to a call',
        'export const h = () => listJobs();',
        'registry.register({ h });',
      ],
      [
        'a class in an array handed to a call',
        'export class L { constructor() { listJobs(); } }',
        'registry.push([L]);',
      ],
      [
        'an object handed to a call, which may call its methods',
        'export const queries = { list: () => listJobs() };',
        'registry.push(queries);',
      ],
      // A value wrapped by an allowlisted call, then used through members.
      [
        'a method of a frozen object',
        'export const o = Object.freeze({ list: () => listJobs() });',
        'registry.push(o.list());',
      ],
      [
        'a function stored in a Map',
        'export const m = new Map([[1, () => listJobs()]]);',
        'registry.push(m.get(1)());',
      ],
      // Implicit member use at the use site.
      [
        'destructuring a getter',
        'export const o = { get x() { return listJobs(); } };',
        'const { x } = o;\nregistry.push(x);',
      ],
      [
        'iterating with for-of',
        'export const it = { *[Symbol.iterator]() { yield listJobs(); } };',
        'for (const job of it) registry.push(job);',
      ],
      [
        'spreading into call arguments',
        'export const it = { *[Symbol.iterator]() { yield listJobs(); } };',
        'registry.push(...it);',
      ],
      [
        'spreading into an object',
        'export const o = { get x() { return listJobs(); } };',
        'registry.push({ ...o });',
      ],
      [
        'coercing in a template span',
        'export const o = { toString() { return String(listJobs()); } };',
        `registry.push(\`$\{o}\`);`,
      ],
      [
        'coercing with +',
        'export const o = { valueOf() { listJobs(); return 1; } };',
        'registry.push(o + 1);',
      ],
      [
        'coercing with unary +',
        'export const o = { valueOf() { listJobs(); return 1; } };',
        'registry.push(+o);',
      ],
      [
        'instanceof, through Symbol.hasInstance',
        'export class C { static [Symbol.hasInstance]() { listJobs(); return false; } }',
        'registry.push({} instanceof C);',
      ],
      [
        'awaiting a thenable',
        'export const thenable = { then(resolve) { listJobs(); resolve(1); } };',
        'registry.push(await thenable);',
      ],
    ])('a two-hop use keeps whole-barrel: %s', (_label, mid, registration) => {
      const result = twoHop(mid, registration);
      expect(result.decisions[0].disposition).toBe('whole-barrel');
      expect(result.decisions[0].reason).toMatch(USE);
    });

    test.each([
      [
        'calling a sibling export that does not call it',
        'export const h = () => 1;\nexport const v = () => listJobs();',
        'registry.push(h());',
      ],
      [
        'an exported class only compared, never constructed, with no heritage',
        'export class L { constructor() { listJobs(); } static get x() { return listJobs(); } }',
        'registry.ready = L !== undefined;',
      ],
      [
        // Resolved through the rename, not failed closed as unfindable.
        'calling an export renamed from a local that does not call it',
        'const inner = () => 1;\nexport { inner as h };\nexport const v = () => listJobs();',
        'registry.push(h());',
      ],
      [
        'an exported object only compared, its methods never called',
        'export const queries = { list: () => listJobs() };',
        'registry.ready = queries !== undefined;',
      ],
      [
        // Coercion runs only what the coerced value names.
        'a coerced object that names nothing from it',
        'export const o = { a: 1 };\nexport const v = () => listJobs();',
        "registry.push('a' in o);",
      ],
    ])('control: %s stays refined', (_label, mid, registration) => {
      expect(twoHop(mid, registration).decisions[0].disposition).toBe(
        'refined',
      );
    });

    test('a call chain through further modules is followed into each', () => {
      const result = decide(
        {
          'packages/sdk/src/mid.ts':
            "import { g } from './mid2';\nexport const h = () => g();",
          'packages/sdk/src/mid2.ts':
            "import { listJobs } from './client/scheduler';\nexport function g() { const alias = listJobs; return alias(); }",
          [REGISTRATION]: "import { h } from './mid';\nregistry.push(h());",
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].reason).toMatch(USE);
    });

    // A chain of `length` modules, each running the next; the last runs
    // nothing imported, so a traced chain does NOT reach scheduler.ts.
    const chain = (length: number, use = 'registry.push(h1());') => {
      const modules: Record<string, string> = {
        [REGISTRATION]: `import { h1 } from './c1';\nimport { listJobs } from './client/scheduler';\n${use}`,
      };
      for (let index = 1; index <= length; index += 1)
        modules[`packages/sdk/src/c${index}.ts`] =
          index === length
            ? `export const h${index} = () => 1;`
            : `import { h${index + 1} } from './c${index + 1}';\nexport const h${index} = () => h${index + 1}();`;
      return decide(modules, SDK_SOURCES[SCHEDULER]);
    };

    test('a call chain within the bound (8 modules) is traced to its end', () => {
      expect(chain(8).decisions[0].disposition).toBe('refined');
    });

    test('a call chain past the bound (9 modules) fails closed to whole-barrel', () => {
      const [decision] = chain(9).decisions;
      expect(decision.disposition).toBe('whole-barrel');
      expect(decision.reason).toMatch(
        /registration\.ts line \d+ uses it in a top-level side effect \(a call chain deeper than 8 modules is not traced\)/,
      );
    });

    test('the bound is named only when it alone decides', () => {
      // The same statement also calls scheduler.ts directly: that decides,
      // so the reason must not blame the cut chain.
      const [decision] = chain(9, 'registry.push(h1(), listJobs());').decisions;
      expect(decision.disposition).toBe('whole-barrel');
      expect(decision.reason).toMatch(USE);
    });

    test('an export whose declaration cannot be found fails closed', () => {
      // `export import` names the module but declares no initializer this
      // analysis reads, so what calling a member of it runs is unknown.
      const result = decide(
        {
          'packages/sdk/src/mid.ts':
            "export import s = require('./client/board');",
          [REGISTRATION]: "import { s } from './mid';\nregistry.push(s.go());",
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].reason).toMatch(USE);
    });

    test('a local const that does not read the import is not a use (control)', () => {
      const result = decide(
        {
          'packages/sdk/src/mid.ts':
            "import { listJobs } from './client/scheduler';\nexport const g = () => 1;\nexport const h = listJobs;",
          'packages/sdk/src/registration.ts':
            "import { g } from './mid';\nregistry.push(g());",
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].disposition).toBe('refined');
    });

    test('a top-level side effect that does not use it does not (control)', () => {
      const result = decide(
        {
          'packages/sdk/src/registration.ts':
            "import { listJobs } from './client/scheduler';\nregisterAll(other);\nexport const f = () => listJobs();",
        },
        SDK_SOURCES[SCHEDULER],
      );
      expect(result.decisions[0].disposition).toBe('refined');
    });
  });

  test('an internal refinement failure selects MORE for that path, not a failed lane', () => {
    const result = refineSdkBarrelRelatedPaths('/repo', [SCHEDULER, BOARD], {
      base: 'merge-base',
      loadGraph: () => ({
        ...graph,
        resolveBarrelName: () => {
          throw new Error('resolver bug');
        },
      }),
      readBase: (_root: string, _base: string, path: string) =>
        SDK_SOURCES[path] ?? null,
    });
    expect(result.paths).toEqual(expect.arrayContaining([SCHEDULER, BOARD]));
    expect(result.decisions).toEqual([
      {
        path: SCHEDULER,
        disposition: 'whole-barrel',
        reason: 'refinement failed: resolver bug',
      },
      {
        path: BOARD,
        disposition: 'whole-barrel',
        reason: 'refinement failed: resolver bug',
      },
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
    [
      'freezing, spreading and iterating LOCAL values',
      "const local = { a: 1 };\nconst list = ['a'];\nexport const f = Object.freeze(local);\nexport const all = [...list];\nexport const copy = { ...local };\nexport const m = new Map([[1, 2]]);\nexport const n = local.a;",
    ],
    [
      'non-coercing operators and local coercion',
      "import { v } from './v';\nconst n = 1;\nexport const a = v === 1;\nexport const b = v !== n;\nexport const c = v && n;\nexport const d = v || n;\nexport const e = v ?? n;\nexport const f = !v;\nexport const g = `" +
        span('n') +
        '` + (n * 2) + -n;',
    ],
    [
      'reading an imported binding without touching it',
      "import { Base, value } from './b';\nexport const same = value;\nexport const pair = [value];",
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
    [
      'coercing an imported value in a template span',
      `import { items } from './s';\nexport const s = \`${span('items')}\`;`,
    ],
    ...[
      '+',
      '-',
      '*',
      '/',
      '%',
      '**',
      '<',
      '>=',
      '==',
      '!=',
      '&',
      '|',
      '<<',
      'in',
      'instanceof',
    ].map((operator) => [
      `the ${operator} operator on an imported value`,
      `import { v } from './v';\nconst o = {};\nexport const r = v ${operator} o;`,
    ]),
    ...['+', '-', '~'].map((operator) => [
      `unary ${operator} on an imported value`,
      `import { v } from './v';\nexport const r = ${operator}v;`,
    ]),
    // Coercion reaches an import nested anywhere in the operand.
    [
      'an import nested in an array in a template span',
      `import { items } from './s';\nexport const s = \`${span('[items]')}\`;`,
    ],
    [
      'an import nested in an array under +',
      "import { items } from './s';\nexport const s = [items] + '';",
    ],
    [
      'an import in a conditional in a template span',
      `import { items } from './s';\nconst c = true;\nexport const s = \`${span('c ? items : 0')}\`;`,
    ],
    [
      'an import nested in an object under unary -',
      "import { items } from './s';\nexport const s = -{ a: items };",
    ],
    // Property keys are converted with ToPropertyKey.
    [
      'an import as an element-access key on a local',
      "import { items } from './s';\nconst o = {};\nexport const s = o[items];",
    ],
    [
      'an import as an element-access key on a literal',
      "import { items } from './s';\nexport const s = [1][items];",
    ],
    [
      'an import nested in an element-access key',
      "import { items } from './s';\nconst o = {};\nexport const s = o[[items]];",
    ],
    [
      'an import as a computed object-literal key',
      "import { items } from './s';\nexport const s = { [items]: 1 };",
    ],
    [
      'an import as a computed class method name',
      "import { items } from './s';\nexport class C { [items]() {} }",
    ],
    [
      'an import as a computed static field name',
      "import { items } from './s';\nexport class C { static [items] = 1; }",
    ],
    [
      'coercing a local alias of an imported value',
      `import { v } from './v';\nconst alias = v;\nexport const r = \`${span('alias')}\`;`,
    ],
    [
      'a property read of an imported value (a getter)',
      "import { cfg } from './c';\nexport const a = cfg.value;",
    ],
    [
      'an element read of an imported value',
      "import { cfg } from './c';\nexport const a = cfg['value'];",
    ],
    [
      'spreading an imported array (an iterator)',
      "import { list } from './l';\nexport const all = [...list];",
    ],
    [
      'spreading an imported object',
      "import { obj } from './o';\nexport const copy = { ...obj };",
    ],
    [
      'constructing a Map from an imported iterable',
      "import { list } from './l';\nexport const m = new Map(list);",
    ],
    [
      'freezing an imported object (mutates another module)',
      "import { obj } from './o';\nexport const f = Object.freeze(obj);",
    ],
    [
      'freezing an element of a local container of imported values',
      "import { obj } from './o';\nconst list = [obj];\nexport const f = Object.freeze(list[0]);",
    ],
    [
      'freezing a local alias of an imported object',
      "import { obj } from './o';\nconst alias = obj;\nexport const f = Object.freeze(alias);",
    ],
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

describe('top-level use analysis through re-export cycles', () => {
  const X = 'packages/sdk/src/client/x.ts';
  const A = 'packages/sdk/src/client/a.ts';
  const B = 'packages/sdk/src/client/b.ts';
  const C = 'packages/sdk/src/client/c.ts';
  const EARLY = 'packages/sdk/src/early.ts';
  const REG = 'packages/sdk/src/reg.ts';
  // a and b re-export each other; only c (through a) reaches x. `early`
  // asks for a's `f` first in one order, so the analysis walks b while a is
  // on the stack; `reg` then asks b directly. A partial answer for b cached
  // during early's walk would hide x from reg.
  const cycleGraph = (earlyFirst: boolean) => {
    const modules = earlyFirst ? ['./reg', './early'] : ['./early', './reg'];
    const sources = new Map(
      Object.entries({
        [ROOT_BARREL]: modules.map((m) => `export * from '${m}';`).join('\n'),
        [A]: "export * from './b';\nexport * from './c';",
        [B]: "export * from './a';",
        [C]: "export { f } from './x';",
        [X]: 'export function f() { return 1; }',
        [EARLY]: "import { f } from './client/a';\nregister(f);",
        [REG]:
          "import { f } from './client/b';\nexport const registry = [];\nregistry.push(f());",
      }),
    );
    return buildSdkImportGraph({
      sources,
      fileSet: [...sources.keys()],
      sdkExports: { '.': './src/index.ts' },
    });
  };

  test.each([
    ['early before reg', true],
    ['reg before early', false],
  ])('%s: both uses reach x through the cycle', (_order, earlyFirst) => {
    const uses = topLevelUseAnalysis(cycleGraph(earlyFirst));
    const importers = uses.map((use) => use.importer);
    // Population: both modules were analysed, in the intended order.
    expect(importers).toEqual(earlyFirst ? [EARLY, REG] : [REG, EARLY]);
    for (const use of uses) expect([...use.mods]).toContain(X);
  });
});
