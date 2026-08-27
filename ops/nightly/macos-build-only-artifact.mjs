import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

export function canonicalPath(
  path,
  { cwd, realpath = realpathSync.native } = {},
) {
  let candidate = resolve(cwd, path);
  const missing = [];
  while (true) {
    try {
      return resolve(realpath(candidate), ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

export function pathsOverlap(left, right) {
  return [relative(left, right), relative(right, left)].some(
    (relation) =>
      relation === '' ||
      (!(relation === '..' || relation.startsWith('../')) &&
        !isAbsolute(relation)),
  );
}

export function validateBuildOnlyOutput({
  outputDir,
  invocationCwd,
  forbiddenRoots,
  realpath,
}) {
  const output = canonicalPath(outputDir, { cwd: invocationCwd, realpath });
  for (const root of forbiddenRoots) {
    const canonicalRoot = canonicalPath(root, { cwd: invocationCwd, realpath });
    if (pathsOverlap(output, canonicalRoot))
      throw new Error(
        `Build-only output overlaps protected path: ${canonicalRoot}`,
      );
  }
  return output;
}

export function createExclusiveDirectory(path, { mkdir = mkdirSync } = {}) {
  try {
    mkdir(path);
  } catch (error) {
    if (error?.code === 'EEXIST')
      throw new Error(`Build-only output directory already exists: ${path}`);
    throw error;
  }
}

export function assertSafeArchiveEntries(entries) {
  for (const entry of entries) {
    const operatingSystemHome = /(^|\/)(Users|home)\//.test(entry);
    const credentialDirectory = /(^|\/)\.(ssh|aws)\//i.test(entry);
    const privateKeyExtension = /\.(key|pem|p12|p8)$/i.test(entry);
    if (operatingSystemHome || credentialDirectory || privateKeyExtension)
      throw new Error(
        'Nightly archive contains a user-home or private-key path',
      );
  }
}

export const ARCHIVE_LIST_MAX_BUFFER = 64 * 1024 * 1024;

export function assertSafeArchiveFile(
  archivePath,
  { run = execFileSync, maxBuffer = ARCHIVE_LIST_MAX_BUFFER } = {},
) {
  let listing;
  try {
    listing = run('unzip', ['-Z1', archivePath], {
      encoding: 'utf8',
      maxBuffer,
      windowsHide: true,
    });
  } catch {
    throw new Error('Nightly archive listing could not be validated.');
  }
  assertSafeArchiveEntries(listing.trim().split('\n').filter(Boolean));
}
