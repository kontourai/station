import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JsonFileStore, JsonFileStoreCorruptionError } from '../json-store.js';

describe('JsonFileStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'json-store-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('read returns fallback when file missing', () => {
    const store = new JsonFileStore(join(dir, 'missing.json'), { x: 1 });
    expect(store.read()).toEqual({ x: 1 });
  });

  test('write then read round-trips', () => {
    const store = new JsonFileStore(join(dir, 'data.json'), {});
    store.write({ hello: 'world' });
    expect(store.read()).toEqual({ hello: 'world' });
  });

  test('write creates parent directories', () => {
    const store = new JsonFileStore(join(dir, 'a', 'b', 'c.json'), {});
    store.write({ nested: true });
    expect(store.read()).toEqual({ nested: true });
  });

  test('append adds entries and respects max', () => {
    const store = new JsonFileStore<string[]>(join(dir, 'arr.json'), []);
    store.append('a', 3);
    store.append('b', 3);
    store.append('c', 3);
    store.append('d', 3);
    expect(store.read()).toEqual(['b', 'c', 'd']);
  });

  test('read returns fallback on corrupt JSON', () => {
    const path = join(dir, 'bad.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, 'not json');
    const store = new JsonFileStore(path, []);
    expect(store.read()).toEqual([]);
  });

  test('keeps a prior complete value beside an atomic durable write', () => {
    const path = join(dir, 'durable.json');
    const store = new JsonFileStore(
      path,
      { value: 0 },
      {
        onCorruption: 'throw',
        durableAtomicWrite: true,
      },
    );
    store.write({ value: 1 });
    store.write({ value: 2 });

    expect(store.read()).toEqual({ value: 2 });
    expect(JSON.parse(readFileSync(`${path}.previous`, 'utf8'))).toEqual({
      value: 1,
    });
  });

  test('durably recovers the prior complete value if a primary is missing', () => {
    const path = join(dir, 'recover.json');
    const store = new JsonFileStore(
      path,
      { value: 0 },
      {
        onCorruption: 'throw',
        durableAtomicWrite: true,
      },
    );
    store.write({ value: 1 });
    store.write({ value: 2 });
    rmSync(path);

    expect(existsSync(`${path}.previous`)).toBe(true);
    expect(store.read()).toEqual({ value: 1 });
  });

  test('strict stores surface corrupt primary JSON instead of returning fallback', () => {
    const path = join(dir, 'strict.json');
    writeFileSync(path, 'not json');
    const store = new JsonFileStore(path, [], { onCorruption: 'throw' });

    expect(() => store.read()).toThrow(JsonFileStoreCorruptionError);
  });
});
