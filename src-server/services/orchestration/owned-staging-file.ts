import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';

/**
 * Writes `data` to a staging file this call creates, then hands it to
 * `publish` (a rename into place). Ownership is taken by creating the file
 * exclusively (`wx`), so an existing file is refused with EEXIST and never
 * touched. Once the file exists, any later failure (a partial write, the
 * close, or `publish`) unlinks that file and only that file before the error
 * is rethrown, so a failed attempt leaves no staging copy behind (#4852
 * review).
 */
export function publishThroughOwnedFile(
  staging: string,
  data: string | Uint8Array,
  publish: (staging: string) => void,
  mode = 0o600,
): void {
  let owned = false;
  let fd: number | undefined;
  try {
    fd = openSync(staging, 'wx', mode);
    owned = true;
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    for (let at = 0; at < bytes.length; )
      at += writeSync(fd, bytes, at, bytes.length - at);
    const done = fd;
    fd = undefined;
    closeSync(done);
    publish(staging);
  } catch (error) {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        // The descriptor is released with the process at worst.
      }
    if (owned)
      try {
        unlinkSync(staging);
      } catch {
        // Already renamed or removed; nothing of ours is left to clean.
      }
    throw error;
  }
}
