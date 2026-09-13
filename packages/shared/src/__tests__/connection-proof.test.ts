import { randomUUID } from 'node:crypto';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
  StationConnectionSigningKey,
} from '@kontourai/station-contracts/connection-proof';
import {
  STATION_CONNECTION_PROOF_AUDIENCE,
  STATION_CONNECTION_PROOF_TYPE,
} from '@kontourai/station-contracts/connection-proof';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';
import { describe, expect, test } from 'vitest';
import {
  connectionDescriptionDigest,
  createStationConnectionProofVerifier,
  signStationConnectionProof,
} from '../connection-proof.js';

async function fixture() {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const trust: ApprovedStationConnectionTrust = {
    stationId: randomUUID(),
    enrollmentId: randomUUID(),
    generation: 1,
    signingKey: (await exportJWK(
      keys.publicKey,
    )) as StationConnectionSigningKey,
  };
  const binding: StationConnectionProofBinding = {
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    generation: 1,
    connectionId: randomUUID(),
    clientNonce: 'a'.repeat(43),
    clientFingerprint: Array(32).fill('AA').join(':'),
    stationFingerprint: Array(32).fill('BB').join(':'),
    offerSha256: await connectionDescriptionDigest('client offer'),
    answerSha256: await connectionDescriptionDigest('Station answer'),
  };
  const token = await signStationConnectionProof({
    trust,
    binding,
    signingKey: keys.privateKey,
    now: 100,
  });
  const verifier = (
    options: {
      trust?: ApprovedStationConnectionTrust;
      expected?: StationConnectionProofBinding;
      now?: () => number;
      isCurrent?: () => boolean;
    } = {},
  ) =>
    createStationConnectionProofVerifier({
      trust: options.trust ?? trust,
      expected: options.expected ?? binding,
      now: options.now ?? (() => 101),
      isCurrent: options.isCurrent ?? (() => true),
    });
  return { keys, trust, binding, token, verifier };
}

