/**
 * Guarded read and atomic write for the small private JSON files native push
 * keeps under the Station's `security/` directory. One implementation for the
 * push signing key and the registration store, with the custody discipline of
 * `ConnectionSigningKeyStore`: the file must be a regular, singly linked,
 * non-symlink file of mode 0600 and bounded size, checked on the opened
 * descriptor so a swap between check and read is refused; writes go to a
 * 0600 temporary file that is fsynced and renamed over the target.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  fsyncDirectorySync,
  renameFileSyncRetrying,
} from '@kontourai/station-shared/fs-windows-compat';

const PRIVATE_FILE_MODE = 0o600;

/** A present file that fails any custody or parse check. Carries no content. */
export class PrivateJsonFileError extends Error {
  constructor(readonly label: string) {
    super(`${label} is unreadable or unsafe`);
  }
}

/**
 * The parsed JSON value, or null when the file does not exist. Any other
 * failure throws {@link PrivateJsonFileError} without the parser's message,
 * which could quote private content.
 */
export function readPrivateJsonFile(
  path: string,
  maxBytes: number,
  label: string,
): unknown {
  let descriptor: number | undefined;
  let observedFile = false;
  try {
    const link = lstatSync(path);
    observedFile = true;
    if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1)
      throw new Error('invalid file');
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      status.size > maxBytes ||
      status.dev !== link.dev ||
      status.ino !== link.ino ||
      (process.platform !== 'win32' &&
        (status.mode & 0o777) !== PRIVATE_FILE_MODE)
    )
      throw new Error('invalid file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw new Error('oversized file');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch (error) {
    if (!observedFile && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null;
    throw new PrivateJsonFileError(label);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Atomic 0600 replace. Throws if the serialized value exceeds `maxBytes`. */
export function writePrivateJsonFileSync(
  path: string,
  value: unknown,
  maxBytes: number,
  label: string,
): void {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > maxBytes)
    throw new Error(`${label} exceeds the byte limit`);
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      PRIVATE_FILE_MODE,
    );
    if (process.platform !== 'win32') fchmodSync(descriptor, PRIVATE_FILE_MODE);
    writeFileSync(descriptor, serialized, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameFileSyncRetrying(temporaryPath, path);
    try {
      fsyncDirectorySync(dirname(path));
    } catch {}
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}
