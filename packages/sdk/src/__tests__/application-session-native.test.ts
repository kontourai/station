import {
  APPLICATION_SESSION_NATIVE_CHALLENGE_PATH,
  APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
  APPLICATION_SESSION_NATIVE_HEADER,
  APPLICATION_SESSION_NATIVE_PROOF_HEADER,
  APPLICATION_SESSION_NATIVE_VERSION,
  type NativeApplicationSessionChallengeV1,
  type NativeApplicationSessionContinuationV1,
  type NativeApplicationSessionProofClaimsV1,
} from '@kontourai/station-contracts/application-session';
import { describe, expect, test, vi } from 'vitest';
import { createApplicationSessionKey } from '../client/application-session';
import {
  applicationSessionKeyThumbprint,
  canonicalCredentialsHash,
  createNativeApplicationSessionProof,
  NativeApplicationSessionClient,
  type NativeApplicationSessionTrustSnapshotV1,
} from '../client/application-session-native';

const OPAQUE = (label: string) => label.padEnd(43, 'A').slice(0, 43);

const audience = 'https://station.example';
const surface = {
  kind: 'station-native' as const,
  appIdentifier: 'io.kontourai.station',
  channel: 'dev' as const,
  clientInstanceId: '33333333-3333-4333-8333-333333333333',
  keyThumbprint: OPAQUE('K'),
};
const deviceId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const credentials = { username: 'operator', password: 'correct horse' };

function decodeClaims(proof: string): NativeApplicationSessionProofClaimsV1 {
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(proof.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
        (character) => character.charCodeAt(0),
      ),
    ),
  );
}

async function fixture() {
  const key = await createApplicationSessionKey();
  let trust: NativeApplicationSessionTrustSnapshotV1 = {
    kind: 'station-native',
    stationId: '11111111-1111-4111-8111-111111111111',
    audience,
    deviceId,
    surface,
  };
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  let challengeOverride: Partial<NativeApplicationSessionChallengeV1> = {};
  let continuationOverride: Partial<NativeApplicationSessionContinuationV1> =
    {};
  let dropContinuation = false;
  const posts: {
    path: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }[] = [];
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const transport = {
    post: async (input: {
      path: string;
      headers: Record<string, string>;
      body: unknown;
    }) => {
      posts.push({
        path: input.path,
        headers: { ...input.headers },
        body: input.body as Record<string, unknown>,
      });
      if (input.path === APPLICATION_SESSION_NATIVE_CHALLENGE_PATH) {
        return {
          version: APPLICATION_SESSION_NATIVE_VERSION,
          challengeId: OPAQUE('C'),
          nonce: OPAQUE('N'),
          expiresAt,
          target: {
            kind: 'station-native' as const,
            stationId: trust.stationId,
            audience: trust.audience,
            surface: trust.surface,
          },
          deviceId: trust.deviceId,
          keyThumbprint: await applicationSessionKeyThumbprint(key.publicKey),
          ...challengeOverride,
        };
      }
      if (input.path === APPLICATION_SESSION_NATIVE_EXCHANGE_PATH) {
        if (dropContinuation) return null;
        return {
          version: APPLICATION_SESSION_NATIVE_VERSION,
          credential: OPAQUE('E'),
          authorityKey: 'authority-key-1',
          target: {
            kind: 'station-native' as const,
            stationId: trust.stationId,
            audience: trust.audience,
            surface: trust.surface,
          },
          deviceId: trust.deviceId,
          principal: {
            id: 'human:local:operator',
            kind: 'human',
            display: 'Operator',
          },
          keyThumbprint: await applicationSessionKeyThumbprint(key.publicKey),
          nonce: OPAQUE('X'),
          expiresAt,
          ...continuationOverride,
        };
      }
      throw new Error(`unexpected transport path ${input.path}`);
    },
  };
  const client = new NativeApplicationSessionClient(
    transport,
    () => trust,
    key,
  );
  return {
    client,
    key,
    posts,
    fetchSpy,
    setTrust(next: Partial<NativeApplicationSessionTrustSnapshotV1>) {
      trust = { ...trust, ...next };
    },
    setChallengeOverride(next: Partial<NativeApplicationSessionChallengeV1>) {
      challengeOverride = next;
    },
    setContinuationOverride(
      next: Partial<NativeApplicationSessionContinuationV1>,
    ) {
      continuationOverride = next;
    },
    dropContinuation() {
      dropContinuation = true;
    },
  };
}

