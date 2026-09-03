import {
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_DATA_LIMITS } from '@kontourai/station-contracts/plugin-data';
import { afterEach, describe, expect, test } from 'vitest';
import { PluginDataStore } from '../plugin-data-store.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-plugin-data-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const owner = {
  pluginId: 'review-tools',
  installationKey: `sha256:${'a'.repeat(64)}`,
};

describe('PluginDataStore', () => {
  test('persists owner-qualified JSON across handles', () => {
    const directory = root();
    const first = new PluginDataStore({ directory });
    const created = first.set(
      owner,
      'preferences.theme',
      { mode: 'dark' },
      null,
    );
    expect(created).toMatchObject({
      kind: 'written',
      record: {
        key: 'preferences.theme',
        value: { mode: 'dark' },
        revision: 1,
      },
    });
    first.close();

    const second = new PluginDataStore({ directory });
    expect(second.get(owner, 'preferences.theme')).toMatchObject({
      kind: 'found',
      record: { value: { mode: 'dark' }, revision: 1 },
    });
    second.close();
  });

  test('requires the observed revision for update and delete', () => {
    const directory = root();
    const first = new PluginDataStore({ directory });
    const second = new PluginDataStore({ directory });
    expect(first.set(owner, 'state', { value: 1 }, null)).toMatchObject({
      kind: 'written',
      record: { revision: 1 },
    });
    expect(second.set(owner, 'state', { value: 2 }, null)).toEqual({
      kind: 'conflict',
      currentRevision: 1,
    });
    expect(second.set(owner, 'state', { value: 2 }, 1)).toMatchObject({
      kind: 'written',
      record: { revision: 2 },
    });
    expect(first.delete(owner, 'state', 1)).toEqual({
      kind: 'conflict',
      currentRevision: 2,
    });
    expect(first.delete(owner, 'state', 2)).toEqual({ kind: 'deleted' });
    first.close();
    second.close();
  });

  test('isolates data by host-issued installation identity', () => {
    const store = new PluginDataStore({ directory: root() });
    const replacement = {
      ...owner,
      installationKey: `sha256:${'b'.repeat(64)}`,
    };
    expect(store.set(owner, 'state', 'original', null)).toMatchObject({
      kind: 'written',
    });
    expect(store.get(replacement, 'state')).toEqual({ kind: 'not-found' });
    expect(store.set(replacement, 'state', 'replacement', null)).toMatchObject({
      kind: 'written',
    });
    expect(store.get(owner, 'state')).toMatchObject({
      kind: 'found',
      record: { value: 'original' },
    });
    store.close();
  });

  test('rejects unsafe identities, keys, and non-JSON values before writing', () => {
    const store = new PluginDataStore({ directory: root() });
    expect(
      store.set({ ...owner, pluginId: '../escape' }, 'safe', 'x', null),
    ).toMatchObject({
      kind: 'invalid',
    });
    expect(store.set(owner, '../escape', 'x', null)).toMatchObject({
      kind: 'invalid',
    });
    expect(store.set(owner, 'nan', Number.NaN, null)).toMatchObject({
      kind: 'invalid',
    });
    expect(store.set(owner, 'date', new Date() as never, null)).toMatchObject({
      kind: 'invalid',
    });
    expect(store.list(owner)).toEqual({ kind: 'available', records: [] });
    store.close();
  });

  test('bounds each serialized value before mutation', () => {
    const store = new PluginDataStore({ directory: root() });
    const value = 'x'.repeat(PLUGIN_DATA_LIMITS.valueBytes + 1);
    expect(store.set(owner, 'large', value, null)).toEqual({
      kind: 'capacity',
      reason: 'value-bytes',
    });
    expect(store.get(owner, 'large')).toEqual({ kind: 'not-found' });
    store.close();
  });

  test('bounds key count and aggregate bytes per installation', () => {
    const store = new PluginDataStore({ directory: root() });
    for (
      let index = 0;
      index < PLUGIN_DATA_LIMITS.keysPerInstallation;
      index += 1
    ) {
      expect(store.set(owner, `key-${index}`, null, null)).toMatchObject({
        kind: 'written',
      });
    }
    expect(store.set(owner, 'one-too-many', null, null)).toEqual({
      kind: 'capacity',
      reason: 'keys',
    });

    const aggregateOwner = {
      ...owner,
      installationKey: `sha256:${'c'.repeat(64)}`,
    };
    const chunk = 'x'.repeat(PLUGIN_DATA_LIMITS.valueBytes - 2);
    for (let index = 0; index < 16; index += 1) {
      expect(
        store.set(aggregateOwner, `chunk-${index}`, chunk, null),
      ).toMatchObject({ kind: 'written' });
    }
    expect(store.set(aggregateOwner, 'overflow', 'extra', null)).toEqual({
      kind: 'capacity',
      reason: 'total-bytes',
    });
    store.close();
  });

  test('refuses a symlink database before SQLite opens it', () => {
    const directory = root();
    const target = join(root(), 'outside.sqlite');
    writeFileSync(target, 'not a database');
    symlinkSync(target, join(directory, 'plugin-data.sqlite'));
    expect(() => new PluginDataStore({ directory })).toThrow(
      'Plugin data database must not be a symbolic link',
    );
    expect(
      lstatSync(join(directory, 'plugin-data.sqlite')).isSymbolicLink(),
    ).toBe(true);
  });
});
