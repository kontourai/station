import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  elfSectionNames,
  evaluateNativeSize,
  parseBudget,
} from '../check-android-native-size.mjs';

/**
 * A little-endian ELF (64-bit unless `bits` is 32) carrying only a section
 * header table: `names`, then a final `.shstrtab` section holding every name.
 */
function elfWithSections(names: string[], padding = 0, bits = 64): Buffer {
  const is64 = bits === 64;
  const header = is64 ? 64 : 52;
  const entry = is64 ? 64 : 40;
  const all = [...names, '.shstrtab'];
  const strtab = Buffer.from(`\0${all.map((n) => `${n}\0`).join('')}`);
  const nameOffsets: number[] = [];
  let cursor = 1;
  for (const name of all) {
    nameOffsets.push(cursor);
    cursor += name.length + 1;
  }
  const strtabOffset = header + padding;
  const shoff = strtabOffset + strtab.length;
  const shnum = names.length + 1;
  const buffer = Buffer.alloc(shoff + shnum * entry);
  buffer.writeUInt32BE(0x7f454c46, 0);
  buffer[4] = is64 ? 2 : 1;
  buffer[5] = 1;
  buffer[6] = 1;
  const fields = is64 ? 0x3a : 0x2e;
  if (is64) buffer.writeBigUInt64LE(BigInt(shoff), 0x28);
  else buffer.writeUInt32LE(shoff, 0x20);
  buffer.writeUInt16LE(entry, fields);
  buffer.writeUInt16LE(shnum, fields + 2);
  // The last section is .shstrtab itself.
  buffer.writeUInt16LE(shnum - 1, fields + 4);
  strtab.copy(buffer, strtabOffset);
  for (let index = 0; index < shnum; index += 1) {
    buffer.writeUInt32LE(nameOffsets[index], shoff + index * entry);
  }
  const own = shoff + (shnum - 1) * entry;
  if (is64) {
    buffer.writeBigUInt64LE(BigInt(strtabOffset), own + 0x18);
    buffer.writeBigUInt64LE(BigInt(strtab.length), own + 0x20);
  } else {
    buffer.writeUInt32LE(strtabOffset, own + 0x10);
    buffer.writeUInt32LE(strtab.length, own + 0x14);
  }
  return buffer;
}

const STRIPPED = ['', '.dynsym', '.dynstr', '.text', '.rodata'];
const LIB = 'lib/arm64-v8a/libstation_ai_lib.so';

