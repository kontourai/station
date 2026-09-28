/**
 * Test selection follows spawned scripts through their imports (#2922).
 *
 * During #2886 a change to `scripts/lib/learning-markdown.mjs` did not select
 * `guardrail-process-boundary.test.ts`, which spawns `check-markdown-links.mjs`
 * (a script that imports that module), so the break surfaced first in the merge
 * queue. The edges are now derived from the test sources and the scripts'
 * own imports; these cases prove the derivation on a scratch tree the
 * committed manifest knows nothing about, and on the real tree.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  scanSpawnedScripts,
  sourceSpawns,
} from '../lib/spawned-script-scan.mjs';
import { selectChangedVerification } from '../run-changed-verification.mjs';
import {
  buildTestImpactManifest,
  spawnedScriptEdges,
  TEST_IMPACT_MANIFEST,
  validateTestImpactManifest,
} from '../test-impact-manifest.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const makeTempDir = trackTempDirs();

// Spelled in pieces so this file itself never reads as a spawning suite.
const CHILD_PROCESS = `'node:${'child'}_process'`;
const SPAWN_IMPORT = `import { spawnSync } from ${CHILD_PROCESS};`;

function tree(files: Record<string, string>): string {
  const root = makeTempDir('station-spawned-selection-');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

/** A script that reaches a leaf module through two relative imports. */
const SCRIPT_GRAPH = {
  'scripts/fixture-tool.mjs':
    "import { middle } from './lib/fixture-middle.mjs';\nmiddle();\n",
  'scripts/lib/fixture-middle.mjs':
    "import { leaf } from './fixture-leaf.mjs';\nexport const middle = () => leaf;\n",
  'scripts/lib/fixture-leaf.mjs': 'export const leaf = 1;\n',
  'scripts/lib/fixture-unrelated.mjs': 'export const unrelated = 1;\n',
};

/** The fixture suites the real selector picks for one changed path. */
function selectedTests(root: string, changed: string) {
  return selectChangedVerification([changed], [
    ...TEST_IMPACT_MANIFEST,
    ...spawnedScriptEdges({ root }),
  ] as never)
    .tests.map((entry) => entry.path)
    .filter((path) => existsSync(join(root, path)));
}

