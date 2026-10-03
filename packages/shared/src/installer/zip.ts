/**
 * The zip reader of the Windows installer core (#2675 slice W).
 *
 * A prebuilt Windows server archive is a zip (portable-server-targets.mjs).
 * The installer does not hand it to an archive tool: it reads the central
 * directory itself, refuses the whole archive when any entry could land
 * outside its `station/` root, alias another entry on a case-insensitive
 * filesystem, or be anything but a plain file or directory, and only then
 * extracts it, entry by entry, with the same code. Each entry's inflated
 * bytes must match its declared size and CRC-32.
 *
 * Only what the archive builder writes (bsdtar's zip writer) is supported:
 * stored or deflated entries, no encryption, one disk, ZIP64 where needed.
 * Node.js built-ins only, and nothing newer than Node.js 20, since the core
 * runs on whichever Node.js the installer found.
 */
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export class ZipRefusal extends Error {}

export type ZipEntry = {
  /** The entry name as stored, `/`-separated. */
  name: string;
  directory: boolean;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  /** Permission bits a Unix-made entry carries (0 when none). */
  unixMode: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const DOS_DIRECTORY = 0x10;
const DOS_REPARSE_POINT = 0x400;

let crcTable: Uint32Array | undefined;

/** CRC-32 (IEEE), the checksum every zip entry declares. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new ZipRefusal('archive ends inside a zip record');
    done += read;
  }
  return buffer;
}

function safeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ZipRefusal(`zip ${what} is too large`);
  return Number(value);
}

type Directory = { offset: number; size: number; count: number };

function locateCentralDirectory(fd: number, fileSize: number): Directory {
  const tailLength = Math.min(fileSize, 22 + MAX_COMMENT);
  const tail = readAt(fd, fileSize - tailLength, tailLength);
  let at = -1;
  for (let index = tailLength - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
      at = index;
      break;
    }
  }
  if (at === -1) throw new ZipRefusal('archive is not a zip file');
  const eocdOffset = fileSize - tailLength + at;
  const disk = tail.readUInt16LE(at + 4);
  const directoryDisk = tail.readUInt16LE(at + 6);
  let count = tail.readUInt16LE(at + 10);
  let size = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  const commentLength = tail.readUInt16LE(at + 20);
  if (at + 22 + commentLength !== tailLength)
    throw new ZipRefusal('zip end record is followed by unexpected bytes');
  if (disk !== 0 || directoryDisk !== 0)
    throw new ZipRefusal('multi-disk zip archives are not supported');
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    if (eocdOffset < 20) throw new ZipRefusal('zip64 locator is missing');
    const locator = readAt(fd, eocdOffset - 20, 20);
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE)
      throw new ZipRefusal('zip64 locator is missing');
    const record = readAt(
      fd,
      safeNumber(locator.readBigUInt64LE(8), 'zip64 record offset'),
      56,
    );
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE)
      throw new ZipRefusal('zip64 end record is missing');
    count = safeNumber(record.readBigUInt64LE(32), 'entry count');
    size = safeNumber(record.readBigUInt64LE(40), 'central directory size');
    offset = safeNumber(record.readBigUInt64LE(48), 'central directory offset');
  }
  if (count === 0) throw new ZipRefusal('archive has no entries');
  if (offset + size > eocdOffset)
    throw new ZipRefusal('zip central directory overlaps its end record');
  return { offset, size, count };
}

function zip64Values(
  extra: Buffer,
  wanted: { size: boolean; compressed: boolean; offset: boolean },
): { size?: number; compressed?: number; offset?: number } {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (at + 4 + length > extra.length)
      throw new ZipRefusal('zip extra field is truncated');
    if (id === 0x0001) {
      const values: { size?: number; compressed?: number; offset?: number } =
        {};
      let cursor = at + 4;
      const next = (what: string) => {
        if (cursor + 8 > at + 4 + length)
          throw new ZipRefusal('zip64 extra field is truncated');
        const value = safeNumber(extra.readBigUInt64LE(cursor), what);
        cursor += 8;
        return value;
      };
      if (wanted.size) values.size = next('entry size');
      if (wanted.compressed) values.compressed = next('entry size');
      if (wanted.offset) values.offset = next('entry offset');
      return values;
    }
    at += 4 + length;
  }
  throw new ZipRefusal('zip64 extra field is missing');
}

/** Reads every central directory entry of the zip open at `fd`. */
export function readZipDirectory(fd: number): ZipEntry[] {
  const fileSize = fstatSync(fd).size;
  const directory = locateCentralDirectory(fd, fileSize);
  const bytes = readAt(fd, directory.offset, directory.size);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < directory.count; index += 1) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIGNATURE)
      throw new ZipRefusal('zip central directory is malformed');
    const madeBy = bytes.readUInt16LE(at + 4) >> 8;
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    let compressedSize = bytes.readUInt32LE(at + 20);
    let size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const diskStart = bytes.readUInt16LE(at + 34);
    const external = bytes.readUInt32LE(at + 38);
    let localHeaderOffset = bytes.readUInt32LE(at + 42);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length)
      throw new ZipRefusal('zip central directory is malformed');
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    const extra = bytes.subarray(
      at + 46 + nameLength,
      at + 46 + nameLength + extraLength,
    );
    if (
      size === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const values = zip64Values(extra, {
        size: size === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localHeaderOffset === 0xffffffff,
      });
      size = values.size ?? size;
      compressedSize = values.compressed ?? compressedSize;
      localHeaderOffset = values.offset ?? localHeaderOffset;
    }
    // Bit 11 declares UTF-8; without it the name is CP437, which agrees with
    // UTF-8 only for ASCII, so anything else is refused rather than guessed.
    const utf8 = (flags & 0x0800) !== 0;
    if (!utf8 && rawName.some((byte) => byte >= 0x80))
      throw new ZipRefusal('zip entry name is not ASCII or declared UTF-8');
    const name = rawName.toString('utf8');
    if (utf8 && !Buffer.from(name, 'utf8').equals(rawName))
      throw new ZipRefusal('zip entry name is not valid UTF-8');
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0)
      throw new ZipRefusal(`zip entry ${name} is encrypted`);
    if (method !== 0 && method !== 8)
      throw new ZipRefusal(
        `zip entry ${name} uses unsupported compression ${method}`,
      );
    if (diskStart !== 0)
      throw new ZipRefusal('multi-disk zip archives are not supported');
    let directoryEntry = name.endsWith('/');
    let unixMode = 0;
    if (madeBy === UNIX_HOST) {
      const mode = external >>> 16;
      const type = mode & S_IFMT;
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR)
        throw new ZipRefusal(
          `zip entry ${name} is not a regular file or directory`,
        );
      if (type === S_IFDIR) directoryEntry = true;
      if (type === S_IFREG && directoryEntry)
        throw new ZipRefusal(`zip entry ${name} is not a regular file`);
      unixMode = mode & 0o777;
    }
    if ((external & DOS_REPARSE_POINT) !== 0)
      throw new ZipRefusal(`zip entry ${name} is a reparse point`);
    if ((external & DOS_DIRECTORY) !== 0) directoryEntry = true;
    if (directoryEntry && !name.endsWith('/'))
      throw new ZipRefusal(`zip directory entry ${name} lacks a trailing /`);
    if (directoryEntry && size !== 0)
      throw new ZipRefusal(`zip directory entry ${name} has content`);
    entries.push({
      name,
      directory: directoryEntry,
      method,
      crc32: crc,
      compressedSize,
      size,
      localHeaderOffset,
      unixMode,
    });
    at = end;
  }
  if (at !== bytes.length)
    throw new ZipRefusal('zip central directory has trailing bytes');
  return entries;
}

