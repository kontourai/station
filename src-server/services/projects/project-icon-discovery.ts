import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import {
  PROJECT_ICON_MAX_IMAGE_BYTES,
  type ProjectIconCandidate,
  projectIconProblem,
} from '@kontourai/station-contracts/project';
import { expandTilde } from '../../utils/paths.js';

const MAX_CANDIDATES = 8;
const MAX_DERIVED_BYTES = 12 * 1024;
// Bound retained image bytes as well as entry count; stat every use so edits
// invalidate the cache without a watcher or stale process-lifetime snapshot.
const imageCache = new Map<
  string,
  { stamp: string; candidate: ProjectIconCandidate }
>();
// The stored-icon bound: every candidate offered is one the routes accept.
const MAX_IMAGE_BYTES = PROJECT_ICON_MAX_IMAGE_BYTES;
const MANIFEST_PATHS = [
  'manifest.json',
  'site.webmanifest',
  'public/manifest.json',
  'public/site.webmanifest',
];
const COMMON_PATHS: Array<[string, ProjectIconCandidate['source']]> = [
  ['favicon.ico', 'favicon'],
  ['favicon.png', 'favicon'],
  ['public/favicon.ico', 'favicon'],
  ['public/favicon.png', 'favicon'],
  ['public/apple-touch-icon.png', 'app-icon'],
  ['apple-touch-icon.png', 'app-icon'],
  ['public/icon.png', 'app-icon'],
  ['assets/icon.png', 'app-icon'],
  ['src/assets/icon.png', 'app-icon'],
  ['logo.png', 'logo'],
  ['public/logo.png', 'logo'],
  ['assets/logo.png', 'logo'],
  ['src/assets/logo.png', 'logo'],
  ['logo.webp', 'logo'],
  ['public/logo.webp', 'logo'],
];

