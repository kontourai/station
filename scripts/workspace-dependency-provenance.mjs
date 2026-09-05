import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readPnpmWorkspace } from './lib/pnpm-lockfile.mjs';
import { declaredDependencies } from './lib/workspace-dependency-satisfaction.mjs';

export function isPnpmRepository(root) {
  const manifestPath = join(root, 'package.json');
  const manager = existsSync(manifestPath)
    ? readJson(manifestPath).packageManager
    : '';
  return (
    manager?.startsWith('pnpm@') ||
    existsSync(join(root, 'pnpm-workspace.yaml')) ||
    existsSync(join(root, 'pnpm-lock.yaml'))
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `workspace dependency provenance could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isInside(root, target) {
  const relation = relative(root, target);
  return (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== '..' &&
      !isAbsolute(relation))
  );
}

function activeWorktree(cwd) {
  const raw = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (!raw)
    throw new Error(
      'workspace dependency provenance could not find a Git worktree root',
    );
  return realpathSync(resolve(cwd, raw));
}

/**
 * Expand the deliberately narrow workspace shapes this repository declares.
 * An unknown shape fails closed: silently omitting a package would reintroduce
 * the provenance gap this preflight closes.
 */
export function listWorkspacePackageManifests(repositoryRoot) {
  const root = realpathSync(repositoryRoot);
  const rootManifest = readJson(join(root, 'package.json'));
  const declared = rootManifest.workspaces;
  let patterns = Array.isArray(declared)
    ? declared
    : Array.isArray(declared?.packages)
      ? declared.packages
      : null;
  if (isPnpmRepository(root)) {
    const configured = readPnpmWorkspace(root).packages;
    if (
      !Array.isArray(configured) ||
      configured.some((item) => typeof item !== 'string')
    )
      throw new Error(
        'workspace dependency provenance requires pnpm workspace packages',
      );
    if (
      JSON.stringify([...configured].sort()) !==
      JSON.stringify([...(patterns ?? [])].sort())
    )
      throw new Error(
        'workspace dependency provenance requires package.json workspaces to match pnpm-workspace.yaml packages',
      );
    patterns = configured;
  }
  if (!patterns?.length)
    throw new Error(
      'workspace dependency provenance found no declared workspaces',
    );

  const packages = [];
  const add = (directory) => {
    const declaredRoot = realpathSync(directory);
    if (!isInside(root, declaredRoot))
      throw new Error(
        `workspace dependency provenance rejected declared workspace outside the active worktree: ${declaredRoot}`,
      );
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath))
      throw new Error(
        `workspace dependency provenance requires a package manifest: ${manifestPath}`,
      );
    const manifest = readJson(manifestPath);
    if (typeof manifest.name !== 'string' || manifest.name.length === 0)
      throw new Error(
        `workspace dependency provenance requires a package name: ${manifestPath}`,
      );
    packages.push({ name: manifest.name, directory: declaredRoot });
  };

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern)
      throw new Error(
        'workspace dependency provenance requires string workspace patterns',
      );
    if (!pattern.includes('*')) {
      add(join(root, pattern));
      continue;
    }
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*'))
      throw new Error(
        `workspace dependency provenance does not support workspace pattern ${JSON.stringify(pattern)}`,
      );
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent))
      throw new Error(
        `workspace dependency provenance requires workspace directory: ${parent}`,
      );
    for (const entry of readdirSync(parent, { withFileTypes: true }))
      if (entry.isDirectory() || entry.isSymbolicLink())
        add(join(parent, entry.name));
  }
  packages.sort((left, right) => left.name.localeCompare(right.name));
  return packages;
}

function resolvedPackageRoot(entryPath, packageName) {
  let current = dirname(realpathSync(entryPath));
  while (dirname(current) !== current) {
    const manifestPath = join(current, 'package.json');
    if (existsSync(manifestPath) && readJson(manifestPath).name === packageName)
      return current;
    current = dirname(current);
  }
  throw new Error(
    `workspace dependency provenance could not find ${packageName}'s package root from Node resolution ${entryPath}`,
  );
}

function resolvePackageFromNodeLookupPaths(resolver, packageName) {
  const lookupPaths = resolver.resolve.paths(packageName) ?? [];
  for (const lookupPath of lookupPaths) {
    const candidate = join(lookupPath, packageName);
    const manifestPath = join(candidate, 'package.json');
    if (existsSync(manifestPath)) return manifestPath;
  }
  return null;
}

