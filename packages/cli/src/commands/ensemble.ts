import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  ENSEMBLE_MAX_BYTES,
  parseEnsemblePreset,
  renderEnsembleRoster,
} from '@kontourai/station-contracts/ensemble';
import { terminalSafeJson, terminalSafeText } from './terminal-safe.js';

function safeJson(value: unknown): string {
  return terminalSafeJson(value).split('\n').map(terminalSafeText).join('\n');
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameEntry(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function inspectFile(input: string) {
  const path = resolve(input);
  if ((await realpath(path)) !== path)
    throw new Error('Ensemble: file path must not contain symbolic links');
  const ancestors: Array<{ path: string; stat: BigIntStats }> = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = await lstat(parent, { bigint: true });
    if (!stat.isDirectory())
      throw new Error('Ensemble: preset file identity changed');
    ancestors.push({ path: parent, stat });
    if (dirname(parent) === parent) break;
  }
  const expected = await lstat(path, { bigint: true });
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const assertIdentity = async () => {
      const opened = await file.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (!sameFile(expected, opened) || !sameFile(opened, named))
        throw new Error('Ensemble: preset file identity changed');
      for (const ancestor of ancestors) {
        const current = await lstat(ancestor.path, { bigint: true });
        if (!current.isDirectory() || !sameEntry(ancestor.stat, current))
          throw new Error('Ensemble: preset file identity changed');
      }
    };
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile())
      throw new Error('Ensemble: expected a regular preset file');
    if (stat.size > ENSEMBLE_MAX_BYTES)
      throw new Error('Ensemble: preset exceeds byte limit');
    await assertIdentity();
    const buffer = Buffer.alloc(ENSEMBLE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > ENSEMBLE_MAX_BYTES)
      throw new Error('Ensemble: preset exceeds byte limit');
    await assertIdentity();
    const bytes = buffer.subarray(0, length);
    let json: string;
    try {
      // Preserve a BOM for JSON validation rather than silently dropping bytes.
      json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new Error('Ensemble: invalid UTF-8');
    }
    const preset = parseEnsemblePreset(json);
    return {
      kind: 'station.ensemble.inspection',
      version: 1,
      path,
      bytes: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      preset,
      roster: renderEnsembleRoster(preset),
    };
  } finally {
    await file.close();
  }
}

export async function runEnsembleCommand(rawArgs: string[]): Promise<void> {
  const separator = rawArgs.indexOf('--');
  const json = (
    separator === -1 ? rawArgs : rawArgs.slice(0, separator)
  ).includes('--json');
  try {
    const [action, ...args] = rawArgs;
    let file: string | undefined;
    let literal = false;
    for (const arg of args) {
      if (!literal && arg === '--') literal = true;
      else if (!literal && arg === '--json') continue;
      else if ((!literal && arg.startsWith('-')) || file !== undefined)
        throw new Error(
          'Expected one preset file; see station ensemble --help.',
        );
      else file = arg;
    }
    if (action !== 'inspect' || !file)
      throw new Error(
        'Expected inspect and a preset file; see station ensemble --help.',
      );
    const inspection = await inspectFile(file);
    if (json) console.log(safeJson(inspection));
    else {
      console.log(
        [
          `File: ${terminalSafeText(inspection.path)}`,
          `Version: ${inspection.preset.version}`,
          `Bytes: ${inspection.bytes}`,
          `Digest: ${inspection.sha256}`,
          'Inspection only; no members launched.',
          ...inspection.roster.split('\n').map(terminalSafeText),
          ...inspection.preset.members.map(
            (member) =>
              `${member.codename} options: ${safeJson(member.options)}`,
          ),
        ].join('\n'),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      json
        ? safeJson({ success: false, error: message })
        : `Error: ${terminalSafeText(message)}`,
    );
    process.exitCode = 1;
  }
}
