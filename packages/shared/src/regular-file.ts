import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Opens `path` only if it is a regular file, without ever blocking.
 *
 * `stat` then `open` is a race: the path can be swapped for a FIFO between
 * the two, and a synchronous `open` of a FIFO with no writer blocks the
 * calling thread (in the server, the event loop) until something writes to
 * it. Opening with `O_NONBLOCK` returns immediately for a FIFO, and the type
 * is then read from the descriptor itself, so what is checked is exactly
 * what is read. `O_NOFOLLOW` additionally refuses a final symlink where the
 * platform has it. Returns the open descriptor, or null (and closes it).
 */
export function openRegularFileSync(path: string): number | null {
  const flags =
    constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) |
    (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch {
    return null;
  }
  try {
    if (fstatSync(fd).isFile()) return fd;
  } catch {}
  closeSync(fd);
  return null;
}

/** Whether `path` is a regular file right now, decided without blocking. */
export function isRegularFileSync(path: string): boolean {
  const fd = openRegularFileSync(path);
  if (fd === null) return false;
  closeSync(fd);
  return true;
}

/** Reads a regular file of at most `maxBytes`, or null. Never blocks on a FIFO. */
export function readBoundedRegularFileSync(
  path: string,
  maxBytes: number,
): string | null {
  const fd = openRegularFileSync(path);
  if (fd === null) return null;
  try {
    const size = fstatSync(fd).size;
    if (size > maxBytes) return null;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
