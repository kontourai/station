import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';

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
