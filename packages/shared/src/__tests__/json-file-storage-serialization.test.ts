import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { publishJsonFileWithOwnedLock } from '../json-file-storage.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'json-file-storage-'));
  roots.push(dir);
  return dir;
}

describe('publishJsonFileWithOwnedLock serialization', () => {
  // This seam's historical bytes differ from writeJsonDurably's: two-space
  // JSON with NO trailing newline. Pinned as exact text so a caller that
  // passes no options keeps what it had before options existed.
  test('the default document is two-space JSON with no trailing newline', async () => {
    const path = join(root(), 'state.json');
    await publishJsonFileWithOwnedLock(path, {
      a: 1,
      nested: { b: [true, null] },
    });
    expect(readFileSync(path, 'utf8')).toBe(
      JSON.stringify({ a: 1, nested: { b: [true, null] } }, null, 2),
    );
  });

  test('indent: null writes the compact form', async () => {
    const path = join(root(), 'state.json');
    await publishJsonFileWithOwnedLock(
      path,
      { a: 1, nested: { b: [true, null] } },
      { indent: null },
    );
    expect(readFileSync(path, 'utf8')).toBe(
      '{"a":1,"nested":{"b":[true,null]}}',
    );
  });

  // `null` and "not supplied" are different answers; a `?? 2` read of the
  // option collapses them, which is the defect this asserts against.
  test('indent: null is not read as "no answer"', async () => {
    const path = join(root(), 'state.json');
    await publishJsonFileWithOwnedLock(path, { a: 1 }, { indent: null });
    expect(readFileSync(path, 'utf8')).not.toContain('\n  ');
  });

  test('trailingNewline: true appends the newline', async () => {
    const path = join(root(), 'state.json');
    await publishJsonFileWithOwnedLock(
      path,
      { a: 1 },
      { trailingNewline: true },
    );
    expect(readFileSync(path, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });

  test('the two options compose', async () => {
    const path = join(root(), 'state.json');
    await publishJsonFileWithOwnedLock(
      path,
      { a: 1 },
      { indent: null, trailingNewline: true },
    );
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
  });

  // The cap must measure the document that is actually written. `{"a":1}` is
  // 7 bytes; with the newline it is 8, so a limit of 7 has to refuse it --
  // otherwise a caller opts into a byte the limit never saw.
  test('maxBytes measures the trailing newline it was asked to write', async () => {
    const path = join(root(), 'state.json');
    await expect(
      publishJsonFileWithOwnedLock(
        path,
        { a: 1 },
        {
          indent: null,
          trailingNewline: true,
          maxBytes: 7,
          label: 'test document',
        },
      ),
    ).rejects.toThrow('test document exceeds the byte limit.');
    await expect(
      publishJsonFileWithOwnedLock(
        path,
        { a: 1 },
        {
          indent: null,
          trailingNewline: true,
          maxBytes: 8,
          label: 'test document',
        },
      ),
    ).resolves.toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
  });
});