describe('derived spawned-script edges', () => {
  it('selects a spawning suite for every file its script reaches, and only those', () => {
    const root = tree({
      ...SCRIPT_GRAPH,
      // The harness convention: a bare script name, joined onto scripts/.
      'scripts/__tests__/fixture-tool.test.ts': `${SPAWN_IMPORT}\nconst SCRIPT = 'fixture-tool.mjs';\nspawnSync(process.execPath, ['scripts/' + SCRIPT]);\n`,
    });
    const suite = 'scripts/__tests__/fixture-tool.test.ts';
    for (const changed of [
      'scripts/fixture-tool.mjs',
      'scripts/lib/fixture-middle.mjs',
      'scripts/lib/fixture-leaf.mjs',
    ])
      expect(selectedTests(root, changed), changed).toEqual([suite]);
    expect(selectedTests(root, 'scripts/lib/fixture-unrelated.mjs')).toEqual(
      [],
    );
  });

  it('follows the edge when the script changes what it imports', () => {
    // The same leaf, no longer reached: the edge goes with the import, which
    // a hand-written mapping would not do.
    const root = tree({
      ...SCRIPT_GRAPH,
      'scripts/fixture-tool.mjs': 'export {};\n',
      'scripts/__tests__/fixture-tool.test.ts': `${SPAWN_IMPORT}\nspawnSync(process.execPath, ['scripts/fixture-tool.mjs']);\n`,
    });
    expect(selectedTests(root, 'scripts/fixture-tool.mjs')).toEqual([
      'scripts/__tests__/fixture-tool.test.ts',
    ]);
    expect(selectedTests(root, 'scripts/lib/fixture-leaf.mjs')).toEqual([]);
  });

  it('counts a spawn that lives in a test helper the suite imports', () => {
    const root = tree({
      ...SCRIPT_GRAPH,
      'scripts/__tests__/helpers/run.ts': `${SPAWN_IMPORT}\nexport const run = (s: string) => spawnSync(process.execPath, [s]);\n`,
      'scripts/__tests__/fixture-tool.test.ts':
        "import { run } from './helpers/run.js';\nrun('scripts/fixture-tool.mjs');\n",
    });
    expect(selectedTests(root, 'scripts/lib/fixture-leaf.mjs')).toEqual([
      'scripts/__tests__/fixture-tool.test.ts',
    ]);
  });

  it('does not count a suite that only names the script, or only names the spawn forms', () => {
    const root = tree({
      ...SCRIPT_GRAPH,
      // Reads the script's text; runs nothing.
      'scripts/__tests__/reads.test.ts':
        "import { readFileSync } from 'node:fs';\nreadFileSync('scripts/fixture-tool.mjs', 'utf8');\n",
      // A regex literal naming the forms, with no child_process import.
      'scripts/__tests__/mentions.test.ts':
        "const FORMS = /spawnSync|execFileSync/;\nconst path = 'scripts/fixture-tool.mjs';\n",
      // Imports production code that spawns: not the suite's own spawn.
      'scripts/lib/spawner.mjs': `${SPAWN_IMPORT}\nexport const go = () => spawnSync('true');\n`,
      'scripts/__tests__/imports-spawner.test.ts':
        "import { go } from '../lib/spawner.mjs';\nconst path = 'scripts/fixture-tool.mjs';\n",
    });
    expect(scanSpawnedScripts({ root })).toEqual([]);
    expect(selectedTests(root, 'scripts/lib/fixture-leaf.mjs')).toEqual([]);
  });

  it('treats the spawn signal as an import plus a call', () => {
    expect(
      sourceSpawns(`${SPAWN_IMPORT}\nspawnSync('x');`),
      'import and call',
    ).toBe(true);
    expect(sourceSpawns("spawnSync('x');"), 'call alone').toBe(false);
    expect(
      sourceSpawns(SPAWN_IMPORT.replace('spawnSync', 'x')),
      'import alone',
    ).toBe(false);
  });
});

describe('the real tree', () => {
  const built = buildTestImpactManifest({ root: ROOT });

  it('selects guardrail-process-boundary for a change to learning-markdown (#2886)', () => {
    const changed = 'scripts/lib/learning-markdown.mjs';
    const suite = 'scripts/__tests__/guardrail-process-boundary.test.ts';
    const selection = selectChangedVerification([changed], built as never);
    const entry = selection.tests.find((test) => test.path === suite);
    expect(entry, JSON.stringify(selection.tests)).toBeDefined();
    // Selected by the derived edge, and by nothing the committed manifest
    // spells: the static manifest alone leaves the suite out.
    expect(entry?.reasons.some((reason) => reason.includes('#2922'))).toBe(
      true,
    );
    expect(
      selectChangedVerification([changed], TEST_IMPACT_MANIFEST).tests.map(
        (test) => test.path,
      ),
    ).not.toContain(suite);
  });

  it('keeps the built manifest valid and the derived edges tests-only', () => {
    expect(validateTestImpactManifest(built)).toEqual([]);
    const derived = spawnedScriptEdges({ root: ROOT });
    expect(derived.length).toBeGreaterThan(0);
    for (const edge of derived) {
      expect(edge.supplemental, edge.pattern).toBe(true);
      expect(edge.related, edge.pattern).toBeUndefined();
      expect(edge.lanes, edge.pattern).toBeUndefined();
      for (const test of edge.tests ?? [])
        expect(test.startsWith('tests/'), `${edge.pattern} -> ${test}`).toBe(
          false,
        );
    }
  });
});
