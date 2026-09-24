import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  NativePushRegistrationStore,
  NativePushRegistrationStoreError,
} from '../native-push-registration-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-native-push-store-'));
  roots.push(home);
  mkdirSync(join(home, 'security'), { mode: 0o700 });
  return {
    home,
    reopen: () => new NativePushRegistrationStore(home),
    store: new NativePushRegistrationStore(home),
    path: join(home, 'security', 'native-push-registrations.json'),
  };
}

const REQUEST = {
  token: `fcm-token-${'a'.repeat(40)}`,
  packageName: 'io.kontourai.station',
  platform: 'android',
} as const;
const KEY = 'k'.repeat(43);
const posix = process.platform !== 'win32';

describe('NativePushRegistrationStore', () => {
  test('creates nothing until a registration, then a 0600 file', () => {
    const { store, path } = fixture();
    expect(store.list().size).toBe(0);
    const registration = store.upsert('device-1', REQUEST, KEY, 1);
    expect(registration.payloadKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.list().get('device-1')).toEqual(registration);
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('keeps the registrationId and payload key across token rotation', () => {
    const { store } = fixture();
    const first = store.upsert('device-1', REQUEST, KEY, 1);
    const rotated = store.upsert(
      'device-1',
      { ...REQUEST, token: `fcm-token-${'b'.repeat(40)}` },
      KEY,
      2,
    );
    expect(rotated.registrationId).toBe(first.registrationId);
    expect(rotated.payloadKey).toBe(first.payloadKey);
  });

  test('retain drops every device not kept', () => {
    const { store } = fixture();
    store.upsert('keep', REQUEST, KEY, 1);
    store.upsert('drop', REQUEST, KEY, 1);
    store.retain(new Set(['keep']));
    expect([...store.list().keys()]).toEqual(['keep']);
  });

  test('refuses a corrupt file rather than treating it as empty', () => {
    const { store, path } = fixture();
    writeFileSync(path, '{ nope', { mode: 0o600 });
    expect(() => store.list()).toThrow(NativePushRegistrationStoreError);
    expect(() => store.upsert('device-1', REQUEST, KEY, 1)).toThrow(
      NativePushRegistrationStoreError,
    );
    expect(readFileSync(path, 'utf8')).toBe('{ nope');
  });

  test('refuses a record with an unknown field', () => {
    const { store, path, reopen } = fixture();
    const registration = store.upsert('device-1', REQUEST, KEY, 1);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        registrations: { 'device-1': { ...registration, extra: 1 } },
      }),
      { mode: 0o600 },
    );
    expect(() => reopen().list()).toThrow(NativePushRegistrationStoreError);
  });

  test.runIf(posix)('refuses a loosely permissioned file', () => {
    const { store, path, reopen } = fixture();
    store.upsert('device-1', REQUEST, KEY, 1);
    chmodSync(path, 0o644);
    expect(() => reopen().list()).toThrow(NativePushRegistrationStoreError);
  });

  test('serves reads from memory after the first, and its own writes keep it current', () => {
    const { store, path } = fixture();
    store.upsert('device-1', REQUEST, KEY, 1);
    // Not re-read from disk: an external edit is invisible to this writer…
    writeFileSync(path, '{ garbage', { mode: 0o600 });
    expect([...store.list().keys()]).toEqual(['device-1']);
    // …and its own write replaces both file and cache.
    store.upsert('device-2', REQUEST, KEY, 2);
    expect([...store.list().keys()].sort()).toEqual(['device-1', 'device-2']);
    expect(readFileSync(path, 'utf8')).toContain('device-2');
  });

  test('a failed read is not cached', () => {
    const { store, path } = fixture();
    writeFileSync(path, '{ garbage', { mode: 0o600 });
    expect(() => store.list()).toThrow(NativePushRegistrationStoreError);
    rmSync(path);
    expect(store.list().size).toBe(0);
  });

  test('records delivered alert ids durably, bounded, and keeps them across token rotation', () => {
    const { store, reopen } = fixture();
    const first = store.upsert('device-1', REQUEST, KEY, 1);
    const ids = Array.from({ length: 130 }, (_, i) =>
      i.toString(16).padStart(64, '0'),
    );
    store.recordAlerted('device-1', first.registrationId, ids);
    store.upsert(
      'device-1',
      { ...REQUEST, token: `fcm-token-${'z'.repeat(40)}` },
      KEY,
      2,
    );
    const alerted = reopen().list().get('device-1')?.alerted ?? [];
    expect(alerted).toHaveLength(128);
    expect(alerted.at(-1)).toBe(ids.at(-1));
    // A stale registrationId records nothing.
    store.recordAlerted('device-1', 'other', ['f'.repeat(64)]);
    expect(reopen().list().get('device-1')?.alerted).not.toContain(
      'f'.repeat(64),
    );
  });
});
