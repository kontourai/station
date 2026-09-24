/**
 * The bounded reader for a `plugin.json` Station does not own yet (#2342).
 *
 * It covers these reads of untrusted trees:
 * - `POST /api/plugins/validate`: an author-named folder, read in place;
 * - `POST /api/plugins/preview` and install: the tree staged from a local
 *   path or a git clone (`fetchPluginSource`);
 * - fetched dependency sources, in dependency resolution and dependency
 *   install;
 * - the registry provider's staged source (`JsonManifestRegistryProvider`);
 * - the plugin update route, after `git pull --ff-only` or a registry
 *   re-fetch rewrites the installed tree.
 *
 * An untrusted tree can make `plugin.json` anything. A symlink points it at
 * any file this user can read (and the loader then echoes its bytes in a
 * parse error, or its `name`/`version`/`description` in a preview); a FIFO
 * blocks the read forever; a device such as `/dev/zero` streams without end.
 * So the manifest must be a regular file in the tree itself, and the read is
 * capped. Refusal messages never quote the file's bytes.
 *
 * Other reads of installed trees (runtime loading, inventory, conflict
 * detection, uninstall) are NOT routed through this and are unchanged: those
 * trees are Station's copies, admitted by the reads above.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { parsePluginManifestDocumentWithFormat } from './plugin-manifest-loader.js';

/** Far above any real manifest; low enough that a hostile file cannot stall a request. */
export const PLUGIN_MANIFEST_MAX_BYTES = 1024 * 1024;

export type PluginManifestReadRefusalCode =
  | 'manifest-missing'
  | 'manifest-not-regular-file'
  | 'manifest-too-large';

export type BoundedPluginManifestRead =
  | { ok: true; raw: string }
  | { ok: false; code: PluginManifestReadRefusalCode; message: string };

const TOO_LARGE = `plugin.json is larger than ${PLUGIN_MANIFEST_MAX_BYTES} bytes.`;
const NOT_REGULAR = 'plugin.json is not a regular file.';

/**
 * Reads `manifestPath` only if it is a regular file, never following a
 * symlink, and never more than {@link PLUGIN_MANIFEST_MAX_BYTES}.
 */
export function readPluginManifestBytesBounded(
  manifestPath: string,
): BoundedPluginManifestRead {
  const refuse = (
    code: PluginManifestReadRefusalCode,
    message: string,
  ): BoundedPluginManifestRead => ({ ok: false, code, message });
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(manifestPath);
  } catch {
    return refuse(
      'manifest-missing',
      'Not a valid plugin: plugin.json not found in the folder.',
    );
  }
  if (info.isSymbolicLink()) {
    return refuse(
      'manifest-not-regular-file',
      'plugin.json is a symlink. Station reads the manifest from the plugin folder itself; replace the link with the file.',
    );
  }
  if (!info.isFile()) return refuse('manifest-not-regular-file', NOT_REGULAR);
  if (info.size > PLUGIN_MANIFEST_MAX_BYTES) {
    return refuse('manifest-too-large', TOO_LARGE);
  }
  // The open is non-blocking and refuses a final-component symlink, so a
  // FIFO swapped in after the lstat cannot block the server thread (a
  // synchronous blocking open is beyond any timeout above this). Both flags
  // are POSIX; on Windows they read as 0. The descriptor is then checked
  // against the lstat: it must be a regular file with the SAME inode and
  // device, so a swap between lstat and open (to a symlink's target, or to
  // any other file) is refused on every platform, including Windows. The
  // read itself is capped rather than trusting either size. What this does
  // not cover: a directory component swapped for a symlink above the file.
  let fd: number;
  try {
    fd = openSync(
      manifestPath,
      constants.O_RDONLY |
        (constants.O_NONBLOCK ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    // ELOOP (swapped to a symlink after the lstat) or it vanished.
    return refuse('manifest-not-regular-file', NOT_REGULAR);
  }
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev
    ) {
      return refuse('manifest-not-regular-file', NOT_REGULAR);
    }
    const buffer = Buffer.alloc(PLUGIN_MANIFEST_MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > PLUGIN_MANIFEST_MAX_BYTES) {
        return refuse('manifest-too-large', TOO_LARGE);
      }
    }
    return { ok: true, raw: buffer.subarray(0, length).toString('utf8') };
  } finally {
    closeSync(fd);
  }
}

/** A staged or author-named `plugin.json` Station refused to read. */
export class PluginManifestReadRefusedError extends Error {
  readonly name = 'PluginManifestReadRefusedError';

  constructor(
    readonly code: PluginManifestReadRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * {@link readPluginManifestBytesBounded} then the ordinary manifest parse.
 * Throws {@link PluginManifestReadRefusedError} for a refused read, and
 * whatever the parser throws for a bad document.
 */
export function readUntrustedPluginManifestSyncWithFormat(
  manifestPath: string,
): ReturnType<typeof parsePluginManifestDocumentWithFormat> {
  const read = readPluginManifestBytesBounded(manifestPath);
  if (!read.ok)
    throw new PluginManifestReadRefusedError(read.code, read.message);
  return parsePluginManifestDocumentWithFormat(read.raw, manifestPath);
}
