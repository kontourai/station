/**
 * Freshness of a workspace package's *untracked build output* relative to its
 * sources (station#1813).
 *
 * ## The failure this exists to remove
 *
 * `packages/connect/dist` is gitignored, so it is not part of any checkout.
 * `npm run typecheck` runs `typecheck:ui`, which resolves
 * `@kontourai/station-connect` through `dist/index.d.ts` — and nothing in the
 * `typecheck` script declares a dependency on `build:connect`. So a merge that
 * changes `packages/connect/src` silently invalidates every worktree's local
 * `dist`, and the type error surfaces **in a consumer file the merger never
 * opened**. On this checkout (~80 worktrees) the natural reading of that red is
 * "main is broken", which costs someone else an investigation.
 *
 * The tool is correct; its inputs are stale; nothing says so. This module makes
 * the staleness itself the diagnostic.
 *
 * ## Derivation, not a hardcoded package list
 *
 * Nothing here names `connect`. A package is on the stale-dist path when an
 * entry point it publishes (`main`/`module`/`types`/`typings`/`bin`/`exports`)
 * resolves into a directory git ignores. That is the property that causes the failure, so it is
 * the property that is computed — a sibling package that grows the same shape
 * is covered the day it does, and one that stops having it drops out. Every
 * workspace package is classified and reported, so scope loss is visible rather
 * than silent.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Bumping this invalidates every existing stamp on purpose. */
export const DIGEST_VERSION = 1;

export const STAMP_FILENAME = '.dist-stamp.json';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Workspace package directories, expanded from the root `workspaces` field.
 *
 * Supports the two forms npm workspaces are declared in here: an explicit
 * directory path, and the single-level `<dir>/*` glob. Anything else throws
 * rather than silently contributing nothing — a pattern that quietly expands to
 * zero is exactly the blind spot this gate exists to close.
 */
export function listWorkspacePackages(repoRoot) {
  const root = readJson(join(repoRoot, 'package.json'));
  const declared = root?.workspaces;
  // npm also accepts the object form `{ "packages": [...] }`. Reading only the
  // array form made that shape yield zero packages and a green run.
  const patterns = Array.isArray(declared)
    ? declared
    : Array.isArray(declared?.packages)
      ? declared.packages
      : [];
  const packages = [];
  const unreadable = [];
  const admit = (dir) => {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) return;
    const manifest = readJson(manifestPath);
    if (!manifest) {
      // Silently skipping an unparseable manifest removes a package from both
      // the report and the coverage with no diagnostic — the blind spot this
      // module exists to remove, applied to itself.
      unreadable.push(relative(repoRoot, manifestPath).split(sep).join('/'));
      return;
    }
    packages.push({
      name: manifest.name ?? relative(repoRoot, dir),
      dir,
      relDir: relative(repoRoot, dir).split(sep).join('/'),
      manifest,
    });
  };
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
        throw new Error(
          `unsupported workspaces pattern ${JSON.stringify(pattern)}; ` +
            'package-dist-freshness expands an explicit path or the "<dir>/*" form',
        );
      }
      const parent = join(repoRoot, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) admit(join(parent, entry.name));
      }
      continue;
    }
    const dir = join(repoRoot, pattern);
    if (existsSync(dir)) admit(dir);
  }
  packages.sort((a, b) => a.relDir.localeCompare(b.relDir));
  return { packages, unreadable };
}

/**
 * Every relative path a package publishes as a resolvable entry point.
 *
 * Covers `main`, `module`, `types`, `typings`, **`bin`**, and `exports`. `bin`
 * is not an optional extra: `packages/cli` publishes *only* a `bin`, pointing
 * at a git-ignored bundle that `station --link` installs as the global
 * `station` command. Reading the other five and not `bin` made the gate print
 * `publishes no resolvable entry point` for the one package in this repo whose
 * sole entry point is a git-ignored build artefact — a green line asserting a
 * property the derivation never evaluated.
 *
 * Bare specifiers count too. `main`/`module`/`types`/`typings`/`bin` are file
 * paths by specification and are conventionally written without `./`; an
 * earlier `startsWith('.')` filter discarded them, which meant
 * `packages/connect` was in scope only because its `exports` map happens to use
 * `./`-prefixed strings. A sibling going dist-backed via a bare `main` alone
 * would have been reported clean.
 */
