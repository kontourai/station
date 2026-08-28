#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { MAX_SARIF_BYTES, parseSarifBytes } from './codeql-sarif-policy.mjs';

const FILESYSTEM = Object.freeze({
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
});

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function requireWithinCap(stat) {
  if (stat.size > MAX_SARIF_BYTES)
    throw new Error(`SARIF input exceeds the ${MAX_SARIF_BYTES}-byte limit.`);
}

function option(argv, name) {
  const prefix = `--${name}=`;
  const matches = argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length !== 1 || matches[0].length === prefix.length)
    throw new Error(
      'Usage: codeql-sarif-normalize.mjs --input=<CodeQL SARIF file> --output=<normalized SARIF file>.',
    );
  return matches[0].slice(prefix.length);
}

export function parseNormalizeArguments(argv) {
  const input = option(argv, 'input');
  const output = option(argv, 'output');
  if (argv.length !== 2 || resolve(input) === resolve(output))
    throw new Error(
      'Usage: codeql-sarif-normalize.mjs requires distinct --input and --output paths.',
    );
  return { input, output };
}

/** Read no more than the admission cap, even when an input is concurrently extended. */
export function readBoundedSarifFile(path, filesystem = FILESYSTEM) {
  const descriptor = filesystem.openSync(path, 'r');
  try {
    const opened = filesystem.fstatSync(descriptor);
    const named = filesystem.statSync(path);
    requireWithinCap(opened);
    requireWithinCap(named);
    if (fingerprint(opened) !== fingerprint(named))
      throw new Error('SARIF input changed while it was being opened.');
    const size = opened.size;
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = filesystem.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (read === 0)
        throw new Error('SARIF input changed while it was being read.');
      offset += read;
    }
    const afterRead = filesystem.fstatSync(descriptor);
    const afterNamed = filesystem.statSync(path);
    requireWithinCap(afterRead);
    requireWithinCap(afterNamed);
    if (
      fingerprint(opened) !== fingerprint(afterRead) ||
      fingerprint(named) !== fingerprint(afterNamed) ||
      fingerprint(afterRead) !== fingerprint(afterNamed)
    )
      throw new Error('SARIF input changed while it was being read.');
    return bytes;
  } finally {
    filesystem.closeSync(descriptor);
  }
}

export function normalizeSarifBytes(bytes) {
  const document = parseSarifBytes(bytes, { requireTerminalNewline: false });
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error('SARIF input must be a JSON object.');
  return `${JSON.stringify(document)}\n`;
}

/** Write a fully durable replacement, never exposing a partially-written output. */
export function writeNormalizedSarifAtomically(
  output,
  normalized,
  filesystem = FILESYSTEM,
) {
  const directory = dirname(output);
  filesystem.mkdirSync(directory, { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryDescriptor;
  let directoryDescriptor;
  let renamed = false;
  try {
    temporaryDescriptor = filesystem.openSync(temporary, 'wx', 0o600);
    filesystem.writeFileSync(temporaryDescriptor, normalized, 'utf8');
    filesystem.fsyncSync(temporaryDescriptor);
    filesystem.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    filesystem.renameSync(temporary, output);
    renamed = true;
    directoryDescriptor = filesystem.openSync(directory, 'r');
    filesystem.fsyncSync(directoryDescriptor);
    filesystem.closeSync(directoryDescriptor);
    directoryDescriptor = undefined;
  } catch (error) {
    if (temporaryDescriptor !== undefined)
      filesystem.closeSync(temporaryDescriptor);
    if (directoryDescriptor !== undefined)
      filesystem.closeSync(directoryDescriptor);
    if (!renamed)
      try {
        filesystem.unlinkSync(temporary);
      } catch {
        // The temporary name is private and may not exist when opening failed.
      }
    throw error;
  }
}

export function runCodeqlSarifNormalize(argv = process.argv.slice(2)) {
  const { input, output } = parseNormalizeArguments(argv);
  const normalized = normalizeSarifBytes(readBoundedSarifFile(input));
  writeNormalizedSarifAtomically(output, normalized);
  return { input, output };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = runCodeqlSarifNormalize();
    console.log(
      `Normalized CodeQL SARIF from ${result.input} to ${result.output}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
