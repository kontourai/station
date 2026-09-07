#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { npmPurl } from './lib/dependency-lifecycle-policy.mjs';
import {
  pnpmImporterManifest,
  readPnpmDependencyGraph,
} from './lib/pnpm-dependency-graph.mjs';
import { canonicalJson } from './lib/release-sboms.mjs';

/** Tarball integrity describes the package archive, never a fabricated file hash. */
export function integrityHashes(integrity) {
  if (integrity === undefined) return [];
  if (typeof integrity !== 'string')
    throw new Error('Invalid package integrity');
  const hashes = new Map();
  for (const token of integrity.split(/\s+/)) {
    const match = /^(sha256|sha512)-(.+)$/.exec(token);
    if (!match) continue;
    const bytes = Buffer.from(match[2], 'base64');
    const length = match[1] === 'sha512' ? 64 : 32;
    if (bytes.length !== length || bytes.toString('base64') !== match[2])
      throw new Error('Invalid package integrity digest');
    const alg = length === 64 ? 'SHA-512' : 'SHA-256';
    const content = bytes.toString('hex');
    if (hashes.has(alg) && hashes.get(alg) !== content)
      throw new Error('Conflicting package integrity digests');
    hashes.set(alg, content);
  }
  return [...hashes]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alg, content]) => ({ alg, content }));
}

/** Produce the exact production graph, including optional cross-platform packages. */
export function createPnpmSbom({ graph, manifestForImporter }) {
  const selected = graph.workspaceClosure(true);
  const identities = new Map();
  const components = new Map();
  for (const id of selected) {
    const node = graph.nodes.get(id);
    const manifest = node.importer ? manifestForImporter(node.path) : node;
    if (
      typeof manifest?.name !== 'string' ||
      typeof manifest?.version !== 'string'
    )
      throw new Error(`Missing SBOM package identity: ${id}`);
    const purl = npmPurl(manifest.name, manifest.version);
    identities.set(id, purl);
    const hashes = node.importer
      ? []
      : integrityHashes(node.meta.resolution?.integrity);
    const patch = /\(patch_hash=([a-f0-9]{64})\)/.exec(id)?.[1];
    const component = {
      type: id === 'importer:.' ? 'application' : 'library',
      'bom-ref': purl,
      name: manifest.name,
      version: manifest.version,
      purl,
      ...(hashes.length ? { hashes } : {}),
      ...(patch
        ? { properties: [{ name: 'station:pnpm-patch-hash', value: patch }] }
        : {}),
    };
    if (
      components.has(purl) &&
      canonicalJson(components.get(purl)) !== canonicalJson(component)
    )
      throw new Error(`Conflicting SBOM package identity: ${purl}`);
    components.set(purl, component);
  }
  // Peer-qualified instances share an archive identity; union their edges.
  const edges = new Map();
  for (const id of selected) {
    const ref = identities.get(id);
    if (!edges.has(ref)) edges.set(ref, new Set());
    for (const child of graph.dependencies(graph.nodes.get(id), true)) {
      const target = identities.get(child);
      if (!target)
        throw new Error(`Incomplete production SBOM graph: ${child}`);
      if (target !== ref) edges.get(ref).add(target);
    }
  }
  const root = identities.get('importer:.');
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: { component: components.get(root) },
    components: [...components]
      .filter(([purl]) => purl !== root)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, component]) => component),
    dependencies: [...edges]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ref, targets]) => ({ ref, dependsOn: [...targets].sort() })),
  };
}

export function generatePnpmSbom(root) {
  return createPnpmSbom({
    graph: readPnpmDependencyGraph(root),
    manifestForImporter: (importer) => pnpmImporterManifest(root, importer),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const index = process.argv.indexOf('--output-file');
    if (index < 0 || !process.argv[index + 1])
      throw new Error('Missing --output-file');
    writeFileSync(
      resolve(process.argv[index + 1]),
      canonicalJson(generatePnpmSbom(process.cwd())),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
