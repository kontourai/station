#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  allowlistDigest,
  expectedLifecyclePurls,
} from './lib/dependency-lifecycle-policy.mjs';
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
  return (
    (!packageMeta.os?.length || packageMeta.os.includes(platform)) &&
    (!packageMeta.cpu?.length || packageMeta.cpu.includes(arch))
  );
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

export function productionLifecyclePurls({
  allowlist,
  rootLock,
  platform = RELEASE_PLATFORM,
  arch = RELEASE_ARCH,
}) {
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

export function containerLifecyclePurls({ allowlist, rootLock }) {
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

function releaseRootLock() {
  return JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
}

export function releaseDependencyLifecycle({
  allowlist,
  rootLock,
  platform = RELEASE_PLATFORM,
  arch = RELEASE_ARCH,
}) {
  const production = productionLifecyclePurls({
    allowlist,
    rootLock,
    platform,
    arch,
  });
  const container = containerLifecyclePurls({ allowlist, rootLock });
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
          rootLock: releaseRootLock(),
        }),
        subjectsByScope,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
