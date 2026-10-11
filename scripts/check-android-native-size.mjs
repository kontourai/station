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
// - Each budgeted library must stay under its byte ceiling. The ceiling
//   carries headroom over the measured size and fails only on growth past
//   it; raising it is a reviewed edit to config/android-native-size-budget.json.

import { readFileSync } from 'node:fs';
import { readApkNativeLibraries } from './check-android-16kb-alignment.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const BUDGET_PATH = new URL(
  '../config/android-native-size-budget.json',
  import.meta.url,
);

/**
 * Section names of a little-endian 64-bit ELF, or null when the section
 * header table or its string table is malformed. Never a partial list.
 * @param {Buffer} buffer
 * @returns {string[] | null}
 */
export function elfSectionNames(buffer) {
  if (buffer.length < 64 || buffer.readUInt32BE(0) !== 0x7f454c46) return null;
  if (buffer[4] !== 2 || buffer[5] !== 1 || buffer[6] !== 1) return null;
  const shoff = buffer.readBigUInt64LE(0x28);
  const shentsize = buffer.readUInt16LE(0x3a);
  const shnum = buffer.readUInt16LE(0x3c);
  const shstrndx = buffer.readUInt16LE(0x3e);
  if (shentsize < 64 || shnum === 0 || shstrndx >= shnum) return null;
  const length = BigInt(buffer.length);
  const table = BigInt(shnum) * BigInt(shentsize);
  if (shoff > length || table > length - shoff) return null;
  const header = (index) => Number(shoff) + index * shentsize;
  const strings = header(shstrndx);
  const stringsOffset = buffer.readBigUInt64LE(strings + 0x18);
  const stringsSize = buffer.readBigUInt64LE(strings + 0x20);
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

/**
 * @param {{ name: string, bytes: Buffer }[]} libraries
 * @param {{ libraries: Record<string, number> }} budget
 */
export function evaluateNativeSize(libraries, budget) {
  const failures = [];
  const report = [];
  const present = new Set();
  for (const { name, bytes } of libraries) {
    const file = name.slice(name.lastIndexOf('/') + 1);
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
      'android-native-size-budget.json must map library file names to positive byte ceilings',
    );
  }
  return { libraries: /** @type {Record<string, number>} */ (libraries) };
}

function main() {
  const apkPath = process.argv[2];
  if (!apkPath || process.argv.length > 3) {
    console.error('usage: check-android-native-size.mjs <path-to.apk>');
    process.exit(2);
  }
  try {
    const budget = parseBudget(JSON.parse(readFileSync(BUDGET_PATH, 'utf8')));
    const libraries = readApkNativeLibraries(readFileSync(apkPath));
    if (libraries.length === 0)
      throw new Error(`${apkPath}: contains no native libraries to check`);
    const result = evaluateNativeSize(libraries, budget);
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