export function entryPointFields(manifest) {
  const found = new Map();
  const add = (field, value) => {
    if (typeof value !== 'string' || value.length === 0) return;
    // `#`-prefixed values belong to `imports`, not to a published entry point.
    if (value.startsWith('#')) return;
    const specifier = value.replace(/^\.\//, '');
    if (!found.has(specifier)) found.set(specifier, new Set());
    found.get(specifier).add(field);
  };
  add('main', manifest.main);
  add('module', manifest.module);
  add('types', manifest.types);
  add('typings', manifest.typings);
  if (typeof manifest.bin === 'string') add('bin', manifest.bin);
  else if (manifest.bin && typeof manifest.bin === 'object') {
    for (const value of Object.values(manifest.bin)) add('bin', value);
  }
  const walkExports = (node) => {
    if (typeof node === 'string') {
      add('exports', node);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) walkExports(value);
    }
  };
  walkExports(manifest.exports);
  return found;
}

export function entryPointSpecifiers(manifest) {
  return [...entryPointFields(manifest).keys()].sort();
}

/**
 * Which of `paths` git ignores, asked in one call.
 *
 * `git check-ignore` exits 1 when nothing matched, which is a legitimate
 * answer, not a failure — only an exit above 1 is a real error.
 */
export function ignoredPaths(repoRoot, paths) {
  if (paths.length === 0) return new Set();
  const result = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: repoRoot,
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore failed (status ${result.status}): ${result.stderr}`,
    );
  }
  return new Set(
    (result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(sep).join('/')),
  );
}

/**
 * The root `npm run` script that rebuilds this package, derived from the root
 * manifest rather than written down.
 *
 * A hardcoded `build:connect` would keep printing after someone renamed the
 * script — a diagnostic naming a command that no longer exists is the same
 * defect class as a stale dist.
 */
export function resolveBuildScript(repoRoot, pkg) {
  const scripts = readJson(join(repoRoot, 'package.json'))?.scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue;
    if (!/\bbuild\b/.test(command)) continue;
    if (
      command.includes(`--workspace=${pkg.relDir}`) ||
      command.includes(`--workspace=${pkg.name}`)
    ) {
      return `npm run ${name}`;
    }
  }
  return `npm run build --workspace=${pkg.relDir}`;
}

/**
 * Classify one package: is an entry point it publishes resolved out of a
 * git-ignored directory?
 */
export function classifyPackage(pkg, ignored) {
  const byField = entryPointFields(pkg.manifest);
  const distDirs = new Map();
  for (const [specifier, fields] of byField) {
    const relPath = `${pkg.relDir}/${specifier}`;
    if (!ignored.has(relPath)) continue;
    // The ignored directory is the first segment of the entry path inside the
    // package — `dist/index.d.ts` -> `dist`.
    const segment = relPath.slice(pkg.relDir.length + 1).split('/')[0];
    if (!segment) continue;
    if (!distDirs.has(segment)) distDirs.set(segment, new Set());
    for (const field of fields) distDirs.get(segment).add(field);
  }
  return {
    name: pkg.name,
    relDir: pkg.relDir,
    dir: pkg.dir,
    entryPoints: [...byField.keys()].sort(),
    distBacked: distDirs.size > 0,
    distDirs: [...distDirs.keys()].sort(),
    // Which manifest fields put each build directory on the published surface.
    // The remedy sentence is chosen from this: `bin` is not resolved by any
    // typechecker, so telling its reader to expect a type error in a consumer
    // file would be a confident, wrong diagnosis.
    distFields: Object.fromEntries(
      [...distDirs].map(([dir, fields]) => [dir, [...fields].sort()]),
    ),
  };
}

/**
 * Compile a tsconfig `exclude` entry into a matcher.
 *
 * The previous implementation reduced each pattern to a directory prefix with
 * `entry.replace(/\/?\*\*?.*$/, '')`, which is correct only when the glob is
 * the trailing segment. For a mid-path wildcard it collapses the pattern to its
 * root:
 *
 * ```
 *   "src/__tests__/**"   -> "src/__tests__"   (intended)
 *   "src/**\/*.test.ts"  -> "src"             (the entire source tree)
 * ```
 *
 * Moving a package from `__tests__/` to co-located `*.test.ts` — an ordinary
 * refactor, in a different file, reviewed by someone thinking about tests —
 * would therefore have silently reduced the freshness digest to
 * `package.json` + `tsconfig.json`, so every source change read fresh forever.
 * Total silence, permanent, with no diagnostic. Matching the pattern properly
 * removes the class rather than backstopping it; `sourceFiles`' zero-file check
 * is the backstop for whatever this still gets wrong.
 */
export function excludeMatcher(patterns) {
  const regexes = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const pattern = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    let source = '';
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (char === '*') {
        if (pattern[index + 1] === '*') {
          index += 1;
          if (pattern[index + 1] === '/') {
            index += 1;
            source += '(?:.*/)?';
          } else {
            source += '.*';
          }
        } else {
          source += '[^/]*';
        }
        continue;
      }
      if (char === '?') {
        source += '[^/]';
        continue;
      }
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    // tsconfig treats a pattern naming a directory as excluding its contents.
    regexes.push(new RegExp(`^${source}(?:/.*)?$`));
  }
  return (relPath) => regexes.some((regex) => regex.test(relPath));
}

/**
 * Source paths the package's build actually compiles, honouring its own
 * tsconfig `exclude` so editing a test does not report the build as stale.
 *
 * Returns `{ sources, manifests }` so callers can tell "no source file is
 * covered" from "the digest is over a small package".
 */
export function sourceFiles(pkgDir) {
  const tsconfig = readJson(join(pkgDir, 'tsconfig.json'));
  const isExcluded = excludeMatcher(tsconfig?.exclude ?? []);

  const files = [];
  const walk = (absDir) => {
    if (!existsSync(absDir)) return;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name);
      const rel = relative(pkgDir, abs).split(sep).join('/');
      if (isExcluded(rel)) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile()) files.push(rel);
    }
  };
  walk(join(pkgDir, 'src'));
  const sources = files.sort();
  const manifests = ['package.json', 'tsconfig.json'].filter((extra) =>
    existsSync(join(pkgDir, extra)),
  );
  return { sources, manifests, all: [...sources, ...manifests].sort() };
}

/** Content digest of a package's compiled source surface. */
export function computeSourceDigest(pkgDir, covered = sourceFiles(pkgDir)) {
  const hash = createHash('sha256');
  hash.update(`digest-version:${DIGEST_VERSION}\n`);
  for (const rel of covered.all) {
    hash.update(rel);
    hash.update('\0');
    hash.update(
      createHash('sha256')
        .update(readFileSync(join(pkgDir, rel)))
        .digest('hex'),
    );
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function stampPath(pkgDir, distDir) {
  return join(pkgDir, distDir, STAMP_FILENAME);
}

export function readStamp(pkgDir, distDir) {
  return readJson(stampPath(pkgDir, distDir));
}

/**
 * `fresh` | `missing` | `unstamped` | `stale` | `unmeasurable` for one package's
 * dist directory.
 *
 * `unmeasurable` is the backstop §6 asks for: a digest that covers **no source
 * file** cannot show anything fresh, so it must red rather than compare two
 * digests of the same two manifest files and call them equal. Without it the
 * only symptom of a mis-scoped `exclude` is a permanent, silent green.
 */
export function evaluateDist(pkg, distDir) {
  const absDist = join(pkg.dir, distDir);
  if (!existsSync(absDist) || !statSync(absDist).isDirectory()) {
    return {
      distDir,
      status: 'missing',
      expected: null,
      recorded: null,
      coveredSources: 0,
    };
  }
  const covered = sourceFiles(pkg.dir);
  const base = { distDir, coveredSources: covered.sources.length };
  if (covered.sources.length === 0) {
    return { ...base, status: 'unmeasurable', expected: null, recorded: null };
  }
  const expected = computeSourceDigest(pkg.dir, covered);
  const stamp = readStamp(pkg.dir, distDir);
  if (!stamp || typeof stamp.sourceDigest !== 'string') {
    return { ...base, status: 'unstamped', expected, recorded: null };
  }
  if (stamp.digestVersion !== DIGEST_VERSION) {
    return {
      ...base,
      status: 'unstamped',
      expected,
      recorded: stamp.sourceDigest,
    };
  }
  return {
    ...base,
    status: stamp.sourceDigest === expected ? 'fresh' : 'stale',
    expected,
    recorded: stamp.sourceDigest,
  };
}

/**
 * Classify every workspace package and evaluate the dist-backed ones.
 *
 * `packages` is always the complete enumerated set — the report prints one line
 * per package, so a package silently dropping out of scope is visible instead
 * of being absorbed into a green.
 */
export function inspectWorkspace(repoRoot) {
  const { packages, unreadable } = listWorkspacePackages(repoRoot);
  const candidatePaths = [];
  for (const pkg of packages) {
    for (const specifier of entryPointSpecifiers(pkg.manifest)) {
      candidatePaths.push(`${pkg.relDir}/${specifier.replace(/^\.\//, '')}`);
    }
  }
  const ignored = ignoredPaths(repoRoot, candidatePaths);
  const report = [];
  for (const pkg of packages) {
    const classified = classifyPackage(pkg, ignored);
    const entry = {
      ...classified,
      buildScript: resolveBuildScript(repoRoot, pkg),
      dists: [],
    };
    for (const distDir of classified.distDirs) {
      entry.dists.push(evaluateDist(pkg, distDir));
    }
    report.push(entry);
  }
  return { repoRoot, packages: report, unreadableManifests: unreadable };
}

