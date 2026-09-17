import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull } from 'node:os';
import { dirname } from 'node:path';

import { fsyncDirectorySync } from './fs-windows-compat.js';

export function writePrivateNewFile(path: string, data: Buffer): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const identity = fstatSync(fd);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    let current: ReturnType<typeof lstatSync> | undefined;
    try {
      current = lstatSync(path);
    } catch {}
    if (
      current &&
      !current.isSymbolicLink() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    )
      rmSync(path);
    throw error;
  }
  closeSync(fd);
  fsyncDirectorySync(dirname(path));
}

export const PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const COMPONENT_MAX_BYTES = 16 * 1024 * 1024;
export const FILE_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRIES = 5000;

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readBoundedFile(path: string, limit: number): Buffer {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > limit
  )
    throw new Error('Package input must be a bounded, unlinked regular file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw new Error('Package input changed while opening');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = lstatSync(path);
    if (
      length !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Package input changed while reading');
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** Compare physical ancestry so case aliases and linked worktree gitdirs do
 * not let an output or key be placed back into the source repository. */
export function isWithin(root: string, path: string): boolean {
  const rootInfo = lstatSync(realpathSync(root));
  let current = realpathSync(path);
  for (;;) {
    const info = lstatSync(current);
    if (info.dev === rootInfo.dev && info.ino === rootInfo.ino) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Portable filenames, not a credential-content scanner. */
export function validatePaths(paths: readonly string[]): void {
  if (paths.length > MAX_ENTRIES)
    throw new Error('Workspace entry limit exceeded');
  const seen = new Set<string>();
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      path.length > 2048 ||
      Buffer.from(path, 'utf8').toString('utf8') !== path
    )
      throw new Error('Invalid workspace path');
    const segments = path.split('/');
    if (
      segments.some(
        (part) =>
          !part ||
          Buffer.byteLength(part) > 255 ||
          part === '.' ||
          part === '..' ||
          /[\\:<>"|?*]/.test(part) ||
          [...part].some(
            (character) =>
              character.codePointAt(0)! < 32 ||
              character.codePointAt(0) === 127,
          ) ||
          /[. ]$/.test(part) ||
          /^(?:\.git|\.?git~[0-9]+)$/i.test(part) ||
          /\p{Cf}/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
    )
      throw new Error('Unsafe or non-portable workspace path');
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key))
      throw new Error('Duplicate or case-colliding workspace path');
    seen.add(key);
  }
  for (const key of seen) {
    const parts = key.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join('/')))
        throw new Error('Workspace file/directory collision');
    }
  }
}

/** Git is an offline data codec here. Never inherit alternate repo selection,
 * global hooks, credential helpers, or network transports from the caller. */
export function packageGit(
  cwd: string,
  args: string[],
  input?: Buffer | string,
  contentPolicyQuery = false,
): Buffer {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  if (
    contentPolicyQuery &&
    !['ls-files', 'check-attr'].includes(args[0]) &&
    (args[0] !== 'config' ||
      !['core.autocrlf', 'core.eol', 'core.filemode'].includes(
        args.at(-1) ?? '',
      ))
  )
    throw new Error('Invalid content policy query');
  if (contentPolicyQuery)
    for (const key of [
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_NOSYSTEM',
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  Object.assign(env, {
    ...(!contentPolicyQuery
      ? {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: devNull,
          GIT_ATTR_NOSYSTEM: '1',
        }
      : {}),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
  });
  try {
    return execFileSync(
      'git',
      [
        '-c',
        `core.hooksPath=${devNull}`,
        '-c',
        'core.fsmonitor=false',
        ...(!contentPolicyQuery
          ? ['-c', `core.attributesFile=${devNull}`]
          : []),
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        '-c',
        'pack.threads=1',
        '-c',
        'core.protectNTFS=true',
        '-c',
        'core.protectHFS=true',
        '-c',
        'fetch.fsckObjects=true',
        '-c',
        'transfer.fsckObjects=true',
        '-C',
        cwd,
        ...args,
      ],
      {
        input,
        env,
        timeout: 30_000,
        maxBuffer: COMPONENT_MAX_BYTES,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch {
    throw new Error(
      `Workspace Git operation failed or exceeded its bound: ${args[0]}`,
    );
  }
}
