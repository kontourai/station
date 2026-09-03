import {
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    const firstStore = new PluginDataStore({ directory });
    const first = firstStore.bind(owner);
    const created = first.set('preferences.theme', { mode: 'dark' }, null);
    expect(created).toMatchObject({
      kind: 'written',
      record: {
        key: 'preferences.theme',
        value: { mode: 'dark' },
        revision: 1,
      },
    });
    firstStore.close();

    const secondStore = new PluginDataStore({ directory });
    const second = secondStore.bind(owner);
    expect(second.get('preferences.theme')).toMatchObject({
      kind: 'found',
      record: { value: { mode: 'dark' }, revision: 1 },
    });
    secondStore.close();
  });

  test('requires the observed revision for update and delete', () => {
    const directory = root();
    const firstStore = new PluginDataStore({ directory });
    const secondStore = new PluginDataStore({ directory });
    const first = firstStore.bind(owner);
    const second = secondStore.bind(owner);
    expect(first.set('state', { value: 1 }, null)).toMatchObject({
      kind: 'written',
      record: { revision: 1 },
    });
    expect(second.set('state', { value: 2 }, null)).toEqual({
      kind: 'conflict',
      currentRevision: 1,
    });
    expect(second.set('state', { value: 2 }, 1)).toMatchObject({
      kind: 'written',
      record: { revision: 2 },
    });
    expect(first.delete('state', 1)).toEqual({
      kind: 'conflict',
      currentRevision: 2,
    });
    expect(first.delete('state', 2)).toEqual({ kind: 'deleted' });
    expect(first.set('state', { value: 3 }, null)).toMatchObject({
      kind: 'written',
      record: { revision: 3 },
    });
    expect(second.set('state', { stale: true }, 1)).toEqual({
      kind: 'conflict',
      currentRevision: 3,
    });
    firstStore.close();
    secondStore.close();
  });

  test('isolates data by host-issued installation identity', () => {
    const store = new PluginDataStore({ directory: root() });
    const original = store.bind(owner);
    const replacement = {
      ...owner,
      installationKey: `sha256:${'b'.repeat(64)}`,
    };
    expect(original.set('state', 'original', null)).toMatchObject({
      kind: 'written',
    });
    const replacementCapability = store.bind(replacement);
    expect(replacementCapability.get('state')).toEqual({ kind: 'not-found' });
    expect(
      replacementCapability.set('state', 'replacement', null),
    ).toMatchObject({
      kind: 'written',
    });
    expect(original.get('state')).toMatchObject({
      kind: 'found',
      record: { value: 'original' },
    });
    store.close();
  });

  test('rejects unsafe identities, keys, and non-JSON values before writing', () => {
    const store = new PluginDataStore({ directory: root() });
    expect(() => store.bind({ ...owner, pluginId: '../escape' })).toThrow(
      'pluginId must be a canonical plugin identifier',
    );
    const capability = store.bind(owner);
    expect(capability.set('../escape', 'x', null)).toMatchObject({
      kind: 'invalid',
    });
    expect(capability.set('nan', Number.NaN, null)).toMatchObject({
      kind: 'invalid',
    });
    expect(capability.set('date', new Date() as never, null)).toMatchObject({
      kind: 'invalid',
    });
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        throw new Error('must not escape');
      },
    });
    expect(capability.set('accessor', accessor as never, null)).toMatchObject({
      kind: 'invalid',
    });
    expect(capability.list()).toEqual({ kind: 'available', records: [] });
    store.close();
  });

  test('bounds each serialized value before mutation', () => {
    const store = new PluginDataStore({ directory: root() });
    const capability = store.bind(owner);
    const value = 'x'.repeat(PLUGIN_DATA_LIMITS.valueBytes + 1);
    expect(capability.set('large', value, null)).toEqual({
      kind: 'capacity',
      reason: 'value-bytes',
    });
    expect(capability.get('large')).toEqual({ kind: 'not-found' });
    store.close();
  });

  test('bounds key count and aggregate bytes per installation', () => {
    const store = new PluginDataStore({ directory: root() });
    const capability = store.bind(owner);
    for (
      let index = 0;
      index < PLUGIN_DATA_LIMITS.keysPerInstallation;
      index += 1
    ) {
      expect(capability.set(`key-${index}`, null, null)).toMatchObject({
        kind: 'written',
      });
    }
    expect(capability.set('one-too-many', null, null)).toEqual({
      kind: 'capacity',
      reason: 'keys',
    });

    const aggregateOwner = {
      ...owner,
      installationKey: `sha256:${'c'.repeat(64)}`,
    };
    const aggregate = store.bind(aggregateOwner);
    const chunk = 'x'.repeat(PLUGIN_DATA_LIMITS.valueBytes - 2);
    for (let index = 0; index < 16; index += 1) {
      expect(aggregate.set(`chunk-${index}`, chunk, null)).toMatchObject({
        kind: 'written',
      });
    }
    expect(aggregate.set('overflow', 'extra', null)).toEqual({
      kind: 'capacity',
      reason: 'total-bytes',
    });
    store.close();
  });

  test.each([
    ['negative revision', 'revision = -1'],
    ['forged timestamp', "updated_at = 'not-a-time'"],
    ['mismatched byte length', 'byte_length = byte_length + 1'],
    [
      'oversized persisted value',
      `value_json = '"' || printf('%.*c', ${PLUGIN_DATA_LIMITS.valueBytes}, 'x') || '"', byte_length = ${PLUGIN_DATA_LIMITS.valueBytes + 2}`,
    ],
  ])('reports %s as corrupt instead of serving it', (_name, mutation) => {
    const directory = root();
    const store = new PluginDataStore({ directory });
    expect(store.bind(owner).set('state', { value: 1 }, null)).toMatchObject({
      kind: 'written',
    });
    store.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec(`UPDATE plugin_data SET ${mutation} WHERE key = 'state'`);
    database.close();

    const reopened = new PluginDataStore({ directory });
    expect(reopened.bind(owner).get('state')).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    reopened.close();
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
