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

    test.each([
      [
        'adds an import of a side-effecting module',
        `import { voiceSessionAdapterRegistry } from '../voice/session-registry';\n${SDK_SOURCES[SCHEDULER]}`,
        SDK_SOURCES[SCHEDULER],
      ],
      [
        'adds a barrel self-import (a cycle)',
        `import { fetchBoard } from '../index';\n${SDK_SOURCES[SCHEDULER]}`,
        SDK_SOURCES[SCHEDULER],
      ],
      [
        'removes an import',
        SDK_SOURCES[SCHEDULER],
        `import { getBoard } from './board';\n${SDK_SOURCES[SCHEDULER]}`,
      ],
    ])(
      'a change that %s keeps whole-barrel selection',
      (_label, head, base) => {
        const result = decide({ [SCHEDULER]: head }, base);
        expect(result.paths).toEqual([SCHEDULER]);
        expect(result.decisions[0].reason).toMatch(/runtime imports differ/);
      },
    );

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
      const result = decide(
        {
          'packages/sdk/src/mid.ts':
            "import { listJobs } from './client/scheduler';\nexport const queries = { list: () => listJobs(), all: [function () { return listJobs; }] };",
          [REGISTRATION]:
            "import { queries } from './mid';\nregistry.push(queries);",
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
        'a class expression constructed in a load-time callback',
        'const Registry = class { jobs = listJobs(); };\nexport const all = Array.from([1], () => new Registry());',
        'whole-barrel',
      ],
      [
        'never constructed: constructor and fields do not run',
        'class Registry { jobs = listJobs(); constructor() { listJobs(); } }\nexport const all = Registry;',
        'refined',
      ],
      [
        'never constructed, but its heritage reads it at declaration',
        'class Registry extends SchedulerResponseError {}\nexport const all = Registry;',
        'whole-barrel',
      ],
    ])(
      'a local class read through a re-exporter, %s',
      (_label, body, disposition) => {
        const mid = `import { listJobs, SchedulerResponseError } from './client/scheduler';\n${body}`;
        expect(topLevelSideEffect('mid.ts', mid)).toBeNull();
        const result = decide(
          {
            'packages/sdk/src/mid.ts': mid,
            [REGISTRATION]: "import { all } from './mid';\nregistry.push(all);",
          },
          SDK_SOURCES[SCHEDULER],
        );
        expect(result.decisions[0].disposition).toBe(disposition);
      },
    );

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
