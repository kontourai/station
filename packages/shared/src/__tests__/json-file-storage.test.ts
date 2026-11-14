import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
  readJsonFileSnapshot,
  writeJsonFile,
} from '../json-file-storage.js';

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
  test('the synchronous commit span contains authority check and rename and cannot escape', async () => {
    const path = join(root(), 'owned.json');
    let inside = false;
    let escaped: (() => void) | undefined;
    await publishJsonFileWithOwnedLock(
      path,
      { revision: 1 },
      {
        finalizeCommit: () => {
          expect(inside).toBe(true);
          return undefined;
        },
        commitWithin: (commit) => {
          inside = true;
          escaped = commit;
          commit();
          expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
            revision: 1,
          });
          inside = false;
        },
      },
    );
    expect(() => escaped!()).toThrow('not current');
    await expect(
      publishJsonFileWithOwnedLock(
        path,
        { revision: 2 },
        { commitWithin: () => {} },
      ),
    ).rejects.toThrow('must commit synchronously');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: 1 });
  });
  test('revoked effect authority after staging preserves the retained document and removes staging', async () => {
    const directory = root();
    const path = join(directory, 'state.json');
    writeFileSync(path, '{"retained":true}');
    let current = true;
    await expect(
      publishJsonFileWithOwnedLock(
        path,
        { replacement: true },
        {
          beforeCommit() {
            queueMicrotask(() => {
              current = false;
            });
          },
          finalizeCommit() {
            if (!current) throw new Error('authority revoked');
          },
        },
      ),
    ).rejects.toThrow('authority revoked');
    expect(readFileSync(path, 'utf8')).toBe('{"retained":true}');
    expect(readdirSync(directory)).toEqual(['state.json']);
    current = true;
    let observedAtRevocation: unknown;
    await publishJsonFileWithOwnedLock(
      path,
      { replacement: true },
      {
        finalizeCommit() {
          if (!current) throw new Error('authority revoked');
          queueMicrotask(() => {
            current = false;
            observedAtRevocation = JSON.parse(readFileSync(path, 'utf8'));
          });
        },
      },
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      replacement: true,
    });
    expect(current).toBe(false);
    expect(observedAtRevocation).toEqual({ replacement: true });
  });
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

describe('json file storage reads and optimistic writes', () => {
  test('preserves an external edit when an optimistic write is stale', async () => {
    const directory = root();
    const path = join(directory, 'state.json');
    await writeJsonFile(path, { value: 'initial' });
    const snapshot = readJsonFileSnapshot(path, {});
    writeFileSync(path, JSON.stringify({ value: 'external' }), 'utf8');

    await expect(
      writeJsonFile(
        path,
        { value: 'station' },
        { expectedFingerprint: snapshot.fingerprint },
      ),
    ).rejects.toThrow('File changed before the update could commit');

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      value: 'external',
    });
    expect(
      readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('uses fallback only for ENOENT and never for another read failure', () => {
    const directory = root();
    expect(
      readJsonFile(join(directory, 'missing.json'), { empty: true }),
    ).toEqual({ empty: true });
    expect(() => readJsonFile(directory, { empty: true })).toThrow();
    writeFileSync(join(directory, 'invalid.json'), '{not-json', 'utf8');
    expect(() =>
      readJsonFile(join(directory, 'invalid.json'), { empty: true }),
    ).toThrow();
  });
});

test.each([
  'rejecting',
  'resolving',
  'scalar',
  'then-getter',
  'current',
] as const)(
  'synchronous finalizer containment survives a child process (%s)',
  (variant) => {
    const child = spawnSync(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        '--input-type=module',
        '--eval',
        `const variant = ${JSON.stringify(variant)};
const directory = ${JSON.stringify(root())};
const moduleUrl = ${JSON.stringify(new URL('../json-file-storage.ts', import.meta.url).href)};
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
const invalidResult = () => {
  if (variant === 'rejecting') return (async () => {
    await Promise.resolve();
    throw new Error('async authority revoked');
  })();
  if (variant === 'resolving') return Promise.resolve();
  if (variant === 'scalar') return 'invalid authority result';
  if (variant === 'then-getter') return { get then() { throw new Error('then getter revoked'); } };
  return undefined;
};
let refusal;
const { publishJsonFileWithOwnedLock } = await import(moduleUrl);
const target = join(directory, 'state.json');
fs.writeFileSync(target, '{"retained":true}');
const retained = fs.readFileSync(target, 'utf8');
try {
  await publishJsonFileWithOwnedLock(target, { replacement: true }, {
    finalizeCommit: invalidResult,
  });
} catch (error) { refusal = error; }
if (variant === 'current') {
  assert.equal(refusal, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { replacement: true });
} else {
  assert.equal(refusal?.message, 'JSON publication finalizer must be synchronous.');
  assert.equal(fs.readFileSync(target, 'utf8'), retained);
}
assert.deepEqual(fs.readdirSync(directory), ['state.json']);
await immediate();
await immediate();
console.log('finalizer-check-survived');
`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('finalizer-check-survived');
  },
  30_000,
);
test('final publication admission observes the fully staged file and refuses rename without changing prior bytes', async () => {
  const dir = root();
  const path = join(dir, 'state.json');
  await publishJsonFileWithOwnedLock(path, { version: 'before' });
  let checked = false;
  await expect(
    publishJsonFileWithOwnedLock(
      path,
      { version: 'after' },
      {
        assertCurrent: () => {
          const staged = readdirSync(dir).find((name) => name.endsWith('.tmp'));
          expect(staged).toBeDefined();
          expect(JSON.parse(readFileSync(join(dir, staged!), 'utf8'))).toEqual({
            version: 'after',
          });
          checked = true;
          throw new Error('Authority ended');
        },
      },
    ),
  ).rejects.toThrow('Authority ended');
  expect(checked).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 'before' });
  expect(readdirSync(dir)).toEqual(['state.json']);
});
