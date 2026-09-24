/**
 * Station's own verification of an installed device tool tree (#1970).
 *
 * What each check establishes, precisely:
 * - Every package's CONTENT was checked by npm itself: `npm ci` fetches each
 *   tarball and verifies it against the lockfile's sha512 (ssri) before
 *   extracting it. Station does not re-hash every dependency's files.
 * - Station re-hashes the TOOL'S OWN package end to end: it finds the
 *   tarball npm fetched in the install's private cache, checks its sha512
 *   against the pin, and compares every file in it byte-for-byte (sha256)
 *   with what was extracted. The entry point therefore runs exactly the
 *   pinned bytes.
 * - The tree SHAPE: walking every `node_modules` (scoped and nested
 *   included), every entry — file or directory — must be a pinned package
 *   directory with a manifest (npm's own `.package-lock.json` and `.bin`
 *   links excepted), and npm's record of the tree must carry each pinned
 *   version and integrity. Nothing unpinned can sit on the resolution path.
 *   `.bin` link targets are not re-checked: nothing Station runs resolves
 *   through them.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { DeviceToolFailure } from '@kontourai/station-contracts/device-toolchain';
import type { DeviceToolPin } from './device-tool-pins.js';

export interface TreeProblem {
  reason: DeviceToolFailure;
  message: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The first entry in any `node_modules` directory under `root` that the
 * lockfile does not account for, as a lockfile-style path. Every entry must
 * be a real (not symlinked) directory at a pinned package path (scoped ones
 * under their `@scope/`), whose manifest version was checked above; the only exceptions are npm's own record
 * (`node_modules/.package-lock.json`, top level) and `.bin` link directories
 * when a pinned package declares a `bin`. A loose `node_modules/<name>.js`
 * would shadow a CommonJS `require('<name>')`, and a directory without a
 * manifest or a dot-directory is not something npm installed from the pin.
 */
function unpinnedEntry(root: string, pin: DeviceToolPin): string | undefined {
  const allowBin = Object.values(pin.lock.packages).some(
    (entry) => entry.bin !== undefined,
  );
  const rel = (path: string) => relative(root, path).split(sep).join('/');
  const checkPackage = (dir: string): string | undefined => {
    const key = rel(dir);
    // Membership only: every pinned path's manifest and version were
    // already checked against the lockfile above.
    if (!(key in pin.lock.packages)) return key;
    const nested = join(dir, 'node_modules');
    return existsSync(nested) ? walk(nested, false) : undefined;
  };
  const walk = (modulesDir: string, top: boolean): string | undefined => {
    for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
      const path = join(modulesDir, entry.name);
      if (top && entry.name === '.package-lock.json' && entry.isFile())
        continue;
      if (entry.name === '.bin' && allowBin && entry.isDirectory()) continue;
      // A symlink is never a package npm installed from the pin, even when
      // it points at a directory with the right manifest.
      if (!entry.isDirectory()) return rel(path);
      if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(path, { withFileTypes: true })) {
          const scopedPath = join(path, scoped.name);
          if (!scoped.isDirectory()) return rel(scopedPath);
          const problem = checkPackage(scopedPath);
          if (problem !== undefined) return problem;
        }
        continue;
      }
      const problem = checkPackage(path);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  const top = join(root, 'node_modules');
  return existsSync(top) ? walk(top, true) : undefined;
}

/** The tarball npm cached for `integrity`, in the install's private cache. */
function cachedTarball(cacheDir: string, integrity: string): string {
  const hex = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString(
    'hex',
  );
  return join(
    cacheDir,
    '_cacache',
    'content-v2',
    'sha512',
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4),
  );
}

/** Regular files in a (gunzipped) tar, by path. Handles ustar, pax and GNU names. */
function tarFiles(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | undefined;
  const text = (start: number, length: number) =>
    tar
      .subarray(start, start + length)
      .toString('utf8')
      .replace(/\0.*$/s, '');
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = text(offset + 345, 155);
    const name = text(offset, 100);
    const bodyStart = offset + 512;
    const body = tar.subarray(bodyStart, bodyStart + size);
    if (type === 'x') {
      const match = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (match?.[1]) longName = match[1];
    } else if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
    } else {
      const path = longName ?? (prefix ? `${prefix}/${name}` : name);
      longName = undefined;
      if (type === '0' || type === '\0') files.set(path, Buffer.from(body));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Files under `dir`, relative, excluding nested `node_modules`. */
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' && dir === base) continue;
      out.push(...listFiles(path, base));
    } else out.push(relative(base, path).split(sep).join('/'));
  }
  return out;
}

