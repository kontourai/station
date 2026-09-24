import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionKeyCandidateClaimsV1,
} from '@kontourai/station-contracts/connection-proof';
import {
  formatStationConnectionKeyConfirmationCode,
  verifyStationConnectionKeyCandidate,
} from '@kontourai/station-shared/connection-proof';
import { afterEach, expect, test } from 'vitest';
import { ConnectionKeyCandidateIssuer } from '../connection-key-candidate-issuer.js';
import { ConnectionSigningKeyStore } from '../connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../environment-security-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-key-candidate-'));
  roots.push(home);
  await new EnvironmentSecurityService({ homeDir: home }).initialize();
  const store = new ConnectionSigningKeyStore(home);
  const trust = await store.initialize();
  return { home, store, trust };
}

function request(trust: ApprovedStationConnectionTrust) {
  return {
    brokerOrigin: 'https://broker.example',
    expectedStationId: trust.stationId,
    expectedEnrollmentId: trust.enrollmentId,
    challenge: 'A'.repeat(43),
    clientInstanceId: randomUUID(),
    clientKeyThumbprint: 'A'.repeat(43),
  };
}

test('issues a public-only, short-lived candidate and 80-bit confirmation code', async () => {
  const { store, trust } = await fixture();
  const now = Date.now();
  const issuer = new ConnectionKeyCandidateIssuer(store, () => now);
  const expected = request(trust);
  const result = await issuer.issue(expected);
  expect(result.candidate.version).toBe('station-connection-key-candidate/v1');
  expect(result.keyId).toHaveLength(43);
  expect(result.confirmationCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
  expect(
    formatStationConnectionKeyConfirmationCode(result.confirmationCode),
  ).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  expect(result.expiresAt).toBe(Math.floor(now / 1000) + 60);
  const verified = await verifyStationConnectionKeyCandidate(result.candidate, {
    brokerOrigin: expected.brokerOrigin,
    challenge: expected.challenge,
    clientInstanceId: expected.clientInstanceId,
    clientKeyThumbprint: expected.clientKeyThumbprint,
    stationId: expected.expectedStationId,
    enrollmentId: expected.expectedEnrollmentId,
    now: Math.floor(now / 1000) + 1,
  });
  expect(verified.status).toBe('candidate');
  expect(verified.claims.candidate).toEqual(trust);
  expect(verified.claims.confirmationCode).toBe(result.confirmationCode);
  expect(JSON.stringify(result)).not.toContain('privateKeyPem');
  expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  expect(JSON.stringify(result)).not.toContain('BEGIN PRIVATE');
});

test('refuses invalid challenge context and rejects a key rotation during signing', async () => {
  const { store, trust } = await fixture();
  const now = Date.now();
  const issuer = new ConnectionKeyCandidateIssuer(store, () => now);
  const base = request(trust);
  await expect(
    issuer.issue({ ...base, brokerOrigin: 'https://broker.example/path' }),
  ).rejects.toMatchObject({ code: 'candidate_invalid' });
  await expect(
    issuer.issue({ ...base, challenge: 'short' }),
  ).rejects.toMatchObject({ code: 'candidate_invalid' });
  await expect(
    issuer.issue({ ...base, expectedEnrollmentId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'candidate_stale' });

  let rotated = false;
  const rotatingCustody = {
    readDescriptor: () => store.readDescriptor(),
    signConnectionKeyCandidate: async (
      claims: StationConnectionKeyCandidateClaimsV1,
    ) => {
      const candidate = await store.signConnectionKeyCandidate(claims);
      if (!rotated) {
        rotated = true;
        await store.rotate(trust);
      }
      return candidate;
    },
  };
  await expect(
    new ConnectionKeyCandidateIssuer(rotatingCustody, () => now).issue(base),
  ).rejects.toMatchObject({ code: 'candidate_stale' });
  expect(store.readDescriptor()?.generation).toBe(trust.generation + 1);
});
