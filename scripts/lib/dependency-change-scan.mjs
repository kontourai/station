import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import ts from 'typescript-api';
import { readPnpmLockfile } from './pnpm-lockfile.mjs';
import { collectCorpusTestFiles } from './spawned-script-scan.mjs';
import { workspaceManifestPaths } from './workspace-dependency-satisfaction.mjs';

/**
 * #3149: dependency changes the selector could not see.
 *
 * `package.json` and `pnpm-lock.yaml` are escalation paths, so a dependency
 * bump defers to `ci-fast` and drops related discovery for the whole diff. A
 * bump changes no source file either, so nothing in the import graph names a
 * consumer. #3200 moved `@kontourai/flow-agents` from 6.4.0 to 6.5.1 and
 * fast-checks ran none of the suites that execute its hooks for real;
 * `agent-policy-service.test.ts` first failed in scheduled qualification.
 *
 * This reads WHICH direct dependency changed — a manifest's dependency
 * sections and the lockfile importers' resolved versions — and selects the
 * suites that import that package by its specifier. Those are explicit tests,
 * so they survive the escalation's deferral (`executionSelection` keeps
 * explicit tests when a lane is selected, up to 32 of them).
 *
 * Transitive bumps (a lockfile `packages` entry alone) are not followed: they
 * would add the suites of packages Station does not import itself, and a
 * deferred selection with more than 32 explicit tests runs none of them. On
 * #3200 following `@kontourai/flow`'s transitive 5.1.3 took the diff from 31
 * explicit tests to 39, and so from 31 executed to zero.
 *
 * Scoped to sibling Kontour packages, which Station consumes as runtime
 * behaviour (hooks, stores, protocol owners) rather than as libraries with
 * their own release suites. A third-party bump (react, vite) is imported by
 * hundreds of suites: a test list that long is dropped whole by the
 * 32-explicit-test limit of a deferred selection, so it would cost the diff
 * the tests it already selects. Workspace packages are excluded: their source
 * is in this repository and selects its consumers through the import graph.
 */
export const DEPENDENCY_IMPACT_SCOPE = '@kontourai/';

/**
 * Above this many importing suites, a changed package defers to `test-full`
 * instead of naming its suites inline — the same bound, for the same reason,
 * as `SPAWNED_SCRIPT_FANOUT_LIMIT` in test-impact-manifest.mjs (#2922).
 */
export const DEPENDENCY_TEST_FANOUT_LIMIT = 16;

const MANIFEST_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const LOCKFILE_IMPORTER_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]);
const LOCKFILE = 'pnpm-lock.yaml';

function isManifestPath(path) {
  return path === 'package.json' || path.endsWith('/package.json');
}

function parseManifest(path, text) {
  if (text === null) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `dependency impact: ${path} is not valid JSON: ${error.message}`,
    );
  }
}

function parseLockfile(label, text) {
  if (text === null) return { importers: {}, packages: {} };
  try {
    return readPnpmLockfile('.', () => text);
  } catch (error) {
    throw new Error(`dependency impact: ${label}: ${error.message}`);
  }
}

function importerVersions(lock) {
  const versions = new Map();
  for (const [importer, sections] of Object.entries(lock.importers ?? {}))
    for (const section of LOCKFILE_IMPORTER_SECTIONS)
      for (const [name, entry] of Object.entries(sections?.[section] ?? {}))
        versions.set(`${importer}\0${section}\0${name}`, entry?.version);
  return versions;
}

function addChange(changes, name, source) {
  const sources = changes.get(name) ?? new Set();
  sources.add(source);
  changes.set(name, sources);
}

function diffKeyedValues(before, after, nameOf, source, changes) {
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) !== after.get(key))
      addChange(changes, nameOf(key), source);
  }
}

/**
 * Package names whose declared or resolved version changed between the base
 * and head reads of the changed dependency files, mapped to the changed paths
 * that show it. Workspace packages and names outside the scope are dropped.
 *
 * `scope: null` keeps every non-workspace name, for callers that apply
 * their own narrower rule (the test-runtime environment packages below).
 *
 * @param {{
 *   root?: string,
 *   paths: readonly string[],
 *   readBase: (path: string) => string | null,
 *   readHead: (path: string) => string | null,
 *   scope?: string | null,
 * }} options `null` means the file does not exist on that side.
 * @returns {Map<string, Set<string>>}
 */
