import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import semver from 'semver';
import { readPnpmWorkspace } from './pnpm-lockfile.mjs';

const targets = new Set([
  'glob',
  'test-exclude',
  'minimatch',
  'brace-expansion',
]);

/** Inspect installed bytes and Node's ancestor lookup, without npm's Arborist
 * reconstruction of a pnpm tree. This is deliberately the remediation family,
 * not a general package-manager implementation or a lockfile audit. */
export function validateInstalledRemediationGraph(root) {
  root = realpathSync(root);
  const workspace = readPnpmWorkspace(root);
  if (workspace.nodeLinker !== 'hoisted')
    throw new Error(
      'Remediation validation requires the reviewed hoisted layout',
    );
  const manifests = new Map();
  const scanned = new Set();
  const read = (directory) => {
    const physical = realpathSync(directory);
    if (!manifests.has(physical)) {
      manifests.set(
        physical,
        JSON.parse(readFileSync(join(physical, 'package.json'), 'utf8')),
      );
    }
    return physical;
  };
  function scan(directory) {
    if (!existsSync(directory)) return;
    const physical = realpathSync(directory);
    if (scanned.has(physical)) return;
    scanned.add(physical);
    for (const entry of readdirSync(physical, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = join(physical, entry.name);
      if (entry.name.startsWith('@')) scan(child);
      else {
        const packageRoot = read(child);
        scan(join(packageRoot, 'node_modules'));
      }
    }
  }
  const importers = new Set();
  for (const importer of ['.', ...workspace.packages]) {
    const directory = read(resolve(root, importer));
    importers.add(directory);
    scan(join(directory, 'node_modules'));
  }
  function lookup(directory, name) {
    for (;;) {
      // Match Node's NODE_MODULES_PATHS: never append node_modules to itself.
      if (basename(directory) !== 'node_modules') {
        const candidate = join(directory, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) return read(candidate);
      }
      if (directory === root || dirname(directory) === directory) return null;
      directory = dirname(directory);
    }
  }
  const checked = [];
  for (const [directory, parent] of manifests) {
    const dependencies = {
      ...parent.dependencies,
      ...(importers.has(directory) ? parent.devDependencies : {}),
      ...parent.optionalDependencies,
    };
    for (const [name, declared] of Object.entries(dependencies)) {
      if (!targets.has(name) && !targets.has(parent.name)) continue;
      const childRoot = lookup(directory, name);
      if (!childRoot) {
        if (Object.hasOwn(parent.optionalDependencies ?? {}, name)) continue;
        throw new Error(
          `Missing installed dependency: ${parent.name} -> ${name}`,
        );
      }
      const child = manifests.get(childRoot);
      // The reviewed major-version override is intentional. Every other edge
      // must retain its upstream semver contract, including older minimatches.
      const range =
        parent.name === 'minimatch' &&
        semver.satisfies(parent.version, '^10.0.0') &&
        name === 'brace-expansion'
          ? workspace.overrides['minimatch@^10.0.0>brace-expansion']
          : declared;
      if (
        child.name !== name ||
        !semver.validRange(range) ||
        !semver.satisfies(child.version, range)
      ) {
        throw new Error(
          `Invalid installed dependency: ${parent.name}@${parent.version} -> ${name}@${child.version}; expected ${range}`,
        );
      }
      if (
        name === 'brace-expansion' &&
        semver.satisfies(child.version, '^2.0.0') &&
        !semver.satisfies(
          child.version,
          workspace.overrides['brace-expansion@^2.0.2'],
        )
      ) {
        throw new Error(
          `Unremediated installed brace-expansion: ${child.version}`,
        );
      }
      checked.push({
        parent: parent.name,
        name,
        version: child.version,
        directory: childRoot,
      });
    }
  }
  for (const name of ['glob', 'minimatch', 'brace-expansion']) {
    if (!checked.some((edge) => edge.name === name))
      throw new Error(`Missing remediation family: ${name}`);
  }
  return checked;
}
