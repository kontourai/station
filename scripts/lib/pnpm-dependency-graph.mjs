import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { readPnpmLockfile } from './pnpm-lockfile.mjs';

/** Resolve the locked graph, independently of the installed/hoisted layout. */
export function pnpmDependencyGraph(lock) {
  if (!lock?.importers || !lock?.packages || !lock?.snapshots)
    throw new Error(
      'pnpm dependency graph requires importers, packages, and snapshots',
    );
  const nodes = new Map();
  for (const [key, snapshot] of Object.entries(lock.snapshots)) {
    const packageKey = key.replace(/\(.*/, '');
    const meta = lock.packages[packageKey];
    const split = packageKey.lastIndexOf('@');
    if (!meta || split <= 0)
      throw new Error(`Missing package metadata: ${key}`);
    nodes.set(key, {
      id: key,
      name: packageKey.slice(0, split),
      version: packageKey.slice(split + 1),
      meta,
      snapshot,
      importer: false,
    });
  }
  for (const [key, snapshot] of Object.entries(lock.importers)) {
    if (key !== '.' && (posix.isAbsolute(key) || key.split('/').includes('..')))
      throw new Error(`Invalid pnpm importer: ${key}`);
    nodes.set(`importer:${key}`, {
      id: `importer:${key}`,
      path: key,
      snapshot,
      importer: true,
    });
  }
  function target(parent, name, raw) {
    const version = typeof raw === 'string' ? raw : raw?.version;
    if (typeof version !== 'string')
      throw new Error(`Invalid reference: ${parent.id}:${name}`);
    let id;
    if (version.startsWith('link:')) {
      if (!parent.importer)
        throw new Error(`Unexpected linked package in ${parent.id}`);
      const linked = posix.normalize(posix.join(parent.path, version.slice(5)));
      if (
        linked === '..' ||
        linked.startsWith('../') ||
        posix.isAbsolute(linked)
      )
        throw new Error(`Escaping workspace link: ${parent.id}:${name}`);
      id = `importer:${linked}`;
    } else {
      id = nodes.has(`${name}@${version}`) ? `${name}@${version}` : version;
    }
    if (!nodes.has(id))
      throw new Error(
        `Unresolved dependency: ${parent.id}:${name} -> ${version}`,
      );
    return id;
  }
  function dependencies(node, productionOnly = true) {
    const source = {
      ...node.snapshot.dependencies,
      ...node.snapshot.optionalDependencies,
      ...(!productionOnly && node.importer
        ? node.snapshot.devDependencies
        : {}),
    };
    return [
      ...new Set(
        Object.entries(source).map(([name, raw]) => target(node, name, raw)),
      ),
    ].sort();
  }
  function closure(importer = '.', productionOnly = true) {
    const selected = new Set();
    function visit(id) {
      if (selected.has(id)) return;
      const node = nodes.get(id);
      if (!node) throw new Error(`Missing pnpm importer or package: ${id}`);
      selected.add(id);
      for (const child of dependencies(node, productionOnly)) visit(child);
    }
    visit(`importer:${importer}`);
    return selected;
  }
  function workspaceClosure(productionOnly = true) {
    const selected = new Set();
    for (const node of nodes.values()) {
      if (!node.importer) continue;
      for (const id of closure(node.path, productionOnly)) selected.add(id);
    }
    return selected;
  }
  return { nodes, dependencies, closure, workspaceClosure };
}

export function readPnpmDependencyGraph(root) {
  return pnpmDependencyGraph(readPnpmLockfile(root));
}

export function pnpmImporterManifest(root, importer) {
  if (
    importer !== '.' &&
    (posix.isAbsolute(importer) || importer.split('/').includes('..'))
  )
    throw new Error(`Invalid importer path: ${importer}`);
  return JSON.parse(
    readFileSync(resolve(root, importer, 'package.json'), 'utf8'),
  );
}