describe('Android native size gate', () => {
  it('reads every section name from a stripped library', () => {
    expect(elfSectionNames(elfWithSections(STRIPPED))).toEqual([
      ...STRIPPED,
      '.shstrtab',
    ]);
  });

  it('accepts a stripped library under its ceiling', () => {
    const bytes = elfWithSections(STRIPPED, 100);
    const result = evaluateNativeSize([{ name: LIB, bytes }], {
      libraries: { 'arm64-v8a/libstation_ai_lib.so': bytes.length },
    });
    expect(result).toMatchObject({ ok: true, failures: [] });
    expect(result.report).toEqual([
      `${LIB}: ${bytes.length} bytes (ceiling ${bytes.length})`,
    ]);
  });

  it('rejects symbol and debug sections whatever the size', () => {
    const bytes = elfWithSections([
      ...STRIPPED,
      '.symtab',
      '.strtab',
      '.debug_info',
    ]);
    const result = evaluateNativeSize([{ name: LIB, bytes }], {
      libraries: { 'arm64-v8a/libstation_ai_lib.so': bytes.length * 100 },
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      `${LIB}: not stripped (.symtab, .debug_info); set strip in the release profile`,
    ]);
  });

  it('rejects one byte over the ceiling and a budgeted library that is missing', () => {
    const bytes = elfWithSections(STRIPPED);
    expect(
      evaluateNativeSize([{ name: LIB, bytes }], {
        libraries: { 'arm64-v8a/libstation_ai_lib.so': bytes.length - 1 },
      }).failures,
    ).toEqual([
      `${LIB}: ${bytes.length} bytes exceeds the ${bytes.length - 1}-byte ceiling in config/android-native-size-budget.json`,
    ]);
    expect(
      evaluateNativeSize([{ name: LIB, bytes }], {
        libraries: { 'arm64-v8a/libother.so': 10 },
      }).failures,
    ).toEqual(['arm64-v8a/libother.so: budgeted but not packaged']);
  });

  // The release APK packages all four ABIs; armeabi-v7a and x86 are 32-bit.
  it('reads 32-bit libraries and budgets only the measured ABI', () => {
    expect(elfSectionNames(elfWithSections(STRIPPED, 0, 32))).toEqual([
      ...STRIPPED,
      '.shstrtab',
    ]);
    const arm64 = elfWithSections(STRIPPED, 400);
    const result = evaluateNativeSize(
      [
        { name: LIB, bytes: arm64 },
        {
          name: 'lib/armeabi-v7a/libstation_ai_lib.so',
          bytes: elfWithSections(STRIPPED, 900, 32),
        },
        {
          name: 'lib/x86/libstation_ai_lib.so',
          bytes: elfWithSections([...STRIPPED, '.symtab'], 0, 32),
        },
        {
          name: 'lib/x86_64/libstation_ai_lib.so',
          bytes: elfWithSections(STRIPPED, 900),
        },
      ],
      { libraries: { 'arm64-v8a/libstation_ai_lib.so': arm64.length } },
    );
    expect(result.failures).toEqual([
      'lib/x86/libstation_ai_lib.so: not stripped (.symtab); set strip in the release profile',
    ]);
  });

  it('fails closed on a malformed section header table', () => {
    const good = elfWithSections(STRIPPED);
    const truncated = good.subarray(0, good.length - 1);
    const badIndex = Buffer.from(good);
    badIndex.writeUInt16LE(200, 0x3e);
    const badName = Buffer.from(good);
    badName.writeUInt32LE(0xffff, good.readUInt32LE(0x28));
    for (const bytes of [truncated, badIndex, badName, Buffer.alloc(80)]) {
      expect(elfSectionNames(bytes)).toBeNull();
      expect(
        evaluateNativeSize([{ name: LIB, bytes }], { libraries: {} }).failures,
      ).toEqual([`${LIB}: unreadable ELF section header table`]);
    }
  });

  it('refuses a budget without positive integer ceilings', () => {
    for (const value of [
      {},
      { libraries: {} },
      { libraries: [] },
      { libraries: { 'a.so': 0 } },
      { libraries: { 'a.so': 1.5 } },
      { libraries: { 'a.so': '10' } },
    ]) {
      expect(() => parseBudget(value)).toThrow(/positive byte ceilings/);
    }
  });

  // The gate is only as good as its wiring: each lane that stages a release
  // APK must run it on that APK, beside the 16 KB gate that already reads it.
  it.each([
    '.github/workflows/nightly-native-stage.yml',
    '.github/workflows/release.yml',
  ])('runs on the staged release APK in %s', (path) => {
    const workflow = readFileSync(path, 'utf8');
    expect(workflow).toContain(
      'node scripts/check-android-16kb-alignment.mjs "$apk"\n          node scripts/check-android-native-size.mjs "$apk"\n',
    );
    expect(workflow.match(/check-android-native-size\.mjs/g)).toHaveLength(1);
  });

  // Pin the checked-in ceiling independently of the gate: a raise is a
  // reviewed edit here and in the budget file together.
  it('keeps the checked-in ceiling', () => {
    const budget = parseBudget(
      JSON.parse(
        readFileSync('config/android-native-size-budget.json', 'utf8'),
      ),
    );
    expect(budget.libraries).toEqual({
      'arm64-v8a/libstation_ai_lib.so': 24_000_000,
    });
  });
});