describe('Station connection proof', () => {
  test('binds the exact Station, client, generation and SDP once', async () => {
    const { token, binding, verifier } = await fixture();
    const gate = verifier();
    expect(await gate.verifyAndConsume(token)).toEqual(binding);
    await expect(gate.verifyAndConsume(token)).rejects.toMatchObject({
      code: 'connection_proof_refused',
    });
  });

  test('two concurrent verifications cannot both consume one challenge', async () => {
    const { token, verifier } = await fixture();
    const gate = verifier();
    const results = await Promise.allSettled([
      gate.verifyAndConsume(token),
      gate.verifyAndConsume(token),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  test.each([
    'clientNonce',
    'connectionId',
    'clientFingerprint',
    'stationFingerprint',
    'offerSha256',
    'answerSha256',
  ] as const)(
    'rejects a proof for a different %s without consuming the valid retry',
    async (field) => {
      const { keys, trust, binding, token, verifier } = await fixture();
      const changed = {
        ...binding,
        [field]:
          field === 'connectionId'
            ? randomUUID()
            : field.endsWith('Fingerprint')
              ? Array(32).fill('CC').join(':')
              : 'z'.repeat(43),
      };
      const wrong = await signStationConnectionProof({
        trust,
        binding: changed,
        signingKey: keys.privateKey,
        now: 100,
      });
      const gate = verifier();
      await expect(gate.verifyAndConsume(wrong)).rejects.toThrow(
        'Station connection proof refused',
      );
      expect(await gate.verifyAndConsume(token)).toEqual(binding);
    },
  );

  test.each(['stationId', 'enrollmentId', 'generation'] as const)(
    'refuses stale or cross-authority %s',
    async (field) => {
      const { token, trust, binding, verifier } = await fixture();
      const value = field === 'generation' ? 2 : randomUUID();
      const gate = verifier({
        trust: { ...trust, [field]: value },
        expected: { ...binding, [field]: value },
      });
      await expect(gate.verifyAndConsume(token)).rejects.toThrow(
        'Station connection proof refused',
      );
    },
  );

  test('a broker cannot substitute its signing key or alter a signed token', async () => {
    const { keys, binding, trust, token, verifier } = await fixture();
    const attacker = await generateKeyPair('ES256');
    const forged = await signStationConnectionProof({
      trust,
      binding,
      signingKey: attacker.privateKey,
      now: 100,
    });
    await expect(verifier().verifyAndConsume(forged)).rejects.toThrow(
      'Station connection proof refused',
    );
    const [header, payload, signature] = token.split('.');
    const altered = `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    await expect(verifier().verifyAndConsume(altered)).rejects.toThrow(
      'Station connection proof refused',
    );
    expect(keys.privateKey.type).toBe('private');
  });

  test('rechecks trust currentness and expiry after asynchronous cryptography', async () => {
    const { token, verifier } = await fixture();
    let checks = 0;
    await expect(
      verifier({ isCurrent: () => ++checks === 1 }).verifyAndConsume(token),
    ).rejects.toThrow('Station connection proof refused');
    let clock = 0;
    await expect(
      verifier({ now: () => (++clock === 1 ? 101 : 130) }).verifyAndConsume(
        token,
      ),
    ).rejects.toThrow('Station connection proof refused');
    await expect(
      verifier({ now: () => 99 }).verifyAndConsume(token),
    ).rejects.toThrow('Station connection proof refused');
    await expect(
      verifier({
        isCurrent: (() => Promise.resolve(true)) as unknown as () => boolean,
      }).verifyAndConsume(token),
    ).rejects.toThrow('Station connection proof refused');
  });

  test('rejects extra authority claims, longer lifetimes, wrong audiences and key-discovery headers', async () => {
    const { token, trust, binding, keys, verifier } = await fixture();
    const header = {
      alg: 'ES256',
      typ: STATION_CONNECTION_PROOF_TYPE,
      kid: await calculateJwkThumbprint(trust.signingKey, 'sha256'),
    };
    for (const kind of ['claims', 'lifetime', 'audience', 'header']) {
      const jwt = new SignJWT({
        version: 1,
        binding,
        ...(kind === 'claims' ? { operator: true } : {}),
      })
        .setProtectedHeader({
          ...header,
          ...(kind === 'header' ? { jku: 'https://attacker.invalid/key' } : {}),
        })
        .setIssuer(`urn:station:${trust.stationId}`)
        .setAudience(
          kind === 'audience' ? 'other' : STATION_CONNECTION_PROOF_AUDIENCE,
        )
        .setJti(randomUUID())
        .setIssuedAt(100)
        .setNotBefore(100)
        .setExpirationTime(kind === 'lifetime' ? 131 : 130);
      const gate = verifier();
      await expect(
        gate.verifyAndConsume(await jwt.sign(keys.privateKey)),
      ).rejects.toThrow('Station connection proof refused');
      await expect(gate.verifyAndConsume(token)).resolves.toEqual(binding);
    }
  });

  test('copies caller-owned expectations and bounds malformed inputs', async () => {
    const { token, trust, binding } = await fixture();
    const mutable = { ...binding };
    const gate = createStationConnectionProofVerifier({
      trust,
      expected: mutable,
      now: () => 101,
      isCurrent: () => true,
    });
    mutable.clientNonce = 'z'.repeat(43);
    for (const bad of ['', 'x'.repeat(4097), 'a.b.c\n'])
      await expect(gate.verifyAndConsume(bad)).rejects.toThrow(
        'Station connection proof refused',
      );
    await expect(gate.verifyAndConsume(token)).resolves.toEqual(binding);
    await expect(
      connectionDescriptionDigest('x'.repeat(65537)),
    ).rejects.toThrow('Station connection proof refused');
    expect(await connectionDescriptionDigest('a\r\n')).not.toEqual(
      await connectionDescriptionDigest('a\n'),
    );
  });
});
