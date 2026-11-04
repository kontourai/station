import { createPublicKey, verify } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL,
  type AnalyticsSourceEnrollmentIntent,
} from '@kontourai/station-contracts/usage-export';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  recipientCandidateSchema,
  verifyRecipientCandidateSignature,
} from '../../../analytics/recipient-candidate.js';
import { RecipientStore } from '../../../analytics/recipient-store.js';
import type { EnrollmentActor } from '../../../analytics/source-enrollment-store.js';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import { AuthorityObservationRejected } from '../../../services/identity/authority-observation.js';
import { createRecipientCandidateRoutes } from '../recipient-candidates.js';

const temporary = trackTempDirs();
const base = '/api/analytics/recipient-candidates';
const recipientId = '11234567-89ab-4cde-8fab-0123456789ab';
const sourceIntent: AnalyticsSourceEnrollmentIntent = {
  protocol: 'station-analytics-source-enrollment-intent/v1',
  operationId: '01234567-89ab-4cde-8fab-0123456789ab',
  sourceStationId: 'source-station',
  proposedDestination: {
    stationId: 'receiving-station',
    origin: 'https://receiving.example.test',
  },
  destinationVerified: false,
  scope: 'individual',
  expiresAt: '2026-10-25T00:00:00.000Z',
  retention: { mode: 'live-mirror' },
  phase: 'prepared',
  createdAt: '2026-10-24T00:00:00.000Z',
  exportAuthority: false,
};
const input = {
  operationId: recipientId,
  proposedSourceOrigin: 'https://source.example.test',
  sourceIntent,
};
function fixture(home = temporary('analytics-recipient-')) {
  let now = Date.parse('2026-10-24T00:00:00.000Z');
  let current = {
    userId: 'human:tailscale:alice',
    mode: 'hosted' as const,
    tenantId: 'tenant-a',
  };
  let permitted = true;
  const app = new Hono().route(
    base,
    createRecipientCandidateRoutes({
      store: new RecipientStore(home, () => now),
      // Authentication is supplied here; real keys, persistence and response
      // release are exercised. Runtime ingress has a separate composition owner.
      capture: async () => {
        if (!permitted)
          throw new AuthorityObservationRejected(403, 'authority_changed');
        const captured = { ...current };
        const actor: EnrollmentActor = {
          ...captured,
          sourceStationId: 'receiving-station',
          ownerIds: [captured.userId],
          async assertCurrent() {
            if (
              !permitted ||
              JSON.stringify(current) !== JSON.stringify(captured)
            )
              throw new AuthorityObservationRejected(403, 'authority_changed');
          },
        };
        return actor;
      },
    }),
  );
  return {
    home,
    app,
    post(body: unknown = input) {
      return app.request(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
    setUser(userId: string) {
      current = { ...current, userId };
    },
    setTenant(tenantId: string) {
      current = { ...current, tenantId };
    },
    expire() {
      now += 300_001;
    },
    deny() {
      permitted = false;
    },
  };
}
const responseSchema = z.object({
  data: z.object({ candidate: recipientCandidateSchema }),
});

test('recipient preparation creates private purpose keys and returns an owner-derived, tamper-evident candidate without export authority', async () => {
  const h = fixture();
  expect(requiredPairingScope('POST', base)).toBe('orchestration:read');
  expect(requiredPairingScope('GET', `${base}/${recipientId}`)).toBe(
    'orchestration:read',
  );
  expect(
    (await h.post({ ...input, recipientPrincipalId: 'foreign' })).status,
  ).toBe(400);
  expect(
    (
      await h.post({
        ...input,
        sourceIntent: {
          ...sourceIntent,
          proposedDestination: {
            ...sourceIntent.proposedDestination,
            stationId: 'other-station',
          },
        },
      })
    ).status,
  ).toBe(409);
  const response = await h.post();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const wire: unknown = await response.json();
  expect(wire).toMatchObject({
    data: {
      phase: 'candidate',
      verification: 'key-possession-only',
      exportAuthority: false,
      sourceVerified: false,
      candidate: {
        claims: {
          recipientPrincipalId: 'human:tailscale:alice',
          destinationStationId: 'receiving-station',
          sourceStationId: 'source-station',
        },
      },
    },
  });
  const { candidate } = responseSchema.parse(wire).data;
  const key = createPublicKey({
    key: candidate.claims.proofKey,
    format: 'jwk',
  });
  const bytes = Buffer.from(
    `${ANALYTICS_RECIPIENT_CANDIDATE_PROTOCOL}\n${JSON.stringify(candidate.claims)}`,
  );
  expect(
    verify(null, bytes, key, Buffer.from(candidate.signature, 'base64url')),
  ).toBe(true);
  expect(() =>
    verifyRecipientCandidateSignature({
      ...candidate,
      claims: { ...candidate.claims, recipientPrincipalId: 'foreign' },
    }),
  ).toThrow('candidate is invalid');
  expect(candidate.claims.expiresAt - candidate.claims.createdAt).toBe(300_000);
  const file = join(h.home, 'security/analytics-recipients.json');
  const stored = z
    .object({
      records: z.array(
        z.object({
          encryptionPrivateKey: z.string(),
          proofPrivateKey: z.string(),
        }),
      ),
    })
    .parse(JSON.parse(await readFile(file, 'utf8')));
  expect(stored.records).toHaveLength(1);
  const record = stored.records[0];
  if (!record) throw new Error('Missing receiving key record');
  expect(record.encryptionPrivateKey).toContain('BEGIN PRIVATE KEY');
  expect(record.proofPrivateKey).toContain('BEGIN PRIVATE KEY');
  expect(JSON.stringify(wire)).not.toContain(
    JSON.stringify(record.encryptionPrivateKey),
  );
  expect(JSON.stringify(wire)).not.toContain(
    JSON.stringify(record.proofPrivateKey),
  );
  if (process.platform !== 'win32')
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  const reopened = fixture(h.home);
  expect(
    responseSchema.parse(await (await reopened.post()).json()).data.candidate,
  ).toEqual(candidate);
  expect(
    (
      await reopened.post({
        ...input,
        proposedSourceOrigin: 'https://different.example.test',
      })
    ).status,
  ).toBe(409);
  h.expire();
  expect(
    await (await h.app.request(`${base}/${recipientId}`)).json(),
  ).toMatchObject({ data: { phase: 'expired', exportAuthority: false } });
});

test('receiving keys remain person/tenant scoped, cancel without reactivation, fence queued delivery and refuse corrupt state', async () => {
  const h = fixture();
  expect((await h.post()).status).toBe(200);
  h.setUser('human:tailscale:bob');
  expect((await h.app.request(`${base}/${recipientId}`)).status).toBe(404);
  expect(await (await h.app.request(base)).json()).toEqual({ data: [] });
  h.setUser('human:tailscale:alice');
  h.setTenant('tenant-b');
  expect((await h.app.request(`${base}/${recipientId}`)).status).toBe(404);
  expect(
    (await h.app.request(`${base}/${recipientId}`, { method: 'DELETE' }))
      .status,
  ).toBe(404);
  h.setTenant('tenant-a');
  const held = await h.app.request(`${base}/${recipientId}`);
  h.deny();
  await expect(held.text()).rejects.toThrow('Authority observation ended');
  const current = fixture(h.home);
  expect(
    await (
      await current.app.request(`${base}/${recipientId}`, { method: 'DELETE' })
    ).json(),
  ).toMatchObject({ data: { phase: 'cancelled', exportAuthority: false } });
  expect(await (await current.post()).json()).toMatchObject({
    data: { phase: 'cancelled' },
  });
  const file = join(h.home, 'security/analytics-recipients.json');
  await writeFile(file, 'null', { mode: 0o600 });
  const corrupt = await current.app.request(base);
  expect(corrupt.status).toBe(503);
  expect(await corrupt.json()).toEqual({
    error: { code: 'recipient_candidate_unavailable' },
  });
  expect(await readFile(file, 'utf8')).toBe('null');
});
