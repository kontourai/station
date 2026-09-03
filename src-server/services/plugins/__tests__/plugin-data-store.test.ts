import {
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PLUGIN_DATA_LIMITS } from '@kontourai/station-contracts/plugin-data';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PluginDataStore } from '../plugin-data-store.js';

const roots: string[] = [];

function root(): string {
  const value = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-plugin-data-')),
  );
  roots.push(value);
  return value;
}

function store(directory: string): PluginDataStore {
  return new PluginDataStore({ trustedRoot: directory, directory });
}

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const owner = {
  pluginId: 'review-tools',
  installationKey: `sha256:${'a'.repeat(64)}`,
};

const absent = (revision: number | null = null) =>
  ({ kind: 'absent', revision }) as const;

describe('PluginDataStore', () => {
  test('persists owner-qualified JSON across handles', () => {
    const directory = root();
    const firstStore = store(directory);
    const first = firstStore.bind(owner);
    const created = first.set('preferences.theme', { mode: 'dark' }, absent());
    expect(created).toMatchObject({
      kind: 'written',
      record: {
        key: 'preferences.theme',
        value: { mode: 'dark' },
        revision: 1,
      },
    });
    firstStore.close();

    const secondStore = store(directory);
    const second = secondStore.bind(owner);
    expect(second.get('preferences.theme')).toMatchObject({
      kind: 'found',
      record: { value: { mode: 'dark' }, revision: 1 },
    });
    secondStore.close();
  });

  test('migrates the pre-runtime revision schema conservatively', () => {
    const directory = root();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec(`
      CREATE TABLE plugin_data (
        plugin_id TEXT NOT NULL,
        installation_key TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, installation_key, key)
      ) WITHOUT ROWID;
      CREATE TABLE plugin_data_revisions (
        plugin_id TEXT NOT NULL,
        installation_key TEXT NOT NULL,
        key TEXT NOT NULL,
        last_revision INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, installation_key, key)
      ) WITHOUT ROWID;
      INSERT INTO plugin_data VALUES
        ('${owner.pluginId}', '${owner.installationKey}', 'state', '"one"', 5, 1, '2026-09-03T00:00:00.000Z');
      INSERT INTO plugin_data_revisions VALUES
        ('${owner.pluginId}', '${owner.installationKey}', 'state', 1);
    `);
    database.close();

    const migrated = store(directory);
    expect(migrated.bind(owner).get('state')).toMatchObject({
      kind: 'found',
      record: { value: 'one', revision: 1 },
    });
    migrated.close();
    const inspected = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    expect(
      inspected
        .prepare(
          "SELECT record_state FROM plugin_data_revisions WHERE key = 'state'",
        )
        .get(),
    ).toEqual({ record_state: 'live' });
    inspected.close();
  });

  test('requires the observed revision for update and delete', () => {
    const directory = root();
    const firstStore = store(directory);
    const secondStore = store(directory);
    const first = firstStore.bind(owner);
    const second = secondStore.bind(owner);
    expect(first.set('state', { value: 1 }, absent())).toMatchObject({
      kind: 'written',
      record: { revision: 1 },
    });
    expect(second.set('state', { value: 2 }, absent())).toEqual({
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
    expect(first.get('state')).toEqual({
      kind: 'not-found',
      absence: absent(2),
    });
    expect(first.set('state', { value: 3 }, absent(2))).toMatchObject({
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

  test('rejects stale absence and stale live observations across two-writer create-delete-recreate ABA', () => {
    const directory = root();
    const firstStore = store(directory);
    const secondStore = store(directory);
    const first = firstStore.bind(owner);
    const second = secondStore.bind(owner);
    const initiallyAbsent = first.get('state');
    expect(initiallyAbsent).toEqual({
      kind: 'not-found',
      absence: absent(),
    });
    if (initiallyAbsent.kind !== 'not-found')
      throw new Error('expected absence');

    expect(second.set('state', 'one', initiallyAbsent.absence)).toMatchObject({
      kind: 'written',
      record: { revision: 1 },
    });
    expect(second.delete('state', 1)).toEqual({ kind: 'deleted' });
    expect(
      first.set('state', 'stale-absence', initiallyAbsent.absence),
    ).toEqual({
      kind: 'conflict',
      currentRevision: absent(1),
    });

    const afterDelete = first.get('state');
    expect(afterDelete).toEqual({
      kind: 'not-found',
      absence: absent(1),
    });
    if (afterDelete.kind !== 'not-found') throw new Error('expected tombstone');
    expect(first.set('state', 'two', afterDelete.absence)).toMatchObject({
      kind: 'written',
      record: { revision: 2 },
    });
    const staleLiveRevision = 2;
    expect(second.delete('state', staleLiveRevision)).toEqual({
      kind: 'deleted',
    });
    expect(first.set('state', 'stale-live', staleLiveRevision)).toEqual({
      kind: 'conflict',
      currentRevision: absent(2),
    });
    expect(first.set('state', 'three', absent(2))).toMatchObject({
      kind: 'written',
      record: { revision: 3, value: 'three' },
    });

    firstStore.close();
    secondStore.close();
  });

  test('isolates data by host-issued installation identity', () => {
    const dataStore = store(root());
    const original = dataStore.bind(owner);
    const replacement = {
      ...owner,
      installationKey: `sha256:${'b'.repeat(64)}`,
    };
    expect(original.set('state', 'original', absent())).toMatchObject({
      kind: 'written',
    });
    const replacementCapability = dataStore.bind(replacement);
    expect(replacementCapability.get('state')).toEqual({
      kind: 'not-found',
      absence: absent(),
    });
    expect(
      replacementCapability.set('state', 'replacement', absent()),
    ).toMatchObject({
      kind: 'written',
    });
    expect(original.get('state')).toMatchObject({
      kind: 'found',
      record: { value: 'original' },
    });
    dataStore.close();
  });

  test('rejects unsafe identities, keys, and non-JSON values before writing', () => {
    const dataStore = store(root());
    expect(() => dataStore.bind({ ...owner, pluginId: '../escape' })).toThrow(
      'pluginId must be a canonical plugin identifier',
    );
    const capability = dataStore.bind(owner);
    expect(capability.set('../escape', 'x', absent())).toMatchObject({
      kind: 'invalid',
    });
    expect(capability.set('nan', Number.NaN, absent())).toMatchObject({
      kind: 'invalid',
    });
    expect(capability.set('date', new Date() as never, absent())).toMatchObject(
      {
        kind: 'invalid',
      },
    );
    expect(capability.set('legacy-null', 'x', null as never)).toMatchObject({
      kind: 'invalid',
    });
    const revisionGetter = vi.fn(() => null);
    const accessorRevision = Object.defineProperty(
      { kind: 'absent' },
      'revision',
      { enumerable: true, get: revisionGetter },
    );
    expect(
      capability.set('accessor-revision', 'x', accessorRevision as never),
    ).toMatchObject({ kind: 'invalid' });
    expect(revisionGetter).not.toHaveBeenCalled();
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        throw new Error('must not escape');
      },
    });
    expect(
      capability.set('accessor', accessor as never, absent()),
    ).toMatchObject({
      kind: 'invalid',
    });
    expect(capability.get(Symbol('key') as never)).toMatchObject({
      kind: 'invalid',
    });
    const coerciveKey = {
      [Symbol.toPrimitive]() {
        throw new Error('key trap');
      },
    };
    expect(capability.delete(coerciveKey as never, 1)).toMatchObject({
      kind: 'invalid',
    });
    const trappingOwner = new Proxy(owner, {
      get() {
        throw new Error('owner trap');
      },
    });
    expect(() => dataStore.bind(trappingOwner)).toThrow(
      'Plugin data owner must be a host-issued identity',
    );
    expect(capability.list()).toEqual({ kind: 'available', records: [] });
    dataStore.close();
  });

  test('bounds each serialized value before mutation', () => {
    const dataStore = store(root());
    const capability = dataStore.bind(owner);
    const stringify = vi.spyOn(JSON, 'stringify');
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const value = 'x'.repeat(PLUGIN_DATA_LIMITS.valueBytes + 1);
      expect(capability.set('large', value, absent())).toEqual({
        kind: 'capacity',
        reason: 'value-bytes',
      });
      const property = 'x'.repeat(PLUGIN_DATA_LIMITS.valueBytes + 1);
      expect(
        capability.set('large-property', { [property]: null }, absent()),
      ).toEqual({
        kind: 'capacity',
        reason: 'value-bytes',
      });
      expect(stringify).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
      parse.mockRestore();
    }
    expect(capability.get('large')).toEqual({
      kind: 'not-found',
      absence: absent(),
    });
    expect(capability.get('large-property')).toEqual({
      kind: 'not-found',
      absence: absent(),
    });
    dataStore.close();
  });

  test('bounds key count and aggregate bytes per installation', () => {
    const dataStore = store(root());
    const capability = dataStore.bind(owner);
    for (
      let index = 0;
      index < PLUGIN_DATA_LIMITS.keysPerInstallation;
      index += 1
    ) {
      expect(capability.set(`key-${index}`, null, absent())).toMatchObject({
        kind: 'written',
      });
    }
    expect(capability.set('one-too-many', null, absent())).toEqual({
      kind: 'capacity',
      reason: 'keys',
    });
    expect(capability.delete('key-0', 1)).toEqual({ kind: 'deleted' });
    expect(capability.set('still-one-too-many', null, absent())).toEqual({
      kind: 'capacity',
      reason: 'keys',
    });
    expect(capability.set('key-0', null, absent(1))).toMatchObject({
      kind: 'written',
      record: { revision: 2 },
    });

    const aggregateOwner = {
      ...owner,
      installationKey: `sha256:${'c'.repeat(64)}`,
    };
    const aggregate = dataStore.bind(aggregateOwner);
    const chunk = 'x'.repeat(PLUGIN_DATA_LIMITS.valueBytes - 2);
    for (let index = 0; index < 16; index += 1) {
      expect(aggregate.set(`chunk-${index}`, chunk, absent())).toMatchObject({
        kind: 'written',
      });
    }
    expect(aggregate.set('overflow', 'extra', absent())).toEqual({
      kind: 'capacity',
      reason: 'total-bytes',
    });
    dataStore.close();
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
    const dataStore = store(directory);
    expect(
      dataStore.bind(owner).set('state', { value: 1 }, absent()),
    ).toMatchObject({
      kind: 'written',
    });
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec(`UPDATE plugin_data SET ${mutation} WHERE key = 'state'`);
    database.close();

    const reopened = store(directory);
    expect(reopened.bind(owner).get('state')).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    reopened.close();
  });

  test('refuses delete when the retained revision head is corrupt', () => {
    const directory = root();
    const dataStore = store(directory);
    const capability = dataStore.bind(owner);
    expect(capability.set('state', 'one', absent())).toMatchObject({
      kind: 'written',
    });
    expect(capability.set('state', 'two', 1)).toMatchObject({
      kind: 'written',
    });
    expect(capability.set('state', 'three', 2)).toMatchObject({
      kind: 'written',
      record: { revision: 3 },
    });
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec(
      "UPDATE plugin_data_revisions SET last_revision = 1 WHERE key = 'state'",
    );
    database.close();

    const reopened = store(directory);
    const rebound = reopened.bind(owner);
    expect(rebound.delete('state', 3)).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    expect(rebound.get('state')).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    reopened.close();
  });

  test('does not repair a missing retained revision head during reopen', () => {
    const directory = root();
    const dataStore = store(directory);
    expect(dataStore.bind(owner).set('state', 'one', absent())).toMatchObject({
      kind: 'written',
    });
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec("DELETE FROM plugin_data_revisions WHERE key = 'state'");
    database.close();

    const reopened = store(directory);
    expect(reopened.bind(owner).get('state')).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    expect(reopened.bind(owner).list()).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    reopened.close();
  });

  test('does not reinterpret a missing live payload as a tombstone', () => {
    const directory = root();
    const dataStore = store(directory);
    expect(dataStore.bind(owner).set('state', 'one', absent())).toMatchObject({
      kind: 'written',
      record: { revision: 1 },
    });
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.prepare('DELETE FROM plugin_data WHERE key = ?').run('state');
    database.close();

    const reopened = store(directory);
    const rebound = reopened.bind(owner);
    expect(rebound.get('state')).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    expect(rebound.list()).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    expect(rebound.set('state', 'replacement', absent())).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    reopened.close();
  });

  test('persists explicit tombstones across restart and monotonic recreation', () => {
    const directory = root();
    const dataStore = store(directory);
    const capability = dataStore.bind(owner);
    expect(capability.set('state', 'one', absent())).toMatchObject({
      kind: 'written',
      record: { revision: 1 },
    });
    expect(capability.delete('state', 1)).toEqual({ kind: 'deleted' });
    dataStore.close();

    const reopened = store(directory);
    const rebound = reopened.bind(owner);
    expect(rebound.get('state')).toEqual({
      kind: 'not-found',
      absence: absent(1),
    });
    expect(rebound.list()).toEqual({ kind: 'available', records: [] });
    expect(rebound.set('state', 'two', absent(1))).toMatchObject({
      kind: 'written',
      record: { revision: 2, value: 'two' },
    });
    reopened.close();
  });

  test('reports a corrupt tombstone revision head instead of absence', () => {
    const directory = root();
    const dataStore = store(directory);
    const capability = dataStore.bind(owner);
    expect(capability.set('state', 'one', absent())).toMatchObject({
      kind: 'written',
      record: { revision: 1 },
    });
    expect(capability.delete('state', 1)).toEqual({ kind: 'deleted' });
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec(
      "UPDATE plugin_data_revisions SET last_revision = -1 WHERE key = 'state'",
    );
    database.close();

    const reopened = store(directory);
    expect(reopened.bind(owner).get('state')).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    reopened.close();
  });

  test('refuses every namespace mutation when a peer revision head is corrupt', () => {
    const directory = root();
    const dataStore = store(directory);
    const capability = dataStore.bind(owner);
    expect(capability.set('corrupt-peer', 'one', absent())).toMatchObject({
      kind: 'written',
    });
    expect(capability.set('healthy-peer', 'one', absent())).toMatchObject({
      kind: 'written',
    });
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec(
      "UPDATE plugin_data_revisions SET last_revision = 2 WHERE key = 'corrupt-peer'",
    );
    database.close();

    const reopened = store(directory);
    const rebound = reopened.bind(owner);
    expect(rebound.set('healthy-peer', 'two', 1)).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    expect(rebound.delete('healthy-peer', 1)).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    expect(rebound.get('healthy-peer')).toMatchObject({
      kind: 'found',
      record: { revision: 1, value: 'one' },
    });
    reopened.close();
  });

  test('lists one coherent WAL snapshot while another handle commits', () => {
    const directory = root();
    const seeded = store(directory);
    expect(seeded.bind(owner).set('state', 'one', absent())).toMatchObject({
      kind: 'written',
    });
    seeded.close();

    const writer = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    let interleaved = false;
    const reader = new PluginDataStore({
      trustedRoot: directory,
      directory,
      afterRevisionHeadsRead() {
        if (interleaved) return;
        interleaved = true;
        writer.exec('BEGIN IMMEDIATE');
        writer.exec(
          `UPDATE plugin_data
           SET value_json = '"two"', byte_length = 5, revision = 2,
               updated_at = '2026-09-03T00:00:01.000Z'
           WHERE key = 'state';
           UPDATE plugin_data_revisions SET last_revision = 2 WHERE key = 'state';`,
        );
        writer.exec('COMMIT');
      },
    });
    expect(reader.bind(owner).list()).toEqual({
      kind: 'available',
      records: [
        expect.objectContaining({ key: 'state', value: 'one', revision: 1 }),
      ],
    });
    expect(reader.bind(owner).get('state')).toMatchObject({
      kind: 'found',
      record: { value: 'two', revision: 2 },
    });
    reader.close();
    writer.close();
  });

  test('refuses an oversized persisted namespace on reads and updates', () => {
    const directory = root();
    const dataStore = store(directory);
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    const insertData = database.prepare(
      `INSERT INTO plugin_data
        (plugin_id, installation_key, key, value_json, byte_length, revision, updated_at)
       VALUES (?, ?, ?, 'null', 4, 1, '2026-09-03T00:00:00.000Z')`,
    );
    const insertHead = database.prepare(
      `INSERT INTO plugin_data_revisions
        (plugin_id, installation_key, key, last_revision)
       VALUES (?, ?, ?, 1)`,
    );
    database.exec('BEGIN IMMEDIATE');
    for (
      let index = 0;
      index <= PLUGIN_DATA_LIMITS.keysPerInstallation;
      index += 1
    ) {
      const key = `corrupt-${index}`;
      insertData.run(owner.pluginId, owner.installationKey, key);
      insertHead.run(owner.pluginId, owner.installationKey, key);
    }
    database.exec('COMMIT');
    database.close();

    const reopened = store(directory);
    const rebound = reopened.bind(owner);
    expect(rebound.list()).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    expect(rebound.set('corrupt-0', 'updated', 1)).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    reopened.close();
  });

  test('classifies overflowing persisted declared-byte totals as corrupt', () => {
    const directory = root();
    const dataStore = store(directory);
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec(`
      INSERT INTO plugin_data
        (plugin_id, installation_key, key, value_json, byte_length, revision, updated_at)
      VALUES
        ('${owner.pluginId}', '${owner.installationKey}', 'overflow-a', 'null', 9223372036854775807, 1, '2026-09-03T00:00:00.000Z'),
        ('${owner.pluginId}', '${owner.installationKey}', 'overflow-b', 'null', 1, 1, '2026-09-03T00:00:00.000Z');
      INSERT INTO plugin_data_revisions
        (plugin_id, installation_key, key, last_revision)
      VALUES
        ('${owner.pluginId}', '${owner.installationKey}', 'overflow-a', 1),
        ('${owner.pluginId}', '${owner.installationKey}', 'overflow-b', 1);
    `);
    database.close();

    const reopened = store(directory);
    expect(reopened.bind(owner).list()).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    reopened.close();
  });

  test('rejects oversized persisted metadata before row materialization', () => {
    const directory = root();
    const dataStore = store(directory);
    expect(dataStore.bind(owner).set('state', 'one', absent())).toMatchObject({
      kind: 'written',
    });
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec(
      "UPDATE plugin_data SET updated_at = zeroblob(1000000) WHERE key = 'state'",
    );
    database.close();
    const afterRevisionHeadsRead = vi.fn();

    const reopened = new PluginDataStore({
      trustedRoot: directory,
      directory,
      afterRevisionHeadsRead,
    });
    expect(reopened.bind(owner).list()).toEqual({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    expect(afterRevisionHeadsRead).not.toHaveBeenCalled();
    reopened.close();
  });

  test('rejects oversized persisted revision-head keys', () => {
    const directory = root();
    const dataStore = store(directory);
    expect(dataStore.bind(owner).set('state', 'one', absent())).toMatchObject({
      kind: 'written',
    });
    dataStore.close();
    const database = new DatabaseSync(join(directory, 'plugin-data.sqlite'));
    database.exec(
      "UPDATE plugin_data_revisions SET key = zeroblob(1000000) WHERE key = 'state'",
    );
    database.close();

    const reopened = store(directory);
    expect(reopened.bind(owner).list()).toEqual({
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
    expect(() => store(directory)).toThrow(
      'Plugin data database must not be a symbolic link',
    );
    expect(
      lstatSync(join(directory, 'plugin-data.sqlite')).isSymbolicLink(),
    ).toBe(true);
  });

  test('refuses an ancestor symlink beneath the trusted physical root', () => {
    const trustedRoot = root();
    const outside = root();
    const linked = join(trustedRoot, 'linked');
    symlinkSync(outside, linked);
    const directory = join(linked, 'data');

    expect(() => new PluginDataStore({ trustedRoot, directory })).toThrow(
      'Plugin data directory path must contain only real directories',
    );
    expect(existsSync(join(outside, 'data', 'plugin-data.sqlite'))).toBe(false);
  });

  test('refuses a data directory outside its trusted physical root', () => {
    const trustedRoot = root();
    const outside = root();
    expect(
      () => new PluginDataStore({ trustedRoot, directory: outside }),
    ).toThrow('Plugin data directory must remain within its trusted root');
  });
});
