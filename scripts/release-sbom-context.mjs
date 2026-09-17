#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  allowlistDigest,
  expectedLifecyclePurls,
  npmPurl,
} from './lib/dependency-lifecycle-policy.mjs';
import { readPnpmDependencyGraph } from './lib/pnpm-dependency-graph.mjs';
import { releaseVariants } from './lib/release-artifacts.mjs';
import { canonicalJson } from './lib/release-sboms.mjs';

const RELEASE_PLATFORM = 'linux';
const RELEASE_ARCH = 'x64';
const CONTAINER_PLATFORMS = [
  ['linux', 'x64'],
  ['linux', 'arm64'],
];

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

function platformMatches(packageMeta, platform, arch) {
  const matches = (values, value) =>
    !values?.length ||
    (!values.includes(`!${value}`) &&
      (!values.some((entry) => !entry.startsWith('!')) ||
        values.includes(value)));
  return matches(packageMeta.os, platform) && matches(packageMeta.cpu, arch);
}

function graphPurls(graph, platform, arch, productionOnly) {
  const selected = new Set();
  const purls = new Set();
  const visit = (id) => {
    if (selected.has(id)) return;
    const node = graph.nodes.get(id);
    if (!node) throw new Error(`Missing release dependency: ${id}`);
    if (!node.importer && !platformMatches(node.meta, platform, arch)) return;
    selected.add(id);
    if (!node.importer) purls.add(npmPurl(node.name, node.version));
    for (const child of graph.dependencies(node, productionOnly)) visit(child);
  };
  // The container copies the unpruned workspace installation, not just root
  // production dependencies. Every importer contributes its installed graph.
  for (const node of graph.nodes.values()) if (node.importer) visit(node.id);
  return purls;
}

