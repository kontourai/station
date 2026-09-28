/**
 * Which test files run which `scripts/*.mjs` entry points as a child process,
 * and which repository files those entry points import (#2922).
 *
 * Two consumers share the one parser:
 *
 * - `scripts/evidence-check-execution-gate.mjs` asks whether the test corpus
 *   executes an evidence check's script at all (#1746). It uses the spawn
 *   form and the `scripts/<name>.mjs` path form below, unchanged.
 * - `scripts/test-impact-manifest.mjs` derives impact edges from the same
 *   signal (`spawnedScriptEdges`): a change to a spawned script, or to any
 *   module that script imports directly or transitively, selects every test
 *   that spawns it. Vitest's related-file graph cannot see those edges,
 *   because the test never imports the script; before this derivation a
 *   change to `scripts/lib/learning-markdown.mjs` did not select
 *   `guardrail-process-boundary.test.ts`, which spawns
 *   `check-markdown-links.mjs`, and the failure first appeared in the merge
 *   queue (#2886).
 *
 * Every rule here errs toward selecting more. A false edge costs one
 * scheduled test; a missed edge costs a merge-queue candidate.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Roots the corpus walk starts from. */
const TEST_CORPUS_ROOTS = Object.freeze([
  'scripts/__tests__',
  'src-server',
  'src-ui',
  'src-desktop',
  'packages',
  'tests',
]);
const CORPUS_SKIPPED_DIRECTORIES = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);
const CORPUS_TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/;

// A path mentioned in prose is not an execution. Requiring a spawn form in
// the same file is what separates "this test runs the script" from "this test
// names the script"; both shapes exist in the real corpus today.
//
// The signal is deliberately file-level co-occurrence, not an argv match. A
// stricter rule would miss the case the evidence gate exists for:
// proof-repo-guardrails-fail-closed.test.ts reads the real script's source,
// writes a copy (unmutated for its positive control) into a temporary
// directory, and spawns THAT -- so no spawn argument ever holds the
// repository path. File-level co-occurrence is therefore evidence the corpus
// reaches the script, not proof of a direct invocation.
export const SPAWN_FORM_PATTERN =
  /\bspawnSync\b|\bexecFileSync\b|\bexecFile\(|\bspawn\(/;
export const SCRIPT_FILE_PATTERN = /scripts\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs/g;

/**
 * A bare `'<name>.mjs'` string literal. The scratch-repository harness
 * (`scripts/__tests__/helpers/guardrail-scratch.ts`) and the production
 * accept runs name a guardrail by its file name and join `scripts/` on at
 * run time, so `guardrail-process-boundary.test.ts` never spells
 * `scripts/check-markdown-links.mjs` at all. Honoured only for suites under
 * `scripts/__tests__/`, where that convention lives, and only when
 * `scripts/<name>.mjs` exists.
 */
const BARE_SCRIPT_LITERAL_PATTERN =
  /['"`]([A-Za-z0-9][A-Za-z0-9._-]*\.mjs)['"`]/g;
const BARE_SCRIPT_SUITE_PREFIX = 'scripts/__tests__/';

/**
 * Static import, re-export, side-effect import, literal dynamic import and
 * literal require. Type-only imports match too, which only over-selects.
 */
const IMPORT_SPECIFIER_PATTERN =
  /\b(?:import|export)\s*(?:[\w*{}\s,$]*?\bfrom\s*)?['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const RESOLVABLE_EXTENSIONS = Object.freeze([
  '.mjs',
  '.js',
  '.ts',
  '.tsx',
  '.mts',
  '.cjs',
  '.cts',
  '.json',
]);

function toRepoPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

/** Every `*.test.*` file under the corpus roots, as absolute paths. */
export function collectCorpusTestFiles(repoRoot) {
  const files = [];
  // A symlinked directory reports isDirectory() false through withFileTypes,
  // so the walk cannot follow one out of the repository or into a cycle.
  const pending = TEST_CORPUS_ROOTS.map((root) => resolve(repoRoot, root));
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // A root a repository does not have is not a corpus, and not an error:
      // callers run against fixture roots that carry only what they test.
      continue;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!CORPUS_SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (entry.isFile() && CORPUS_TEST_FILE_PATTERN.test(entry.name)) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

/** Relative specifiers in `source`; bare package names are not followed. */
function relativeImportSpecifiers(source) {
  const found = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier?.startsWith('./') || specifier?.startsWith('../'))
      found.push(specifier);
  }
  return found;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The file a relative specifier names, or null when none exists. */
function resolveRelativeImport(fromAbsolute, specifier) {
  const target = resolve(dirname(fromAbsolute), specifier.split('?')[0]);
  if (isFile(target)) return target;
  // TypeScript ESM names `./x.js` for a `./x.ts` source.
  const withoutJs = target.replace(/\.[cm]?js$/, '');
  if (withoutJs !== target)
    for (const extension of ['.ts', '.tsx', '.mts', '.cts'])
      if (isFile(withoutJs + extension)) return withoutJs + extension;
  for (const extension of RESOLVABLE_EXTENSIONS)
    if (isFile(target + extension)) return target + extension;
  for (const extension of RESOLVABLE_EXTENSIONS)
    if (isFile(join(target, `index${extension}`)))
      return join(target, `index${extension}`);
  return null;
}

/**
 * The repository files `entry` reaches through relative imports, `entry`
 * included, as repository paths. Files outside `root` and `node_modules`
 * are not followed. `cache` (absolute path -> source or null) is shared
 * across calls so a module imported by many scripts is read once.
 */
function localImportClosure(
  root,
  entryAbsolute,
  { readSource = (path) => readFileSync(path, 'utf8'), cache = new Map() } = {},
) {
  const seen = new Set();
  const pending = [entryAbsolute];
  const rootPrefix = resolve(root) + sep;
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current.endsWith('.json')) continue;
    let source = cache.get(current);
    if (source === undefined) {
      try {
        source = readSource(current);
      } catch {
        source = null;
      }
      cache.set(current, source);
    }
    if (source === null) continue;
    for (const specifier of relativeImportSpecifiers(source)) {
      const resolved = resolveRelativeImport(current, specifier);
      if (
        resolved?.startsWith(rootPrefix) &&
        !resolved.includes(`${sep}node_modules${sep}`)
      )
        pending.push(resolved);
    }
  }
  return [...seen].map((path) => toRepoPath(root, path)).sort();
}

