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
  return withTranscriptFile(path, (descriptor) => {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset <= maxLineBytes) {
      const chunk = Buffer.alloc(Math.min(4096, maxLineBytes + 1 - offset));
      let filled = 0;
      while (filled < chunk.length) {
        const bytesRead = readSync(
          descriptor,
          chunk,
          filled,
          chunk.length - filled,
          offset,
        );
        const newline = chunk
          .subarray(filled, filled + bytesRead)
          .indexOf(0x0a);
        if (bytesRead === 0 || newline >= 0) {
          chunks.push(chunk.subarray(0, filled + Math.max(newline, 0)));
          // Decode only after joining: a UTF-8 code point can cross reads.
          return Buffer.concat(chunks).toString('utf8').trim() || undefined;
        }
        filled += bytesRead;
        offset += bytesRead;
      }
      chunks.push(chunk);
    }
    return null;
  });
}

export interface LeadingLineScanLimits {
  /** Lines offered to the visitor before the scan refuses to continue. */
  maxLines: number;
  /** A longer line is skipped and offered as `null`, never parsed. */
  maxLineBytes: number;
  /** Total bytes the scan may read, including skipped oversized lines. */
  maxBytes: number;
}

export type LeadingLineScanEnd =
  | 'stopped'
  | 'eof'
  | 'line_count'
  | 'byte_budget';

const LEADING_SCAN_CHUNK_BYTES = 32 * 1024;

/**
 * Offer a file's leading lines, in order, to `visit` until it returns true.
 * Blank lines are not offered; an over-long line is offered as `null`. Every
 * read goes through `readWindow`, and the scan never reads past `maxBytes`.
 */
export function scanLeadingLines(
  path: string,
  limits: LeadingLineScanLimits,
  visit: (line: string | null) => boolean,
): LeadingLineScanEnd {
  let base = 0;
  let buffer: Buffer = Buffer.alloc(0);
  let oversized = false;
  let offered = 0;
  const offer = (line: string | null): LeadingLineScanEnd | undefined => {
    if (line === '') return undefined;
    if (offered >= limits.maxLines) return 'line_count';
    offered += 1;
    return visit(line) ? 'stopped' : undefined;
  };
  for (;;) {
    const newline = buffer.indexOf(0x0a);
    if (newline >= 0) {
      const line = oversized
        ? null
        : newline > limits.maxLineBytes
          ? null
          : buffer.subarray(0, newline).toString('utf8').trim();
      oversized = false;
      base += newline + 1;
      buffer = buffer.subarray(newline + 1);
      const end = offer(line);
      if (end) return end;
      continue;
    }
    if (buffer.length > limits.maxLineBytes) {
      oversized = true;
      base += buffer.length;
      buffer = Buffer.alloc(0);
    }
    const readFrom = base + buffer.length;
    if (readFrom >= limits.maxBytes) return 'byte_budget';
    const chunk = readWindow(
      path,
      readFrom,
      Math.min(LEADING_SCAN_CHUNK_BYTES, limits.maxBytes - readFrom),
    );
    if (chunk.length === 0) {
      // An unterminated final line is still a complete leading record here.
      const tail =
        oversized || buffer.length > limits.maxLineBytes
          ? null
          : buffer.toString('utf8').trim();
      if (buffer.length > 0 || oversized) {
        const end = offer(tail);
        if (end) return end;
      }
      return 'eof';
    }
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  }
}

export function readWindow(
  path: string,
  offset: number,
  length: number,
): Buffer {
  return withTranscriptFile(path, (descriptor) => {
    const content = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, content, 0, length, offset);
    return content.subarray(0, bytesRead);
  });
}

function withTranscriptFile<T>(
  path: string,
  read: (descriptor: number) => T,
): T {
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
    return read(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
