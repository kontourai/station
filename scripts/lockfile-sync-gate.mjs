#!/usr/bin/env node
/**
 * Fails when pnpm-lock.yaml importers, resolved peers, patches, or settings
 * disagree with workspace manifests and pnpm-workspace.yaml.
 *
 * A frozen install refuses an out-of-sync lock, so a stale lock breaks
 * clean-checkout installs on every surface: the container image, the desktop
 * clean-checkout build, Android, iOS, the portable server bundle, and any
 * fresh dev machine. Nothing catches it locally, because a working tree that
 * already has node_modules never runs a frozen install.
 *
 * It also reports a resolved peer whose version falls outside the declared
 * range (or its override). That shape made dependency updates impossible on
 * main for an unknown stretch (archive#1233) while frozen installs stayed green.
 *
 * This is a pure lock-vs-manifest check. No network.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import semver from 'semver';
import { invokedDirectly } from './lib/module-entry.mjs';
import { readPnpmLockfile, readPnpmWorkspace } from './lib/pnpm-lockfile.mjs';
import { listWorkspacePackageManifests } from './workspace-dependency-provenance.mjs';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function isPathWithinRoot(root, target) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
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
}

// Importable for tests without running the gate against the real repo files;
// still runs normally when invoked as a script. station#1805 review: this call
// site's form is the canonical one, now shared rather than duplicated.
if (invokedDirectly(import.meta.url)) main();
