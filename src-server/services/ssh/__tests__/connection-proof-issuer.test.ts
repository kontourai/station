import { randomUUID } from 'node:crypto';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
  StationConnectionSigningKey,
} from '@kontourai/station-contracts/connection-proof';
import { createStationConnectionProofVerifier } from '@kontourai/station-shared/connection-proof';
import { exportJWK, generateKeyPair } from 'jose';
import { expect, test } from 'vitest';
import { createStationConnectionProofIssuer } from '../connection-proof-issuer.js';

test('the issuer requires current Station-owned admission before and after signing', async () => {
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
    offerSha256: 'b'.repeat(43),
    answerSha256: 'c'.repeat(43),
    clientFingerprint: Array(32).fill('AA').join(':'),
    stationFingerprint: Array(32).fill('BB').join(':'),
  };
  const issuer = (
    authorize: (value: StationConnectionProofBinding) => boolean,
    now = () => 100,
  ) =>
    createStationConnectionProofIssuer({
      trust,
      signingKey: keys.privateKey,
      authorize,
      now,
    });
  await expect(issuer(() => false).issue(binding)).rejects.toThrow(
    'Station connection proof refused',
  );
  await expect(
    issuer((() => Promise.resolve(true)) as unknown as () => boolean).issue(
      binding,
    ),
  ).rejects.toThrow('Station connection proof refused');
  let calls = 0;
  await expect(issuer(() => ++calls === 1).issue(binding)).rejects.toThrow(
    'Station connection proof refused',
  );
  const token = await issuer(
    (value) => value.connectionId === binding.connectionId,
  ).issue(binding);
  await expect(
    createStationConnectionProofVerifier({
      trust,
      expected: binding,
      now: () => 101,
      isCurrent: () => true,
    }).verifyAndConsume(token),
  ).resolves.toEqual(binding);
  let clock = 0;
  await expect(
    issuer(
      () => true,
      () => (++clock === 1 ? 100 : 131),
    ).issue(binding),
  ).rejects.toThrow('Station connection proof refused');
});
