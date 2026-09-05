import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  isPnpmRepository,
  listWorkspacePackageManifests,
} from '../workspace-dependency-provenance.mjs';
import { readPnpmLockfile } from './pnpm-lockfile.mjs';

/**
 * `package-lock.json`'s `packages` map is always forward-slash-keyed,
 * regardless of platform (npm writes it that way on every OS). `relDir` is
 * computed once via `path.relative` and then used both to build a lock key
 * and to name a scope in a mismatch message -- station#4109 review H1
 * (Windows follow-up): storing it in `path.sep` form meant a Windows
 * `packages\contracts` never matched the lockfile's `packages/contracts`
 * key, silently fell back to the root candidate, and reintroduced the exact
 * scope-collapse bug H1 fixed on POSIX.
 *
 * Normalize to forward-slash at the single point `relDir` is first computed,
 * so every downstream consumer (lock lookup, message, filesystem read)
 * shares one canonical form. Deliberately NOT gated on the current
 * platform's `path.sep` -- an unconditional backslash-to-forward-slash
 * transform is correct on every platform (a real POSIX workspace directory
 * name here is a plain ASCII identifier and never contains a literal
 * backslash) and, unlike a `sep`-conditional version, is exercisable by a
 * test on any single platform rather than only on Windows.
 */
export function toLockRelDir(relDir) {
  return relDir.split('\\').join('/');
}

/** Inverse of `toLockRelDir`: rebuilds a platform-correct path from the
 * canonical forward-slash `relDir` for an actual filesystem read. */
function relDirToPathSegments(relDir) {
  return relDir ? relDir.split('/') : [];
}

/**
 * station#4109: the verification receipt's identity hashes package-lock.json
 * (`dependencyDigest`) but nothing ever checked that `node_modules` actually
 * matches it. A worktree that merges a dependency bump forward and resubmits
 * without `npm ci` gets phase failures (a changed export, a moved type) that
 * read exactly like branch defects — the live incident was three lanes
 * failing `sdk-builds` on `TS2305: no exported member 'FoundAnswerCardProjection'`
 * because `@kontourai/surface` was installed at 2.14.0 while the lockfile
 * (and the branch) were already on 2.15.0.
 *
 * This is a preflight, not a repair: it only compares versions already on
 * disk and never mutates node_modules (`npm ci` deletes and rewrites it,
 * which is the operator's call, not the coordinator's).
 *
 * ## What this gate does and does not establish (station#4109 review, M2)
 *
 * It is a plain-semver **version-identity** check, resolved per declaring
 * scope (see below) -- nothing more. It is silent about:
 *
 * - **git / file / link dependencies.** A git-pinned dependency's `version`
 *   field can be stale relative to the actual pinned commit (the revision
 *   moves without the semver string changing), and a `link:`/workspace-link
 *   entry has no registry version at all. This gate cannot verify either, so
 *   it does not try: such entries are counted and named in the `skipped`
 *   list rather than silently compared or silently dropped. Station has none
 *   of these among its direct dependencies today.
 * - **Content/integrity drift.** A version string matching is not proof the
 *   installed bytes match the locked `integrity` hash (a corrupted or
 *   hand-edited `node_modules` entry with an unchanged `version` field would
 *   pass). This gate deliberately does not hash content -- that is a
 *   different, heavier check for a different round.
 * pnpm declarations resolve against their own importer, including peer-context
 * suffixes, then compare the installed package in that scope or hoisted root.
 * Missing or malformed pnpm locks fail closed. Historical npm fixtures retain
 * the npm packages-map reader when no pnpm configuration is declared.
 */

// `listWorkspacePackageManifests` resolves declared workspace directories
// through `realpathSync`, so a caller passing an alias root (a common macOS
// /tmp -> /private/tmp symlink hop in tests, or a symlinked worktree) would
// otherwise compute a `relative(repositoryRoot, directory)` against two
// different spellings of the same path. Canonicalizing here keeps every
// derived relative directory (and therefore every lockfile/node_modules
// lookup key) consistent.
function canonicalRoot(repositoryRoot) {
  try {
    return realpathSync(repositoryRoot);
  } catch {
    return repositoryRoot;
  }
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function directDependencyNames(manifest) {
  return new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
    ...Object.keys(manifest?.optionalDependencies ?? {}),
  ]);
}

