#!/usr/bin/env node
/**
 * Android requires native libraries to be 16 KB page aligned. A release APK
 * must satisfy both the ELF loader constraints and the ZIP-container
 * constraints that `zipalign -c -P 16` checks. Build success is not proof:
 * packaging flags can be dropped while still producing an APK.
 *
 * This deliberately parses the APK itself. That keeps the release gate
 * hermetic: a missing host `zipalign` executable cannot turn a packaging
 * defect into an unverified pass.
 *
 * Usage: node scripts/check-android-16kb-alignment.mjs <path-to.apk>
 */
import { readFileSync } from 'node:fs';

export const REQUIRED_ALIGNMENT = 0x4000;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_UTF8_NAME_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP64_U16_SENTINEL = 0xffff;
const ZIP64_U32_SENTINEL = 0xffff_ffff;
const APK_SIGNING_BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'ascii');

function readU16(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) {
    throw new Error('APK ZIP record is truncated');
  }
  return buffer.readUInt16LE(offset);
}

function readU32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) {
    throw new Error('APK ZIP record is truncated');
  }
  return buffer.readUInt32LE(offset);
}

function isNativeLibraryPath(name) {
  return /^lib\/[^/]+\/[^/]+\.so$/.test(name);
}

function decodeZipName(bytes) {
  try {
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (
      [...name].some((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && (code < 0x20 || code === 0x7f);
      })
    ) {
      throw new Error('invalid');
    }
    return name;
  } catch {
    throw new Error('APK ZIP entry name is not valid UTF-8');
  }
}

function supportedZipFlags(flags) {
  return (flags & ~(ZIP_UTF8_NAME_FLAG | ZIP_DATA_DESCRIPTOR_FLAG)) === 0;
}

function invalidNativeLibraryMetadata() {
  return new Error('APK ZIP native library metadata is invalid');
}

function readApkSigningBlockStart(apk, centralOffset) {
  // The APK Signing Block sits immediately before the ZIP central directory:
  // uint64 size | ID-value pairs | uint64 same size | 16-byte magic. Its
  // declared size excludes only the leading uint64.
  if (centralOffset < 24) return centralOffset;
  if (
    !apk
      .subarray(centralOffset - APK_SIGNING_BLOCK_MAGIC.length, centralOffset)
      .equals(APK_SIGNING_BLOCK_MAGIC)
  ) {
    return centralOffset;
  }
  const trailingSize = apk.readBigUInt64LE(centralOffset - 24);
  const minimumSize = 36n; // one uint64 length plus one uint32 ID, then trailer.
  const totalSize = trailingSize + 8n;
  if (
    trailingSize < minimumSize ||
    totalSize > BigInt(centralOffset) ||
    totalSize > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('APK Signing Block is invalid');
  }
  const start = centralOffset - Number(totalSize);
  if (apk.readBigUInt64LE(start) !== trailingSize) {
    throw new Error('APK Signing Block is invalid');
  }
  const pairAreaStart = start + 8;
  const pairAreaEnd = centralOffset - 24;
  let offset = pairAreaStart;
  while (offset < pairAreaEnd) {
    if (pairAreaEnd - offset < 8) {
      throw new Error('APK Signing Block is invalid');
    }
    const pairLength = apk.readBigUInt64LE(offset);
    const remaining = pairAreaEnd - offset - 8;
    if (pairLength < 4n || pairLength > BigInt(remaining)) {
      throw new Error('APK Signing Block is invalid');
    }
    offset += 8 + Number(pairLength);
  }
  if (offset !== pairAreaEnd) {
    throw new Error('APK Signing Block is invalid');
  }
  return start;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb8_8320 : 0);
  }
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

/**
 * Return stored native libraries with their *data* offset, not their local
 * header offset. Android's ZIP alignment requirement applies to the first
 * byte of the uncompressed library data.
 */
