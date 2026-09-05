#!/usr/bin/env node
/**
 * Fails when pnpm-lock.yaml importers, resolved peers, patches, or settings
 * disagree with workspace manifests and configuration. The npm reader below
 * remains for explicit historical fixture callers.
 *
 * `npm ci` refuses an out-of-sync lock, so a lock regenerated under
 * --legacy-peer-deps (which drops required peer entries such as `graphql`,
 * reached via graphql-request under @voltagent/core) breaks clean-checkout
 * installs on every surface: the container image, the desktop clean-checkout
 * build, Android, iOS, the portable server bundle, and any fresh dev machine.
 *
 * Nothing catches it locally, because a working tree that already has
 * node_modules never runs `npm ci`. It has regressed twice — once via an
 * unrelated logging fix (#836), once via a `git add -A` that swept a
 * regenerated lock into an unrelated commit.
 *
 * This is a pure lock-vs-manifest check: it reads both files and reports any
 * non-optional peer dependency that has no entry in the lock. No network.
 *
 * It also reports a peer — optional included — whose locked version falls
 * outside the declared range. That case is why `npm install` was impossible on
 * main for an unknown stretch (#1233): `@strands-agents/sdk` declares
 * `peerOptional @anthropic-ai/sdk@^0.109.1` while the root pins `^0.115.0`,
 * which is unsatisfiable, so every attempt to add or update any dependency
 * died in ERESOLVE. `npm ci` never re-resolves, so CI and fresh worktrees
 * stayed green and nothing surfaced it until someone tried to touch a
 * dependency. Presence alone was never the property worth checking.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import semver from 'semver';
import { invokedDirectly } from './lib/module-entry.mjs';
import { readPnpmLockfile, readPnpmWorkspace } from './lib/pnpm-lockfile.mjs';
import {
  isPnpmRepository,
  listWorkspacePackageManifests,
} from './workspace-dependency-provenance.mjs';

/**
 * An override on the dependent's own peer is a deliberate statement that the
 * declared range is stale and the root's version is the one to use, so it is
 * not a finding. This is the sanctioned escape hatch, and honouring it here
 * keeps the gate from flagging the very fix it exists to prompt.
 *
 * npm also accepts version-pinned override keys (`"pkg@1.2.3": {...}`), so a
 * bare-name lookup alone would miss a legitimate override written that way and
 * report a false positive. Nothing in this repo uses that form today; matching
 * it costs one split and removes a trap for whoever writes the next one.
 */
export function isOverridden(manifest, dependentName, peerName) {
  const overrides = manifest.overrides ?? {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!value || typeof value !== 'object') continue;
    const at = key.lastIndexOf('@');
    const keyName = at > 0 ? key.slice(0, at) : key;
    if (keyName !== dependentName) continue;
    if (value[peerName]) return true;
  }
  return false;
}

export function dependentNameFor(path) {
  const at = path.lastIndexOf('node_modules/');
  return at === -1 ? '<root>' : path.slice(at + 'node_modules/'.length);
}

/**
 * Pure over the two parsed JSON documents so it can be exercised against
 * synthetic fixtures. The scoping rules below are deliberate and load-bearing —
 * an earlier draft without them produced a false positive on a real package —
 * so they are pinned by tests rather than left to the next reader's judgement.
 */
