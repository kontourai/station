import { describe, expect, test } from 'vitest';
import {
  emptyStationProfileStore,
  isStationProfile,
  isStationProfileStore,
} from '../station-profile.js';

const profile = {
  schemaVersion: 1,
  name: 'kontour',
  endpoint: 'http://127.0.0.1:3141',
  credentialRef: { kind: 'station-bearer', id: 'env-kontour' },
  environmentId: 'env-kontour',
  setupSource: 'local',
  configurationState: 'configured',
  createdAt: 1,
  updatedAt: 1,
};

describe('saved Station contract', () => {
  /**
   * station#1818 part 3 review round 1 (MEDIUM) — `clientInstanceId` is
   * shared, plain-JSON state written by the desktop app's
   * `station_local_self_provision` and read back by both the desktop app
   * and the CLI (the same `profiles.json`). It must round-trip through
   * this strict validator or the CLI would refuse the whole shared store
   * the first time desktop persists one.
   */
  test('accepts a profile carrying a persisted clientInstanceId', () => {
    expect(
      isStationProfile({
        ...profile,
        clientInstanceId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe(true);
  });

  test('rejects a clientInstanceId that is not UUID-shaped, matching the server route it must reach', () => {
    expect(
      isStationProfile({ ...profile, clientInstanceId: 'not-a-uuid' }),
    ).toBe(false);
    expect(isStationProfile({ ...profile, clientInstanceId: '' })).toBe(false);
  });

  test('accepts a versioned secret-free profile store', () => {
    expect(isStationProfile(profile)).toBe(true);
    expect(
      isStationProfileStore({
        schemaVersion: 1,
        revision: 0,
        defaultProfile: 'kontour',
        projectProfiles: {},
        profiles: [profile],
      }),
    ).toBe(true);
    expect(emptyStationProfileStore()).toEqual({
      schemaVersion: 1,
      revision: 0,
      defaultProfile: null,
      projectProfiles: {},
      profiles: [],
    });
  });

  test('rejects unknown versions, plaintext credential fields, dangling defaults, and case collisions', () => {
    expect(isStationProfile({ ...profile, schemaVersion: 2 })).toBe(false);
    expect(isStationProfile({ ...profile, credential: 'bearer-secret' })).toBe(
      false,
    );
    expect(
      isStationProfileStore({
        schemaVersion: 1,
        revision: 0,
        defaultProfile: 'missing',
        projectProfiles: {},
        profiles: [profile],
      }),
    ).toBe(false);
    expect(
      isStationProfileStore({
        schemaVersion: 1,
        revision: 0,
        defaultProfile: null,
        projectProfiles: {},
        profiles: [profile, { ...profile, name: 'Kontour' }],
      }),
    ).toBe(false);
    expect(
      isStationProfile({
        ...profile,
        localService: {
          instanceId: 'kontour',
          baseDir: '/tmp/kontour',
          serverPort: 31_41,
          uiPort: 3000,
          extra: 'not allowed',
        },
      }),
    ).toBe(false);
    expect(
      isStationProfile({
        ...profile,
        localService: {
          instanceId: '',
          baseDir: '/tmp/kontour',
          serverPort: 0,
          uiPort: 70_000,
        },
      }),
    ).toBe(false);
  });
});
