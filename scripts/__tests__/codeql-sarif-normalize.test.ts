import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  normalizeSarifBytes,
  parseNormalizeArguments,
  readBoundedSarifFile,
  runCodeqlSarifNormalize,
  writeNormalizedSarifAtomically,
} from '../codeql-sarif-normalize.mjs';
import { MAX_SARIF_BYTES } from '../codeql-sarif-policy.mjs';

const directories: string[] = [];

function temporaryPath(name: string) {
  const directory = mkdtempSync(join(tmpdir(), 'station-codeql-sarif-'));
  directories.push(directory);
  return join(directory, name);
}

function cleanSarif() {
  return readFileSync(
    'scripts/__tests__/fixtures/codeql-sarif/pinned-codeql-clean.sarif',
    'utf8',
  );
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('CodeQL SARIF normalization', () => {
  test('accepts a valid no-newline artifact and atomically writes canonical JSON with a newline', () => {
    const input = temporaryPath('input.sarif');
    const output = input.replace('input.sarif', 'normalized/output.sarif');
    const document = JSON.parse(cleanSarif());
    writeFileSync(input, JSON.stringify(document));

    expect(
      runCodeqlSarifNormalize([`--input=${input}`, `--output=${output}`]),
    ).toEqual({ input, output });
    expect(readFileSync(output, 'utf8')).toBe(`${JSON.stringify(document)}\n`);
    expect(readdirSync(join(input, '..', 'normalized'))).toEqual([
      'output.sarif',
    ]);
  });

  test.each([
    ['truncated JSON', '{'],
    ['malformed JSON', '{ nope }'],
    ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
    ['non-object JSON', '[]\n'],
  ])('rejects %s without replacing a prior output', (_name, source) => {
    const input = temporaryPath('input.sarif');
    const output = input.replace('input.sarif', 'output.sarif');
    writeFileSync(input, source);
    writeFileSync(output, 'previous complete artifact\n');

    expect(() =>
      runCodeqlSarifNormalize([`--input=${input}`, `--output=${output}`]),
    ).toThrow();
    expect(readFileSync(output, 'utf8')).toBe('previous complete artifact\n');
    expect(readdirSync(join(input, '..'))).toEqual([
      'input.sarif',
      'output.sarif',
    ]);
  });

  test('does not read an oversized input or create an output', () => {
    const input = temporaryPath('oversized.sarif');
    const output = input.replace('oversized.sarif', 'output.sarif');
    const descriptor = openSync(input, 'w');
    ftruncateSync(descriptor, MAX_SARIF_BYTES + 1);
    closeSync(descriptor);

    expect(() =>
      runCodeqlSarifNormalize([`--input=${input}`, `--output=${output}`]),
    ).toThrow(`exceeds the ${MAX_SARIF_BYTES}-byte limit`);
    expect(existsSync(output)).toBe(false);
  });

  test('atomically replaces an existing output without leaving a temporary artifact', () => {
    const output = temporaryPath('normalized.sarif');
    writeFileSync(output, 'old complete artifact\n');

    writeNormalizedSarifAtomically(output, '{"complete":true}\n');

    expect(readFileSync(output, 'utf8')).toBe('{"complete":true}\n');
    expect(readdirSync(join(output, '..'))).toEqual(['normalized.sarif']);
  });

  test('fsyncs the containing directory after atomically replacing the output', () => {
    const calls: string[] = [];
    const output = '/tmp/normalized.sarif';
    writeNormalizedSarifAtomically(output, '{}\n', {
      closeSync(descriptor: number) {
        calls.push(`close:${descriptor}`);
      },
      fsyncSync(descriptor: number) {
        calls.push(`fsync:${descriptor}`);
      },
      mkdirSync(path: string) {
        calls.push(`mkdir:${path}`);
      },
      openSync(path: string, flags: string) {
        calls.push(`open:${path}:${flags}`);
        return flags === 'wx' ? 10 : 11;
      },
      renameSync(from: string, to: string) {
        calls.push(`rename:${from.startsWith(`${output}.`)}:${to}`);
      },
      unlinkSync() {
        calls.push('unlink');
      },
      writeFileSync(descriptor: number) {
        calls.push(`write:${descriptor}`);
      },
    } as never);
    expect(calls).toEqual([
      'mkdir:/tmp',
      expect.stringMatching(/^open:\/tmp\/normalized\.sarif\..+:wx$/),
      'write:10',
      'fsync:10',
      'close:10',
      'rename:true:/tmp/normalized.sarif',
      'open:/tmp:r',
      'fsync:11',
      'close:11',
    ]);
  });

  test('cleans up a private temporary artifact when its write fails', () => {
    const calls: string[] = [];
    expect(() =>
      writeNormalizedSarifAtomically('/tmp/output.sarif', '{}\n', {
        closeSync(descriptor: number) {
          calls.push(`close:${descriptor}`);
        },
        fsyncSync() {},
        mkdirSync() {},
        openSync() {
          return 10;
        },
        renameSync() {
          calls.push('rename');
        },
        unlinkSync(path: string) {
          calls.push(`unlink:${path.startsWith('/tmp/output.sarif.')}`);
        },
        writeFileSync() {
          throw new Error('injected write failure');
        },
      } as never),
    ).toThrow('injected write failure');
    expect(calls).toEqual(['close:10', 'unlink:true']);
  });

  test.each([
    [
      'growth beyond the cap',
      [
        { dev: 1, ino: 1, size: 2, mtimeMs: 1, ctimeMs: 1 },
        {
          dev: 1,
          ino: 1,
          size: MAX_SARIF_BYTES + 1,
          mtimeMs: 2,
          ctimeMs: 2,
        },
      ],
      [
        { dev: 1, ino: 1, size: 2, mtimeMs: 1, ctimeMs: 1 },
        {
          dev: 1,
          ino: 1,
          size: MAX_SARIF_BYTES + 1,
          mtimeMs: 2,
          ctimeMs: 2,
        },
      ],
      `exceeds the ${MAX_SARIF_BYTES}-byte limit`,
    ],
    [
      'shrinkage after reading a valid prefix',
      [
        { dev: 1, ino: 1, size: 2, mtimeMs: 1, ctimeMs: 1 },
        { dev: 1, ino: 1, size: 1, mtimeMs: 2, ctimeMs: 2 },
      ],
      [
        { dev: 1, ino: 1, size: 2, mtimeMs: 1, ctimeMs: 1 },
        { dev: 1, ino: 1, size: 1, mtimeMs: 2, ctimeMs: 2 },
      ],
      'changed while it was being read',
    ],
    [
      'replacement after reading a valid prefix',
      [
        { dev: 1, ino: 1, size: 2, mtimeMs: 1, ctimeMs: 1 },
        { dev: 1, ino: 1, size: 2, mtimeMs: 1, ctimeMs: 1 },
      ],
      [
        { dev: 1, ino: 1, size: 2, mtimeMs: 1, ctimeMs: 1 },
        { dev: 1, ino: 2, size: 2, mtimeMs: 2, ctimeMs: 2 },
      ],
      'changed while it was being read',
    ],
  ])('rejects concurrent %s', (_name, fstats, stats, expected) => {
    let fstatCalls = 0;
    let statCalls = 0;
    expect(() =>
      readBoundedSarifFile('input.sarif', {
        closeSync() {},
        fstatSync() {
          return fstats[fstatCalls++];
        },
        openSync() {
          return 10;
        },
        readSync(_descriptor: number, bytes: Buffer) {
          bytes.set(Buffer.from('{}'));
          return 2;
        },
        statSync() {
          return stats[statCalls++];
        },
      } as never),
    ).toThrow(expected);
  });

  test('closes the directory and preserves the published artifact when directory fsync fails', () => {
    const calls: string[] = [];
    expect(() =>
      writeNormalizedSarifAtomically('/tmp/output.sarif', '{}\n', {
        closeSync(descriptor: number) {
          calls.push(`close:${descriptor}`);
        },
        fsyncSync(descriptor: number) {
          calls.push(`fsync:${descriptor}`);
          if (descriptor === 11) throw new Error('injected directory fsync');
        },
        mkdirSync() {},
        openSync(_path: string, flags: string) {
          return flags === 'wx' ? 10 : 11;
        },
        renameSync() {
          calls.push('rename');
        },
        unlinkSync() {
          calls.push('unlink');
        },
        writeFileSync() {},
      } as never),
    ).toThrow('injected directory fsync');
    expect(calls).toEqual([
      'fsync:10',
      'close:10',
      'rename',
      'fsync:11',
      'close:11',
    ]);
  });

  test('requires exactly two distinct named paths', () => {
    expect(() => parseNormalizeArguments([])).toThrow('Usage:');
    expect(() =>
      parseNormalizeArguments(['--input=input.sarif', '--output=input.sarif']),
    ).toThrow('distinct');
  });

  test('keeps valid object normalization separate from semantic policy validation', () => {
    expect(normalizeSarifBytes(Buffer.from('{}'))).toBe('{}\n');
  });
});
