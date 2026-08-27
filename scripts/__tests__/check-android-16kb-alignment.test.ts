import { describe, expect, it } from 'vitest';
import {
  crc32,
  evaluateAlignment,
  loadLoadSegments,
  loadSegmentAlignments,
  REQUIRED_ALIGNMENT,
  readApkNativeLibraries,
} from '../check-android-16kb-alignment.mjs';

/**
 * Verified against the real artefacts before these fixtures were written: the
 * pre-fix `libstation_ai_lib.so` reports 0x1000 and is rejected, the rebuilt
 * one reports 0x4000 and passes. The synthetic ELFs below keep that behaviour
 * pinned without committing a 130 MB binary.
 */

/** Minimal 64-bit little-endian ELF carrying one PT_LOAD of a given p_align. */
function elf64({
  align,
  offset = 0,
  vaddr = 0,
  fileSize = 1,
  memorySize = fileSize,
}: {
  align: number | bigint;
  offset?: number | bigint;
  vaddr?: number | bigint;
  fileSize?: number | bigint;
  memorySize?: number | bigint;
}): Buffer {
  const phoff = 64;
  const phentsize = 56;
  const buffer = Buffer.alloc(phoff + phentsize);
  buffer.writeUInt32BE(0x7f454c46, 0); // magic
  buffer[4] = 2; // 64-bit
  buffer[5] = 1; // little endian
  buffer[6] = 1; // ELF version
  buffer.writeUInt32LE(1, 0x14); // e_version
  buffer.writeBigUInt64LE(BigInt(phoff), 0x20);
  buffer.writeUInt16LE(64, 0x34);
  buffer.writeUInt16LE(phentsize, 0x36);
  buffer.writeUInt16LE(1, 0x38); // one program header
  buffer.writeUInt32LE(1, phoff); // PT_LOAD
  buffer.writeBigUInt64LE(BigInt(offset), phoff + 0x08);
  buffer.writeBigUInt64LE(BigInt(vaddr), phoff + 0x10);
  buffer.writeBigUInt64LE(BigInt(fileSize), phoff + 0x20);
  buffer.writeBigUInt64LE(BigInt(memorySize), phoff + 0x28);
  buffer.writeBigUInt64LE(BigInt(align), phoff + 0x30);
  return buffer;
}

/** Minimal 32-bit ELF, optionally big-endian, carrying one PT_LOAD. */
function elf32({
  align,
  big = false,
  offset = 0,
  vaddr = 0,
  fileSize = 1,
  memorySize = fileSize,
}: {
  align: number;
  big?: boolean;
  offset?: number;
  vaddr?: number;
  fileSize?: number;
  memorySize?: number;
}): Buffer {
  const phoff = 52;
  const phentsize = 32;
  const buffer = Buffer.alloc(phoff + phentsize);
  buffer.writeUInt32BE(0x7f454c46, 0);
  buffer[4] = 1; // 32-bit
  buffer[5] = big ? 2 : 1;
  const w32 = (value: number, offset: number) =>
    big
      ? buffer.writeUInt32BE(value, offset)
      : buffer.writeUInt32LE(value, offset);
  const w16 = (value: number, offset: number) =>
    big
      ? buffer.writeUInt16BE(value, offset)
      : buffer.writeUInt16LE(value, offset);
  buffer[6] = 1;
  w32(1, 0x14);
  w32(phoff, 0x1c);
  w16(52, 0x28);
  w16(phentsize, 0x2a);
  w16(1, 0x2c);
  w32(1, phoff); // PT_LOAD
  w32(offset, phoff + 0x04);
  w32(vaddr, phoff + 0x08);
  w32(fileSize, phoff + 0x10);
  w32(memorySize, phoff + 0x14);
  w32(align, phoff + 0x1c);
  return buffer;
}

function signingPair(id = 0x7109_8701, value = Buffer.alloc(0)): Buffer {
  const pair = Buffer.alloc(value.length + 12);
  pair.writeBigUInt64LE(BigInt(value.length + 4), 0);
  pair.writeUInt32LE(id, 8);
  value.copy(pair, 12);
  return pair;
}