function workspaceManifests(repositoryRoot) {
  if (isPnpmRepository(repositoryRoot))
    return listWorkspacePackageManifests(repositoryRoot);
  try {
    return listWorkspacePackageManifests(repositoryRoot);
  } catch {
    // No declared workspaces (or an unsupported shape) is not this
    // preflight's concern -- it degrades to root-only direct deps rather
    // than failing a repository that legitimately has none.
    return [];
  }
}

/**
 * Enumerates every (declaring manifest, dependency name) pair: the root
 * manifest's own direct dependencies (`relDir: ''`) and each declared
 * workspace's own manifest (`relDir: '<workspace path>'`). Deliberately NOT
 * collapsed by name -- station#4109 review H1: two different manifests can
 * declare the same dependency name at two different versions (root pulling
 * one transitively-hoisted version, a workspace requiring another directly),
 * and each is a distinct installation to verify. Workspace packages
 * themselves (the `@kontourai/station-*` internal packages) are excluded:
 * they are symlinked by npm, not installed from the registry, and their
 * provenance is already proven by `assertWorkspacePackageProvenance`.
 */
export function collectDirectDependencyDeclarations(repositoryRoot) {
  repositoryRoot = canonicalRoot(repositoryRoot);
  const declarations = [];
  const seen = new Set();
  const declare = (name, relDir) => {
    const key = `${relDir}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    declarations.push({ name, relDir });
  };

  const rootManifest = readJsonOrNull(join(repositoryRoot, 'package.json'));
  if (rootManifest)
    for (const name of directDependencyNames(rootManifest)) declare(name, '');

  const workspaces = workspaceManifests(repositoryRoot);
  for (const { directory } of workspaces) {
    const manifest = readJsonOrNull(join(directory, 'package.json'));
    if (!manifest) continue;
    const relDir = toLockRelDir(relative(repositoryRoot, directory));
    for (const name of directDependencyNames(manifest)) declare(name, relDir);
  }

  const workspaceNames = new Set(workspaces.map((entry) => entry.name));
  return declarations
    .filter(({ name }) => !workspaceNames.has(name))
    .sort(
      (left, right) =>
        left.relDir.localeCompare(right.relDir) ||
        left.name.localeCompare(right.name),
    );
}

/**
 * Reads `package-lock.json`, distinguishing ABSENT from PRESENT-BUT-BROKEN
 * (station#4109 review M3). Absent degrades this preflight to a no-op (bare
 * test fixtures with no lockfile at all stay unaffected, and a real repo
 * checkout is separately protected by provenance's required lockfile-hash
 * read). Present-but-unparseable, or present but lacking the npm v7+
 * `packages` map (a v1-shaped lockfile) is a DIFFERENT, honest failure this
 * gate must not swallow: `status: 'unreadable'` becomes its own named
 * refusal rather than a silent clean pass.
 */
function readLockfile(repositoryRoot) {
  if (isPnpmRepository(repositoryRoot)) {
    try {
      return {
        status: 'ok',
        importers: readPnpmLockfile(repositoryRoot).importers,
      };
    } catch {
      return { status: 'unreadable' };
    }
  }
  const path = join(repositoryRoot, 'package-lock.json');
  if (!existsSync(path)) return { status: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { status: 'unreadable' };
  }
  const packages = parsed?.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages))
    return { status: 'unreadable' };
  return { status: 'ok', packages };
}

function installedVersion(repositoryRoot, relDir, name) {
  // `relDir` is canonical forward-slash form (see `toLockRelDir`); rebuild a
  // platform-correct path for the actual filesystem read rather than
  // joining the forward-slash string directly.
  const manifestPath = join(
    repositoryRoot,
    ...relDirToPathSegments(relDir),
    'node_modules',
    name,
    'package.json',
  );
  if (!existsSync(manifestPath)) return undefined;
  const manifest = readJsonOrNull(manifestPath);
  return typeof manifest?.version === 'string' ? manifest.version : undefined;
}

/**
 * Classifies a resolved lock entry for whether a plain semver-string compare
 * is even meaningful (station#4109 review M2). Returns a skip reason, or
 * `null` when the entry is a normal registry-versioned package.
 */
function unverifiableReason(entry) {
  if (entry.link === true) return 'link';
  const resolved = typeof entry.resolved === 'string' ? entry.resolved : '';
  if (resolved.startsWith('git+') || resolved.startsWith('git:')) return 'git';
  if (resolved.startsWith('file:')) return 'file';
  if (typeof entry.version !== 'string') return 'versionless';
  return null;
}

/**
 * Resolves the lock entry for one (name, declaring-scope) pair the way npm
 * resolution actually works for that scope: a workspace's own dependency
 * resolves through its own nested `node_modules` first, then falls back to
 * the hoisted root -- never the other way around, and never merged with a
 * different scope's resolution (station#4109 review H1). A root-declared
 * dependency has only the root candidate; there is no "nested root".
 */
export function resolveLockEntry(packages, relDir, name) {
  const candidates = relDir ? [relDir, ''] : [''];
  for (const scope of candidates) {
    const lockKey = scope
      ? `${scope}/node_modules/${name}`
      : `node_modules/${name}`;
    const entry = packages[lockKey];
    if (entry && typeof entry === 'object') return { scope, entry };
  }
  return null;
}

/**
 * Compares each direct dependency's installed `node_modules` version against
 * the declared package manager's lockfile, resolved per declaring scope (root vs. each
 * workspace) rather than collapsed by name. Bounded to O(direct
 * dependencies): each (scope, name) pair costs at most two lockfile-map
 * lookups (nested candidate, then root fallback) plus one
 * `node_modules/<name>/package.json` read at the resolved scope. No npm
 * subprocess, no walk of the full (transitive) dependency tree.
 *
 * Returns `{ mismatches, skipped, lockfileUnreadable }`:
 * - `mismatches`: `{ name, relDir, installed, locked }` -- installed does
 *   not match locked at that scope's resolved location.
 * - `skipped`: `{ name, relDir, reason }` -- a resolved lock entry this gate
 *   cannot verify by version alone (git/file/link/versionless; see the
 *   module doc comment). Never silently compared, never silently dropped.
 * - `lockfileUnreadable`: true for a missing or invalid pnpm lock, missing
 *   importer declaration, or malformed legacy npm packages map. Only legacy
 *   fixtures without pnpm configuration may omit a lockfile.
 */
export function findStaleInstalledDependencies({ repositoryRoot }) {
  repositoryRoot = canonicalRoot(repositoryRoot);
  const lock = readLockfile(repositoryRoot);
  if (lock.status === 'absent')
    return { mismatches: [], skipped: [], lockfileUnreadable: false };
  if (lock.status === 'unreadable')
    return { mismatches: [], skipped: [], lockfileUnreadable: true };

  const declarations = collectDirectDependencyDeclarations(repositoryRoot);
  const mismatches = [];
  const skipped = [];

  for (const { name, relDir } of declarations) {
    let resolved;
    if (lock.importers) {
      const importer = lock.importers[relDir || '.'];
      const reference =
        importer?.dependencies?.[name] ??
        importer?.devDependencies?.[name] ??
        importer?.optionalDependencies?.[name];
      if (!reference || typeof reference.version !== 'string')
        return { mismatches: [], skipped: [], lockfileUnreadable: true };
      const rawVersion = reference.version.replace(/\(.*$/, '');
      const version = rawVersion.replace(
        /^(?:@[^/]+\/)?[^@]+@(\d+\.\d+\.\d+.*)$/,
        '$1',
      );
      if (!/^(?:\d+\.\d+\.\d+|link:|file:|git:|git\+)/.test(version)) {
        skipped.push({ name, relDir, reason: 'non-registry' });
        continue;
      }
      const entry = {
        version,
        resolved: version,
        link: version.startsWith('link:'),
        optional: !!importer?.optionalDependencies?.[name],
      };
      // The importer owns the locked version; Node's lookup owns its installed
      // location. Hoisting never changes which importer version is expected.
      const scope =
        relDir &&
        existsSync(
          join(
            repositoryRoot,
            ...relDirToPathSegments(relDir),
            'node_modules',
            name,
            'package.json',
          ),
        )
          ? relDir
          : '';
      resolved = { entry, scope };
    } else resolved = resolveLockEntry(lock.packages, relDir, name);
    // No lock entry found at any candidate location for this scope: nothing
    // to assert a mismatch against, so this declaration is out of scope for
    // this preflight.
    if (!resolved) continue;

    const reason = unverifiableReason(resolved.entry);
    if (reason) {
      skipped.push({ name, relDir, reason });
      continue;
    }

    const locked = resolved.entry.version;
    const installed = installedVersion(repositoryRoot, resolved.scope, name);
    if (installed === undefined && resolved.entry.optional === true)
      // A registry-optional package legitimately absent on this platform
      // (os/cpu restricted) is not a mismatch -- npm never installs it here
      // by design. If it IS installed, it is still validated below.
      continue;
    if (installed !== locked)
      mismatches.push({ name, relDir, installed, locked });
  }

  return { mismatches, skipped, lockfileUnreadable: false };
}

function scopeLabel(relDir) {
  return relDir || 'root';
}

export class VerificationEnvironmentStaleError extends Error {
  constructor(
    message,
    { mismatches = [], skipped = [], reason, repositoryRoot } = {},
  ) {
    super(message);
    this.name = 'VerificationEnvironmentStaleError';
    this.disposition = 'environment-stale';
    this.reason = reason;
    this.mismatches = mismatches;
    this.skipped = skipped;
    /** The tree that was inspected — where the remedy must be run. */
    this.repositoryRoot = repositoryRoot;
  }
}

/**
 * The remedy is `npm run dependencies:ci` IN THE INSPECTED TREE, which is not
 * always the caller's own worktree: `orchestration-transfer-gate.mjs` inspects
 * the prepared baseline sibling, whose `node_modules` a freshly created
 * baseline does not have at all. An unqualified "run npm run dependencies:ci"
 * reads as being about the tree you are standing in — running it there repairs
 * nothing while the identical error repeats, naming packages that are correctly
 * installed where you are.
 *
 * Reached through `run-verification.mjs`, the coordinator and submission paths
 * pass their OWN git toplevel (that CLI has no `--cwd`), so there the root
 * disambiguates which open lane worktree was read rather than pointing
 * somewhere foreign. Other entry points may pass a foreign cwd — the
 * stress harness does — which is why the message names the root either way.
 */
function remedyFor(repositoryRoot) {
  return `run \`npm run dependencies:ci\` in ${repositoryRoot}`;
}

function mismatchError(mismatches, skipped, repositoryRoot) {
  const lines = mismatches
    .map(
      ({ name, relDir, installed, locked }) =>
        `  ${scopeLabel(relDir)} → ${name}: installed ${installed ?? 'missing'}, locked ${locked}`,
    )
    .join('\n');
  return new VerificationEnvironmentStaleError(
    `environment-stale: node_modules does not match ${isPnpmRepository(repositoryRoot) ? 'pnpm-lock.yaml' : 'package-lock.json'} for ` +
      `${mismatches.length} package${mismatches.length === 1 ? '' : 's'} ` +
      `-- ${remedyFor(repositoryRoot)}:\n${lines}`,
    { mismatches, skipped, reason: 'dependency-mismatch', repositoryRoot },
  );
}

function lockfileUnreadableError(repositoryRoot) {
  return new VerificationEnvironmentStaleError(
    `environment-stale: ${isPnpmRepository(repositoryRoot) ? 'pnpm-lock.yaml' : 'package-lock.json'} unreadable/unsupported shape ` +
      `-- cannot verify environment -- ${remedyFor(repositoryRoot)}`,
    { reason: 'lockfile-unreadable', repositoryRoot },
  );
}

/**
 * Refuses -- never repairs. A mismatch here means `node_modules` does not
 * match `package-lock.json`, so any phase this coordinator would run next
 * could fail for reasons that have nothing to do with the branch under
 * test. Throwing before request admission means the caller never reaches a
 * lease, an admitted phase, or a receipt: there is nothing to quarantine or
 * reuse, because nothing was ever created.
 *
 * That holds for the receipt surface, not for every artifact: on the detached
 * worker path this error is caught and persisted into the handoff record via
 * `errorText`, which scrubs absolute paths. `repositoryRoot` is a plain own
 * property and is never spread into that record, so the unredacted root
 * reaches only stderr — this CLI's, and `orchestration-transfer-gate.mjs`'s,
 * which prints `error.message` raw through its own handler. Do not start
 * serializing this error object wholesale without revisiting that.
 */
export function assertInstalledDependenciesMatchLockfile({ repositoryRoot }) {
  // Report the tree the check actually read, not the caller's argument:
  // `findStaleInstalledDependencies` canonicalizes before every lockfile and
  // node_modules lookup, and on macOS `/var/...` vs `/private/var/...` makes
  // those genuinely different strings. Naming the argument would document a
  // root nobody inspected.
  const inspectedRoot = canonicalRoot(repositoryRoot);
  const result = findStaleInstalledDependencies({ repositoryRoot });
  if (result.lockfileUnreadable) throw lockfileUnreadableError(inspectedRoot);
  if (result.mismatches.length > 0)
    throw mismatchError(result.mismatches, result.skipped, inspectedRoot);
}
