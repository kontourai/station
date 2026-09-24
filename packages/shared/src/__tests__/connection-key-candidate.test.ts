import { randomUUID } from 'node:crypto';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionKeyCandidateClaimsV1,
  StationConnectionKeyCandidateV1,
  StationConnectionSigningKey,
} from '@kontourai/station-contracts/connection-proof';
import { STATION_CONNECTION_KEY_CANDIDATE_TYPE } from '@kontourai/station-contracts/connection-proof';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { expect, test } from 'vitest';
import {
  copyStationConnectionKeyCandidateClaims,
  formatStationConnectionKeyConfirmationCode,
  serializeStationConnectionKeyCandidateClaims,
  stationConnectionKeyConfirmationCode,
  stationConnectionSigningKeyId,
  verifyStationConnectionKeyCandidate,
} from '../connection-proof.js';

async function fixture() {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const trust: ApprovedStationConnectionTrust = {
    stationId: randomUUID(),
    enrollmentId: randomUUID(),
    generation: 5,
    signingKey: (await exportJWK(
      keys.publicKey,
    )) as StationConnectionSigningKey,
  };
  const clientInstanceId = randomUUID();
  const clientKeyThumbprint = 'A'.repeat(43);
  const challenge = 'A'.repeat(43);
  const brokerOrigin = 'https://broker.example';
  const now = 1_700_000_000;
  const claims: StationConnectionKeyCandidateClaimsV1 = {
    version: 'station-connection-key-candidate/v1',
    aud: 'urn:station:connection-key-candidate:v1',
    purpose: 'advertise-station-connection-key',
    brokerOrigin,
    challenge,
    clientInstanceId,
    clientKeyThumbprint,
    confirmationCode: await stationConnectionKeyConfirmationCode(trust),
    candidate: trust,
    keyId: await stationConnectionSigningKeyId(trust),
    iat: now,
    exp: now + 60,
  };
  return {
    keys,
    trust,
    claims,
    expected: {
      brokerOrigin,
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      challenge,
      clientInstanceId,
      clientKeyThumbprint,
    },
    now,
  };
}

async function signCandidate(
  claims: StationConnectionKeyCandidateClaimsV1,
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'],
) {
  return new CompactSign(serializeStationConnectionKeyCandidateClaims(claims))
    .setProtectedHeader({
      alg: 'ES256',
      typ: STATION_CONNECTION_KEY_CANDIDATE_TYPE,
    })
    .sign(privateKey);
}

test('serializes the candidate claims with fixed ordered UTF-8 bytes', async () => {
  const trust: ApprovedStationConnectionTrust = {
    stationId: '11111111-1111-4111-8111-111111111111',
    enrollmentId: '22222222-2222-4222-8222-222222222222',
    generation: 3,
    signingKey: {
      kty: 'EC',
      crv: 'P-256',
      x: 'X'.repeat(43),
      y: 'Y'.repeat(43),
    },
  };
  const claims: StationConnectionKeyCandidateClaimsV1 = {
    version: 'station-connection-key-candidate/v1',
    aud: 'urn:station:connection-key-candidate:v1',
    purpose: 'advertise-station-connection-key',
    brokerOrigin: 'https://broker.example',
    challenge: 'A'.repeat(43),
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    clientKeyThumbprint: 'A'.repeat(43),
    confirmationCode: '0123456789ABCDEF',
    candidate: trust,
    keyId: 'K'.repeat(43),
    iat: 1_700_000_000,
    exp: 1_700_000_060,
  };
  const payload = new TextDecoder().decode(
    serializeStationConnectionKeyCandidateClaims(claims),
  );
  expect(payload).toBe(
    `{"aud":"urn:station:connection-key-candidate:v1","brokerOrigin":"https://broker.example","challenge":"${'A'.repeat(43)}","clientInstanceId":"33333333-3333-4333-8333-333333333333","clientKeyThumbprint":"${'A'.repeat(43)}","confirmationCode":"0123456789ABCDEF","exp":1700000060,"iat":1700000000,"keyId":"${'K'.repeat(43)}","purpose":"advertise-station-connection-key","candidate":{"stationId":"11111111-1111-4111-8111-111111111111","enrollmentId":"22222222-2222-4222-8222-222222222222","generation":3,"signingKey":{"kty":"EC","crv":"P-256","x":"${'X'.repeat(43)}","y":"${'Y'.repeat(43)}"}},"version":"station-connection-key-candidate/v1"}`,
  );
  await expect(stationConnectionKeyConfirmationCode(trust)).resolves.toBe(
    'PJSBK93PMKJDN1VE',
  );
});

