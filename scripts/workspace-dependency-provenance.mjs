import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  const patterns = Array.isArray(declared)
    ? declared
    : Array.isArray(declared?.packages)
      ? declared.packages
      : null;
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

/**
 * Resolves each local package exactly as Node would from the active root and
 * rejects a package whose resolved source lives in another checkout. A plain
 * node_modules path check is insufficient because workspace links can be
 * relative to a dependency-owning sibling checkout.
 */
export function assertWorkspacePackageProvenance({
  cwd = process.cwd(),
  repositoryRoot = activeWorktree(cwd),
  resolvePackage,
} = {}) {
  const root = realpathSync(repositoryRoot);
  const resolver = createRequire(join(root, 'package.json'));
  const packages = listWorkspacePackageManifests(root);
  const resolved = packages.map(({ name, directory }) => {
    let entryPath;
    try {
      entryPath = resolvePackage
        ? resolvePackage(name)
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
            `workspace dependency provenance could not resolve ${name} from ${root}: ${manifestError instanceof Error ? manifestError.message : String(manifestError)} (package entry resolution: ${entryError instanceof Error ? entryError.message : String(entryError)})`,
          );
      }
    }
    const packageRoot = resolvedPackageRoot(entryPath, name);
    if (!isInside(root, packageRoot))
      throw new Error(
        `workspace dependency provenance rejected ${name}: Node resolved ${packageRoot} outside the active worktree ${root}`,
      );
    return {
      name,
      declaredRoot: directory,
      resolvedEntry: realpathSync(entryPath),
      resolvedRoot: packageRoot,
    };
  });
  return { repositoryRoot: root, packages: resolved };
}