function apkSigningBlock(pairArea = signingPair()): Buffer {
  const size = BigInt(pairArea.length + 24);
  const block = Buffer.alloc(pairArea.length + 32);
  block.writeBigUInt64LE(size, 0);
  pairArea.copy(block, 8);
  block.writeBigUInt64LE(size, 8 + pairArea.length);
  Buffer.from('APK Sig Block 42', 'ascii').copy(block, 16 + pairArea.length);
  return block;
}

function storedApk({
  name = 'lib/arm64-v8a/libstation.so',
  elf = elf64({ align: REQUIRED_ALIGNMENT }),
  dataOffset = REQUIRED_ALIGNMENT,
  compression = 0,
  flags = 0,
  localFlags = flags,
  centralName = Buffer.from(name),
  localName = centralName,
  centralExtra = Buffer.alloc(0),
  dataDescriptor = false,
  descriptorSignature = true,
  signingBlock = Buffer.alloc(0),
}: {
  name?: string;
  elf?: Buffer;
  dataOffset?: number;
  compression?: number;
  flags?: number;
  localFlags?: number;
  centralName?: Buffer;
  localName?: Buffer;
  centralExtra?: Buffer;
  dataDescriptor?: boolean;
  descriptorSignature?: boolean;
  signingBlock?: Buffer;
} = {}): Buffer {
  const extraLength = dataOffset - 30 - localName.length;
  if (extraLength < 0 || extraLength > 0xffff) {
    throw new Error('test APK dataOffset cannot encode a local header');
  }
  const local = Buffer.alloc(dataOffset);
  const checksum = crc32(elf);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(localFlags, 6);
  local.writeUInt16LE(compression, 8);
  local.writeUInt32LE(dataDescriptor ? 0 : checksum, 14);
  local.writeUInt32LE(dataDescriptor ? 0 : elf.length, 18);
  local.writeUInt32LE(dataDescriptor ? 0 : elf.length, 22);
  local.writeUInt16LE(localName.length, 26);
  local.writeUInt16LE(extraLength, 28);
  localName.copy(local, 30);

  const descriptor = Buffer.alloc(
    dataDescriptor ? (descriptorSignature ? 16 : 12) : 0,
  );
  if (dataDescriptor) {
    const descriptorOffset = descriptorSignature ? 4 : 0;
    if (descriptorSignature) descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(checksum, descriptorOffset);
    descriptor.writeUInt32LE(elf.length, descriptorOffset + 4);
    descriptor.writeUInt32LE(elf.length, descriptorOffset + 8);
  }

  const central = Buffer.alloc(46 + centralName.length + centralExtra.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(compression, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(elf.length, 20);
  central.writeUInt32LE(elf.length, 24);
  central.writeUInt16LE(centralName.length, 28);
  central.writeUInt16LE(centralExtra.length, 30);
  centralName.copy(central, 46);
  centralExtra.copy(central, 46 + centralName.length);

  const centralOffset =
    local.length + elf.length + descriptor.length + signingBlock.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, elf, descriptor, signingBlock, central, end]);
}

function apkWithEntries(
  entries: Array<{
    name: string;
    dataOffset: number;
    dataDescriptor?: boolean;
    descriptorSignature?: boolean;
    elf?: Buffer;
  }>,
): Buffer {
  let cursor = 0;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  for (const entry of entries) {
    const elf = entry.elf ?? elf64({ align: REQUIRED_ALIGNMENT });
    const name = Buffer.from(entry.name);
    const localOffset = cursor;
    const extraLength = entry.dataOffset - localOffset - 30 - name.length;
    if (extraLength < 0 || extraLength > 0xffff) {
      throw new Error('test APK local entry cannot be aligned');
    }
    const flags = entry.dataDescriptor ? 0x0008 : 0;
    const checksum = crc32(elf);
    const local = Buffer.alloc(entry.dataOffset - localOffset);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : checksum, 14);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : elf.length, 18);
    local.writeUInt32LE(entry.dataDescriptor ? 0 : elf.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extraLength, 28);
    name.copy(local, 30);
    const descriptor = Buffer.alloc(
      entry.dataDescriptor
        ? entry.descriptorSignature === false
          ? 12
          : 16
        : 0,
    );
    if (entry.dataDescriptor) {
      const descriptorOffset = entry.descriptorSignature === false ? 0 : 4;
      if (descriptorOffset === 4) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, descriptorOffset);
      descriptor.writeUInt32LE(elf.length, descriptorOffset + 4);
      descriptor.writeUInt32LE(elf.length, descriptorOffset + 8);
    }
    localParts.push(local, elf, descriptor);
    cursor = entry.dataOffset + elf.length + descriptor.length;

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(elf.length, 20);
    central.writeUInt32LE(elf.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(cursor, 16);
  return Buffer.concat([...localParts, central, end]);
}