test('verifies possession and challenge bindings while returning only candidate status', async () => {
  const sample = await fixture();
  const compactJws = await signCandidate(sample.claims, sample.keys.privateKey);
  const candidate = {
    version: 'station-connection-key-candidate/v1' as const,
    compactJws,
  };
  const verified = await verifyStationConnectionKeyCandidate(candidate, {
    ...sample.expected,
    now: sample.now + 1,
  });
  expect(verified.status).toBe('candidate');
  expect(verified.claims.candidate).toEqual(sample.trust);
  expect(verified.claims.confirmationCode).toBe(sample.claims.confirmationCode);
  expect('status' in verified.claims).toBe(false);
  const display = formatStationConnectionKeyConfirmationCode(
    verified.claims.confirmationCode,
  );
  expect(display).toMatch(
    /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/,
  );
  await expect(
    verifyStationConnectionKeyCandidate(
      {
        ...candidate,
        version: 'station-connection-key-candidate/v0',
      } as unknown as StationConnectionKeyCandidateV1,
      { ...sample.expected, now: sample.now + 1 },
    ),
  ).rejects.toMatchObject({ code: 'connection_proof_refused' });
});

test.each([
  ['challenge', { challenge: 'E'.repeat(43) }],
  ['client id', { clientInstanceId: randomUUID() }],
  ['install key', { clientKeyThumbprint: 'E'.repeat(43) }],
  ['broker', { brokerOrigin: 'https://other.example' }],
  ['Station', { stationId: randomUUID() }],
  ['enrollment', { enrollmentId: randomUUID() }],
] as const)(
  'rejects a candidate for a different %s',
  async (_label, change) => {
    const sample = await fixture();
    const compactJws = await signCandidate(
      sample.claims,
      sample.keys.privateKey,
    );
    await expect(
      verifyStationConnectionKeyCandidate(compactJws, {
        ...sample.expected,
        ...change,
        now: sample.now + 1,
      }),
    ).rejects.toMatchObject({ code: 'connection_proof_refused' });
  },
);

test('rejects malformed JWKs and expired or overlong signatures', async () => {
  const sample = await fixture();
  const invalidPoint = {
    ...sample.claims,
    candidate: {
      ...sample.trust,
      signingKey: {
        ...sample.trust.signingKey,
        x: 'A'.repeat(43),
        y: 'A'.repeat(43),
      },
    },
  } as StationConnectionKeyCandidateClaimsV1;
  const malformedJwk = await new CompactSign(
    serializeStationConnectionKeyCandidateClaims(invalidPoint),
  )
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'station-connection-key-candidate+jws',
    })
    .sign(sample.keys.privateKey);
  await expect(
    verifyStationConnectionKeyCandidate(malformedJwk, {
      ...sample.expected,
      now: sample.now + 1,
    }),
  ).rejects.toMatchObject({ code: 'connection_proof_refused' });

  const expired = await signCandidate(sample.claims, sample.keys.privateKey);
  await expect(
    verifyStationConnectionKeyCandidate(expired, {
      ...sample.expected,
      now: sample.now + 61,
    }),
  ).rejects.toMatchObject({ code: 'connection_proof_refused' });
  const overlong = await signCandidate(
    { ...sample.claims, exp: sample.claims.iat + 61 },
    sample.keys.privateKey,
  );
  await expect(
    verifyStationConnectionKeyCandidate(overlong, {
      ...sample.expected,
      now: sample.now + 1,
    }),
  ).rejects.toMatchObject({ code: 'connection_proof_refused' });
});

test('candidate copy refuses private fields and codes change when trust changes', async () => {
  const sample = await fixture();
  const withPrivate = {
    ...sample.claims,
    candidate: {
      ...sample.trust,
      privateKeyPem: 'must-not-escape',
    },
  } as StationConnectionKeyCandidateClaimsV1;
  expect(() => copyStationConnectionKeyCandidateClaims(withPrivate)).toThrow(
    'Station connection proof refused',
  );
  const malformedChallenge = {
    ...sample.claims,
    challenge: { toString: () => 'N'.repeat(43) },
  } as unknown as StationConnectionKeyCandidateClaimsV1;
  expect(() =>
    copyStationConnectionKeyCandidateClaims(malformedChallenge),
  ).toThrow('Station connection proof refused');
  expect(() =>
    copyStationConnectionKeyCandidateClaims({
      ...sample.claims,
      challenge: 'N'.repeat(43),
    }),
  ).toThrow('Station connection proof refused');
  const changed = {
    ...sample.trust,
    generation: sample.trust.generation + 1,
  };
  expect(await stationConnectionKeyConfirmationCode(changed)).not.toBe(
    sample.claims.confirmationCode,
  );
  expect(JSON.stringify(sample.claims)).not.toContain('PRIVATE KEY');
});
