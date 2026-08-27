/**
 * The filesystem exposes neither fdopendir nor openat to Node. This Adapter
 * binds one directory identity by making it a short-lived helper's OS cwd:
 * the helper verifies `.` before it enumerates and opens every direct child.
 * A rename before spawn binds the wrong cwd and fails; a rename after spawn
 * cannot redirect the helper's cwd.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Stats } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HELPER_PATH = fileURLToPath(
  new URL('./bound-directory-enumeration-helper.mjs', import.meta.url),
);
const HELPER_TIMEOUT_MS = 5_000;
const MAX_NAME_BYTES = 255;

export type BoundDirectoryIdentity = {
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type BoundDirectoryEntry =
  | { name: string; kind: 'directory'; identity: BoundDirectoryIdentity }
  | {
      name: string;
      kind: 'file';
      identity: BoundDirectoryIdentity;
      bytes: Buffer;
    }
  | {
      name: string;
      kind:
        | 'symlink'
        | 'hard-link'
        | 'special-file'
        | 'file-size-limit'
        | 'total-size-limit'
        | 'unreadable';
    };

export function boundDirectoryIdentity(stat: Stats): BoundDirectoryIdentity {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    nlink: Number(stat.nlink),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

function unavailable(): never {
  throw new Error('Bound directory enumeration unavailable.');
}

function isIdentity(value: unknown): value is BoundDirectoryIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  return ['dev', 'ino', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === 'number' && Number.isFinite(candidate);
  });
}

function isName(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('\ufffd')
  )
    return false;
  const bytes = Buffer.from(value, 'utf8');
  return (
    bytes.byteLength <= MAX_NAME_BYTES &&
    new TextDecoder('utf-8', { fatal: true }).decode(bytes) === value
  );
}

function parseEntries(value: unknown, limits: BoundDirectoryEnumerationLimits) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    unavailable();
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries) || entries.length > limits.entries) unavailable();
  let totalBytes = 0;
  return entries.map((entry): BoundDirectoryEntry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      unavailable();
    const candidate = entry as Record<string, unknown>;
    if (!isName(candidate.name) || typeof candidate.kind !== 'string')
      unavailable();
    if (candidate.kind === 'directory') {
      if (!isIdentity(candidate.identity)) unavailable();
      return {
        name: candidate.name,
        kind: 'directory',
        identity: candidate.identity,
      };
    }
    if (candidate.kind === 'file') {
      if (
        !isIdentity(candidate.identity) ||
        typeof candidate.bytes !== 'string'
      )
        unavailable();
      const bytes = Buffer.from(candidate.bytes, 'base64');
      if (
        bytes.byteLength > limits.fileBytes ||
        bytes.toString('base64') !== candidate.bytes
      )
        unavailable();
      totalBytes += bytes.byteLength;
      if (totalBytes > limits.totalBytes) unavailable();
      return {
        name: candidate.name,
        kind: 'file',
        identity: candidate.identity,
        bytes,
      };
    }
    if (
      candidate.kind === 'symlink' ||
      candidate.kind === 'hard-link' ||
      candidate.kind === 'special-file' ||
      candidate.kind === 'file-size-limit' ||
      candidate.kind === 'total-size-limit' ||
      candidate.kind === 'unreadable'
    )
      return { name: candidate.name, kind: candidate.kind };
    unavailable();
  });
}

export type BoundDirectoryEnumerationLimits = {
  entries: number;
  fileBytes: number;
  totalBytes: number;
};

export async function enumerateBoundDirectory(options: {
  directory: string;
  expected: BoundDirectoryIdentity;
  limits: BoundDirectoryEnumerationLimits;
  /** Deterministic race instrumentation; never supplied by production. */
  beforeEnumerationForTest?: () => void | Promise<void>;
  /** Deterministic post-enumeration instrumentation; never supplied by production. */
  afterEnumerationForTest?: () => void | Promise<void>;
}): Promise<BoundDirectoryEntry[]> {
  const { directory, expected, limits } = options;
  if (
    !Number.isSafeInteger(limits.entries) ||
    limits.entries < 0 ||
    !Number.isSafeInteger(limits.fileBytes) ||
    limits.fileBytes < 0 ||
    !Number.isSafeInteger(limits.totalBytes) ||
    limits.totalBytes < 0
  )
    unavailable();
  await options.beforeEnumerationForTest?.();
  const maxOutput =
    Math.ceil((limits.totalBytes * 4) / 3) + limits.entries * 1024 + 4096;
  return new Promise<BoundDirectoryEntry[]>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let output = Buffer.alloc(0);
    const finish = (result?: BoundDirectoryEntry[]) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      result === undefined
        ? reject(new Error('Bound directory enumeration unavailable.'))
        : resolve(result);
    };
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn(process.execPath, [HELPER_PATH], {
        cwd: directory,
        env: {},
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      finish();
      return;
    }
    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, HELPER_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.byteLength > maxOutput) {
        child.kill('SIGKILL');
        finish();
      }
    });
    child.once('error', () => finish());
    child.once('close', async (code) => {
      if (code !== 0 || settled) return finish();
      try {
        const entries = parseEntries(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)),
          limits,
        );
        await options.afterEnumerationForTest?.();
        finish(entries);
      } catch {
        finish();
      }
    });
    child.stdin.end(
      JSON.stringify({ intent: 'enumerateBoundDirectory', expected, limits }),
    );
  });
}

export async function publishBoundDirectoryFileExclusive(options: {
  directory: string;
  expected: BoundDirectoryIdentity;
  name: string;
  bytes: Buffer;
  maxBytes: number;
  /** Deterministic race instrumentation; never supplied by production. */
  beforePublishForTest?: () => void | Promise<void>;
  /** Deterministic race instrumentation; never supplied by production. */
  afterPublishForTest?: () => void | Promise<void>;
}): Promise<{
  result: 'created' | 'exists';
  identity: BoundDirectoryIdentity;
}> {
  if (
    !isName(options.name) ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    options.bytes.byteLength > options.maxBytes
  )
    unavailable();
  await options.beforePublishForTest?.();
  return new Promise<{
    result: 'created' | 'exists';
    identity: BoundDirectoryIdentity;
  }>((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let output = Buffer.alloc(0);
    const finish = (result?: {
      result: 'created' | 'exists';
      identity: BoundDirectoryIdentity;
    }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      result === undefined
        ? reject(new Error('Bound directory enumeration unavailable.'))
        : resolve(result);
    };
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn(process.execPath, [HELPER_PATH], {
        cwd: options.directory,
        env: {},
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      finish();
      return;
    }
    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, HELPER_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.byteLength > 1024) {
        child.kill('SIGKILL');
        finish();
      }
    });
    child.once('error', () => finish());
    child.once('close', async (code) => {
      if (code !== 0 || settled) return finish();
      try {
        const result = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(output),
        ) as { result?: unknown; identity?: unknown };
        if (result.result !== 'created' && result.result !== 'exists')
          return finish();
        if (!isIdentity(result.identity)) return finish();
        await options.afterPublishForTest?.();
        finish({ result: result.result, identity: result.identity });
      } catch {
        finish();
      }
    });
    child.stdin.end(
      JSON.stringify({
        intent: 'publishBoundDirectoryFileExclusive',
        expected: options.expected,
        name: options.name,
        bytes: options.bytes.toString('base64'),
        maxBytes: options.maxBytes,
      }),
    );
  });
}
