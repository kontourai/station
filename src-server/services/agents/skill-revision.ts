import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  type BoundDirectoryIdentity,
  boundDirectoryIdentity,
  enumerateBoundDirectory,
} from './bound-directory-enumeration.js';

export const LOCAL_SKILL_REVISION_VERSION = 1;
export const LOCAL_SKILL_REVISION_LIMITS = {
  entries: 256,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  depth: 16,
} as const;

export type LocalSkillRevisionEntry = {
  type: 'directory' | 'file';
  path: string;
  content?: Uint8Array;
};

function unavailable(): never {
  throw new Error('Skill revision unavailable.');
}

function frameLength(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) unavailable();
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(value));
  return frame;
}

function canonicalPath(path: string): Buffer {
  if (
    path === '' ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    unavailable();
  }
  return Buffer.from(path, 'utf8');
}

/**
 * Pure canonical encoder for a revision that has already been safely read or
 * is about to be published.  Recovery may use it only for the exact files it
 * will publish: directory entries are required so tree shape is committed too.
 */
export function expectedLocalSkillRevision(
  entries: readonly LocalSkillRevisionEntry[],
): string {
  if (
    entries.length === 0 ||
    entries.length > LOCAL_SKILL_REVISION_LIMITS.entries
  )
    unavailable();
  const normalized = entries.map((entry) => {
    const path = canonicalPath(entry.path);
    const depth = entry.path.split('/').length;
    if (depth > LOCAL_SKILL_REVISION_LIMITS.depth) unavailable();
    if (entry.type === 'directory') {
      if (entry.content !== undefined && entry.content.byteLength !== 0)
        unavailable();
      return { type: 0x44, path, content: Buffer.alloc(0) };
    }
    if (entry.type !== 'file' || entry.content === undefined) unavailable();
    if (entry.content.byteLength > LOCAL_SKILL_REVISION_LIMITS.fileBytes)
      unavailable();
    return { type: 0x46, path, content: Buffer.from(entry.content) };
  });
  normalized.sort((a, b) => Buffer.compare(a.path, b.path) || a.type - b.type);
  for (let index = 1; index < normalized.length; index += 1) {
    if (
      Buffer.compare(normalized[index - 1]!.path, normalized[index]!.path) === 0
    )
      unavailable();
  }
  let totalBytes = 0;
  const hash = createHash('sha256');
  hash.update(Buffer.from('station.local-skill-revision\0', 'utf8'));
  hash.update(Buffer.of(LOCAL_SKILL_REVISION_VERSION));
  hash.update(frameLength(normalized.length));
  for (const entry of normalized) {
    totalBytes += entry.content.byteLength;
    if (totalBytes > LOCAL_SKILL_REVISION_LIMITS.totalBytes) unavailable();
    hash.update(Buffer.of(entry.type));
    hash.update(frameLength(entry.path.byteLength));
    hash.update(entry.path);
    hash.update(frameLength(entry.content.byteLength));
    hash.update(entry.content);
  }
  return hash.digest('hex');
}

/** Read a bounded, no-symlink, no-hardlink local Skill tree for revision. */
export async function localSkillRevisionFromDirectory(
  root: string,
  options: {
    /** Deterministic proof that a swap before the first spawn is refused. */
    beforeEnumerationForTest?: () => void | Promise<void>;
    /** Deterministic proof that a listed child cannot be rebound by pathname. */
    beforeChildVisitForTest?: (path: string) => void | Promise<void>;
  } = {},
): Promise<string> {
  const entries: LocalSkillRevisionEntry[] = [];
  let totalBytes = 0;
  let firstEnumeration = true;
  const visit = async (
    directory: string,
    expected: BoundDirectoryIdentity,
    depth: number,
  ): Promise<void> => {
    if (depth > LOCAL_SKILL_REVISION_LIMITS.depth) unavailable();
    let listed: Awaited<ReturnType<typeof enumerateBoundDirectory>>;
    try {
      listed = await enumerateBoundDirectory({
        directory,
        expected,
        limits: {
          entries: LOCAL_SKILL_REVISION_LIMITS.entries - entries.length,
          fileBytes: LOCAL_SKILL_REVISION_LIMITS.fileBytes,
          totalBytes: LOCAL_SKILL_REVISION_LIMITS.totalBytes - totalBytes,
        },
        ...(firstEnumeration
          ? { beforeEnumerationForTest: options.beforeEnumerationForTest }
          : {}),
      });
    } catch {
      unavailable();
    } finally {
      firstEnumeration = false;
    }
    for (const entry of listed) {
      if (entries.length >= LOCAL_SKILL_REVISION_LIMITS.entries) unavailable();
      const path = join(directory, entry.name);
      const entryPath = relative(root, path).split(sep).join('/');
      if (entry.kind === 'directory') {
        entries.push({ type: 'directory', path: entryPath });
        await options.beforeChildVisitForTest?.(path);
        await visit(path, entry.identity, depth + 1);
      } else if (entry.kind === 'file') {
        totalBytes += entry.bytes.byteLength;
        if (totalBytes > LOCAL_SKILL_REVISION_LIMITS.totalBytes) unavailable();
        entries.push({
          type: 'file',
          path: entryPath,
          content: entry.bytes,
        });
      } else {
        unavailable();
      }
    }
  };
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) unavailable();
  await visit(root, boundDirectoryIdentity(rootStat), 0);
  if (
    !entries.some((entry) => entry.type === 'file' && entry.path === 'SKILL.md')
  )
    unavailable();
  return expectedLocalSkillRevision(entries);
}