export function readApkNativeLibraries(apk) {
  // EOCD is followed only by an optional <= 65535-byte comment. Search the
  // bounded suffix backwards so a signature in file data cannot be mistaken
  // for the directory terminator.
  const searchStart = Math.max(0, apk.length - 0xffff - 22);
  let eocd = -1;
  for (let offset = apk.length - 22; offset >= searchStart; offset -= 1) {
    if (readU32(apk, offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      const commentLength = readU16(apk, offset + 20);
      if (offset + 22 + commentLength === apk.length) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) throw new Error('APK ZIP end-of-central-directory is missing');

  const disk = readU16(apk, eocd + 4);
  const centralDisk = readU16(apk, eocd + 6);
  const entriesOnDisk = readU16(apk, eocd + 8);
  const entryCount = readU16(apk, eocd + 10);
  const centralSize = readU32(apk, eocd + 12);
  const centralOffset = readU32(apk, eocd + 16);
  if (
    entriesOnDisk === ZIP64_U16_SENTINEL ||
    entryCount === ZIP64_U16_SENTINEL ||
    centralSize === ZIP64_U32_SENTINEL ||
    centralOffset === ZIP64_U32_SENTINEL
  ) {
    throw new Error('APK ZIP64 archives are unsupported');
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('APK ZIP multi-disk archives are unsupported');
  }
  if (centralOffset + centralSize !== eocd) {
    throw new Error('APK ZIP central directory is out of bounds');
  }

  const entries = [];
  const rawNames = new Set();
  const canonicalNames = new Set();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(apk, offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error('APK ZIP central-directory entry is invalid');
    }
    const flags = readU16(apk, offset + 8);
    const compression = readU16(apk, offset + 10);
    const crc32 = readU32(apk, offset + 16);
    const compressedSize = readU32(apk, offset + 20);
    const uncompressedSize = readU32(apk, offset + 24);
    const nameLength = readU16(apk, offset + 28);
    const extraLength = readU16(apk, offset + 30);
    const commentLength = readU16(apk, offset + 32);
    const diskStart = readU16(apk, offset + 34);
    const localHeaderOffset = readU32(apk, offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > centralOffset + centralSize) {
      throw new Error('APK ZIP central-directory entry is truncated');
    }
    const nameBytes = apk.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeZipName(nameBytes);
    offset = entryEnd;
    if (
      diskStart !== 0 ||
      localHeaderOffset === ZIP64_U32_SENTINEL ||
      compressedSize === ZIP64_U32_SENTINEL ||
      uncompressedSize === ZIP64_U32_SENTINEL ||
      !supportedZipFlags(flags)
    ) {
      throw new Error('APK ZIP entry metadata is invalid');
    }
    const rawName = nameBytes.toString('hex');
    if (rawNames.has(rawName) || canonicalNames.has(name)) {
      throw new Error('APK ZIP entry names are duplicated');
    }
    rawNames.add(rawName);
    canonicalNames.add(name);
    entries.push({
      name,
      nameBytes,
      flags,
      compression,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      nativeLibrary: isNativeLibraryPath(name),
    });
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error('APK ZIP central-directory size disagrees');
  }

  const finalLocalBoundary = readApkSigningBlockStart(apk, centralOffset);
  const localOffsets = new Set();
  const orderedEntries = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const nextBoundary =
      orderedEntries[index + 1]?.localHeaderOffset ?? finalLocalBoundary;
    if (
      entry.localHeaderOffset >= nextBoundary ||
      entry.localHeaderOffset >= finalLocalBoundary ||
      localOffsets.has(entry.localHeaderOffset)
    ) {
      throw new Error('APK ZIP local-entry layout is invalid');
    }
    localOffsets.add(entry.localHeaderOffset);
    if (readU32(apk, entry.localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
      throw entry.nativeLibrary
        ? invalidNativeLibraryMetadata()
        : new Error('APK ZIP local-entry metadata is invalid');
    }
    const localFlags = readU16(apk, entry.localHeaderOffset + 6);
    const localCompression = readU16(apk, entry.localHeaderOffset + 8);
    const localCrc32 = readU32(apk, entry.localHeaderOffset + 14);
    const localCompressedSize = readU32(apk, entry.localHeaderOffset + 18);
    const localUncompressedSize = readU32(apk, entry.localHeaderOffset + 22);
    const localNameLength = readU16(apk, entry.localHeaderOffset + 26);
    const localExtraLength = readU16(apk, entry.localHeaderOffset + 28);
    const dataOffset =
      entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const fail = () =>
      entry.nativeLibrary
        ? invalidNativeLibraryMetadata()
        : new Error('APK ZIP local-entry metadata is invalid');
    if (
      localFlags !== entry.flags ||
      localCompression !== entry.compression ||
      dataOffset > nextBoundary ||
      entry.compressedSize > nextBoundary - dataOffset
    ) {
      throw fail();
    }
    const localNameBytes = apk.subarray(
      entry.localHeaderOffset + 30,
      entry.localHeaderOffset + 30 + localNameLength,
    );
    decodeZipName(localNameBytes);
    if (!localNameBytes.equals(entry.nameBytes)) throw fail();
    const dataDescriptor = (entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
    const dataEnd = dataOffset + entry.compressedSize;
    if (
      dataDescriptor
        ? localCrc32 !== 0 ||
          localCompressedSize !== 0 ||
          localUncompressedSize !== 0
        : localCrc32 !== entry.crc32 ||
          localCompressedSize !== entry.compressedSize ||
          localUncompressedSize !== entry.uncompressedSize
    ) {
      throw fail();
    }
    if (dataDescriptor) {
      const descriptorLength = nextBoundary - dataEnd;
      let descriptorOffset = dataEnd;
      if (descriptorLength === 16) {
        if (readU32(apk, descriptorOffset) !== 0x08074b50) throw fail();
        descriptorOffset += 4;
      } else if (descriptorLength !== 12) {
        throw fail();
      }
      if (
        readU32(apk, descriptorOffset) !== entry.crc32 ||
        readU32(apk, descriptorOffset + 4) !== entry.compressedSize ||
        readU32(apk, descriptorOffset + 8) !== entry.uncompressedSize
      ) {
        throw fail();
      }
    } else if (dataEnd !== nextBoundary) {
      throw fail();
    }
    entry.dataOffset = dataOffset;
  }

  const libraries = [];
  for (const entry of entries) {
    if (!entry.nativeLibrary) continue;
    if (
      entry.compression !== 0 ||
      entry.compressedSize !== entry.uncompressedSize
    ) {
      throw invalidNativeLibraryMetadata();
    }
    const bytes = apk.subarray(
      entry.dataOffset,
      entry.dataOffset + entry.uncompressedSize,
    );
    if (crc32(bytes) !== entry.crc32) throw invalidNativeLibraryMetadata();
    libraries.push({ name: entry.name, dataOffset: entry.dataOffset, bytes });
  }
  return libraries;
}

/**
 * Parse every PT_LOAD segment from a 64- or 32-bit ELF. Returns [] for a
 * non-ELF or malformed program-header table, never a partial result.
 */
export function loadLoadSegments(buffer) {
  if (buffer.length < 64 || buffer.readUInt32BE(0) !== 0x7f454c46) return [];
  const elfClass = buffer[4];
  const encoding = buffer[5];
  if (buffer[6] !== 1 || (elfClass !== 1 && elfClass !== 2)) return [];
  if (encoding !== 1 && encoding !== 2) return [];
  const is64 = elfClass === 2;
  const little = encoding === 1;
  const u16 = (offset) =>
    little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const u32 = (offset) =>
    little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const u64 = (offset) =>
    little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
  const phoff = is64 ? Number(u64(0x20)) : u32(0x1c);
  if (u32(0x14) !== 1) return [];
  const ehsize = u16(is64 ? 0x34 : 0x28);
  const phentsize = u16(is64 ? 0x36 : 0x2a);
  const phnum = u16(is64 ? 0x38 : 0x2c);
  const headerSize = is64 ? 64 : 52;
  const minimumPhentsize = is64 ? 56 : 32;
  if (
    ehsize !== headerSize ||
    ehsize > buffer.length ||
    phentsize < minimumPhentsize ||
    phnum === 0
  ) {
    return [];
  }
  const tableSize = phnum * phentsize;
  if (
    !Number.isSafeInteger(phoff) ||
    phoff < ehsize ||
    tableSize > buffer.length ||
    phoff > buffer.length - tableSize
  ) {
    return [];
  }

  const segments = [];
  for (let index = 0; index < phnum; index += 1) {
    const base = phoff + index * phentsize;
    if (u32(base) !== 1) continue;
    const segment = is64
      ? {
          offset: u64(base + 0x08),
          vaddr: u64(base + 0x10),
          fileSize: u64(base + 0x20),
          memorySize: u64(base + 0x28),
          alignment: u64(base + 0x30),
        }
      : {
          offset: BigInt(u32(base + 0x04)),
          vaddr: BigInt(u32(base + 0x08)),
          fileSize: BigInt(u32(base + 0x10)),
          memorySize: BigInt(u32(base + 0x14)),
          alignment: BigInt(u32(base + 0x1c)),
        };
    const fileLength = BigInt(buffer.length);
    const addressLimit = is64 ? (1n << 64n) - 1n : (1n << 32n) - 1n;
    if (
      segment.fileSize > segment.memorySize ||
      segment.offset > fileLength ||
      segment.fileSize > fileLength - segment.offset ||
      segment.vaddr > addressLimit ||
      segment.memorySize > addressLimit - segment.vaddr
    ) {
      return [];
    }
    segments.push(segment);
  }
  return segments;
}

export function loadSegmentAlignments(buffer) {
  return loadLoadSegments(buffer).map((segment) => segment.alignment);
}

function isPowerOfTwo(value) {
  const big = BigInt(value);
  return big > 0n && (big & (big - 1n)) === 0n;
}

export function evaluateAlignment(entries) {
  const failures = [];
  for (const entry of entries) {
    const segments =
      entry.segments ??
      (entry.alignments ?? []).map((alignment) => ({
        alignment: BigInt(alignment),
        offset: 0n,
        vaddr: 0n,
        fileSize: 0n,
        memorySize: 0n,
      }));
    if (segments.length === 0) {
      failures.push(`${entry.name}: no PT_LOAD segments found`);
      continue;
    }
    const required = BigInt(REQUIRED_ALIGNMENT);
    const badAlignment = segments.filter(
      (segment) =>
        segment.alignment < required || !isPowerOfTwo(segment.alignment),
    );
    if (badAlignment.length > 0) {
      const seen = [
        ...new Set(badAlignment.map(({ alignment }) => String(alignment))),
      ].map((value) => `0x${BigInt(value).toString(16)}`);
      failures.push(
        `${entry.name}: LOAD segment aligned to ${seen.join(', ')}, needs 0x4000`,
      );
    }
    const incongruent = segments.filter(
      (segment) =>
        segment.alignment > 0n &&
        segment.offset % segment.alignment !==
          segment.vaddr % segment.alignment,
    );
    if (incongruent.length > 0) {
      failures.push(`${entry.name}: LOAD p_offset and p_vaddr are incongruent`);
    }
    if (
      entry.dataOffset !== undefined &&
      entry.dataOffset % REQUIRED_ALIGNMENT !== 0
    ) {
      failures.push(
        `${entry.name}: ZIP data offset ${entry.dataOffset} is not 16 KB aligned`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

function main() {
  const apkPath = process.argv[2];
  if (!apkPath) {
    console.error('usage: check-android-16kb-alignment.mjs <path-to.apk>');
    process.exit(2);
  }
  try {
    const entries = readApkNativeLibraries(readFileSync(apkPath)).map(
      (library) => ({
        ...library,
        segments: loadLoadSegments(library.bytes),
      }),
    );
    if (entries.length === 0)
      throw new Error(`${apkPath}: contains no native libraries to check`);
    const result = evaluateAlignment(entries);
    console.log(
      `Checked ZIP data offsets and PT_LOAD segments in ${entries.length} native libraries (16 KB).`,
    );
    if (!result.ok) throw new Error(result.failures.join('\n'));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'APK alignment check failed',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('check-android-16kb-alignment.mjs')) main();
