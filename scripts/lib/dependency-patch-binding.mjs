import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pnpmDependencyGraph } from './pnpm-dependency-graph.mjs';
import { readPnpmLockfile, readPnpmWorkspace } from './pnpm-lockfile.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const CORE_FILES = ['src/sprintf.js', 'dist/sprintf.min.js'];
const FIELDS = new Set([
  'schemaVersion',
  'package',
  'version',
  'patchPath',
  'patchSha256',
  'installedEntrypoints',
  'nodeMajor',
]);

function refuse(reason) {
  throw new Error(`patch binding refused: ${reason}`);
}

function safePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

export function requiresDependencyPatchBinding(residual) {
  return (
    residual.scope === 'root' &&
    residual.package === 'sprintf-js' &&
    residual.version === '1.0.3' &&
    residual.advisory === 'GHSA-hp3w-g68c-fv3c'
  );
}

/** This binding admits only the reviewed formatter remediation, not other patches. */
export function validateDependencyPatchBinding(residual) {
  const b = residual.patchBinding;
  if (!b || typeof b !== 'object' || Array.isArray(b))
    refuse('missing binding');
  if (Object.keys(b).some((key) => !FIELDS.has(key)))
    refuse('unknown binding field');
  if (
    residual.scope !== 'root' ||
    residual.package !== 'sprintf-js' ||
    residual.version !== '1.0.3' ||
    residual.advisory !== 'GHSA-hp3w-g68c-fv3c' ||
    residual.severity !== 'moderate' ||
    residual.reachability !== 'production' ||
    b.schemaVersion !== 1 ||
    b.package !== residual.package ||
    b.version !== residual.version ||
    b.nodeMajor !== 24
  )
    refuse('unsupported identity');
  if (
    !safePath(b.patchPath) ||
    typeof b.patchSha256 !== 'string' ||
    !SHA256.test(b.patchSha256)
  )
    refuse('invalid patch identity');
  if (
    !Array.isArray(b.installedEntrypoints) ||
    !b.installedEntrypoints.length ||
    b.installedEntrypoints.length > 128
  )
    refuse('missing entrypoint evidence');
  const paths = new Set();
  for (const entry of b.installedEntrypoints) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !['path', 'sha256'].includes(key)) ||
      !safePath(entry.path) ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256) ||
      paths.has(entry.path)
    )
      refuse('invalid or duplicate entrypoint evidence');
    paths.add(entry.path);
  }
  return b;
}

function confined(root, path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel))
    refuse('path outside repository');
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) refuse('redirected evidence path');
  }
  return path;
}

function bytes(root, path, limit = 4 * 1024 * 1024) {
  confined(root, path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit)
    refuse('non-file or oversized evidence');
  const content = readFileSync(path);
  if (content.length > limit) refuse('oversized evidence');
  return content;
}

function json(root, path) {
  return JSON.parse(bytes(root, path, 1024 * 1024).toString('utf8'));
}

