import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import {
  PROJECT_ICON_MAX_IMAGE_BYTES,
  type ProjectIconCandidate,
  projectIconProblem,
} from '@kontourai/station-contracts/project';
import { expandTilde } from '../../utils/paths.js';

const MAX_CANDIDATES = 8;
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
    const dataUrl = `data:${mediaType};base64,${bytes.toString('base64')}`;
    // The stored-icon rule, not a second copy of it: it checks the signature
    // and re-checks the size against the bytes actually read (the file can
    // grow between the stat and the read).
    if (projectIconProblem(dataUrl)) return null;
    return { relativePath, dataUrl, mediaType, source };
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
