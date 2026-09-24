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
  isValidNativePushRequest,
  NativePushIosRegistrationStore,
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

  test('another process writing the file is seen at the next read', () => {
    const { store, reopen } = fixture();
    store.upsert('device-1', REQUEST, KEY, 1);
    expect([...store.list().keys()]).toEqual(['device-1']);
    // A second writer over the same file (as `station environment reset`
    // is): this instance's cache must not outlive the file it came from.
    const other = reopen();
    other.retain(new Set());
    expect(store.list().size).toBe(0);
    // And this instance's next write cannot resurrect what the other removed.
    store.upsert('device-2', REQUEST, KEY, 2);
    expect([...reopen().list().keys()]).toEqual(['device-2']);
  });

  test('its own writes keep the cache current', () => {
    const { store, reopen } = fixture();
    store.upsert('device-1', REQUEST, KEY, 1);
    store.upsert('device-2', REQUEST, KEY, 2);
    expect([...store.list().keys()].sort()).toEqual(['device-1', 'device-2']);
    expect([...reopen().list().keys()].sort()).toEqual([
      'device-1',
      'device-2',
    ]);
  });

  test('a failed read is not cached: once the file is repaired, the next read sees it', () => {
    const { store, path, reopen } = fixture();
    const good = reopen();
    good.upsert('device-1', REQUEST, KEY, 1);
    const goodContent = readFileSync(path, 'utf8');
    writeFileSync(path, '{ garbage', { mode: 0o600 });
    expect(() => store.list()).toThrow(NativePushRegistrationStoreError);
    writeFileSync(path, goodContent, { mode: 0o600 });
    expect([...store.list().keys()]).toEqual(['device-1']);
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

const IOS_REQUEST = {
  token: 'ab'.repeat(40),
  packageName: 'io.kontourai.station',
  platform: 'ios',
  apnsEnvironment: 'production',
} as const;
const CHANNEL = 'dHN0LXNyY2gtY2hubA==';
const RUN_ID = 'r'.repeat(22);

function iosFixture() {
  const base = fixture();
  return {
    ...base,
    ios: new NativePushIosRegistrationStore(base.home),
    reopenIos: () => new NativePushIosRegistrationStore(base.home),
    iosPath: join(base.home, 'security', 'native-push-ios-registrations.json'),
  };
}

describe('isValidNativePushRequest (the registration union)', () => {
  test.each([
    ['android', REQUEST, true],
    ['ios', IOS_REQUEST, true],
    ['ios sandbox', { ...IOS_REQUEST, apnsEnvironment: 'sandbox' }, true],
    [
      'ios with an Android-only package',
      { ...IOS_REQUEST, packageName: 'io.kontourai.station.debug' },
      false,
    ],
    [
      'android with an iOS-only bundle',
      { ...REQUEST, packageName: 'io.kontourai.station.dev.instance' },
      false,
    ],
    [
      'ios without an environment',
      { ...IOS_REQUEST, apnsEnvironment: undefined },
      false,
    ],
    [
      'ios with uppercase hex',
      { ...IOS_REQUEST, token: 'AB'.repeat(40) },
      false,
    ],
    ['ios with an FCM token', { ...IOS_REQUEST, token: REQUEST.token }, false],
    [
      'android with an iOS platform tag',
      { ...REQUEST, platform: 'ios' },
      false,
    ],
    ['an unknown platform', { ...REQUEST, platform: 'web' }, false],
  ])('%s', (_label, value, valid) => {
    expect(isValidNativePushRequest(value)).toBe(valid);
  });
});

describe('NativePushIosRegistrationStore', () => {
  test('round trip in its own 0600 file; the Android file is never created', () => {
    const { ios, reopenIos, iosPath, path } = iosFixture();
    const registration = ios.upsert('device-1', IOS_REQUEST, KEY, 1);
    expect(registration).toEqual({
      ...IOS_REQUEST,
      registrationId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      payloadKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      stationKey: KEY,
      updatedAt: 1,
    });
    expect(reopenIos().list().get('device-1')).toEqual(registration);
    expect(() => readFileSync(path)).toThrow();
    if (posix) expect(statSync(iosPath).mode & 0o777).toBe(0o600);
  });

  test('channel and activity persist, and survive a token rotation on the same topic', () => {
    const { ios, reopenIos } = iosFixture();
    const { registrationId } = ios.upsert('device-1', IOS_REQUEST, KEY, 1);
    ios.updateLiveActivity('device-1', registrationId, { channelId: CHANNEL });
    ios.updateLiveActivity('device-1', registrationId, {
      activity: { startedAt: 5, runId: RUN_ID },
    });
    const rotated = ios.upsert(
      'device-1',
      { ...IOS_REQUEST, token: 'cd'.repeat(40) },
      KEY,
      2,
    );
    expect(rotated).toMatchObject({
      registrationId,
      channelId: CHANNEL,
      activity: { startedAt: 5, runId: RUN_ID },
    });
    expect(reopenIos().list().get('device-1')).toEqual(rotated);
  });

  test('a token for another bundle or environment drops the channel and its activity', () => {
    const { ios } = iosFixture();
    const { registrationId } = ios.upsert('device-1', IOS_REQUEST, KEY, 1);
    ios.updateLiveActivity('device-1', registrationId, {
      channelId: CHANNEL,
      activity: { startedAt: 5, runId: RUN_ID },
    });
    const moved = ios.upsert(
      'device-1',
      { ...IOS_REQUEST, apnsEnvironment: 'sandbox' },
      KEY,
      2,
    );
    expect(moved.registrationId).toBe(registrationId);
    expect(moved.channelId).toBeUndefined();
    expect(moved.activity).toBeUndefined();
  });

  test('clearing the channel clears the activity; a stale run id or registration changes nothing', () => {
    const { ios } = iosFixture();
    const { registrationId } = ios.upsert('device-1', IOS_REQUEST, KEY, 1);
    ios.updateLiveActivity('device-1', registrationId, {
      channelId: CHANNEL,
      activity: { startedAt: 5, runId: RUN_ID },
    });
    expect(
      ios.updateLiveActivity('device-1', registrationId, {
        activity: null,
        expectedRunId: 's'.repeat(22),
      }),
    ).toBeUndefined();
    expect(
      ios.updateLiveActivity('device-1', 'other-registration-id-000', {
        channelId: null,
      }),
    ).toBeUndefined();
    expect(ios.list().get('device-1')?.activity).toEqual({
      startedAt: 5,
      runId: RUN_ID,
    });
    ios.updateLiveActivity('device-1', registrationId, { channelId: null });
    const cleared = ios.list().get('device-1');
    expect(cleared?.channelId).toBeUndefined();
    expect(cleared?.activity).toBeUndefined();
  });

  test.each([
    ['an unknown field', { extra: 1 }],
    [
      'an activity without a channel',
      { activity: { startedAt: 1, runId: RUN_ID } },
    ],
    ['a malformed channel id', { channelId: 'no spaces allowed' }],
    [
      'an activity with an unknown field',
      { channelId: CHANNEL, activity: { startedAt: 1, runId: RUN_ID, x: 1 } },
    ],
    ['an Android record', { platform: 'android' }],
  ])('refuses a file holding %s', (_label, patch) => {
    const { ios, reopenIos, iosPath } = iosFixture();
    const registration = ios.upsert('device-1', IOS_REQUEST, KEY, 1);
    writeFileSync(
      iosPath,
      JSON.stringify({
        schemaVersion: 1,
        registrations: { 'device-1': { ...registration, ...patch } },
      }),
      { mode: 0o600 },
    );
    expect(() => reopenIos().list()).toThrow(NativePushRegistrationStoreError);
  });

  test('downgrade safety: the Android store refuses an iOS record, which is why iOS has its own file', () => {
    const { store, ios, reopen, path } = iosFixture();
    store.upsert('android-1', REQUEST, KEY, 1);
    const androidBytes = readFileSync(path, 'utf8');
    const iosRecord = ios.upsert('ios-1', IOS_REQUEST, KEY, 1);
    // Writing iOS records leaves the Android file byte-identical...
    expect(readFileSync(path, 'utf8')).toBe(androidBytes);
    expect([...reopen().list().keys()]).toEqual(['android-1']);
    // ...because an Android reader (today's, and every older Station's)
    // refuses the whole file once one iOS record is in it.
    const file = JSON.parse(androidBytes);
    file.registrations['ios-1'] = iosRecord;
    writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
    expect(() => reopen().list()).toThrow(NativePushRegistrationStoreError);
  });
});