export function findPeerProblems({ lock, manifest }) {
  const packages = isRecord(lock?.packages) ? lock.packages : {};
  const rootManifest = isRecord(manifest) ? manifest : {};
  const rootDeps = {
    ...(isRecord(rootManifest.dependencies) ? rootManifest.dependencies : {}),
    ...(isRecord(rootManifest.devDependencies)
      ? rootManifest.devDependencies
      : {}),
  };
  const missing = [];
  const unsatisfiable = [];

  for (const [path, meta] of Object.entries(packages)) {
    if (!isRecord(meta)) continue;
    const peers = meta.peerDependencies;
    if (!isRecord(peers)) continue;
    // An optional package is not installed on every platform, so npm never has
    // to satisfy its peers — flagging them is noise. `@tailwindcss/oxide-
    // wasm32-wasi` is the live example: optional + dev, with bundled @emnapi.
    if (meta.optional) continue;
    const optional = isRecord(meta.peerDependenciesMeta)
      ? meta.peerDependenciesMeta
      : {};
    for (const name of Object.keys(peers)) {
      if (optional[name]?.optional) continue;
      // npm resolves a peer to the nearest node_modules on the path, so accept
      // an entry nested under the dependent as well as the hoisted one.
      const hoisted = `node_modules/${name}`;
      const nested = `${path}/node_modules/${name}`;
      if (packages[hoisted] || packages[nested]) continue;
      missing.push({ name, requiredBy: path || '<root>' });
    }

    // Range check, optional peers included: an optional peer that IS installed
    // still has to satisfy its range, or npm cannot re-resolve the tree.
    //
    // Scoped deliberately to a TOP-LEVEL dependent paired with a peer the root
    // itself depends on, because that is the only shape npm cannot work around
    // — verified against npm directly: a non-root hoisted peer conflict is a
    // soft `ERESOLVE overriding peer dependency` warning, while the root-dep
    // shape is a hard error. A nested dependent just gets its own nested copy,
    // so a stale range there costs nothing and flagging it would be a false
    // positive — the live example is autoevals' bundled openai@4 wanting
    // zod@^3.23.8 while the root is on zod@4, which npm resolves happily.
    const dependent = dependentNameFor(path);
    if (path === `node_modules/${dependent}`) {
      for (const [name, range] of Object.entries(peers)) {
        if (!rootDeps[name]) continue;
        const entry = packages[`node_modules/${name}`];
        if (!entry?.version) continue;
        if (isOverridden(rootManifest, dependent, name)) continue;
        // Deliberately NOT includePrerelease. npm's own peer check is
        // `semver.satisfies(version, range, true)` where the third argument is
        // node-semver's `loose` flag, not prerelease inclusion
        // (@npmcli/arborist/lib/dep-valid.js). Opting into prereleases here
        // would make the gate more permissive than the resolver it models, so
        // a prerelease root pin could read as satisfiable and still ERESOLVE —
        // the exact green-gate/dead-install shape this check exists to stop.
        if (semver.satisfies(entry.version, range, { loose: true })) continue;
        unsatisfiable.push({ name, range, locked: entry.version, dependent });
      }
    }
  }

  return { missing, unsatisfiable };
}

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const ROOT_WORKSPACE = '.';
const LOCK_ROOT_PATH = '';
const DEFAULT_PATH_OPERATIONS = Object.freeze({
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Workspace patterns make it impossible to know which package manifest npm
 * will use without expanding a glob. The release gate deliberately has no
 * such implicit discovery: its input is an explicit, relative package list.
 */
export function normalizeWorkspacePath(value) {
  if (!isNonEmptyString(value)) return undefined;
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    /[*?{}!]/.test(value) ||
    value.includes('[') ||
    value.includes(']') ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  )
    return undefined;
  return value;
}

function problem(workspace, field, manifestValue, lockValue) {
  return { workspace, field, manifestValue, lockValue };
}

function printable(value) {
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function compareProblems(left, right) {
  return (
    left.workspace.localeCompare(right.workspace) ||
    left.field.localeCompare(right.field) ||
    printable(left.manifestValue).localeCompare(
      printable(right.manifestValue),
    ) ||
    printable(left.lockValue).localeCompare(printable(right.lockValue))
  );
}

function workspaceList(value, source) {
  const problems = [];
  if (!Array.isArray(value)) {
    problems.push(
      problem(
        ROOT_WORKSPACE,
        'workspaces',
        source === 'manifest' ? value : undefined,
        source === 'lock' ? value : undefined,
      ),
    );
    return { paths: [], problems };
  }

  const paths = [];
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    const path = normalizeWorkspacePath(entry);
    if (!path || seen.has(path)) {
      problems.push(
        problem(
          ROOT_WORKSPACE,
          `workspaces[${index}]`,
          source === 'manifest' ? entry : undefined,
          source === 'lock' ? entry : undefined,
        ),
      );
      continue;
    }
    seen.add(path);
    paths.push(path);
  }
  return { paths, problems };
}

function sameSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function workspaceManifest(workspaces, path) {
  return workspaces instanceof Map ? workspaces.get(path) : workspaces?.[path];
}

function dependencyMap(entry, field) {
  if (!isRecord(entry)) return undefined;
  const value = entry[field];
  return value === undefined ? {} : isRecord(value) ? value : undefined;
}

function exactPackageFields(problems, workspace, manifest, locked) {
  for (const field of ['name', 'version']) {
    const manifestValue = manifest?.[field];
    const lockValue = locked?.[field];
    if (
      !isNonEmptyString(manifestValue) ||
      !isNonEmptyString(lockValue) ||
      manifestValue !== lockValue
    )
      problems.push(problem(workspace, field, manifestValue, lockValue));
  }
}

/**
 * Pure workspace-manifest validation. npm does not compare these package-lock
 * metadata fields during `npm ci`; keeping it separate from peer checking is
 * deliberate. It does not try to reimplement npm's external or transitive
 * dependency resolution -- only explicit workspace-to-workspace metadata.
 */
export function findWorkspaceMetadataProblems({ lock, manifest, workspaces }) {
  const problems = [];
  const rootManifest = isRecord(manifest) ? manifest : undefined;
  const packages = isRecord(lock?.packages) ? lock.packages : undefined;
  if (!rootManifest) {
    problems.push(problem(ROOT_WORKSPACE, 'manifest', manifest, undefined));
    return problems;
  }
  if (!packages)
    problems.push(
      problem(ROOT_WORKSPACE, 'packages', undefined, lock?.packages),
    );

  const rootLocked = packages?.[LOCK_ROOT_PATH];
  if (!isRecord(rootLocked))
    problems.push(problem(ROOT_WORKSPACE, 'lockEntry', 'required', rootLocked));

  const manifestWorkspaces = workspaceList(rootManifest.workspaces, 'manifest');
  const lockWorkspaces = workspaceList(rootLocked?.workspaces, 'lock');
  problems.push(...manifestWorkspaces.problems, ...lockWorkspaces.problems);
  if (
    manifestWorkspaces.problems.length === 0 &&
    lockWorkspaces.problems.length === 0 &&
    !sameSet(manifestWorkspaces.paths, lockWorkspaces.paths)
  )
    problems.push(
      problem(
        ROOT_WORKSPACE,
        'workspaces',
        [...manifestWorkspaces.paths].sort(),
        [...lockWorkspaces.paths].sort(),
      ),
    );

  const entries = [
    { workspace: ROOT_WORKSPACE, manifest: rootManifest, locked: rootLocked },
    ...manifestWorkspaces.paths.map((workspace) => ({
      workspace,
      manifest: workspaceManifest(workspaces, workspace),
      locked: packages?.[workspace],
    })),
  ];

  for (const entry of entries) {
    if (!isRecord(entry.manifest)) {
      problems.push(
        problem(entry.workspace, 'manifest', 'required', entry.manifest),
      );
    }
    if (!isRecord(entry.locked)) {
      // The root has already reported this, so do not print it twice.
      if (entry.workspace !== ROOT_WORKSPACE)
        problems.push(
          problem(entry.workspace, 'lockEntry', 'required', entry.locked),
        );
    }
    if (!isRecord(entry.manifest) || !isRecord(entry.locked)) continue;
    exactPackageFields(problems, entry.workspace, entry.manifest, entry.locked);
  }

  // A duplicate package name makes every edge aimed at that name ambiguous.
  // Report the duplicate rather than guessing which lock entry it should use.
  for (const side of ['manifest', 'locked']) {
    const byName = new Map();
    for (const entry of entries) {
      if (!isRecord(entry[side]) || !isNonEmptyString(entry[side].name))
        continue;
      const previous = byName.get(entry[side].name);
      if (previous) {
        problems.push(
          problem(
            entry.workspace,
            'name',
            side === 'manifest' ? entry[side].name : 'duplicate name',
            side === 'locked' ? entry[side].name : 'duplicate name',
          ),
        );
      } else byName.set(entry[side].name, entry.workspace);
    }
  }

  const internalNames = new Set();
  const nameCounts = new Map();
  for (const entry of entries.slice(1)) {
    if (!isRecord(entry.manifest) || !isNonEmptyString(entry.manifest.name))
      continue;
    nameCounts.set(
      entry.manifest.name,
      (nameCounts.get(entry.manifest.name) ?? 0) + 1,
    );
  }
  for (const [name, count] of nameCounts)
    if (count === 1) internalNames.add(name);

  for (const entry of entries) {
    if (!isRecord(entry.manifest) || !isRecord(entry.locked)) continue;
    for (const field of DEP_FIELDS) {
      const manifestDependencies = dependencyMap(entry.manifest, field);
      const lockDependencies = dependencyMap(entry.locked, field);
      if (!manifestDependencies || !lockDependencies) {
        problems.push(
          problem(
            entry.workspace,
            field,
            entry.manifest[field],
            entry.locked[field],
          ),
        );
        continue;
      }
      for (const name of [...internalNames].sort()) {
        const manifestValue = manifestDependencies[name];
        const lockValue = lockDependencies[name];
        if (
          manifestValue === lockValue &&
          (manifestValue === undefined || typeof manifestValue === 'string')
        )
          continue;
        problems.push(
          problem(
            entry.workspace,
            `${field}.${name}`,
            manifestValue,
            lockValue,
          ),
        );
      }
    }
  }

  return problems.sort(compareProblems);
}

export function isPathWithinRoot(
  root,
  target,
  pathOps = DEFAULT_PATH_OPERATIONS,
) {
  const pathFromRoot = pathOps.relative(root, target);
  return (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${pathOps.sep}`) &&
    !pathOps.isAbsolute(pathFromRoot)
  );
}

export function loadWorkspaceMetadata(
  root = process.cwd(),
  { readFile = readFileSync, pathOps = DEFAULT_PATH_OPERATIONS } = {},
) {
  const rootPath = pathOps.resolve(root);
  const manifest = JSON.parse(
    readFile(pathOps.join(rootPath, 'package.json'), 'utf8'),
  );
  const lock = JSON.parse(
    readFile(pathOps.join(rootPath, 'package-lock.json'), 'utf8'),
  );
  const declared = isRecord(manifest)
    ? workspaceList(manifest.workspaces, 'manifest').paths
    : [];
  const workspaces = {};
  for (const workspace of declared) {
    const manifestPath = pathOps.resolve(rootPath, workspace, 'package.json');
    // `workspaceList` rejects absolute/traversal paths; keep this assertion at
    // the filesystem seam so a future relaxation cannot turn this gate into a
    // reader outside the release tree.
    if (!isPathWithinRoot(rootPath, manifestPath, pathOps)) continue;
    try {
      workspaces[workspace] = JSON.parse(readFile(manifestPath, 'utf8'));
    } catch {
      workspaces[workspace] = undefined;
    }
  }
  return { lock, manifest, workspaces };
}

/** Matches pnpm 11.25's @pnpm/crypto.object-hasher contract. The checksum
 * is object-hash serialization, not JSON hashing; key/array order is ignored. */
export function pnpmPackageExtensionsChecksum(extensions) {
  if (!extensions || Object.keys(extensions).length === 0) return undefined;
  const objectHash = createRequire(import.meta.url)('object-hash');
  return `sha256-${objectHash(extensions, {
    respectType: false,
    algorithm: 'sha256',
    encoding: 'base64',
    unorderedArrays: true,
    unorderedObjects: true,
    unorderedSets: true,
  })}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

/** PNPM v9 importer specifiers and peer-qualified snapshots are distinct:
 * importer ownership determines manifest parity; snapshots determine peers. */
export function findPnpmLockProblems({
  lock,
  manifests,
  config,
  patchHashes = {},
}) {
  const problems = [];
  const report = (workspace, field, expected, actual) =>
    problems.push(problem(workspace, field, expected, actual));
  const equal = (a, b) =>
    JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  if (
    !equal(
      Object.keys(manifests).sort(),
      Object.keys(lock.importers ?? {}).sort(),
    )
  )
    report(
      '.',
      'importers',
      Object.keys(manifests).sort(),
      Object.keys(lock.importers ?? {}).sort(),
    );
  const extensionsChecksum = pnpmPackageExtensionsChecksum(
    config.packageExtensions,
  );
  if (extensionsChecksum !== lock.packageExtensionsChecksum)
    report(
      '.',
      'packageExtensionsChecksum',
      extensionsChecksum,
      lock.packageExtensionsChecksum,
    );
  for (const [workspace, manifest] of Object.entries(manifests)) {
    const importer = lock.importers?.[workspace];
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ]) {
      const autoPeers =
        field === 'dependencies' && (config.autoInstallPeers ?? true)
          ? Object.fromEntries(
              Object.entries(manifest.peerDependencies ?? {}).filter(
                ([name]) =>
                  !manifest.devDependencies?.[name] &&
                  !manifest.optionalDependencies?.[name],
              ),
            )
          : {};
      const declared = { ...autoPeers, ...(manifest[field] ?? {}) };
      const locked = importer?.[field] ?? {};
      for (const name of new Set([
        ...Object.keys(declared),
        ...Object.keys(locked),
      ])) {
        if (declared[name] !== locked[name]?.specifier)
          report(
            workspace,
            `${field}.${name}.specifier`,
            declared[name],
            locked[name]?.specifier,
          );
        const version = locked[name]?.version;
        if (typeof version !== 'string') {
          report(
            workspace,
            `${field}.${name}.version`,
            'resolved version',
            version,
          );
          continue;
        }
        if (version.startsWith('link:')) {
          const target = relative(
            '/',
            resolve('/', workspace, version.slice(5)),
          )
            .split('\\')
            .join('/');
          if (!manifests[target])
            report(
              workspace,
              `${field}.${name}.link`,
              'declared workspace',
              target,
            );
          continue;
        }
        const key =
          version.startsWith(`${name}@`) ||
          /^(?:@[^/]+\/)?[^@(]+@\d/.test(version)
            ? version
            : `${name}@${version}`;
        if (!lock.snapshots?.[key])
          report(workspace, `${field}.${name}.snapshot`, key, undefined);
      }
    }
  }
  if (!equal(config.overrides ?? {}, lock.overrides ?? {}))
    report('.', 'overrides', config.overrides ?? {}, lock.overrides ?? {});
  for (const [key, fallback] of [
    ['autoInstallPeers', true],
    ['excludeLinksFromLockfile', false],
    ['injectWorkspacePackages', false],
  ]) {
    if ((config[key] ?? fallback) !== (lock.settings?.[key] ?? fallback))
      report(
        '.',
        `settings.${key}`,
        config[key] ?? fallback,
        lock.settings?.[key],
      );
  }
  if (!equal(patchHashes, lock.patchedDependencies ?? {}))
    report(
      '.',
      'patchedDependencies',
      patchHashes,
      lock.patchedDependencies ?? {},
    );
  for (const [snapshotKey, snapshot] of Object.entries(lock.snapshots ?? {})) {
    const packageKey = snapshotKey.replace(/\(.*$/, '');
    const metadata = lock.packages?.[packageKey];
    if (!metadata) {
      report('.', 'package metadata', packageKey, undefined);
      continue;
    }
    const dependent = packageKey.slice(0, packageKey.lastIndexOf('@'));
    for (const [name, range] of Object.entries(
      metadata.peerDependencies ?? {},
    )) {
      const ref =
        snapshot.dependencies?.[name] ?? snapshot.optionalDependencies?.[name];
      if (!ref && metadata.peerDependenciesMeta?.[name]?.optional) continue;
      if (!ref) {
        report(snapshotKey, `peer.${name}`, range, undefined);
        continue;
      }
      const peerKey = `${name}@${ref}`;
      if (!lock.snapshots?.[peerKey])
        report(snapshotKey, `peer.${name}.snapshot`, peerKey, undefined);
      const version = ref
        .replace(/\(.*$/, '')
        .replace(/^(?:@[^/]+\/)?[^@]+@(\d.*)$/, '$1');
      const override =
        config.overrides?.[`${dependent}>${name}`] ?? config.overrides?.[name];
      const allowed =
        config.peerDependencyRules?.allowedVersions?.[`${dependent}>${name}`] ??
        config.peerDependencyRules?.allowedVersions?.[name];
      if (
        !semver.satisfies(version, override ?? allowed ?? range, {
          loose: true,
        })
      )
        report(
          snapshotKey,
          `peer.${name}`,
          override ?? allowed ?? range,
          version,
        );
    }
  }
  return problems.sort(compareProblems);
}

export function checkPnpmLockfile(root = process.cwd()) {
  const lock = readPnpmLockfile(root);
  const config = readPnpmWorkspace(root);
  const manifests = {
    '.': JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
  };
  for (const { directory } of listWorkspacePackageManifests(root))
    manifests[relative(root, directory).split('\\').join('/')] = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    );
  const patchHashes = {};
  for (const [name, path] of Object.entries(config.patchedDependencies ?? {})) {
    if (
      typeof path !== 'string' ||
      !isPathWithinRoot(resolve(root), resolve(root, path))
    )
      throw new Error(`invalid patch path for ${name}`);
    patchHashes[name] = createHash('sha256')
      .update(readFileSync(resolve(root, path)))
      .digest('hex');
  }
  const competingLocks = Object.keys(manifests)
    .filter((workspace) =>
      existsSync(join(root, workspace, 'package-lock.json')),
    )
    .map((workspace) =>
      problem(
        workspace,
        'package-lock.json',
        'absent: pnpm-lock.yaml is the dependency authority',
        'competing npm lockfile',
      ),
    );
  return [
    ...competingLocks,
    ...findPnpmLockProblems({ lock, config, manifests, patchHashes }),
  ].sort(compareProblems);
}

function main() {
  if (isPnpmRepository(process.cwd())) {
    try {
      const problems = checkPnpmLockfile();
      for (const entry of problems)
        console.error(
          `${entry.workspace} ${entry.field}: manifest=${printable(entry.manifestValue)} lock=${printable(entry.lockValue)}`,
        );
      if (problems.length) process.exitCode = 1;
      else
        console.log(
          'Lockfile sync gate: pnpm importers, settings, patches, and resolved peer snapshots agree.',
        );
    } catch (error) {
      console.error(`Lockfile sync gate: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  const { lock, manifest, workspaces } = loadWorkspaceMetadata();
  const { missing, unsatisfiable } = findPeerProblems({ lock, manifest });
  const workspaceProblems = findWorkspaceMetadataProblems({
    lock,
    manifest,
    workspaces,
  });

  // Both classes are reported before exiting. Exiting on the first one sends a
  // fixer round-tripping: they resolve what printed, rerun, and only then
  // discover the second failure that was present all along.
  if (unsatisfiable.length > 0) {
    console.error(
      'package.json declares peer ranges that the locked tree cannot satisfy.\n' +
        '`npm ci` still works (it never re-resolves), but `npm install` — and so\n' +
        'adding or updating ANY dependency — will fail with ERESOLVE.\n\n' +
        'Fix by upgrading the dependent, or by overriding its stale peer to the\n' +
        "root's version, e.g.:\n" +
        '  "overrides": { "<dependent>": { "<peer>": "$<peer>" } }\n',
    );
    for (const { name, range, locked, dependent } of unsatisfiable) {
      console.error(`  ${dependent} wants ${name}@${range}, locked ${locked}`);
    }
  }

  if (missing.length > 0) {
    if (unsatisfiable.length > 0) console.error('');
    console.error(
      'package-lock.json is missing required peer dependencies. `npm ci` will\n' +
        'fail on a clean checkout. Regenerate with:\n\n' +
        '  npm install --package-lock-only --force\n',
    );
    for (const { name, requiredBy } of missing) {
      console.error(`  missing: ${name}  (peer of ${requiredBy})`);
    }
  }

  if (workspaceProblems.length) {
    console.error('package-lock workspace metadata is stale.');
    for (const workspaceProblem of workspaceProblems) {
      const workspace =
        workspaceProblem.workspace === ROOT_WORKSPACE
          ? 'root'
          : workspaceProblem.workspace;
      console.error(
        `  ${workspace} ${workspaceProblem.field}: manifest=${printable(workspaceProblem.manifestValue)} lock=${printable(workspaceProblem.lockValue)}`,
      );
    }
  }
  if (
    unsatisfiable.length > 0 ||
    missing.length > 0 ||
    workspaceProblems.length
  )
    process.exit(1);

  const lockedCount = Object.keys(lock.packages ?? {}).length;
  console.log(
    `Lockfile sync gate: ${lockedCount} locked packages, all required peers present and every declared peer range satisfiable.`,
  );
}

// Importable for tests without running the gate against the real repo files;
// still runs normally when invoked as a script. station#1805 review: this call
// site's form is the canonical one, now shared rather than duplicated.
if (invokedDirectly(import.meta.url)) main();
