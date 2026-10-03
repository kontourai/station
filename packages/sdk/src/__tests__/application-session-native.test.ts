import { createHash } from 'node:crypto';
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
  createNativeApplicationSessionProof,
  NativeApplicationSessionClient,
  type NativeApplicationSessionProofProvider,
  type NativeApplicationSessionTrustSnapshotV1,
  serializedCredentialsHash,
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

async function fixture(
  proofProvider?: (
    key: Awaited<ReturnType<typeof createApplicationSessionKey>>,
    trust: () => NativeApplicationSessionTrustSnapshotV1,
  ) => NativeApplicationSessionProofProvider,
) {
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
  let afterChallenge: (() => void) | undefined;
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
        const challenge = {
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
        afterChallenge?.();
        return challenge;
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
    proofProvider ? proofProvider(key, () => trust) : key,
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
    changeTrustAfterChallenge(action: () => void) {
      afterChallenge = action;
    },
  };
}

function hostProvider(
  key: Awaited<ReturnType<typeof createApplicationSessionKey>>,
  trust: () => NativeApplicationSessionTrustSnapshotV1,
): NativeApplicationSessionProofProvider {
  return {
    kind: 'station-native-host-proof-provider/v1',
    publicKey: key.publicKey,
    async prepareExchange({ challenge, credentials }) {
      const ordered = {
        username: credentials.username,
        password: credentials.password,
      };
      const proof = await createNativeApplicationSessionProof(key, trust(), {
        purpose: 'exchange',
        deviceId: trust().deviceId,
        nonce: challenge.nonce,
        method: 'POST',
        path: APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
        expiresAtMs: challenge.expiresAtMs,
        challengeIdHash: createHash('sha256')
          .update(challenge.challengeId)
          .digest('base64url'),
        credentialsHash: createHash('sha256')
          .update(JSON.stringify(ordered))
          .digest('base64url'),
      });
      return {
        body: {
          version: APPLICATION_SESSION_NATIVE_VERSION,
          challengeId: challenge.challengeId,
          credentials: ordered,
          proof,
        },
        headers: { [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: proof },
      };
    },
    async requestHeaders({ continuation, request }) {
      const proof = await createNativeApplicationSessionProof(key, trust(), {
        purpose: 'request',
        deviceId: trust().deviceId,
        nonce: continuation.nonce,
        method: request.method,
        path: request.path,
        expiresAtMs: continuation.expiresAtMs,
        credentialHash: createHash('sha256')
          .update(continuation.credential)
          .digest('base64url'),
      });
      return {
        [APPLICATION_SESSION_NATIVE_HEADER]: continuation.credential,
        [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: proof,
      };
    },
  };
}

function invitationHostProvider(
  key: Parameters<typeof hostProvider>[0],
  trust: Parameters<typeof hostProvider>[1],
): NativeApplicationSessionProofProvider {
  return {
    ...hostProvider(key, trust),
    async prepareInvitationAcceptance({ continuation, token }) {
      const proof = await createNativeApplicationSessionProof(key, trust(), {
        purpose: 'request',
        deviceId: trust().deviceId,
        nonce: continuation.nonce,
        method: 'POST',
        path: '/api/account-auth/accept-invitation',
        expiresAtMs: continuation.expiresAtMs,
        credentialHash: createHash('sha256')
          .update(continuation.credential)
          .digest('base64url'),
      });
      return {
        body: { token },
        headers: {
          [APPLICATION_SESSION_NATIVE_HEADER]: continuation.credential,
          [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: proof,
        },
      };
    },
  };
}

describe('structured native account proof provider', () => {
  test('host context deadline is frozen before signing and clamps a later server session without extending reads or revoke', async () => {
    const started = Date.now();
    let hostDeadline = started + 900000;
    const h = await fixture((key, trust) => {
      const host = invitationHostProvider(key, trust);
      return {
        ...host,
        get contextExpiresAtMs() {
          return hostDeadline;
        },
        async prepareExchange(input) {
          const result = await host.prepareExchange(input);
          hostDeadline = started + 1800000;
          return result;
        },
      };
    });
    h.setContinuationOverride({
      expiresAt: new Date(started + 960000).toISOString(),
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started + 60000);
    try {
      const accepted = await h.client.exchange(credentials);
      expect(Date.parse(accepted.expiresAt)).toBe(started + 900000);
      clock.mockReturnValue(started + 900000);
      await expect(
        h.client.headers(accepted, { method: 'GET', path: '/api/projects' }),
      ).rejects.toThrow('context expired');
      await expect(h.client.prepareRevocation(accepted)).rejects.toThrow(
        'context expired',
      );
    } finally {
      clock.mockRestore();
      h.fetchSpy.mockRestore();
    }
  });

  test('fixed native revoke preparation validates exact endpoint proof and trust after host signing without widening reads', async () => {
    let wrongPath = true;
    let change: () => void = () => {};
    const h = await fixture((key, trust) => ({
      ...hostProvider(key, trust),
      async prepareRevocation({ continuation }) {
        const proof = await createNativeApplicationSessionProof(key, trust(), {
          purpose: 'request',
          deviceId: trust().deviceId,
          nonce: continuation.nonce,
          method: 'POST',
          path: wrongPath
            ? '/api/account-auth/continuations/revoke'
            : '/api/account-auth/continuations/native/revoke',
          credentialHash: createHash('sha256')
            .update(continuation.credential)
            .digest('base64url'),
          expiresAtMs: continuation.expiresAtMs,
        });
        change();
        return {
          body: {},
          headers: {
            [APPLICATION_SESSION_NATIVE_HEADER]: continuation.credential,
            [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: proof,
          },
        };
      },
    }));
    const continuation = await h.client.exchange(credentials);
    await expect(h.client.prepareRevocation(continuation)).rejects.toThrow();
    wrongPath = false;
    const prepared = await h.client.prepareRevocation(continuation);
    expect(prepared.body).toEqual({});
    expect(Object.isFrozen(prepared.body)).toBe(true);
    expect(
      decodeClaims(prepared.headers[APPLICATION_SESSION_NATIVE_PROOF_HEADER]!),
    ).toMatchObject({
      method: 'POST',
      path: '/api/account-auth/continuations/native/revoke',
    });
    await expect(
      h.client.headers(continuation, {
        method: 'POST',
        path: '/api/account-auth/continuations/native/revoke',
      }),
    ).rejects.toThrow();
    change = () =>
      h.setTrust({ deviceId: '99999999-9999-4999-8999-999999999999' });
    await expect(h.client.prepareRevocation(continuation)).rejects.toThrow();
    h.fetchSpy.mockRestore();
  });

  test('host account read proofs cover only the exact member-read capability inventory', async () => {
    const h = await fixture(hostProvider);
    const continuation = await h.client.exchange({
      username: 'operator',
      password: 'password',
    });
    for (const path of [
      '/.well-known/station/v1',
      '/api/system/status',
      '/api/system/identity',
      '/api/auth/authority',
      '/api/projects',
      '/api/projects/demo',
      '/api/projects/demo/shared-work',
      '/api/projects/demo/shared-work/task_1/document',
      '/api/projects/demo/shared-work/task_1/history',
      '/api/projects/demo/shared-work/task_1/publication',
    ])
      expect(
        await h.client.headers(continuation, { method: 'GET', path }),
      ).toHaveProperty(APPLICATION_SESSION_NATIVE_PROOF_HEADER);
    for (const path of [
      '/api/pairing/devices',
      '/api/config',
      '/api/projects/demo/git/status',
      '/api/projects/demo/shared-work/task_1/messages',
      '/api/projects/demo/shared-work/task_1/document/extra',
      '/api/projects/%2Fadmin',
    ])
      await expect(
        h.client.headers(continuation, { method: 'GET', path }),
      ).rejects.toThrow();
    await expect(
      h.client.headers(continuation, {
        method: 'POST',
        path: '/api/projects/demo/shared-work/task_1/document',
      }),
    ).rejects.toThrow();
    h.fetchSpy.mockRestore();
  });

  test('fixed invitation preparation validates the token and host proof without widening GET/HEAD request headers', async () => {
    const prepare = vi.fn();
    const reads = vi.fn();
    const h = await fixture((key, trust) => {
      const host = invitationHostProvider(key, trust);
      prepare.mockImplementation(host.prepareInvitationAcceptance!);
      reads.mockImplementation(host.requestHeaders);
      return {
        ...host,
        prepareInvitationAcceptance: prepare,
        requestHeaders: reads,
      };
    });
    const continuation = await h.client.exchange({
      username: 'operator',
      password: 'password',
    });
    const token = Buffer.alloc(32, 8).toString('base64url');
    const prepared = await h.client.prepareInvitationAcceptance(
      continuation,
      token,
    );
    expect(prepared.body).toEqual({ token });
    expect(Object.isFrozen(prepared.body)).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
    await expect(
      h.client.headers(continuation, {
        method: 'POST',
        path: '/api/account-auth/accept-invitation',
      }),
    ).rejects.toThrow('only Project reads');
    await expect(
      h.client.prepareInvitationAcceptance(continuation, 'bad-token'),
    ).rejects.toThrow();
    expect(prepare).toHaveBeenCalledTimes(1);
    h.fetchSpy.mockRestore();
  });
  test('fixed invitation preparation refuses substituted body and stale owner while preserving observable failure', async () => {
    let substitution = true;
    let changed: () => void = () => {};
    const h = await fixture((key, trust) => {
      const host = invitationHostProvider(key, trust);
      return {
        ...host,
        async prepareInvitationAcceptance(input) {
          const prepared = await host.prepareInvitationAcceptance!(input);
          if (substitution)
            return {
              ...prepared,
              body: { token: Buffer.alloc(32, 9).toString('base64url') },
            };
          changed();
          return prepared;
        },
      };
    });
    const continuation = await h.client.exchange({
      username: 'operator',
      password: 'password',
    });
    const token = Buffer.alloc(32, 8).toString('base64url');
    await expect(
      h.client.prepareInvitationAcceptance(continuation, token),
    ).rejects.toThrow();
    substitution = false;
    changed = () =>
      h.setTrust({ deviceId: '99999999-9999-4999-8999-999999999999' });
    await expect(
      h.client.prepareInvitationAcceptance(continuation, token),
    ).rejects.toThrow();
    h.fetchSpy.mockRestore();
  });

  test('validates and sends the ordered host exchange body before transport framing', async () => {
    const h = await fixture(hostProvider);
    const result = await h.client.exchange({
      password: '🔒 café\u2028λ',
      username: 'operator',
    });
    const sent = h.posts[1]!;
    const body = zBody(sent.body);
    expect(Object.keys(body.credentials)).toEqual(['username', 'password']);
    expect(decodeClaims(body.proof).credentialsHash).toBe(
      createHash('sha256')
        .update(JSON.stringify(body.credentials))
        .digest('base64url'),
    );
    expect(sent.headers[APPLICATION_SESSION_NATIVE_PROOF_HEADER]).toBe(
      body.proof,
    );
    const headers = await h.client.headers(result, {
      method: 'GET',
      path: '/api/projects?include=exact%2Bquery',
    });
    expect(
      decodeClaims(headers[APPLICATION_SESSION_NATIVE_PROOF_HEADER]!).path,
    ).toBe('/api/projects?include=exact%2Bquery');
    expect(headers[APPLICATION_SESSION_NATIVE_HEADER]).toBe(result.credential);
    h.fetchSpy.mockRestore();
  });

  test.each(['body', 'headers', 'signature'] as const)(
    'refuses mismatched host %s before exchange dispatch',
    async (change) => {
      const h = await fixture((key, trust) => {
        const provider = hostProvider(key, trust);
        return {
          ...provider,
          async prepareExchange(input) {
            const prepared = await provider.prepareExchange(input);
            if (change === 'body')
              return {
                ...prepared,
                body: {
                  ...prepared.body,
                  credentials: {
                    username: 'attacker',
                    password: input.credentials.password,
                  },
                },
              };
            if (change === 'headers')
              return {
                ...prepared,
                headers: {
                  [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: 'different-proof',
                },
              };
            const parts = prepared.body.proof.split('.');
            parts[2] = 'A'.repeat(86);
            const proof = parts.join('.');
            return {
              body: { ...prepared.body, proof },
              headers: { [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: proof },
            };
          },
        };
      });
      await expect(h.client.exchange(credentials)).rejects.toThrow();
      expect(h.posts).toHaveLength(1);
      h.fetchSpy.mockRestore();
    },
  );

  test('refuses unsupported provider credentials and non-read Project targets without calling the provider', async () => {
    const prepare = vi.fn();
    const request = vi.fn();
    const h = await fixture((key, trust) => {
      const provider = hostProvider(key, trust);
      prepare.mockImplementation(provider.prepareExchange);
      request.mockImplementation(provider.requestHeaders);
      return { ...provider, prepareExchange: prepare, requestHeaders: request };
    });
    await expect(
      h.client.exchange({
        email: 'someone@example.test',
        password: 'password',
      }),
    ).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
    expect(h.posts).toHaveLength(0);
    const current = await h.client.exchange(credentials);
    for (const target of [
      { method: 'POST', path: '/api/projects' },
      { method: 'GET', path: '/api/pairing/devices' },
      { method: 'GET', path: '/api/projects/a/access' },
    ])
      await expect(h.client.headers(current, target)).rejects.toThrow(
        'only Project reads',
      );
    expect(request).not.toHaveBeenCalled();
    h.fetchSpy.mockRestore();
  });
});

function zBody(value: Record<string, unknown>) {
  const credentials = value.credentials;
  if (
    !credentials ||
    typeof credentials !== 'object' ||
    Array.isArray(credentials) ||
    typeof value.proof !== 'string'
  )
    throw new Error('fixture exchange body missing');
  return { credentials, proof: value.proof };
}

describe('native application session client', () => {
  test('challenge and exchange bind the exact Station, audience, surface, device, nonce and serialized credentials hash', async () => {
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
      await serializedCredentialsHash(credentials),
    );
    expect(claims.credentialsHash).toBe(
      createHash('sha256')
        .update(JSON.stringify(credentials))
        .digest('base64url'),
    );
    expect(claims.credentialsHash).not.toBe(
      await serializedCredentialsHash({ ...credentials, password: 'wrong' }),
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

  test('native proof accepts a loopback Station audience and an exact query path', async () => {
    const f = await fixture();
    const loopback = 'http://127.0.0.1:4321';
    const proof = await createNativeApplicationSessionProof(
      f.key,
      {
        kind: 'station-native',
        stationId: '11111111-1111-4111-8111-111111111111',
        audience: loopback,
        deviceId,
        surface,
      },
      {
        purpose: 'request',
        deviceId,
        nonce: OPAQUE('N'),
        method: 'GET',
        path: '/api/projects?limit=2',
        credentialHash: OPAQUE('H'),
        expiresAtMs: Date.now() + 60_000,
      },
    );
    expect(decodeClaims(proof)).toMatchObject({
      aud: loopback,
      path: '/api/projects?limit=2',
    });
    await expect(
      createNativeApplicationSessionProof(
        f.key,
        {
          kind: 'station-native',
          stationId: '11111111-1111-4111-8111-111111111111',
          audience: 'http://public.example',
          deviceId,
          surface,
        },
        {
          purpose: 'request',
          deviceId,
          nonce: OPAQUE('N'),
          method: 'GET',
          path: '/api/projects',
          credentialHash: OPAQUE('H'),
          expiresAtMs: Date.now() + 60_000,
        },
      ),
    ).rejects.toThrow('HTTPS or loopback HTTP');
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
        credentialsHash: await serializedCredentialsHash(credentials),
        expiresAtMs: Date.now() + 60_000,
      },
    );
    const claims = decodeClaims(proof);
    expect(claims.credentialsHash).not.toBe(
      await serializedCredentialsHash({ ...credentials, username: 'attacker' }),
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

  test('does not send provider credentials after trust changes during challenge', async () => {
    const f = await fixture();
    f.changeTrustAfterChallenge(() => {
      f.setTrust({ stationId: '99999999-9999-4999-8999-999999999999' });
    });
    await expect(f.client.exchange(credentials)).rejects.toThrow(
      'trust changed',
    );
    expect(
      f.posts.some(
        (post) => post.path === APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
      ),
    ).toBe(false);
  });

  test('a malformed continuation fails closed', async () => {
    const f = await fixture();
    f.dropContinuation();
    await expect(f.client.exchange(credentials)).rejects.toThrow(
      'continuation is invalid',
    );
  });
});
