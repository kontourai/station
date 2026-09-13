import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type { ProviderSessionSourceAffinity } from '@kontourai/station-contracts/provider';

export interface TranscriptConfigHomeIdentity {
  affinity: ProviderSessionSourceAffinity;
  canonicalRoot: string;
}

/**
 * Derive a non-path identity for one configured transcript home. This reads
 * only directory metadata: no config, credentials, or transcript bytes.
 */
export function deriveConfigHomeAffinity(
  namespace: string,
  configuredRoot: string,
): TranscriptConfigHomeIdentity | null {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(namespace)) return null;
  try {
    const canonicalRoot = realpathSync(configuredRoot);
    const stat = lstatSync(canonicalRoot);
    if (!stat.isDirectory()) return null;
    const ref = createHash('sha256')
      .update(
        JSON.stringify([
          'station-transcript-config-home-v1',
          namespace,
          canonicalRoot,
          stat.dev,
          stat.ino,
        ]),
      )
      .digest('hex');
    return {
      affinity: Object.freeze({ kind: namespace, ref }),
      canonicalRoot,
    };
  } catch {
    return null;
  }
}

/** Resolve only an exact, currently configured home identity. */
export function resolveConfigHomeAffinity(
  namespace: string,
  configuredRoot: string,
  affinity: ProviderSessionSourceAffinity | undefined,
): string | null {
  if (
    !affinity ||
    affinity.kind !== namespace ||
    !/^[a-f0-9]{64}$/u.test(affinity.ref)
  ) {
    return null;
  }
  const current = deriveConfigHomeAffinity(namespace, configuredRoot);
  return current && current.affinity.ref === affinity.ref
    ? current.canonicalRoot
    : null;
}

/** Bounded regular-file reads shared by external transcript adapters. */
export function readLeadingLine(
  path: string,
  maxLineBytes: number,
): string | null | undefined {
  const content = readWindow(path, 0, maxLineBytes + 1);
  const newline = content.indexOf(0x0a);
  if (newline < 0 && content.length > maxLineBytes) return null;
  const end = newline < 0 ? content.length : newline;
  return content.subarray(0, end).toString('utf8').trim() || undefined;
}

export function readWindow(
  path: string,
  offset: number,
  length: number,
): Buffer {
  // O_NOFOLLOW plus the descriptor identity check closes final-component swaps.
  // Replacing a parent directory after discovery remains a local-trust residual
  // on platforms without openat-style directory handles.
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Transcript source is not a regular file.');
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error('Transcript source changed during secure open.');
    }
    const content = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, content, 0, length, offset);
    return content.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}