function packagePath(lock, parent, name) {
  let current = parent;
  while (true) {
    const candidate = current
      ? `${current}/node_modules/${name}`
      : `node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!current) return null;
    const nested = current.lastIndexOf('/node_modules/');
    current = nested < 0 ? '' : current.slice(0, nested);
  }
}

function packageMetadata(lock, path) {
  const meta = lock.packages[path];
  if (!meta || typeof meta !== 'object') return null;
  if (meta.link && typeof meta.resolved === 'string')
    return { meta: lock.packages[meta.resolved], path: meta.resolved };
  return { meta, path };
}

/** Exact production closure from the lock, before any SBOM producer runs. */
export function productionPackagePaths(lock, platform, arch) {
  if (!lock?.packages || typeof lock.packages !== 'object')
    throw new Error('Invalid release lifecycle lock');
  const selected = new Set();
  const visit = (path) => {
    const resolved = packageMetadata(lock, path);
    if (!resolved?.meta || selected.has(resolved.path)) return;
    if (!platformMatches(resolved.meta, platform, arch)) return;
    selected.add(resolved.path);
    const dependencies = {
      ...(resolved.meta.dependencies ?? {}),
      ...(resolved.meta.optionalDependencies ?? {}),
    };
    for (const name of Object.keys(dependencies)) {
      const child = packagePath(lock, resolved.path, name);
      if (!child)
        throw new Error(
          `Release production lock is missing ${name} from ${resolved.path || 'root'}`,
        );
      visit(child);
    }
  };
  visit('');
  return selected;
}

function lifecyclePurls(allowlist, selected) {
  const expected = expectedLifecyclePurls(allowlist);
  const purls = expected.filter((purl) => selected.has(purl));
  if (purls.length === 0)
    throw new Error(
      'Release lifecycle policy has no applicable production packages',
    );
  return purls;
}

/** @param {{ allowlist: any, rootLock?: any, graph?: ReturnType<typeof readPnpmDependencyGraph>, platform?: string, arch?: string }} options */
export function productionLifecyclePurls({
  allowlist,
  rootLock = undefined,
  graph = undefined,
  platform = RELEASE_PLATFORM,
  arch = RELEASE_ARCH,
}) {
  if (graph)
    return lifecyclePurls(allowlist, graphPurls(graph, platform, arch, true));
  const reachable = productionPackagePaths(rootLock, platform, arch);
  return lifecyclePurls(
    allowlist,
    new Set(
      allowlist.entries
        .filter((entry) => entry.scope === 'root' && reachable.has(entry.path))
        .map((entry) => entry.purl),
    ),
  );
}

/** @param {{ allowlist: any, rootLock?: any, graph?: ReturnType<typeof readPnpmDependencyGraph>, platform?: string, arch?: string }} options */
export function containerLifecyclePurls({
  allowlist,
  rootLock = undefined,
  graph = undefined,
}) {
  if (graph)
    return lifecyclePurls(
      allowlist,
      new Set(
        CONTAINER_PLATFORMS.flatMap(([platform, arch]) => [
          ...graphPurls(graph, platform, arch, false),
        ]),
      ),
    );
  if (!rootLock?.packages || typeof rootLock.packages !== 'object')
    throw new Error('Invalid release lifecycle lock');
  return lifecyclePurls(
    allowlist,
    new Set(
      allowlist.entries
        .filter((entry) => {
          if (entry.scope !== 'root') return false;
          const meta = rootLock.packages[entry.path];
          return (
            meta &&
            CONTAINER_PLATFORMS.some(([platform, arch]) =>
              platformMatches(meta, platform, arch),
            )
          );
        })
        .map((entry) => entry.purl),
    ),
  );
}

/** @param {{ allowlist: any, rootLock?: any, graph?: ReturnType<typeof readPnpmDependencyGraph>, platform?: string, arch?: string }} options */
export function releaseDependencyLifecycle({
  allowlist,
  rootLock = undefined,
  graph = undefined,
  platform = RELEASE_PLATFORM,
  arch = RELEASE_ARCH,
}) {
  const production = productionLifecyclePurls({
    allowlist,
    rootLock,
    graph,
    platform,
    arch,
  });
  const container = containerLifecyclePurls({ allowlist, rootLock, graph });
  return {
    digest: allowlistDigest(allowlist),
    purlsByScope: {
      portable: production,
      desktop: production,
      mobile: production,
      container,
    },
  };
}

if (process.argv[1]?.endsWith('release-sbom-context.mjs'))
  try {
    const assetsDir = resolve(option('--assets-dir'));
    const tag = option('--tag');
    const sourceSha = option('--sha');
    const generatedAt = option('--generated-at');
    const container = JSON.parse(
      readFileSync(join(assetsDir, 'station-container-release.json'), 'utf8'),
    );
    const dependencyLifecycle = JSON.parse(
      readFileSync(
        resolve('config/dependency-lifecycle-allowlist.json'),
        'utf8',
      ),
    );
    const subjectsByScope = { portable: [], desktop: [], mobile: [] };
    for (const variant of releaseVariants(tag)) {
      const scope =
        variant.id === 'portable-server'
          ? 'portable'
          : ['macos', 'windows', 'linux'].includes(variant.platform)
            ? 'desktop'
            : 'mobile';
      for (const name of variant.files)
        subjectsByScope[scope].push({
          name,
          variant: variant.id,
          sha256: createHash('sha256')
            .update(readFileSync(join(assetsDir, name)))
            .digest('hex'),
        });
    }
    for (const scope of Object.keys(subjectsByScope))
      subjectsByScope[scope].sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      );
    writeFileSync(
      resolve(option('--output')),
      canonicalJson({
        tag,
        version: tag.slice(1),
        sourceSha,
        generatedAt,
        channel: tag.includes('-preview.') ? 'preview' : 'stable',
        container,
        dependencyLifecycle: releaseDependencyLifecycle({
          allowlist: dependencyLifecycle,
          graph: readPnpmDependencyGraph(process.cwd()),
        }),
        subjectsByScope,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
