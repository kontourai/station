import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  readJsonFile,
  readJsonFileSnapshot,
  writeJsonFile,
} from '../file-storage-helpers.js';

describe('file storage helpers', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'station-json-file-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test('preserves an external edit when an optimistic write is stale', async () => {
    const path = join(directory, 'state.json');
    await writeJsonFile(path, { value: 'initial' });
    const snapshot = readJsonFileSnapshot(path, {});
    writeFileSync(path, JSON.stringify({ value: 'external' }), 'utf8');

    await expect(
      writeJsonFile(
        path,
        { value: 'station' },
        {
          expectedFingerprint: snapshot.fingerprint,
        },
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
    expect(
      readJsonFile(join(directory, 'missing.json'), { empty: true }),
    ).toEqual({
      empty: true,
    });
    expect(() => readJsonFile(directory, { empty: true })).toThrow();
    writeFileSync(join(directory, 'invalid.json'), '{not-json', 'utf8');
    expect(() =>
      readJsonFile(join(directory, 'invalid.json'), { empty: true }),
    ).toThrow();
  });
});