function installedInstances(root, lock, name, version) {
  const importerRoots = new Set(
    Object.keys(lock.importers).map((p) => resolve(root, p)),
  );
  const seen = new Set();
  const found = [];
  let count = 0;
  let entries = 0;
  function scan(directory, modules = false, depth = 0) {
    if (++count > 50000 || depth > 64)
      refuse('installed inventory bound exceeded');
    let stat;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    confined(root, directory);
    if (!stat.isDirectory()) refuse('invalid installed directory');
    if (seen.has(directory)) return;
    seen.add(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 500000)
        refuse('installed inventory entry bound exceeded');
      const child = join(directory, entry.name);
      if (
        modules &&
        [name, `${name}.js`, `${name}.json`, `${name}.node`].includes(
          entry.name.toLowerCase(),
        ) &&
        !entry.isDirectory()
      )
        refuse('unaccounted module file shadow');
      if (entry.isSymbolicLink()) {
        const target = realpathSync(child);
        if (
          modules &&
          importerRoots.has(target) &&
          json(root, join(target, 'package.json')).name !== name &&
          entry.name !== name
        )
          continue;
        confined(root, target);
        if (lstatSync(target).isFile()) continue;
        refuse('unaccounted linked dependency');
      }
      if (!entry.isDirectory()) continue;
      if (modules && entry.name.startsWith('@')) {
        scan(child, true, depth + 1);
        continue;
      }
      if (modules && !entry.name.startsWith('.')) {
        let manifest;
        try {
          manifest = json(root, join(child, 'package.json'));
        } catch (error) {
          if (error.code !== 'ENOENT' || entry.name.toLowerCase() === name)
            throw error;
          scan(child, false, depth + 1);
          continue;
        }
        if (
          entry.name.toLowerCase() === name &&
          (manifest.name !== name || manifest.version !== version)
        )
          refuse('installed package identity changed');
        if (manifest.name === name && manifest.version === version)
          found.push(child);
      }
      // A require from lib/help also searches lib/help/node_modules, not just the package root.
      scan(child, entry.name.toLowerCase() === 'node_modules', depth + 1);
    }
  }
  for (const importer of importerRoots) {
    if (importer !== root) confined(root, importer);
    scan(join(importer, 'node_modules'), true);
  }
  return found;
}

/** Re-read observed graph and bytes at acceptance; no external verification receipt is trusted. */
export function verifyDependencyPatchBinding(root, residual) {
  root = realpathSync(root);
  const b = validateDependencyPatchBinding(residual);
  if (Number(process.versions.node.split('.')[0]) !== b.nodeMajor)
    refuse('runtime changed');
  const workspace = readPnpmWorkspace(root);
  const lock = readPnpmLockfile(root);
  if (workspace.nodeLinker !== 'hoisted')
    refuse('unsupported installed layout');
  const key = `${b.package}@${b.version}`;
  if (
    workspace.patchedDependencies?.[key] !== b.patchPath ||
    lock.patchedDependencies?.[key] !== b.patchSha256
  )
    refuse('workspace or lock binding mismatch');
  const patchHash = createHash('sha256')
    .update(bytes(root, resolve(root, b.patchPath)))
    .digest('hex');
  if (patchHash !== b.patchSha256) refuse('patch bytes changed');
  const graph = pnpmDependencyGraph(lock);
  const selected = graph.workspaceClosure(true);
  const targets = [...graph.nodes.values()].filter(
    (node) =>
      !node.importer && node.name === b.package && node.version === b.version,
  );
  if (
    !targets.length ||
    !targets.some((node) => selected.has(node.id)) ||
    targets.some((node) => !node.id.includes(`(patch_hash=${b.patchSha256})`))
  )
    refuse('unpatched or absent locked package');
  // Traverse every edge, including non-production edges, to refuse a dangling/unpatched alias.
  for (const node of graph.nodes.values()) graph.dependencies(node, false);
  const instances = installedInstances(root, lock, b.package, b.version);
  if (!instances.length) refuse('installed package missing');
  const expected = new Map(
    b.installedEntrypoints.map((entry) => [entry.path, entry.sha256]),
  );
  const consumed = new Set();
  for (const directory of instances) {
    const manifest = json(root, join(directory, 'package.json'));
    if (manifest.main !== CORE_FILES[0] || manifest.exports || manifest.browser)
      refuse('runtime entrypoint contract changed');
    for (const file of CORE_FILES) {
      const path = join(directory, file);
      const rel = relative(root, path).split(sep).join('/');
      const digest = expected.get(rel);
      if (!digest) refuse('unaccounted installed copy or entrypoint');
      if (
        createHash('sha256').update(bytes(root, path)).digest('hex') !== digest
      )
        refuse('installed entrypoint bytes changed');
      consumed.add(rel);
    }
  }
  if (consumed.size !== expected.size) refuse('unobserved entrypoint evidence');
  return {
    patchHash,
    instances: instances.map((p) => relative(root, p).split(sep).join('/')),
  };
}