describe('native application session client', () => {
  test('challenge and exchange bind the exact Station, audience, surface, device, nonce and canonical credentials hash', async () => {
    const f = await fixture();
    const continuation = await f.client.exchange(credentials);
    expect(continuation.credential).toBe(OPAQUE('E'));
    expect(f.posts.map((post) => post.path)).toEqual([
      APPLICATION_SESSION_NATIVE_CHALLENGE_PATH,
      APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
    ]);
    const exchange = f.posts[1]!;
    const claims = decodeClaims(
      exchange.headers[APPLICATION_SESSION_NATIVE_PROOF_HEADER]!,
    );
    expect(claims).toMatchObject({
      version: APPLICATION_SESSION_NATIVE_VERSION,
      purpose: 'exchange',
      aud: audience,
      stationId: '11111111-1111-4111-8111-111111111111',
      deviceId,
      method: 'POST',
      path: APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
      nonce: OPAQUE('N'),
    });
    expect(claims.surface).toEqual(surface);
    expect(claims.credentialsHash).toBe(
      await canonicalCredentialsHash(credentials),
    );
    expect(claims.credentialsHash).not.toBe(
      await canonicalCredentialsHash({ ...credentials, password: 'wrong' }),
    );
    expect((exchange.body as { credentials: unknown }).credentials).toEqual(
      credentials,
    );
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });

  test('request proofs mint one-use JTIs and bind method, path and credential hash', async () => {
    const f = await fixture();
    const continuation = await f.client.exchange(credentials);
    const first = await f.client.headers(continuation, {
      method: 'GET',
      path: '/api/example',
    });
    const second = await f.client.headers(continuation, {
      method: 'GET',
      path: '/api/example',
    });
    const firstClaims = decodeClaims(
      first[APPLICATION_SESSION_NATIVE_PROOF_HEADER]!,
    );
    const secondClaims = decodeClaims(
      second[APPLICATION_SESSION_NATIVE_PROOF_HEADER]!,
    );
    expect(firstClaims.purpose).toBe('request');
    expect(firstClaims.path).toBe('/api/example');
    expect(JSON.stringify(firstClaims)).not.toContain('htu');
    expect(JSON.stringify(firstClaims)).not.toContain('requestOrigin');
    expect(firstClaims.jti).not.toBe(secondClaims.jti);
    expect(first[APPLICATION_SESSION_NATIVE_HEADER]).toBe(
      continuation.credential,
    );
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });

  test('a challenge for another Station, audience or surface fails closed before exchange', async () => {
    const wrongStation = await fixture();
    wrongStation.setChallengeOverride({
      target: {
        kind: 'station-native',
        stationId: '99999999-9999-4999-8999-999999999999',
        audience,
        surface,
      },
    });
    await expect(wrongStation.client.exchange(credentials)).rejects.toThrow(
      'another Station',
    );
    expect(
      wrongStation.posts.some(
        (post) => post.path === APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
      ),
    ).toBe(false);

    const wrongAudience = await fixture();
    wrongAudience.setChallengeOverride({
      target: {
        kind: 'station-native',
        stationId: '11111111-1111-4111-8111-111111111111',
        audience: 'https://other.example',
        surface,
      },
    });
    await expect(wrongAudience.client.exchange(credentials)).rejects.toThrow(
      'another Station',
    );

    const wrongSurface = await fixture();
    wrongSurface.setChallengeOverride({
      target: {
        kind: 'station-native',
        stationId: '11111111-1111-4111-8111-111111111111',
        audience,
        surface: { ...surface, clientInstanceId: 'substituted' },
      },
    });
    await expect(wrongSurface.client.exchange(credentials)).rejects.toThrow(
      'another Station',
    );
  });

  test('a challenge issued for another proof key fails closed', async () => {
    const f = await fixture();
    const other = await createApplicationSessionKey();
    f.setChallengeOverride({
      keyThumbprint: await applicationSessionKeyThumbprint(other.publicKey),
    });
    await expect(f.client.exchange(credentials)).rejects.toThrow(
      'another proof key',
    );
    expect(
      f.posts.some(
        (post) => post.path === APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
      ),
    ).toBe(false);
    expect(f.key.publicKey).not.toEqual(other.publicKey);
  });

  test('expired challenges and continuations fail closed', async () => {
    const expiredChallenge = await fixture();
    expiredChallenge.setChallengeOverride({
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    await expect(expiredChallenge.client.exchange(credentials)).rejects.toThrow(
      'expired',
    );

    const f = await fixture();
    const continuation = await f.client.exchange(credentials);
    f.setContinuationOverride({
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    await expect(
      f.client.headers(
        { ...continuation, expiresAt: new Date(Date.now() - 1).toISOString() },
        {
          method: 'GET',
          path: '/api/example',
        },
      ),
    ).rejects.toThrow('expired');
  });

  test('a challenge cannot be replayed for a second exchange', async () => {
    const f = await fixture();
    await f.client.exchange(credentials);
    f.posts.length = 0;
    // The second exchange mints a fresh challenge; a server replaying the
    // first challengeId is still rejected by the client's consumed set.
    f.setChallengeOverride({ challengeId: OPAQUE('C') });
    await expect(f.client.exchange(credentials)).rejects.toThrow('reuse');
  });

  test('proof credentials hash detects any credential substitution', async () => {
    const f = await fixture();
    const proof = await createNativeApplicationSessionProof(
      f.key,
      {
        kind: 'station-native',
        stationId: '11111111-1111-4111-8111-111111111111',
        audience,
        deviceId,
        surface,
      },
      {
        purpose: 'exchange',
        deviceId,
        nonce: OPAQUE('N'),
        method: 'POST',
        path: APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
        credentialsHash: await canonicalCredentialsHash(credentials),
        expiresAtMs: Date.now() + 60_000,
      },
    );
    const claims = decodeClaims(proof);
    expect(claims.credentialsHash).not.toBe(
      await canonicalCredentialsHash({ ...credentials, username: 'attacker' }),
    );
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test('the client never uses cookies, direct fetch, or a bearer authorization header', async () => {
    const f = await fixture();
    const continuation = await f.client.exchange(credentials);
    const headers = await f.client.headers(continuation, {
      method: 'POST',
      path: '/api/example',
    });
    expect(f.fetchSpy).not.toHaveBeenCalled();
    expect(Object.keys(headers)).toEqual([
      APPLICATION_SESSION_NATIVE_HEADER,
      APPLICATION_SESSION_NATIVE_PROOF_HEADER,
    ]);
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain('Cookie');
  });

  test('trust snapshot changes fail closed between operations and for request proofs', async () => {
    const f = await fixture();
    const continuation = await f.client.exchange(credentials);
    f.setTrust({ surface: { ...surface, channel: 'stable' } });
    await expect(
      f.client.headers(continuation, {
        method: 'GET',
        path: '/api/example',
      }),
    ).rejects.toThrow('another Station');
    f.setTrust({ surface });
    f.setTrust({ stationId: '99999999-9999-4999-8999-999999999999' });
    await expect(
      f.client.headers(continuation, {
        method: 'GET',
        path: '/api/example',
      }),
    ).rejects.toThrow();
    f.setTrust({ stationId: '11111111-1111-4111-8111-111111111111' });
    f.setTrust({ audience: 'https://elsewhere.example' });
    await expect(
      f.client.headers(continuation, {
        method: 'GET',
        path: '/api/example',
      }),
    ).rejects.toThrow('audience or surface');
  });

  test('a malformed continuation fails closed', async () => {
    const f = await fixture();
    f.dropContinuation();
    await expect(f.client.exchange(credentials)).rejects.toThrow(
      'continuation is invalid',
    );
  });
});
