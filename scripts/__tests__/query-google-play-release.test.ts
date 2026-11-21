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

  test.each([
    ['authenticate', []],
    ['acquire-client', []],
    ['create-edit', ['POST']],
    ['read-track', ['POST', 'GET', 'DELETE']],
    ['read-bundles', ['POST', 'GET', 'GET', 'DELETE']],
    ['validate-observation', ['POST', 'GET', 'GET', 'DELETE']],
    ['delete-edit', ['POST', 'GET', 'GET', 'DELETE']],
  ] as const)(
    'reports a safe %s failure and preserves edit custody',
    async (phase, methods) => {
      const calls: string[] = [];
      const privateError = new Error('private-provider-context');
      const client = {
        request: async ({ method, url }: { method: string; url: string }) => {
          calls.push(method);
          if (method === 'POST') {
            if (phase === 'create-edit') throw privateError;
            return { data: { id: 'private-edit-id' } };
          }
          if (method === 'DELETE') {
            if (phase === 'delete-edit') throw privateError;
            return { data: {} };
          }
          if (url.endsWith('/tracks/internal')) {
            if (phase === 'read-track') throw privateError;
            const { track } = response();
            if (phase === 'validate-observation')
              track.releases[0].status = privateError.message;
            return { data: track };
          }
          if (phase === 'read-bundles') throw privateError;
          return { data: response().bundles };
        },
      };
      await expect(
        queryGooglePlayInternal(identity, {
          authFactory: async () => {
            if (phase === 'authenticate') throw privateError;
            return {
              getClient: async () => {
                if (phase === 'acquire-client') throw privateError;
                return client;
              },
            };
          },
        }),
      ).rejects.toMatchObject({
        message: `Google Play cohort verification failed: ${phase} failed`,
        cause:
          phase === 'validate-observation'
            ? expect.objectContaining({
                message: expect.stringContaining(privateError.message),
              })
            : privateError,
      });
      expect(calls).toEqual(methods);
    },
  );

  test('does not delete an edit when its creation returned no valid identity', async () => {
    const calls: string[] = [];
    const client = {
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        return { data: { id: 42 } };
      },
    };
    await expect(
      queryGooglePlayInternal(identity, {
        authFactory: async () => ({ getClient: async () => client }),
      }),
    ).rejects.toThrow('create-edit failed');
    expect(calls).toEqual(['POST']);
  });

  test.each([
    ['abort', 'aborted'],
    ['local deadline', 'local deadline elapsed'],
    ['unrelated failure after deadline', 'failed'],
  ] as const)(
    'reports %s without exposing the transport error',
    async (input, outcome) => {
      const client = {
        request: async ({
          method,
          signal,
        }: {
          method: string;
          signal: AbortSignal;
        }) => {
          if (method === 'POST') return { data: { id: 'edit' } };
          if (method === 'DELETE') return { data: {} };
          if (input === 'abort')
            throw new DOMException('private-context', 'AbortError');
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () =>
              reject(
                input === 'local deadline'
                  ? signal.reason
                  : new Error('private-context'),
              ),
            ),
          );
        },
      };
      await expect(
        queryGooglePlayInternal(identity, {
          authFactory: async () => ({ getClient: async () => client }),
          requestTimeoutMs: input === 'abort' ? 15_000 : 1,
        }),
      ).rejects.toMatchObject({
        message: `Google Play cohort verification failed: read-track ${outcome}`,
      });
    },
  );

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
    ).rejects.toMatchObject({
      message: 'Google Play cohort verification failed: read-track failed',
      cause: expect.objectContaining({ message: 'provider timeout' }),
    });
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
    ).rejects.toThrow('delete-edit failed');

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
    ).rejects.toMatchObject({
      message:
        'Google Play cohort verification failed: delete-edit failed after read-track failed',
      cause: expect.objectContaining({
        errors: [
          expect.objectContaining({
            cause: expect.objectContaining({ message: 'cleanup failed' }),
          }),
          expect.objectContaining({
            cause: expect.objectContaining({ message: 'track read failed' }),
          }),
        ],
      }),
    });
  });
});
