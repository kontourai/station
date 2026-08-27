import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { ProjectIconCandidate } from '@kontourai/station-contracts/project';
import { expandTilde } from '../../utils/paths.js';

const MAX_CANDIDATES = 8;
const MAX_IMAGE_BYTES = 128 * 1024;
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

function hasImageSignature(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === 'image/png') {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mediaType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mediaType === 'image/x-icon') {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0 &&
      bytes[1] === 0 &&
      bytes[2] === 1 &&
      bytes[3] === 0
    );
  }
  if (mediaType === 'image/webp') {
    return (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

function safeRelativePath(root: string, candidate: string): string | null {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.replaceAll('\\', '/');
}

async function readCandidate(
  root: string,
  candidatePath: string,
  source: ProjectIconCandidate['source'],
): Promise<ProjectIconCandidate | null> {
  try {
    const canonicalPath = await realpath(candidatePath);
    const mediaType = MEDIA_TYPES[extname(canonicalPath).toLowerCase()];
    if (!mediaType) return null;
    const relativePath = safeRelativePath(root, canonicalPath);
    if (!relativePath) return null;
    const info = await stat(canonicalPath);
    if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES)
      return null;
    const bytes = await readFile(canonicalPath);
    if (!hasImageSignature(bytes, mediaType)) return null;
    return {
      relativePath,
      dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`,
      mediaType,
      source,
    };
  } catch {
    return null;
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
  const seen = new Set<string>();
  const candidates: ProjectIconCandidate[] = [];
  for (const [candidatePath, source] of ranked) {
    const relativePath = safeRelativePath(root, candidatePath);
    if (!relativePath || seen.has(relativePath)) continue;
    seen.add(relativePath);
    const candidate = await readCandidate(root, candidatePath, source);
    if (candidate) candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}