export function changedDependencies({
  root = process.cwd(),
  paths,
  readBase,
  readHead,
  scope = DEPENDENCY_IMPACT_SCOPE,
}) {
  const changes = new Map();
  for (const path of paths) {
    if (!isManifestPath(path)) continue;
    const before = parseManifest(path, readBase(path));
    const after = parseManifest(path, readHead(path));
    for (const section of MANIFEST_SECTIONS) {
      const left = new Map(Object.entries(before[section] ?? {}));
      const right = new Map(Object.entries(after[section] ?? {}));
      diffKeyedValues(left, right, (name) => name, path, changes);
    }
  }
  const workspaceNames = new Set();
  const rootManifest = parseManifest('package.json', readHead('package.json'));
  if (rootManifest.workspaces !== undefined) {
    for (const absolute of workspaceManifestPaths(root, rootManifest)) {
      const path = relative(root, absolute).split(sep).join('/');
      if (path === '..' || path.startsWith('../') || isAbsolute(path))
        throw new Error(
          'dependency impact: workspace manifest is outside root',
        );
      const text = path === 'package.json' ? undefined : readHead(path);
      if (text === null)
        throw new Error(
          `dependency impact: workspace manifest ${path} is missing`,
        );
      const manifest =
        path === 'package.json' ? rootManifest : parseManifest(path, text);
      if (typeof manifest.name === 'string') workspaceNames.add(manifest.name);
    }
  }
  if (paths.includes(LOCKFILE)) {
    const before = parseLockfile(`${LOCKFILE} at base`, readBase(LOCKFILE));
    const after = parseLockfile(LOCKFILE, readHead(LOCKFILE));
    diffKeyedValues(
      importerVersions(before),
      importerVersions(after),
      (key) => key.split('\0')[2],
      LOCKFILE,
      changes,
    );
    for (const name of new Set(
      Object.keys(after.importers ?? {}).flatMap((importer) => {
        const manifest = readHead(
          importer === '.' ? 'package.json' : `${importer}/package.json`,
        );
        const name = manifest === null ? undefined : JSON.parse(manifest).name;
        return typeof name === 'string' ? [name] : [];
      }),
    ))
      workspaceNames.add(name);
  }
  // A manifest-only change (no lockfile in the diff) still names workspace
  // packages by `workspace:` specifiers; drop those too.
  for (const path of paths) {
    if (!isManifestPath(path)) continue;
    const manifest = readHead(path);
    if (manifest === null) continue;
    const parsed = parseManifest(path, manifest);
    if (typeof parsed.name === 'string') workspaceNames.add(parsed.name);
    for (const section of MANIFEST_SECTIONS)
      for (const [name, spec] of Object.entries(parsed[section] ?? {}))
        if (typeof spec === 'string' && /^(?:workspace|link|file):/.test(spec))
          workspaceNames.add(name);
  }
  for (const name of [...changes.keys()])
    if ((scope !== null && !name.startsWith(scope)) || workspaceNames.has(name))
      changes.delete(name);
  return changes;
}

/**
 * #4631: a test-runtime dependency is not imported by the suites it breaks.
 * jsdom 31 changed focus handling for every suite Vitest ran under the
 * `jsdom` environment, but those suites name `@testing-library/react`, not
 * jsdom, and the manifest edits only reached related discovery as Vitest
 * global rerun triggers, which a hosted plan defers to `test-full`. The bump
 * landed with every one of those suites deferred and failed four unrelated
 * pull requests in the queue.
 *
 * The environment a suite runs under is read the way Vitest reads it: its
 * `@vitest-environment` docblock, else the root config's `test.environment`
 * (Vitest's own default is `node`). The package behind an environment
 * follows Vitest's own rule, so the set is derived from the configuration
 * rather than listed here. Vitest itself is deliberately not in the set: a
 * Vitest bump affects every suite, which is the full corpus `test-full`
 * already owns, and more than the four shards' budget holds.
 */
const VITEST_ENVIRONMENT_DOCBLOCK = /@(?:vitest|jest)-environment\s+([\w-]+)\b/;
const VITEST_ENVIRONMENT_PACKAGES = Object.freeze({
  jsdom: 'jsdom',
  'happy-dom': 'happy-dom',
  'edge-runtime': '@edge-runtime/vm',
});
const VITEST_CONFIG = 'vitest.config.ts';
/**
 * Root `test` options that would make a suite's environment depend on more
 * than its docblock and the default; refused rather than misread.
 */
const UNSUPPORTED_ENVIRONMENT_OPTIONS = Object.freeze([
  'environmentMatchGlobs',
  'projects',
  'workspace',
]);

/** Vitest's `getEnvPackageName`: the package an environment name loads. */
export function vitestEnvironmentPackage(environment) {
  if (environment === 'node') return null;
  if (Object.hasOwn(VITEST_ENVIRONMENT_PACKAGES, environment))
    return VITEST_ENVIRONMENT_PACKAGES[environment];
  if (environment.startsWith('.') || isAbsolute(environment)) return null;
  return `vitest-environment-${environment}`;
}

