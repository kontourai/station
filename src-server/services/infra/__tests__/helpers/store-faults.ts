import {
  chmodSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

/**
 * Standard file-backed-store fault battery (#2002): new store tests should
 * compose the applicable corrupt-primary, torn-write, unreadable-path,
 * dangling-link, hostile-shape, and locked-interleave probes below. Keep the
 * store's assertions local; these helpers only provide fault setup.
 */

/**
 * Defect class: corrupt primary bytes must not be silently treated as absence.
 * Historical instance: grants-file-store.ts (#1835).
 */
export function corruptFile(path: string, contents = 'not json'): void {
  writeFileSync(path, contents);
}

/**
 * Defect class: a torn primary must not auto-promote the last `.previous` value.
 * Historical instance: grants-file-store.ts (#1835).
 */
export function truncatePrimaryKeepPrevious(
  path: string,
  fraction = 0.5,
): { primary: string; truncated: string } {
  const primary = readFileSync(path, 'utf-8');
  const truncated = primary.slice(0, Math.floor(primary.length * fraction));
  writeFileSync(path, truncated);
  return { primary, truncated };
}

/**
 * Defect class: a dangling symlink is an inaccessible primary, not absence.
 * Historical instance: grants-file-store.ts (#1835).
 */
export function danglingSymlink(path: string): void {
  symlinkSync(`${path}.missing`, path);
}

/**
 * Guard for chmod-based denial tests when the host can bypass or ignore modes.
 * Defect class: unreadable-path tests must not claim coverage on unsupported hosts.
 * Historical instance: grants-file-store.ts (#1835).
 */
export const skipIfCannotChmod =
  process.platform === 'win32' ||
  typeof process.getuid !== 'function' ||
  process.getuid() === 0;

/**
 * Defect class: unreadable files and parent directories must not read as defaults.
 * Historical instance: grants-file-store.ts (#1835).
 */
export function withUnreadable<T>(target: string, callback: () => T): T {
  const mode = statSync(target).mode & 0o777;
  chmodSync(target, 0o000);
  try {
    const result = callback();
    if (result instanceof Promise) {
      return result.finally(() => chmodSync(target, mode)) as T;
    }
    chmodSync(target, mode);
    return result;
  } catch (error) {
    chmodSync(target, mode);
    throw error;
  }
}

export interface StoreFaultShape {
  label: string;
  content: string;
  expected: 'reject as unavailable';
}

/**
 * Defect class: malformed and prototype-polluting JSON shapes must be rejected.
 * Historical instance: grants-file-store.ts (#1835).
 */
export function reservedKeyShapes(): readonly StoreFaultShape[] {
  return [
    {
      label: 'null literal',
      content: 'null',
      expected: 'reject as unavailable',
    },
    { label: 'array', content: '[]', expected: 'reject as unavailable' },
    {
      label: 'string',
      content: '"a string"',
      expected: 'reject as unavailable',
    },
    {
      label: 'string-valued entry',
      content: '{"p":"providers.register"}',
      expected: 'reject as unavailable',
    },
    {
      label: '__proto__ key',
      content: '{"__proto__":[]}',
      expected: 'reject as unavailable',
    },
    {
      label: 'constructor key',
      content: '{"constructor":[]}',
      expected: 'reject as unavailable',
    },
    {
      label: 'prototype key',
      content: '{"prototype":[]}',
      expected: 'reject as unavailable',
    },
  ];
}

/**
 * Defect class: the read of a read-modify-write must happen under its lock.
 * Historical instance: grants-file-store.ts (#1835).
 */
export function interleaveOnceOnLockAcquire(
  setHook: (hook: ((lock: string) => void) | undefined) => void,
  interleave: (lock: string) => void,
): () => boolean {
  let injected = false;
  setHook((lock) => {
    if (injected) return;
    injected = true;
    interleave(lock);
  });
  return () => injected;
}