const MEDIA_TYPES: Record<string, string> = {
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function safeRelativePath(root: string, candidate: string): string | null {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replaceAll('\\', '/');
}

// Missing paths are rechecked only when their nearest existing directory changes.
// Request-local directory stamps coalesce hundreds of sibling candidate probes.
const missingPaths = new Map<string, { directory: string; stamp: string }>();
async function directoryStamp(path: string): Promise<string> {
  const info = await stat(path);
  return `${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
}
async function rememberMissing(path: string): Promise<void> {
  // A dangling link can become readable when its target changes elsewhere.
  // Its own parent timestamp is insufficient to cache that absence.
  try {
    await lstat(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  let directory = dirname(path);
  while (true) {
    try {
      const stamp = await directoryStamp(directory);
      if (missingPaths.size >= 4096)
        missingPaths.delete(missingPaths.keys().next().value!);
      missingPaths.set(path, { directory, stamp });
      return;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  }
}

async function readCandidate(
  root: string,
  candidatePath: string,
  source: ProjectIconCandidate['source'],
  maxBytes: number,
  stamps: Map<string, Promise<string>>,
): Promise<ProjectIconCandidate | null> {
  try {
    const missing = missingPaths.get(candidatePath);
    if (missing) {
      if (!stamps.has(missing.directory))
        stamps.set(
          missing.directory,
          directoryStamp(missing.directory).catch(() => 'unavailable'),
        );
      if ((await stamps.get(missing.directory)) === missing.stamp) return null;
      missingPaths.delete(candidatePath);
    }
    const canonicalPath = await realpath(candidatePath);
    const mediaType = MEDIA_TYPES[extname(canonicalPath).toLowerCase()];
    if (!mediaType) return null;
    const relativePath = safeRelativePath(root, canonicalPath);
    if (!relativePath) return null;
    const info = await stat(canonicalPath);
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) return null;
    const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const cached = imageCache.get(canonicalPath);
    if (cached?.stamp === stamp)
      return { ...cached.candidate, relativePath, source };
    const bytes = await readFile(canonicalPath);
    const dataUrl = `data:${mediaType};base64,${bytes.toString('base64')}`;
    // The stored-icon rule, not a second copy of it: it checks the signature
    // and re-checks the size against the bytes actually read (the file can
    // grow between the stat and the read).
    if (projectIconProblem(dataUrl)) return null;
    const candidate = { relativePath, dataUrl, mediaType, source };
    if (imageCache.size >= 128)
      imageCache.delete(imageCache.keys().next().value!);
    imageCache.set(canonicalPath, { stamp, candidate });
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      await rememberMissing(candidatePath);
    return null;
  }
}

const directoryEntries = new Map<
  string,
  { stamp: string; entries: Dirent[] }
>();
async function cachedEntries(path: string): Promise<Dirent[]> {
  try {
    const stamp = await directoryStamp(path);
    const cached = directoryEntries.get(path);
    if (cached?.stamp === stamp) return cached.entries;
    const entries = await readdir(path, { withFileTypes: true });
    if (directoryEntries.size >= 256)
      directoryEntries.delete(directoryEntries.keys().next().value!);
    directoryEntries.set(path, { stamp, entries });
    return entries;
  } catch {
    return [];
  }
}

async function manifestPaths(root: string): Promise<string[]> {
  const results: string[] = [];
  for (const manifestPath of MANIFEST_PATHS) {
    const absoluteManifest = resolve(root, manifestPath);
    try {
      const raw = await readFile(absoluteManifest, 'utf8');
      const manifest = JSON.parse(raw) as { icons?: Array<{ src?: unknown }> };
      for (const icon of manifest.icons ?? []) {
        if (
          typeof icon.src !== 'string' ||
          !icon.src ||
          icon.src.startsWith('data:')
        )
          continue;
        const normalized = icon.src.replace(/^\.\//, '').replace(/^\//, '');
        const absolute = resolve(dirname(absoluteManifest), normalized);
        if (safeRelativePath(root, absolute)) results.push(absolute);
      }
    } catch {
      // Missing, inaccessible, and malformed manifests are simply not candidates.
    }
  }
  return results;
}

export async function discoverProjectIconCandidates(
  workspacePath: string,
  limit = MAX_CANDIDATES,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<ProjectIconCandidate[]> {
  const requestedRoot = resolve(expandTilde(workspacePath));
  const root = await realpath(requestedRoot);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    // Carries the errno the kernel would have raised had the path been a file
    // component mid-walk, so the route classifies both spellings of "you named
    // a file, not a directory" the same way instead of falling through to its
    // unknown-cause branch.
    throw Object.assign(new Error('Workspace is not a directory'), {
      code: 'ENOTDIR',
    });
  }

  // Bounded, shallow monorepo scan; readCandidate confines every real path.
  const publicPaths: Array<[string, ProjectIconCandidate['source']]> = [];
  for (const parent of ['', 'apps', 'packages']) {
    const entries = await cachedEntries(resolve(root, parent));
    for (const entry of entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 64)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      for (const file of [
        'favicon.ico',
        'favicon.png',
        'apple-touch-icon.png',
      ]) {
        publicPaths.push([
          resolve(root, parent, entry.name, 'public', file),
          'favicon',
        ]);
      }
    }
  }
  const ranked: Array<[string, ProjectIconCandidate['source']]> = [
    ...(await manifestPaths(root)).map(
      (path) => [path, 'manifest'] as [string, ProjectIconCandidate['source']],
    ),
    ...COMMON_PATHS.map(
      ([path, source]) =>
        [resolve(root, path), source] as [
          string,
          ProjectIconCandidate['source'],
        ],
    ),
  ];
  ranked.push(...publicPaths);
  const stamps = new Map<string, Promise<string>>();
  const seen = new Set<string>();
  const candidates: ProjectIconCandidate[] = [];
  for (const [candidatePath, source] of ranked) {
    const relativePath = safeRelativePath(root, candidatePath);
    if (!relativePath || seen.has(relativePath)) continue;
    seen.add(relativePath);
    const candidate = await readCandidate(
      root,
      candidatePath,
      source,
      maxBytes,
      stamps,
    );
    if (
      candidate &&
      Buffer.byteLength(candidate.dataUrl.split(',')[1], 'base64') <= maxBytes
    )
      candidates.push(candidate);
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/** Derived display metadata only: the stored Project is never mutated. */
export async function withDiscoveredProjectIcon<
  T extends {
    icon?: string;
    iconDisabled?: boolean;
    derivedIcon?: string;
    workingDirectory?: string;
  },
>(project: T): Promise<T> {
  if (project.icon || project.iconDisabled) return project;
  try {
    const root = project.workingDirectory
      ? resolve(expandTilde(project.workingDirectory))
      : undefined;
    if (!root) return project;
    // A folder containing several repositories is not one repository.
    await stat(resolve(root, '.git'));
    const [candidate] = await discoverProjectIconCandidates(
      root,
      1,
      MAX_DERIVED_BYTES,
    );
    return candidate ? { ...project, derivedIcon: candidate.dataUrl } : project;
  } catch {
    return project;
  }
}