function assertWorkspaceTarget({
  root,
  packageRoot,
  directory,
  name,
  importer,
}) {
  if (!isInside(root, packageRoot))
    throw new Error(
      `workspace dependency provenance rejected ${name}: Node resolved ${packageRoot} outside the active worktree ${root}`,
    );
  if (packageRoot !== directory)
    throw new Error(
      `workspace dependency provenance rejected ${name}: Node resolved ${packageRoot} instead of declared workspace ${directory} from ${importer}`,
    );
}

/**
 * Validates every workspace's source ownership, then resolves each declared
 * local dependency from its importing package. PNPM does not create root
 * links for unreferenced workspace members. Legacy npm installs did.
 * Rejects resolution outside the declared workspace source directory. A plain
 * node_modules path check is insufficient because workspace links can be
 * relative to a dependency-owning sibling checkout.
 */
export function assertWorkspacePackageProvenance({
  cwd = process.cwd(),
  repositoryRoot = activeWorktree(cwd),
  resolvePackage,
} = {}) {
  const root = realpathSync(repositoryRoot);
  const packages = listWorkspacePackageManifests(root);
  const pnpm = isPnpmRepository(root);
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  if (byName.size !== packages.length)
    throw new Error(
      'workspace dependency provenance requires unique workspace package names',
    );
  const edges = pnpm
    ? [root, ...packages.map((entry) => entry.directory)].flatMap(
        (importer) => {
          const manifest = readJson(join(importer, 'package.json'));
          const dependencies = declaredDependencies(manifest);
          const declaredNames = new Set(
            dependencies.map((entry) => entry.name),
          );
          for (const name of Object.keys(manifest.peerDependencies ?? {}))
            if (!declaredNames.has(name))
              dependencies.push({
                name,
                optional:
                  manifest.peerDependenciesMeta?.[name]?.optional === true,
              });
          return dependencies
            .filter(({ name }) => byName.has(name))
            .map(({ name, optional }) => ({
              ...byName.get(name),
              importer,
              optional,
            }));
        },
      )
    : packages.map((entry) => ({ ...entry, importer: root, optional: false }));
  const resolved = edges.map(({ name, directory, importer, optional }) => {
    const resolver = createRequire(join(importer, 'package.json'));
    const installedManifest = resolvePackageFromNodeLookupPaths(resolver, name);
    if (optional && !installedManifest) return null;
    // Node caches entry resolution, including symlink realpaths. Inspect the
    // current link too so a dependency refresh cannot conceal a foreign link
    // behind an earlier healthy result in a long-lived verifier.
    if (installedManifest)
      assertWorkspaceTarget({
        root,
        packageRoot: resolvedPackageRoot(installedManifest, name),
        directory,
        name,
        importer,
      });
    let entryPath;
    try {
      entryPath = resolvePackage
        ? resolvePackage(name, importer)
        : resolver.resolve(name);
    } catch (entryError) {
      // A CLI-only workspace can deliberately publish no importable package
      // entry point. Resolve its manifest through the same Node resolver so
      // the dependency link is still proven without inventing an entry point.
      try {
        entryPath = resolver.resolve(`${name}/package.json`);
      } catch (manifestError) {
        const packageManifest = resolvePackageFromNodeLookupPaths(
          resolver,
          name,
        );
        if (packageManifest) entryPath = packageManifest;
        else
          throw new Error(
            `workspace dependency provenance could not resolve ${name} from ${importer}: ${manifestError instanceof Error ? manifestError.message : String(manifestError)} (package entry resolution: ${entryError instanceof Error ? entryError.message : String(entryError)})`,
          );
      }
    }
    const packageRoot = resolvedPackageRoot(entryPath, name);
    assertWorkspaceTarget({ root, packageRoot, directory, name, importer });
    return {
      name,
      ...(pnpm ? { importerRoot: importer } : {}),
      declaredRoot: directory,
      resolvedEntry: realpathSync(entryPath),
      resolvedRoot: packageRoot,
    };
  });
  return {
    repositoryRoot: root,
    packages: resolved.filter((entry) => entry !== null),
  };
}