/**
 * The `scripts/<name>.mjs` entry points a test source names: the path form
 * everywhere, and the bare-name form in `scripts/__tests__/` suites.
 */
function namedScripts(source, { testPath, scriptExists }) {
  const scripts = new Set();
  for (const match of source.matchAll(SCRIPT_FILE_PATTERN))
    if (scriptExists(match[0])) scripts.add(match[0]);
  if (testPath.startsWith(BARE_SCRIPT_SUITE_PREFIX))
    for (const match of source.matchAll(BARE_SCRIPT_LITERAL_PATTERN)) {
      const candidate = `scripts/${match[1]}`;
      if (scriptExists(candidate)) scripts.add(candidate);
    }
  return [...scripts].sort();
}

/**
 * Test-support modules: a spawn inside one of these is the test's own spawn
 * (`runGuardrail` in `scripts/__tests__/helpers/guardrail-scratch.ts`). A
 * production module the test imports is not followed: a test that imports
 * `run-changed-verification.mjs` to call a pure function, and names script
 * paths as fixture data, does not run those scripts.
 */
const TEST_SUPPORT_PATTERN =
  /(?:^|\/)(?:__tests__|__test-utils__|test-utils|helpers)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CHILD_PROCESS_SPECIFIER_PATTERN = /['"](?:node:)?child_process['"]/;

/**
 * Whether a source can start a child process: it imports `child_process`
 * AND uses a spawn form. Either alone is prose, a type, or a regex literal
 * naming the forms (`guardrail-execution-coverage.test.ts` carries one).
 */
export function sourceSpawns(source) {
  return (
    CHILD_PROCESS_SPECIFIER_PATTERN.test(source) &&
    SPAWN_FORM_PATTERN.test(source)
  );
}

function reachesSpawn(root, testAbsolute, read) {
  const seen = new Set();
  const pending = [testAbsolute];
  const rootPrefix = root + sep;
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const source = read(current);
    if (typeof source !== 'string') continue;
    if (sourceSpawns(source)) return true;
    for (const specifier of relativeImportSpecifiers(source)) {
      const resolved = resolveRelativeImport(current, specifier);
      if (
        resolved?.startsWith(rootPrefix) &&
        TEST_SUPPORT_PATTERN.test(toRepoPath(root, resolved))
      )
        pending.push(resolved);
    }
  }
  return false;
}

/**
 * `{ test, scripts }` for every corpus test that can start a child process
 * (itself or through a test-support module it imports) and names a
 * `scripts/*.mjs` entry point that exists.
 */
export function scanSpawnedScripts({
  root = process.cwd(),
  testFiles,
  readSource = (path) => readFileSync(path, 'utf8'),
  cache = new Map(),
} = {}) {
  const absoluteRoot = resolve(root);
  const tests =
    testFiles?.map((path) => resolve(absoluteRoot, path)) ??
    collectCorpusTestFiles(absoluteRoot);
  const scriptExists = (repoPath) => existsSync(join(absoluteRoot, repoPath));
  const read = (absolute) => {
    let source = cache.get(absolute);
    if (source === undefined) {
      try {
        source = readSource(absolute);
      } catch {
        source = null;
      }
      cache.set(absolute, source);
    }
    return source;
  };
  const entries = [];
  for (const absolute of tests) {
    const source = read(absolute);
    if (source === null) continue;
    const testPath = toRepoPath(absoluteRoot, absolute);
    const scripts = namedScripts(source, { testPath, scriptExists });
    if (!scripts.length) continue;
    if (reachesSpawn(absoluteRoot, absolute, read))
      entries.push({ test: testPath, scripts });
  }
  return entries.sort((a, b) => a.test.localeCompare(b.test));
}

/**
 * Inverts a spawn scan through each script's import closure: for every file
 * a spawned script reaches (the script included), the tests that spawn it.
 *
 * @returns {{ path: string, tests: string[] }[]}
 */
export function spawnedScriptDependents({
  root = process.cwd(),
  entries,
  readSource = (path) => readFileSync(path, 'utf8'),
  cache = new Map(),
} = {}) {
  const absoluteRoot = resolve(root);
  const scanned =
    entries ?? scanSpawnedScripts({ root: absoluteRoot, readSource, cache });
  const testsByScript = new Map();
  for (const { test, scripts } of scanned)
    for (const script of scripts) {
      const tests = testsByScript.get(script) ?? new Set();
      tests.add(test);
      testsByScript.set(script, tests);
    }
  const byPath = new Map();
  for (const [script, tests] of testsByScript) {
    const closure = localImportClosure(
      absoluteRoot,
      join(absoluteRoot, script),
      { readSource, cache },
    );
    for (const path of closure) {
      const dependents = byPath.get(path) ?? new Set();
      for (const test of tests) dependents.add(test);
      byPath.set(path, dependents);
    }
  }
  return [...byPath.keys()]
    .sort()
    .map((path) => ({ path, tests: [...byPath.get(path)].sort() }));
}
