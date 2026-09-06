// @vitest-environment node

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { APP_DESTINATION_REGISTRY } from '../app-shell/destination-registry';
import { createRegionClearanceWriter } from '../regions/region-clearance';
import { REGION_IDS } from '../regions/region-model';

/**
 * Placement vocabulary ratchet (#928). The owner decisions on that issue
 * retired two names: "layout" for the map of which surface sits in which
 * region (now the arrangement), and "surface" for a navigable app-shell
 * destination (now the destination registry). `docs/design/placement.md`
 * is the design record and `docs/glossary.md` the short definitions.
 *
 * The scan enumerates through `git ls-files` over directory roots and
 * filters by extension in JS. A glob pathspec (`src-ui/src/**\/*.tsx`)
 * silently excludes root-level files, and a scan whose scope quietly
 * shrinks still reports "clean" — so the enumeration is pinned to known
 * files and a size floor below.
 */
const ROOT = process.cwd();
const SELF = 'src-ui/src/__tests__/placement-vocabulary.test.ts';

/**
 * The two modules whose retired spellings this ratchet guards, imported as
 * values so `test:changed`'s `--related` graph selection schedules this file
 * when either changes. A manifest entry with an explicit `tests` list would
 * REPLACE graph selection for that path (review of #928 measured ~46
 * transitively related suites dropped by one), so the import is the
 * scheduling mechanism, not the manifest.
 */
const GUARDED_MODULES = {
  regionIds: REGION_IDS,
  destinationCount: APP_DESTINATION_REGISTRY.getRegistered().length,
  /** The clearance writer, for the retired CSS custom property below. */
  clearanceWriter: createRegionClearanceWriter,
} as const;
const SCANNED_ROOTS = [
  'src-ui/src',
  'src-server',
  'packages',
  'scripts',
  'tests',
] as const;
// `.css` is in scope because one retired name below IS a custom property,
// and a stylesheet is where it would come back (#1374).
const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mjs',
  '.mts',
  '.js',
  '.css',
] as const;

interface RetiredName {
  name: string;
  pattern: RegExp;
}

const RETIRED_NAMES: readonly RetiredName[] = [
  { name: 'RegionLayout', pattern: /\bRegionLayout\b/ },
  {
    name: 'DEFAULT_DEVICE_REGION_LAYOUT',
    pattern: /\bDEFAULT_DEVICE_REGION_LAYOUT\b/,
  },
  { name: 'seedRegionLayoutFromDock', pattern: /\bseedRegionLayoutFromDock\b/ },
  { name: 'syncRegionLayoutFromDock', pattern: /\bsyncRegionLayoutFromDock\b/ },
  { name: 'APP_SURFACE_REGISTRY', pattern: /\bAPP_SURFACE_REGISTRY\b/ },
  { name: 'SurfaceDefinition', pattern: /\bSurfaceDefinition\b/ },
  { name: 'ManagementSurfaceId', pattern: /\bManagementSurfaceId\b/ },
  { name: 'SurfaceIconId', pattern: /\bSurfaceIconId\b/ },
  { name: 'SurfaceSection', pattern: /\bSurfaceSection\b/ },
  { name: 'getSurfaceForView', pattern: /\bgetSurfaceForView\b/ },
  {
    name: 'app-shell/surface-registry (import path)',
    pattern: /app-shell\/surface-registry\b/,
  },
  /**
   * #1374. The pre-#928 side-width alias: ONE name for the width of "the
   * side", which stopped being a thing that exists the moment a surface
   * could occupy `left` while another occupies `right`. The reducer
   * withheld it there rather than guess, which left every side reader on a
   * shared literal, and while it existed it made one side's width the
   * DECLARED fallback for the other. Side widths
   * are `--region-left-size` and `--region-right-size`; the bottom-edge
   * alias `--dock-slot-size` survives, because the space the dock takes
   * along the bottom edge IS one number.
   *
   * This file is the one place the retired spelling appears, so a grep for
   * it lands on the reason it is gone.
   */
  { name: '--chat-dock-width (CSS variable)', pattern: /--chat-dock-width\b/ },
];

function listSourceFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '--', ...SCANNED_ROOTS], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return output
    .split('\n')
    .filter((path) => path.length > 0)
    .filter((path) => SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)))
    .filter((path) => path !== SELF)
    .filter((path) => !/(^|\/)(node_modules|dist)\//.test(path));
}

/**
 * Every `file:line name` where a retired identifier survives. Pure over the
 * file list so a test can prove the scanner has power on an injected file.
 */
function scanForRetiredNames(
  files: readonly string[],
  root: string = ROOT,
): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(resolve(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const retired of RETIRED_NAMES) {
        if (retired.pattern.test(line)) {
          hits.push(`${file}:${index + 1} ${retired.name}`);
        }
      }
    });
  }
  return hits;
}

describe('placement vocabulary (#928)', () => {
  test('the ratchet is bound to the modules it guards, so graph selection schedules it', () => {
    expect(GUARDED_MODULES.regionIds).toEqual([
      'main',
      'left',
      'right',
      'bottom',
    ]);
    expect(GUARDED_MODULES.destinationCount).toBeGreaterThan(0);
  });

  const files = listSourceFiles();

  test('the enumeration is real: known root files present and the corpus is large', () => {
    for (const sentinel of [
      'src-ui/src/App.tsx',
      'src-ui/src/regions/region-model.ts',
      'src-server/index.ts',
      'packages/contracts/src/workspace-pane.ts',
      'scripts/test-impact-manifest.mjs',
      'tests/e2e-manifest.mjs',
      'src-ui/src/index.css',
      'src-ui/src/components/notifications/BannerHost.css',
    ]) {
      expect(files, `enumeration lost ${sentinel}`).toContain(sentinel);
    }
    expect(files.length, `scanned ${files.length} files`).toBeGreaterThan(500);
  });

  test('no source file uses a retired placement name', () => {
    const hits = scanForRetiredNames(files);
    expect(
      hits,
      [
        'Retired placement names found (see docs/design/placement.md):',
        ...hits,
      ].join('\n'),
    ).toEqual([]);
  });

  test('the scanner reports a retired name on an injected file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'placement-vocabulary-'));
    try {
      const injected = join(dir, 'injected.ts');
      writeFileSync(
        injected,
        [
          "import { APP_DESTINATION_REGISTRY } from '../app-shell/destination-registry';",
          'const retired: RegionLayout = null as never;',
          'export { APP_DESTINATION_REGISTRY, retired };',
        ].join('\n'),
      );
      // And the stylesheet half of the corpus, for the retired custom
      // property: a `.ts` injection alone would leave the CSS pattern
      // unproven on the file kind it exists for.
      const injectedCss = join(dir, 'injected.css');
      writeFileSync(
        injectedCss,
        [
          '.banner-host {',
          '  left: var(--region-left-size, var(--chat-dock-width, 400px));',
          '}',
        ].join('\n'),
      );
      expect(scanForRetiredNames([injected, injectedCss], dir)).toEqual([
        `${injected}:2 RegionLayout`,
        `${injectedCss}:2 --chat-dock-width (CSS variable)`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the design record and glossary entries exist', () => {
    expect(existsSync(resolve(ROOT, 'docs/design/placement.md'))).toBe(true);
    const glossary = readFileSync(resolve(ROOT, 'docs/glossary.md'), 'utf8');
    for (const entry of [
      '**Region**',
      '**Surface**',
      '**Pane host**',
      '**Arrangement**',
    ]) {
      expect(glossary, `docs/glossary.md lacks ${entry}`).toContain(entry);
    }
    const context = readFileSync(
      resolve(ROOT, 'docs/contexts/workspace-surfaces/CONTEXT.md'),
      'utf8',
    );
    for (const entry of ['**Region**:', '**Arrangement**:']) {
      expect(context, `workspace-surfaces CONTEXT.md lacks ${entry}`).toContain(
        entry,
      );
    }
  });
});