// Device names Windows resolves in any directory, with or without an
// extension (and with spaces before it: `nul .txt`), including the console
// and clock devices, and characters it forbids or reinterprets in a name.
const RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$) *(?:\..*)?$/i;
const FORBIDDEN_CHARACTER = /[<>:"|?*\\]/;

/**
 * Why `name` may not be extracted beneath `root/` on Windows, or null when it
 * may. `root` is the archive's single top-level directory.
 */
export function unsafeEntryName(name: string, root: string): string | null {
  if (!name.startsWith(`${root}/`)) return `is outside ${root}/`;
  if ([...name].some((char) => char < ' ' || char === '\u007f'))
    return 'contains a control character';
  if (FORBIDDEN_CHARACTER.test(name))
    return 'contains a character Windows forbids or reinterprets';
  const segments = name.slice(root.length + 1).split('/');
  if (name.endsWith('/')) segments.pop();
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..')
      return 'has an empty, `.` or `..` path segment';
    if (/[. ]$/.test(segment))
      return 'has a segment Windows would rename (a trailing dot or space)';
    if (RESERVED_NAME.test(segment)) return 'names a Windows device';
  }
  return null;
}

/**
 * Refuses the archive unless every entry is safe to extract (see
 * unsafeEntryName) and no two entries collide on a case-insensitive
 * filesystem, including a file that another entry treats as a directory.
 */