/**
 * Verify `dir` (a finished `npm ci` of `pin`'s lockfile, with its private
 * cache at `dir/.npm-cache`). Returns the first problem, or undefined.
 */
export function verifyInstalledTree(
  dir: string,
  pin: DeviceToolPin,
): TreeProblem | undefined {
  const recorded = readJson(join(dir, 'node_modules', '.package-lock.json')) as
    | { packages?: Record<string, { version?: string; integrity?: string }> }
    | undefined;
  if (!recorded?.packages || typeof recorded.packages !== 'object')
    return {
      reason: 'integrity-mismatch',
      message:
        'The installed tree has no package record, so its integrity cannot be confirmed.',
    };
  for (const [path, entry] of Object.entries(pin.lock.packages)) {
    if (path === '') continue;
    const actual = recorded.packages[path];
    if (actual?.integrity !== entry.integrity)
      return {
        reason: 'integrity-mismatch',
        message: `${path} was recorded with integrity ${actual?.integrity ?? 'none'}, not the pinned ${entry.integrity}.`,
      };
    const manifest = readJson(join(dir, path, 'package.json')) as
      | { version?: unknown }
      | undefined;
    if (manifest?.version !== entry.version)
      return {
        reason: 'integrity-mismatch',
        message: `${path} is ${String(manifest?.version ?? 'missing')}, not the pinned ${entry.version}.`,
      };
  }
  const unrecorded =
    Object.keys(recorded.packages).find(
      (path) => path !== '' && !(path in pin.lock.packages),
    ) ?? unpinnedEntry(dir, pin);
  if (unrecorded !== undefined)
    return {
      reason: 'integrity-mismatch',
      message: `${unrecorded} is not a package npm installed from the pinned lockfile.`,
    };
  const toolDir = join(dir, 'node_modules', pin.tool);
  if (!existsSync(join(toolDir, ...pin.entry)))
    return {
      reason: 'entry-missing',
      message: `The installed ${pin.tool} has no entry point at ${pin.entry.join('/')}.`,
    };
  // The tool's own package, re-hashed end to end.
  const tarballPath = cachedTarball(
    join(dir, '.npm-cache'),
    pin.requiredIntegrity,
  );
  let tarball: Buffer;
  try {
    tarball = readFileSync(tarballPath);
  } catch {
    return {
      reason: 'integrity-mismatch',
      message: `The fetched ${pin.tool} tarball is not in the install's cache, so its content cannot be confirmed.`,
    };
  }
  const digest = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (digest !== pin.requiredIntegrity)
    return {
      reason: 'integrity-mismatch',
      message: `The fetched ${pin.tool} tarball hashes to ${digest}, not the pinned ${pin.requiredIntegrity}.`,
    };
  let files: Map<string, Buffer>;
  try {
    files = tarFiles(gunzipSync(tarball));
  } catch {
    return {
      reason: 'integrity-mismatch',
      message: `The fetched ${pin.tool} tarball could not be read.`,
    };
  }
  const expected = new Map<string, string>();
  for (const [path, body] of files) {
    const rel = path.replace(/^[^/]+\//, '');
    if (rel) expected.set(rel, sha256(body));
  }
  for (const [rel, hash] of expected) {
    const installed = join(toolDir, ...rel.split('/'));
    let bytes: Buffer;
    try {
      if (!statSync(installed).isFile()) throw new Error('not a file');
      bytes = readFileSync(installed);
    } catch {
      return {
        reason: 'integrity-mismatch',
        message: `${pin.tool}/${rel} from the pinned tarball is missing from the install.`,
      };
    }
    if (sha256(bytes) !== hash)
      return {
        reason: 'integrity-mismatch',
        message: `${pin.tool}/${rel} differs from the pinned tarball.`,
      };
  }
  const extra = listFiles(toolDir).find((rel) => !expected.has(rel));
  if (extra !== undefined)
    return {
      reason: 'integrity-mismatch',
      message: `${pin.tool}/${extra} is not in the pinned tarball.`,
    };
  return undefined;
}
