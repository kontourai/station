import { constants, type Dirent } from 'node:fs';
import { type FileHandle, lstat, open, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * #3163: the file handling an engine child's transcript reader shares
 * (`claude-subagent-transcript.ts`, `codex-subagent-transcript.ts`): real
 * directories only, a regular file opened without following a link, and
 * JSONL records read as bytes with a per-line cap.
 *
 * Symlinks below a config home are refused by checks made immediately
 * before the open: each directory must be a real one (`lstat`), the file
 * must be a regular file by `lstat`, it is opened with `O_NOFOLLOW` (the
 * last component only) and `O_NONBLOCK` (so a FIFO cannot block the open),
 * and the open handle must be a regular file. These checks are not atomic
 * against a concurrent swap by a process running as the same user: a
 * directory swapped for a link between the check and the open is followed.
 */

/**
 * A record longer than this many BYTES is not buffered: its bytes are
 * discarded as they are read and it becomes one `tooLarge` record.
 */
export const TRANSCRIPT_LINE_MAX_BYTES = 4 * 1024 * 1024;
/** Bytes read per `read()` call. */
const READ_CHUNK_BYTES = 64 * 1024;

export type TranscriptJsonlRecord =
  | { tooLarge: true }
  | ({ tooLarge?: undefined } & Record<string, unknown>);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A directory's entries, or none when it cannot be read. */
export async function directoryEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** A real directory: present, and not a symlink to one. */
export async function isRealDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => undefined);
  return stat?.isDirectory() === true;
}

/** Every directory from below `root` down to `directory` is a real one. */
export async function isRealDirectoryChain(
  root: string,
  directory: string,
): Promise<boolean> {
  const below = relative(root, directory);
  if (below.length === 0 || below.startsWith('..')) return false;
  let current = root;
  for (const segment of below.split(sep)) {
    current = join(current, segment);
    if (!(await isRealDirectory(current))) return false;
  }
  return true;
}

/**
 * Opens a transcript without following a link in its last component, and
 * only when the opened handle is a regular file. Where the platform has no
 * `O_NOFOLLOW` (Windows), the handle's own stat still refuses a non-file.
 */
export async function openTranscriptFile(
  path: string,
): Promise<FileHandle | undefined> {
  // A regular file before the open: a FIFO or device is refused unopened.
  const linkStat = await lstat(path).catch(() => undefined);
  if (!linkStat?.isFile()) return undefined;
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      // Reads of a regular file are unaffected; a FIFO swapped in after the
      // lstat opens at once instead of waiting for a writer.
      (constants.O_NONBLOCK ?? 0),
  ).catch(() => undefined);
  if (!handle) return undefined;
  const stat = await handle.stat().catch(() => undefined);
  if (stat?.isFile()) return handle;
  await handle.close();
  return undefined;
}

/**
 * The file's records, one per line. Bytes are split on newline as they are
 * read; a line past `TRANSCRIPT_LINE_MAX_BYTES` stops being buffered at the
 * cap, its remaining bytes are skipped, and it is yielded as `tooLarge`.
 * A line that is not a JSON object is skipped. Memory holds at most one
 * line's capped bytes.
 */
export async function* transcriptJsonlRecords(
  handle: FileHandle,
): AsyncGenerator<TranscriptJsonlRecord> {
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let parts: Buffer[] = [];
  let length = 0;
  let overflow = false;
  const finish = (): TranscriptJsonlRecord | undefined => {
    const wasOverflow = overflow;
    const line = wasOverflow
      ? ''
      : Buffer.concat(parts, length).toString('utf8');
    parts = [];
    length = 0;
    overflow = false;
    if (wasOverflow) return { tooLarge: true };
    if (line.trim().length === 0) return undefined;
    try {
      const record = asRecord(JSON.parse(line));
      if (!record) return undefined;
      // A record's own `tooLarge` member must not pass as the marker.
      return { ...record, tooLarge: undefined };
    } catch {
      return undefined;
    }
  };
  const take = (chunk: Buffer) => {
    if (overflow) return;
    if (length + chunk.length > TRANSCRIPT_LINE_MAX_BYTES) {
      overflow = true;
      parts = [];
      length = 0;
      return;
    }
    // Copied: the read buffer is reused by the next read.
    parts.push(Buffer.from(chunk));
    length += chunk.length;
  };
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline === -1 || newline >= bytesRead) {
        take(buffer.subarray(start, bytesRead));
        break;
      }
      take(buffer.subarray(start, newline));
      const record = finish();
      if (record) yield record;
      start = newline + 1;
    }
  }
  const last = finish();
  if (last) yield last;
}

/**
 * A FIFO cache of resolved transcript paths: the oldest inserted is evicted
 * first. A hit is still re-checked by the caller before it is opened.
 */
export function createResolvedPathCache(max: number) {
  const paths = new Map<string, string>();
  return {
    get: (key: string) => paths.get(key),
    forget: (key: string) => {
      paths.delete(key);
    },
    remember: (key: string, path: string) => {
      paths.delete(key);
      paths.set(key, path);
      if (paths.size > max) {
        const oldest = paths.keys().next().value;
        if (oldest !== undefined) paths.delete(oldest);
      }
    },
  };
}
