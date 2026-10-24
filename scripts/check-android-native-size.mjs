#!/usr/bin/env node
// Native size gate for the staged Android APK.
//
// Nightly 0.1.11-nightly.2474 shipped libstation_ai_lib.so unstripped: 9.1 MB
// of its 32.6 MB was symbol tables, and the release profile carried no size
// settings at all. Nothing measured the library, so a 6.3 MB jump between
// 2466.3 and 2470 surfaced only as an owner's phone storage reading.
//
// Two checks, deliberately different in kind:
// - Every native library must be stripped: no .symtab and no .debug_*
//   section. This is an invariant, so it fails on the exact regression
//   whatever the library's size.
// - Each budgeted <abi>/<library> must stay under its byte ceiling. The ceiling
//   carries headroom over the measured size and fails only on growth past
//   it; raising it is a reviewed edit to config/android-native-size-budget.json.

import { readFileSync } from 'node:fs';
import { readApkNativeLibraries } from './check-android-16kb-alignment.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const BUDGET_PATH = new URL(
  '../config/android-native-size-budget.json',
  import.meta.url,
);

// Little-endian ELF header and section-header field offsets by class. The
// release APK carries all four Android ABIs, so armeabi-v7a and x86 are 32-bit.
const ELF_LAYOUT = {
  1: { shoff: 0x20, shentsize: 0x2e, entry: 40, offset: 0x10, size: 0x14 },
  2: { shoff: 0x28, shentsize: 0x3a, entry: 64, offset: 0x18, size: 0x20 },
};

/**
 * Section names of a little-endian 32- or 64-bit ELF, or null when the
 * section header table or its string table is malformed. Never a partial list.
 * @param {Buffer} buffer
 * @returns {string[] | null}
 */
export function elfSectionNames(buffer) {
  if (buffer.length < 52 || buffer.readUInt32BE(0) !== 0x7f454c46) return null;
  const layout = ELF_LAYOUT[buffer[4]];
  if (!layout || buffer[5] !== 1 || buffer[6] !== 1) return null;
  const is64 = buffer[4] === 2;
  if (is64 && buffer.length < 64) return null;
  const word = (offset) =>
    is64 ? buffer.readBigUInt64LE(offset) : BigInt(buffer.readUInt32LE(offset));
  const shoff = word(layout.shoff);
  const shentsize = buffer.readUInt16LE(layout.shentsize);
  const shnum = buffer.readUInt16LE(layout.shentsize + 2);
  const shstrndx = buffer.readUInt16LE(layout.shentsize + 4);
  if (shentsize < layout.entry || shnum === 0 || shstrndx >= shnum) return null;
  const length = BigInt(buffer.length);
  const table = BigInt(shnum) * BigInt(shentsize);
  if (shoff > length || table > length - shoff) return null;
  const header = (index) => Number(shoff) + index * shentsize;
  const strings = header(shstrndx);
  const stringsOffset = word(strings + layout.offset);
  const stringsSize = word(strings + layout.size);
  if (stringsOffset > length || stringsSize > length - stringsOffset) {
    return null;
  }
  const start = Number(stringsOffset);
  const end = start + Number(stringsSize);
  const names = [];
  for (let index = 0; index < shnum; index += 1) {
    const nameStart = start + buffer.readUInt32LE(header(index));
    if (nameStart >= end) return null;
    const nameEnd = buffer.indexOf(0, nameStart);
    if (nameEnd === -1 || nameEnd >= end) return null;
    names.push(buffer.toString('latin1', nameStart, nameEnd));
  }
  return names;
}

/** The universal download has a separate ceiling from each installed native library. */
function evaluateUniversalApkSize(
  libraries,
  ceiling,
  apkBytes,
  failures,
  report,
) {
  const abis = new Set(libraries.map(({ name }) => name.split('/')[1]));
  if (abis.size > 1 && ceiling !== undefined) {
    if (!Number.isSafeInteger(apkBytes) || apkBytes < 0)
      failures.push('Universal APK byte size is missing or invalid');
    else if (apkBytes > ceiling)
      failures.push(
        `Universal APK: ${apkBytes} bytes exceeds the ${ceiling}-byte ceiling in config/android-native-size-budget.json`,
      );
    report.push(`Universal APK: ${apkBytes} bytes (ceiling ${ceiling})`);
  }
}