export function validateZipEntries(entries: ZipEntry[], root: string): void {
  const seen = new Map<string, ZipEntry>();
  const directories = new Set<string>();
  for (const entry of entries) {
    const reason = unsafeEntryName(entry.name, root);
    if (reason) throw new ZipRefusal(`zip entry ${entry.name} ${reason}`);
    const key = entry.name.replace(/\/$/, '').toLowerCase();
    if (seen.has(key))
      throw new ZipRefusal(
        `zip entries ${seen.get(key)?.name} and ${entry.name} name the same path`,
      );
    seen.set(key, entry);
    const parts = key.split('/');
    for (let index = 1; index < parts.length; index += 1)
      directories.add(parts.slice(0, index).join('/'));
  }
  for (const [key, entry] of seen)
    if (!entry.directory && directories.has(key))
      throw new ZipRefusal(
        `zip entry ${entry.name} is a file that other entries use as a directory`,
      );
}

/** The inflated, CRC-checked bytes of one file entry. */
export function readZipEntry(fd: number, entry: ZipEntry): Buffer {
  const header = readAt(fd, entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE)
    throw new ZipRefusal(`zip entry ${entry.name} has no local header`);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const localName = readAt(fd, entry.localHeaderOffset + 30, nameLength);
  if (!localName.equals(Buffer.from(entry.name, 'utf8')))
    throw new ZipRefusal(
      `zip entry ${entry.name} is named differently in its local header`,
    );
  const compressed = readAt(
    fd,
    entry.localHeaderOffset + 30 + nameLength + extraLength,
    entry.compressedSize,
  );
  let data: Buffer;
  if (entry.method === 0) {
    data = compressed;
  } else {
    try {
      // One byte more than declared, so an entry that inflates past its
      // declared size is caught below rather than silently truncated.
      data = inflateRawSync(compressed, {
        maxOutputLength: Math.max(entry.size + 1, 1),
      });
    } catch {
      throw new ZipRefusal(
        `zip entry ${entry.name} does not inflate to ${entry.size} bytes`,
      );
    }
  }
  if (data.length !== entry.size)
    throw new ZipRefusal(
      `zip entry ${entry.name} does not inflate to ${entry.size} bytes`,
    );
  if (crc32(data) !== entry.crc32)
    throw new ZipRefusal(`zip entry ${entry.name} fails its CRC-32 check`);
  return data;
}

/** Opens `path`, reads and validates its directory, and runs `use`. */
export function withZip<T>(
  path: string,
  root: string,
  use: (fd: number, entries: ZipEntry[]) => T,
): T {
  const fd = openSync(path, 'r');
  try {
    const entries = readZipDirectory(fd);
    validateZipEntries(entries, root);
    return use(fd, entries);
  } finally {
    closeSync(fd);
  }
}

/** The file entry named `name`, inflated, or null when there is none. */
export function readNamedEntry(
  fd: number,
  entries: ZipEntry[],
  name: string,
): Buffer | null {
  const entry = entries.find(
    (candidate) => candidate.name === name && !candidate.directory,
  );
  return entry ? readZipEntry(fd, entry) : null;
}

/**
 * Extracts validated `entries` beneath `destination` (which must exist and
 * be empty). Files are created exclusively, so nothing is written through a
 * path that already exists. On POSIX hosts (the core's tests) a Unix-made
 * entry keeps its permission bits minus group/other write; Windows has none.
 */
export function extractZipEntries(
  fd: number,
  entries: ZipEntry[],
  destination: string,
): void {
  const posix = process.platform !== 'win32';
  for (const entry of entries) {
    const target = join(destination, ...entry.name.split('/').filter(Boolean));
    if (entry.directory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(join(target, '..'), { recursive: true });
    const mode = posix && entry.unixMode ? entry.unixMode & 0o755 : 0o644;
    writeFileSync(target, readZipEntry(fd, entry), { flag: 'wx', mode });
  }
}