const STATUS_SENTENCE = {
  missing: (relDist) => `${relDist} is MISSING`,
  unstamped: (relDist) =>
    `${relDist} has no current freshness stamp, so it cannot be shown fresh`,
  stale: (relDist) => `${relDist} is STALE`,
  unmeasurable: (relDist) =>
    `${relDist} cannot be checked: the freshness digest covers no source file`,
};

/**
 * Human report. The failure sentence leads with the dist directory and the word
 * STALE/MISSING — never with a consumer file — because the whole harm in
 * station#1813 is a correct tool blaming the wrong file.
 */
export function formatReport({ packages, unreadableManifests = [] }) {
  const lines = [];
  const failures = [];

  // A run that enumerated nothing is not a clean run. `workspaces` missing,
  // renamed, or written in a form this module does not expand yields zero
  // packages, and without this the gate prints `Checked 0 …` and exits 0 — the
  // same shape as a `> 300` floor that cannot notice its inputs disappearing.
  if (packages.length === 0) {
    failures.push(
      [
        'FAIL: no workspace package was enumerated, so nothing was checked.',
        '      A gate that inspects zero packages is not a passing gate. Check the',
        '      root package.json `workspaces` field: it must be an array of paths',
        '      (or `{ "packages": [...] }`), each naming a directory with a',
        '      readable package.json.',
      ].join('\n'),
    );
  }

  for (const path of unreadableManifests) {
    failures.push(
      [
        `FAIL: ${path} could not be parsed, so its package was not classified.`,
        '      An unreadable manifest silently removes a package from both this',
        '      report and its coverage; fix the JSON rather than let it vanish.',
      ].join('\n'),
    );
  }

  for (const pkg of packages) {
    if (!pkg.distBacked) {
      lines.push(
        pkg.entryPoints.length === 0
          ? `OK:   ${pkg.relDir} — publishes no resolvable entry point; not on the stale-dist path`
          : `OK:   ${pkg.relDir} — ${pkg.entryPoints.length} entry point(s) resolve to tracked sources; not on the stale-dist path`,
      );
      continue;
    }
    for (const dist of pkg.dists) {
      const relDist = `${pkg.relDir}/${dist.distDir}`;
      if (dist.status === 'fresh') {
        // The covered count is printed on the green line on purpose: a digest
        // quietly narrowing from 45 files to 2 is otherwise invisible until it
        // reaches zero.
        lines.push(
          `OK:   ${relDist} is fresh for ${pkg.relDir}/src (${dist.coveredSources} source file(s) covered)`,
        );
        continue;
      }
      const sentence = STATUS_SENTENCE[dist.status](relDist);
      const fields = pkg.distFields?.[dist.distDir] ?? [];
      const resolvedByTypecheck = fields.some((field) => field !== 'bin');
      const remedy =
        dist.status === 'unmeasurable'
          ? [
              `      Every file under ${pkg.relDir}/src is excluded by that package's`,
              '      own tsconfig `exclude`, so the digest reduces to its manifests and',
              '      every source change would read fresh forever. Rebuilding will not',
              `      help. Fix: narrow \`exclude\` in ${pkg.relDir}/tsconfig.json.`,
            ]
          : resolvedByTypecheck
            ? [
                `      \`npm run typecheck\` resolves ${pkg.name} through that built`,
                '      output, so it would report a type error in an unrelated',
                '      consumer file rather than here. This is not a source defect.',
                `      Fix: ${pkg.buildScript}`,
              ]
            : [
                `      ${pkg.name} publishes that output as an executable (\`bin\`).`,
                '      Nothing typechecks through it, so a stale build produces no',
                '      diagnostic at all — the installed command just runs old code.',
                `      Fix: ${pkg.buildScript}`,
              ];
      failures.push(
        [`FAIL: ${sentence} relative to ${pkg.relDir}/src.`, ...remedy].join(
          '\n',
        ),
      );
    }
  }
  lines.push(
    `Checked ${packages.length} workspace package(s); ${packages.filter((p) => p.distBacked).length} resolve entry points through a git-ignored build directory.`,
  );
  return { lines, failures };
}