/**
 * @param {{ name: string, bytes: Buffer }[]} libraries
 * @param {{ libraries: Record<string, number>, universalApkBytes?: number }} budget
 * @param {number} [apkBytes]
 */
export function evaluateNativeSize(libraries, budget, apkBytes) {
  const failures = [];
  const report = [];
  const present = new Set();
  evaluateUniversalApkSize(
    libraries,
    budget.universalApkBytes,
    apkBytes,
    failures,
    report,
  );
  for (const { name, bytes } of libraries) {
    // Ceilings are per ABI: a library's size differs by architecture, and
    // only the measured ABI may carry one. Every ABI must still be stripped.
    const file = name.replace(/^lib\//, '');
    present.add(file);
    const sections = elfSectionNames(bytes);
    if (sections === null) {
      failures.push(`${name}: unreadable ELF section header table`);
    } else {
      const unstripped = sections.filter(
        (section) => section === '.symtab' || section.startsWith('.debug_'),
      );
      if (unstripped.length > 0) {
        failures.push(
          `${name}: not stripped (${unstripped.join(', ')}); set strip in the release profile`,
        );
      }
    }
    const ceiling = budget.libraries[file];
    report.push(
      `${name}: ${bytes.length} bytes${ceiling === undefined ? '' : ` (ceiling ${ceiling})`}`,
    );
    if (ceiling !== undefined && bytes.length > ceiling) {
      failures.push(
        `${name}: ${bytes.length} bytes exceeds the ${ceiling}-byte ceiling in config/android-native-size-budget.json`,
      );
    }
  }
  for (const file of Object.keys(budget.libraries)) {
    if (!present.has(file)) failures.push(`${file}: budgeted but not packaged`);
  }
  return { ok: failures.length === 0, failures, report };
}

/** @param {unknown} value */
export function parseBudget(value) {
  const libraries = /** @type {{ libraries?: unknown }} */ (value)?.libraries;
  if (
    !libraries ||
    typeof libraries !== 'object' ||
    Array.isArray(libraries) ||
    Object.keys(libraries).length === 0 ||
    !Object.values(libraries).every(
      (ceiling) => Number.isSafeInteger(ceiling) && ceiling > 0,
    )
  ) {
    throw new Error(
      'android-native-size-budget.json must map <abi>/<library> paths to positive byte ceilings',
    );
  }
  const universalApkBytes = value?.universalApkBytes;
  if (
    universalApkBytes !== undefined &&
    (!Number.isSafeInteger(universalApkBytes) || universalApkBytes <= 0)
  )
    throw new Error(
      'Universal APK ceiling must be a positive integer byte count',
    );
  return {
    libraries: /** @type {Record<string, number>} */ (libraries),
    universalApkBytes,
  };
}

function main() {
  const apkPath = process.argv[2];
  if (!apkPath || process.argv.length > 3) {
    console.error('usage: check-android-native-size.mjs <path-to.apk>');
    process.exit(2);
  }
  try {
    const budget = parseBudget(JSON.parse(readFileSync(BUDGET_PATH, 'utf8')));
    const apk = readFileSync(apkPath);
    const libraries = readApkNativeLibraries(apk);
    if (libraries.length === 0)
      throw new Error(`${apkPath}: contains no native libraries to check`);
    const result = evaluateNativeSize(libraries, budget, apk.length);
    for (const line of result.report) console.log(line);
    if (!result.ok) throw new Error(result.failures.join('\n'));
    console.log(
      `Native size gate passed for ${libraries.length} native libraries.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Android native size check failed',
    );
    process.exitCode = 1;
  }
}

if (invokedDirectly(import.meta.url)) main();
