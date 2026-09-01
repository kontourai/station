import { describe, expect, test } from 'vitest';
import {
  parseGooglePlayObservation,
  queryGooglePlayInternal,
} from '../query-google-play-release.mjs';

const identity = {
  packageName: 'io.kontourai.station.nightly',
  versionCode: 242801,
  versionName: '0.1.3-nightly.242801',
};
const response = () => ({
  track: {
    releases: [
      {
        name: identity.versionName,
        status: 'completed',
        versionCodes: [String(identity.versionCode)],
      },
    ],
  },
  bundles: {
    bundles: [{ versionCode: identity.versionCode, sha256: 'a'.repeat(64) }],
  },
});

describe('Google Play internal observation', () => {
  test('requires one complete observed release and bundle for the Nightly identity', () => {
    expect(parseGooglePlayObservation(identity, response())).toMatchObject({
      provider: 'google-play',
      requested: { track: 'internal', status: 'completed' },
      observed: { versionName: identity.versionName },
      rawResponseDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    for (const mutate of [
      (value: any) => (value.track.releases[0].status = 'inProgress'),
      (value: any) => (value.track.releases[0].name = 'unbound'),
      (value: any) => value.track.releases.push(value.track.releases[0]),
      (value: any) => (value.bundles.bundles = []),
      (value: any) => value.bundles.bundles.push(value.bundles.bundles[0]),
    ]) {
      const value = response();
      mutate(value);
      expect(() => parseGooglePlayObservation(identity, value)).toThrow(
        'Google Play cohort verification failed',
      );
    }
    expect(() =>
      parseGooglePlayObservation(
        { ...identity, packageName: 'io.kontourai.station' },
        response(),
      ),
    ).toThrow('Nightly listing');
  });

  test('uses ADC and deletes the temporary edit even when the observation fails', async () => {
    const calls: any[] = [];
    const client = {
      request: async (request: any) => {
        calls.push(request);
        if (request.method === 'POST')
          return { data: { id: 'edit/unsafe;literal' } };
        if (
          request.method === 'GET' &&
          request.url.endsWith('/tracks/internal')
        )
          return { data: response().track };
        if (request.method === 'GET') return { data: response().bundles };
        return { data: {} };
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => client }),
      }),
    ).resolves.toMatchObject({ provider: 'google-play' });
    expect(calls.map((call) => call.method)).toEqual([
      'POST',
      'GET',
      'GET',
      'DELETE',
    ]);
    expect(calls.every((call) => call.timeout === 15_000 && call.signal)).toBe(
      true,
    );
    expect(calls.at(-1).url).toContain('edit%2Funsafe%3Bliteral');

    const failingClient = {
      request: async (request: any) => {
        calls.push(request);
        if (request.method === 'POST') return { data: { id: 'edit' } };
        if (request.method === 'DELETE') return { data: {} };
        throw new Error('provider timeout');
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => failingClient }),
      }),
    ).rejects.toThrow('provider timeout');
    expect(calls.at(-1).method).toBe('DELETE');

    const cleanupFailure = {
      request: async (request: any) => {
        if (request.method === 'POST') return { data: { id: 'edit' } };
        if (request.method === 'DELETE') throw new Error('cleanup timeout');
        return request.url.endsWith('/tracks/internal')
          ? { data: response().track }
          : { data: response().bundles };
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => cleanupFailure }),
      }),
    ).rejects.toThrow('temporary edit cleanup failed');

    const dualFailure = {
      request: async (request: any) => {
        if (request.method === 'POST') return { data: { id: 'edit' } };
        if (request.method === 'DELETE') throw new Error('cleanup failed');
        throw new Error('track read failed');
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => dualFailure }),
      }),
    ).rejects.toThrow(
      'cleanup failed; operation also failed: track read failed',
    );

    const hangingClient = {
      request: async (request: any) => {
        if (request.method === 'POST') return { data: { id: 'edit' } };
        if (request.method === 'DELETE') return { data: {} };
        return new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        );
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => hangingClient }),
        requestTimeoutMs: 1,
      }),
    ).rejects.toThrow('aborted');
  });
});