describe('16 KB alignment guard', () => {
  it('computes the ZIP-standard CRC32 for stored entry bytes', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf4_3926);
  });

  it('reads the p_align of a LOAD segment', () => {
    expect(loadSegmentAlignments(elf64({ align: 0x4000 }))).toEqual([0x4000n]);
  });

  it('rejects the 4 KB alignment that shipped before the fix', () => {
    const alignments = loadSegmentAlignments(elf64({ align: 0x1000 }));
    const result = evaluateAlignment([{ name: 'lib.so', alignments }]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('0x1000');
  });

  it('accepts 16 KB', () => {
    const alignments = loadSegmentAlignments(
      elf64({ align: REQUIRED_ALIGNMENT }),
    );
    expect(evaluateAlignment([{ name: 'lib.so', alignments }]).ok).toBe(true);
  });

  it('rejects an ELF LOAD segment with incongruent p_offset and p_vaddr', () => {
    const segments = loadLoadSegments(
      elf64({ align: REQUIRED_ALIGNMENT, offset: 0, vaddr: 0x1000 }),
    );
    const result = evaluateAlignment([{ name: 'lib.so', segments }]);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      'lib.so: LOAD p_offset and p_vaddr are incongruent',
    );
  });

  it('rejects a LOAD segment whose file range extends beyond the ELF', () => {
    expect(
      loadLoadSegments(elf64({ align: REQUIRED_ALIGNMENT, fileSize: 0x1000 })),
    ).toEqual([]);
  });

  it('rejects an overflowing or unsafe LOAD file offset', () => {
    expect(
      loadLoadSegments(
        elf64({
          align: REQUIRED_ALIGNMENT,
          offset: 0x20_0000_0000_0000n,
          fileSize: 1,
        }),
      ),
    ).toEqual([]);
  });

  it('rejects a LOAD segment whose p_filesz exceeds p_memsz', () => {
    expect(
      loadLoadSegments(
        elf64({ align: REQUIRED_ALIGNMENT, fileSize: 2, memorySize: 1 }),
      ),
    ).toEqual([]);
  });

  it('rejects virtual-address overflow while accepting each class boundary', () => {
    expect(
      loadLoadSegments(
        elf64({
          align: REQUIRED_ALIGNMENT,
          vaddr: (1n << 64n) - 1n,
          fileSize: 0,
          memorySize: 1,
        }),
      ),
    ).toEqual([]);
    expect(
      loadLoadSegments(
        elf64({
          align: REQUIRED_ALIGNMENT,
          vaddr: (1n << 64n) - 1n,
          fileSize: 0,
          memorySize: 0,
        }),
      ),
    ).toHaveLength(1);
    expect(
      loadLoadSegments(
        elf32({
          align: REQUIRED_ALIGNMENT,
          vaddr: 0xffff_ffff,
          fileSize: 0,
          memorySize: 1,
        }),
      ),
    ).toEqual([]);
    expect(
      loadLoadSegments(
        elf32({
          align: REQUIRED_ALIGNMENT,
          vaddr: 0xffff_ffff,
          fileSize: 0,
          memorySize: 0,
        }),
      ),
    ).toHaveLength(1);
  });

  it('requires the current ELF identity versions and class header size', () => {
    const badIdentity = elf64({ align: REQUIRED_ALIGNMENT });
    badIdentity[6] = 0;
    expect(loadLoadSegments(badIdentity)).toEqual([]);
    const badVersion = elf64({ align: REQUIRED_ALIGNMENT });
    badVersion.writeUInt32LE(2, 0x14);
    expect(loadLoadSegments(badVersion)).toEqual([]);
    const badHeaderSize = elf64({ align: REQUIRED_ALIGNMENT });
    badHeaderSize.writeUInt16LE(52, 0x34);
    expect(loadLoadSegments(badHeaderSize)).toEqual([]);
  });

  it('checks the local ZIP data offset, not only the ELF alignment', () => {
    const [library] = readApkNativeLibraries(storedApk({ dataOffset: 0x3fff }));
    const result = evaluateAlignment([
      {
        ...library,
        segments: loadLoadSegments(library.bytes),
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      'lib/arm64-v8a/libstation.so: ZIP data offset 16383 is not 16 KB aligned',
    );
  });

  it('accepts a stored native library at a 16 KB ZIP data offset', () => {
    const [library] = readApkNativeLibraries(storedApk());
    expect(library.dataOffset).toBe(REQUIRED_ALIGNMENT);
    expect(
      evaluateAlignment([
        {
          ...library,
          segments: loadLoadSegments(library.bytes),
        },
      ]).ok,
    ).toBe(true);
  });

  it('supports canonical data descriptors and ZIP extra fields', () => {
    const [library] = readApkNativeLibraries(
      storedApk({
        flags: 0x0008,
        dataDescriptor: true,
        centralExtra: Buffer.from([0xfe, 0xca, 2, 0, 1, 2]),
      }),
    );
    expect(library.dataOffset).toBe(REQUIRED_ALIGNMENT);
  });

  it('uses the APK Signing Block as the exact final local-entry boundary', () => {
    const signingBlock = apkSigningBlock();
    for (const options of [
      { signingBlock },
      { flags: 0x0008, dataDescriptor: true, signingBlock },
      {
        flags: 0x0008,
        dataDescriptor: true,
        descriptorSignature: false,
        signingBlock,
      },
    ]) {
      expect(readApkNativeLibraries(storedApk(options))).toHaveLength(1);
    }
  });

  it('accepts multiple complete Signing Block pairs with exact exhaustion', () => {
    const signingBlock = apkSigningBlock(
      Buffer.concat([
        signingPair(0x7109_8701, Buffer.from([1, 2])),
        signingPair(0x1234_5678, Buffer.from([3])),
      ]),
    );
    expect(readApkNativeLibraries(storedApk({ signingBlock }))).toHaveLength(1);
  });

  it('rejects empty, truncated, undersized, oversized, and trailing Signing Block pairs', () => {
    const expectInvalid = (signingBlock: Buffer) =>
      expect(() => readApkNativeLibraries(storedApk({ signingBlock }))).toThrow(
        'APK Signing Block is invalid',
      );
    expectInvalid(apkSigningBlock(Buffer.alloc(0)));
    expectInvalid(apkSigningBlock(Buffer.alloc(7)));

    const zeroLength = apkSigningBlock();
    zeroLength.writeBigUInt64LE(0n, 8);
    expectInvalid(zeroLength);

    const tooSmall = apkSigningBlock();
    tooSmall.writeBigUInt64LE(3n, 8);
    expectInvalid(tooSmall);

    const oversized = apkSigningBlock();
    oversized.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 8);
    expectInvalid(oversized);

    expectInvalid(
      apkSigningBlock(Buffer.concat([signingPair(), Buffer.from([0])])),
    );
  });

  it('rejects an arbitrary final-entry gap without a valid Signing Block', () => {
    const apk = storedApk();
    const centralOffset = apk.readUInt32LE(apk.length - 6);
    const gapped = Buffer.concat([
      apk.subarray(0, centralOffset),
      Buffer.alloc(4),
      apk.subarray(centralOffset),
    ]);
    gapped.writeUInt32LE(centralOffset + 4, gapped.length - 6);
    expect(() => readApkNativeLibraries(gapped)).toThrow(
      'APK ZIP native library metadata is invalid',
    );
  });

  it('rejects malformed APK Signing Block framing', () => {
    const makeSigned = () => {
      const signingBlock = apkSigningBlock();
      return {
        apk: storedApk({ signingBlock }),
        signingBlock,
      };
    };
    const badMagic = makeSigned();
    const badMagicCentral = badMagic.apk.readUInt32LE(badMagic.apk.length - 6);
    badMagic.apk[badMagicCentral - 1] ^= 0xff;
    expect(() => readApkNativeLibraries(badMagic.apk)).toThrow(
      'APK ZIP native library metadata is invalid',
    );

    const mismatchedSizes = makeSigned();
    const mismatchCentral = mismatchedSizes.apk.readUInt32LE(
      mismatchedSizes.apk.length - 6,
    );
    mismatchedSizes.apk.writeBigUInt64LE(
      25n,
      mismatchCentral - mismatchedSizes.signingBlock.length,
    );
    expect(() => readApkNativeLibraries(mismatchedSizes.apk)).toThrow(
      'APK Signing Block is invalid',
    );

    const oversized = makeSigned();
    const oversizedCentral = oversized.apk.readUInt32LE(
      oversized.apk.length - 6,
    );
    oversized.apk.writeBigUInt64LE(
      0xffff_ffff_ffff_ffffn,
      oversizedCentral - 24,
    );
    expect(() => readApkNativeLibraries(oversized.apk)).toThrow(
      'APK Signing Block is invalid',
    );

    const truncated = makeSigned();
    const truncatedCentral = truncated.apk.readUInt32LE(
      truncated.apk.length - 6,
    );
    truncated.apk.writeBigUInt64LE(24n, truncatedCentral - 24);
    expect(() => readApkNativeLibraries(truncated.apk)).toThrow(
      'APK Signing Block is invalid',
    );
  });

  it('accepts signed and unsigned descriptors followed by another local entry', () => {
    const libraries = readApkNativeLibraries(
      apkWithEntries([
        {
          name: 'lib/arm64-v8a/libfirst.so',
          dataOffset: 0x4000,
          dataDescriptor: true,
        },
        {
          name: 'lib/arm64-v8a/libsecond.so',
          dataOffset: 0x8000,
          dataDescriptor: true,
          descriptorSignature: false,
        },
      ]),
    );
    expect(libraries.map(({ name }) => name)).toEqual([
      'lib/arm64-v8a/libfirst.so',
      'lib/arm64-v8a/libsecond.so',
    ]);
  });

  it('rejects CRC mismatch in the central record and data descriptor', () => {
    const centralMismatch = storedApk();
    const centralOffset = centralMismatch.readUInt32LE(
      centralMismatch.length - 6,
    );
    centralMismatch.writeUInt32LE(0, centralOffset + 16);
    expect(() => readApkNativeLibraries(centralMismatch)).toThrow(
      'APK ZIP native library metadata is invalid',
    );

    const descriptorMismatch = storedApk({
      flags: 0x0008,
      dataDescriptor: true,
    });
    descriptorMismatch.writeUInt32LE(
      REQUIRED_ALIGNMENT,
      REQUIRED_ALIGNMENT + 124,
    );
    expect(() => readApkNativeLibraries(descriptorMismatch)).toThrow(
      'APK ZIP native library metadata is invalid',
    );
  });

  it('rejects duplicate native central records and a central-directory gap', () => {
    expect(() =>
      readApkNativeLibraries(
        apkWithEntries([
          { name: 'lib/arm64-v8a/libsame.so', dataOffset: 0x4000 },
          { name: 'lib/arm64-v8a/libsame.so', dataOffset: 0x8000 },
        ]),
      ),
    ).toThrow('APK ZIP entry names are duplicated');
    const apk = storedApk();
    const gapped = Buffer.concat([
      apk.subarray(0, -22),
      Buffer.alloc(1),
      apk.subarray(-22),
    ]);
    expect(() => readApkNativeLibraries(gapped)).toThrow(
      'APK ZIP central directory is out of bounds',
    );
  });

  it('rejects duplicate local offsets and overlapping physical entry ranges', () => {
    const duplicateLocalOffset = apkWithEntries([
      { name: 'lib/arm64-v8a/libfirst.so', dataOffset: 0x4000 },
      { name: 'lib/arm64-v8a/libsecond.so', dataOffset: 0x8000 },
    ]);
    const centralOffset = duplicateLocalOffset.readUInt32LE(
      duplicateLocalOffset.length - 6,
    );
    const firstLocalOffset = duplicateLocalOffset.readUInt32LE(
      centralOffset + 42,
    );
    const secondCentralOffset =
      centralOffset + 46 + 'lib/arm64-v8a/libfirst.so'.length;
    duplicateLocalOffset.writeUInt32LE(
      firstLocalOffset,
      secondCentralOffset + 42,
    );
    expect(() => readApkNativeLibraries(duplicateLocalOffset)).toThrow(
      'APK ZIP local-entry layout is invalid',
    );

    const overlap = apkWithEntries([
      { name: 'lib/arm64-v8a/libfirst.so', dataOffset: 0x4000 },
      { name: 'lib/arm64-v8a/libsecond.so', dataOffset: 0x8000 },
    ]);
    const overlapCentralOffset = overlap.readUInt32LE(overlap.length - 6);
    const overlapSecondCentral =
      overlapCentralOffset + 46 + 'lib/arm64-v8a/libfirst.so'.length;
    overlap.writeUInt32LE(0x4000 + 64, overlapSecondCentral + 42);
    expect(() => readApkNativeLibraries(overlap)).toThrow(
      'APK ZIP native library metadata is invalid',
    );
  });

  it('fails loudly when a native library is compressed', () => {
    expect(() => readApkNativeLibraries(storedApk({ compression: 8 }))).toThrow(
      'APK ZIP native library metadata is invalid',
    );
  });

  it('rejects encrypted or reserved ZIP flags', () => {
    expect(() => readApkNativeLibraries(storedApk({ flags: 0x0001 }))).toThrow(
      'APK ZIP entry metadata is invalid',
    );
    expect(() => readApkNativeLibraries(storedApk({ flags: 0x0040 }))).toThrow(
      'APK ZIP entry metadata is invalid',
    );
  });

  it('rejects central/local ZIP flag disagreement', () => {
    expect(() =>
      readApkNativeLibraries(
        storedApk({ flags: 0x0008, localFlags: 0, dataDescriptor: true }),
      ),
    ).toThrow('APK ZIP native library metadata is invalid');
  });

  it('rejects invalid UTF-8 and unequal central/local raw names', () => {
    const invalidName = Buffer.from([
      ...Buffer.from('lib/arm64-v8a/lib'),
      0xc3,
      0x28,
      ...Buffer.from('.so'),
    ]);
    expect(() =>
      readApkNativeLibraries(
        storedApk({ centralName: invalidName, localName: invalidName }),
      ),
    ).toThrow('APK ZIP entry name is not valid UTF-8');
    expect(() =>
      readApkNativeLibraries(
        storedApk({ localName: Buffer.from('lib/arm64-v8a/libother.so') }),
      ),
    ).toThrow('APK ZIP native library metadata is invalid');
  });

  it('rejects nonzero per-entry disk numbers and ZIP64 sentinels', () => {
    const disk = storedApk();
    const diskCentralOffset = disk.readUInt32LE(disk.length - 6);
    disk.writeUInt16LE(1, diskCentralOffset + 34);
    expect(() => readApkNativeLibraries(disk)).toThrow(
      'APK ZIP entry metadata is invalid',
    );
    const zip64 = storedApk();
    const zip64CentralOffset = zip64.readUInt32LE(zip64.length - 6);
    zip64.writeUInt32LE(0xffff_ffff, zip64CentralOffset + 42);
    expect(() => readApkNativeLibraries(zip64)).toThrow(
      'APK ZIP entry metadata is invalid',
    );
  });

  it('accepts an alignment larger than required', () => {
    // A 64 KB-aligned library still loads on a 16 KB-page device.
    const alignments = loadSegmentAlignments(elf64({ align: 0x10000 }));
    expect(evaluateAlignment([{ name: 'lib.so', alignments }]).ok).toBe(true);
  });

  it('fails a library with no LOAD segments rather than passing it silently', () => {
    // An unreadable or truncated .so must not read as "nothing wrong".
    const result = evaluateAlignment([{ name: 'lib.so', alignments: [] }]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('no PT_LOAD');
  });

  it('reports every offending library, not just the first', () => {
    const bad = loadSegmentAlignments(elf64({ align: 0x1000 }));
    const result = evaluateAlignment([
      { name: 'arm64-v8a/lib.so', alignments: bad },
      { name: 'x86_64/lib.so', alignments: bad },
    ]);
    expect(result.failures).toHaveLength(2);
  });

  it('reads a 32-bit little-endian ELF', () => {
    expect(loadSegmentAlignments(elf32({ align: 0x4000 }))).toEqual([0x4000n]);
  });

  it('reads a 32-bit big-endian ELF', () => {
    expect(loadSegmentAlignments(elf32({ align: 0x4000, big: true }))).toEqual([
      0x4000n,
    ]);
  });

  it('rejects an undefined ELF class rather than guessing 32-bit', () => {
    const buffer = elf64({ align: 0x4000 });
    buffer[4] = 7; // not ELFCLASS32 or ELFCLASS64
    expect(loadSegmentAlignments(buffer)).toEqual([]);
  });

  it('rejects an undefined encoding rather than guessing big-endian', () => {
    const buffer = elf64({ align: 0x4000 });
    buffer[5] = 9;
    expect(loadSegmentAlignments(buffer)).toEqual([]);
  });

  it('refuses a truncated program-header table instead of passing what it read', () => {
    // Claim two headers but supply bytes for one: reporting the readable half
    // as a complete result is how a broken library passes.
    const buffer = elf64({ align: 0x4000 });
    buffer.writeUInt16LE(2, 0x38);
    expect(loadSegmentAlignments(buffer)).toEqual([]);
  });

  it('rejects a non-power-of-two alignment even when it exceeds 16 KB', () => {
    const alignments = loadSegmentAlignments(elf64({ align: 0x6000 }));
    expect(evaluateAlignment([{ name: 'lib.so', alignments }]).ok).toBe(false);
  });

  it('rejects a 64-bit non-power-of-two alignment that 32-bit maths would pass', () => {
    // 0x100004000 & (0x100004000 - 1) is 0 under JavaScript's 32-bit bitwise
    // coercion, so a naive check reports this malformed value as aligned.
    const alignments = [0x100004000n];
    expect(evaluateAlignment([{ name: 'lib.so', alignments }]).ok).toBe(false);
  });

  it('refuses a program-header size smaller than the format allows', () => {
    // A crafted e_phentsize lets overlapping reads masquerade as valid,
    // well-aligned segments.
    const buffer = elf64({ align: 0x4000 });
    buffer.writeUInt16LE(1, 0x36);
    buffer.writeUInt16LE(2, 0x38);
    expect(loadSegmentAlignments(buffer)).toEqual([]);
  });

  it('accepts the real program-header sizes for both classes', () => {
    expect(loadSegmentAlignments(elf64({ align: 0x4000 }))).toEqual([0x4000n]);
    expect(loadSegmentAlignments(elf32({ align: 0x4000 }))).toEqual([0x4000n]);
  });

  it('does not round a 64-bit alignment into a power of two', () => {
    // 0x2000000000000001 is not a power of two, but converting it to a
    // JavaScript number rounds it to 0x2000000000000000, which is — so a
    // checker that narrows before testing reports this malformed value as
    // correctly aligned.
    const alignments = loadSegmentAlignments(
      elf64({ align: 0x2000000000000001n }),
    );
    expect(alignments).toEqual([0x2000000000000001n]);
    expect(evaluateAlignment([{ name: 'lib.so', alignments }]).ok).toBe(false);
  });

  it('ignores a file that is not an ELF at all', () => {
    expect(loadSegmentAlignments(Buffer.alloc(64))).toEqual([]);
  });
});