function propertyName(node) {
  return node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ? node.name.text
    : undefined;
}

/**
 * The root config's default `test.environment`, read from its source: the
 * object literal passed to `defineConfig`. Anything this cannot read exactly
 * (a computed environment, per-glob or per-project environments) throws, so
 * a config change cannot silently shrink the selection.
 */
export function configuredVitestEnvironment(
  root,
  read = (path) => readFileSync(join(root, path), 'utf8'),
) {
  const source = ts.createSourceFile(
    VITEST_CONFIG,
    read(VITEST_CONFIG),
    ts.ScriptTarget.Latest,
    true,
  );
  let options;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'defineConfig'
    ) {
      const [config] = node.arguments;
      if (!config || !ts.isObjectLiteralExpression(config) || options)
        throw new Error(
          `test runtime: ${VITEST_CONFIG} must pass one object literal to defineConfig`,
        );
      const test = config.properties.find(
        (property) => propertyName(property) === 'test',
      );
      if (!test) {
        options = [];
        return;
      }
      if (
        !ts.isPropertyAssignment(test) ||
        !ts.isObjectLiteralExpression(test.initializer)
      )
        throw new Error(
          `test runtime: ${VITEST_CONFIG} test options must be an object literal`,
        );
      options = test.initializer.properties;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!options)
    throw new Error(`test runtime: ${VITEST_CONFIG} has no defineConfig call`);
  for (const property of options) {
    const name = ts.isSpreadAssignment(property)
      ? '...spread'
      : propertyName(property);
    if (name === '...spread' || UNSUPPORTED_ENVIRONMENT_OPTIONS.includes(name))
      throw new Error(
        `test runtime: ${VITEST_CONFIG} test.${name} can change a suite's environment; teach dependency-change-scan.mjs to read it`,
      );
  }
  const environment = options.find(
    (property) => propertyName(property) === 'environment',
  );
  if (!environment) return 'node';
  if (
    !ts.isPropertyAssignment(environment) ||
    !ts.isStringLiteralLike(environment.initializer)
  )
    throw new Error(
      `test runtime: ${VITEST_CONFIG} test.environment must be a string literal`,
    );
  return environment.initializer.text;
}

/**
 * The corpus suites (not `tests/`) each test-runtime environment package
 * runs, keyed by package name. A suite in the `node` environment, or in an
 * in-repository environment file, needs no package and is not listed.
 *
 * @param {{ root: string, testFiles?: readonly string[], read?: (path: string) => string, defaultEnvironment?: string }} options
 * @returns {Map<string, string[]>}
 */
export function vitestEnvironmentSuites({
  root,
  testFiles = collectCorpusTestFiles(root).map((absolute) =>
    relative(root, absolute).split(sep).join('/'),
  ),
  read = (path) => readFileSync(join(root, path), 'utf8'),
  defaultEnvironment = configuredVitestEnvironment(root),
}) {
  const suites = new Map();
  for (const file of testFiles) {
    if (file.startsWith('tests/')) continue;
    const environment =
      VITEST_ENVIRONMENT_DOCBLOCK.exec(read(file))?.[1] ?? defaultEnvironment;
    const name = vitestEnvironmentPackage(environment);
    if (!name) continue;
    const files = suites.get(name) ?? [];
    files.push(file);
    suites.set(name, files);
  }
  for (const files of suites.values()) files.sort();
  return suites;
}

/**
 * Whether `source` imports `name` or one of its subpaths: a static import or
 * export, a dynamic `import()`, or a `require()`, as TypeScript's import
 * scanner reads them. A specifier inside a string or template literal (the
 * fixture source an import gate scans) is not an import and does not count.
 */
function importsPackage(source, name) {
  if (!source.includes(name)) return false;
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.some(
      ({ fileName }) => fileName === name || fileName.startsWith(`${name}/`),
    );
}

/**
 * Vitest-eligible suites (not `tests/`, which Vitest excludes) that import
 * each package directly, by name.
 *
 * @param {{ root: string, names: Iterable<string>, testFiles?: readonly string[], read?: (path: string) => string }} options
 * @returns {Map<string, string[]>}
 */
export function directImporterTests({
  root,
  names,
  testFiles = collectCorpusTestFiles(root).map((absolute) =>
    relative(root, absolute).split(sep).join('/'),
  ),
  read = (path) => readFileSync(join(root, path), 'utf8'),
}) {
  const importers = new Map([...names].map((name) => [name, []]));
  if (!importers.size) return importers;
  for (const file of testFiles) {
    if (file.startsWith('tests/')) continue;
    const source = read(file);
    for (const [name, files] of importers)
      if (importsPackage(source, name)) files.push(file);
  }
  for (const files of importers.values()) files.sort();
  return importers;
}
