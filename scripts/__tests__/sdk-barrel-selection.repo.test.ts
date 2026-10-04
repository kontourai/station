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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  loadSdkImportGraph,
  refinedSeedsFor,
  refineSdkBarrelRelatedPaths,
  topLevelUseAnalysis,
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

  test('base contents are read in one batch and decide every candidate', () => {
    // Several candidates, so a misaligned batch read would hand one path
    // another's content (an import-set difference, a side effect).
    const candidates = [
      SCHEDULER,
      'packages/sdk/src/client/agents.ts',
      'packages/sdk/src/client/board.ts',
      'packages/sdk/src/api-core.ts',
    ];
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const dirty = execFileSync(
      'git',
      ['status', '--porcelain', '--', ...candidates],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true },
    ).trim();
    const { decisions } = refineSdkBarrelRelatedPaths(ROOT, candidates, {
      base: head,
    });
    // Unedited against HEAD, each is refined; an edit may legitimately not be.
    if (dirty === '')
      expect(decisions.map((decision) => decision.disposition)).toEqual(
        candidates.map(() => 'refined'),
      );
    const broken = refineSdkBarrelRelatedPaths(ROOT, candidates, {
      base: 'refs/heads/no-such-branch-2707',
    });
    expect(broken.paths).toEqual([...candidates].sort());
    for (const decision of broken.decisions)
      expect(decision.reason).toMatch(/^base content unavailable/);
  });

  test('ListenerManager stays whole: barrel-loaded registries construct its subclasses at top level', () => {
    // context/registry.ts and voice/registry.ts each declare a local
    // subclass of ListenerManager and construct it at module top level,
    // so every barrel load runs ListenerManager's constructor.
    const [decision] = refineSdkBarrelRelatedPaths(
      ROOT,
      ['packages/sdk/src/core/ListenerManager.ts'],
      {
        base: 'HEAD',
        readBase: (_root, _base, path) =>
          readFileSync(join(ROOT, path), 'utf8'),
      },
    ).decisions;
    expect(decision.disposition).toBe('whole-barrel');
    expect(decision.reason).toMatch(
      /packages\/sdk\/src\/(context|voice)\/registry\.ts line \d+ uses it in a top-level side effect/,
    );
  });

  test('fail-closed tracing stays precise on the real uses (#2766)', () => {
    // The barrel-loaded registries construct ListenerManager subclasses
    // (above). Following what they run must still resolve to real modules:
    // no use may collapse to ANY or the depth bound, which would make every
    // changed SDK module whole-barrel, and no client module is reached.
    const uses = topLevelUseAnalysis(graph);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use).toMatchObject({ any: false, bounded: false });
      expect(
        [...use.mods].filter((module) =>
          module.startsWith('packages/sdk/src/client/'),
        ),
      ).toEqual([]);
    }
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
    // Measured 2026-09-26: 172 refined seeds against 524 whole-barrel seeds.
    // The bound is loose on purpose; the subset and the named control above
    // are what pin the direction.
    expect(refined.length).toBeLessThan(whole.length * 0.75);
  });
});

/**
 * The resolver understands exactly two specifier forms for the SDK: the
 * package name through its `exports` map, and relative paths. An alias that
 * names SDK source any other way would make the graph silently miss edges —
 * under-selection with a green lane. This pins every alias surface to what
 * the resolver can see.
 */
describe('no alias names SDK source behind the resolver’s back', () => {
  const tracked = (pattern: string) =>
    execFileSync('git', ['ls-files', '-z', '--', pattern], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    })
      .split('\0')
      .filter(Boolean);
  const sdkExports: Record<string, string> = JSON.parse(
    readFileSync(join(ROOT, 'packages/sdk/package.json'), 'utf8'),
  ).exports;

  test('no Vitest config aliases the SDK', () => {
    const configs = tracked('*vitest.config.*');
    expect(configs).toContain('vitest.config.ts');
    for (const config of configs)
      expect(
        readFileSync(join(ROOT, config), 'utf8'),
        `${config} mentions the SDK; teach resolveSdkSpecifier its alias first`,
      ).not.toMatch(/station-sdk|packages\/sdk/);
  });

  test('every tsconfig path into SDK source is the package export it mirrors', () => {
    const mismatches: string[] = [];
    let sdkPaths = 0;
    for (const config of tracked('*tsconfig*.json')) {
      const parsed = ts.parseConfigFileTextToJson(
        config,
        readFileSync(join(ROOT, config), 'utf8'),
      ).config;
      const paths: Record<string, string[]> =
        parsed?.compilerOptions?.paths ?? {};
      const baseUrl = posix.join(
        posix.dirname(config),
        parsed?.compilerOptions?.baseUrl ?? '.',
      );
      for (const [key, targets] of Object.entries(paths))
        for (const target of targets) {
          const resolved = posix.normalize(posix.join(baseUrl, target));
          if (!resolved.startsWith('packages/sdk/')) continue;
          sdkPaths += 1;
          const subpath =
            key === '@kontourai/station-sdk'
              ? '.'
              : key.startsWith('@kontourai/station-sdk/')
                ? `.${key.slice('@kontourai/station-sdk'.length)}`
                : null;
          const exported = subpath === null ? undefined : sdkExports[subpath];
          if (
            exported === undefined ||
            posix.normalize(posix.join('packages/sdk', exported)) !== resolved
          )
            mismatches.push(`${config}: ${key} -> ${target}`);
        }
    }
    // Population: src-ui mirrors five subpaths today.
    expect(sdkPaths).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });
});
