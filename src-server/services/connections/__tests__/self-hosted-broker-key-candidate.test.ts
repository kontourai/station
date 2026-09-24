import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import type {
  SelfHostedBrokerNativeKeyCandidateResultV1,
  SelfHostedBrokerNativeRouteInvitationV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  stationConnectionSigningKeyId,
  verifyStationConnectionKeyCandidate,
} from '@kontourai/station-shared/connection-proof';
import { Hono } from 'hono';
import {
  CompactSign,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSelfHostedBrokerRoutes } from '../../../routes/connections/self-hosted-broker.js';
import { createSelfHostedBrokerPionRuntime } from '../../../runtime/bootstrap/self-hosted-broker-pion-runtime.js';
import { ConnectionKeyCandidateIssuer } from '../../ssh/connection-key-candidate-issuer.js';
import { ConnectionSigningKeyStore } from '../../ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { SelfHostedBrokerClient } from '../self-hosted-broker-client.js';
import { SelfHostedBrokerConnector } from '../self-hosted-broker-connector.js';
import {
  SelfHostedBrokerService,
  serializeNativeBrokerKeyCandidatePayload,
  serializeNativeBrokerRedemptionPayload,
} from '../self-hosted-broker-service.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'candidate-courier-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  await new EnvironmentSecurityService({ homeDir: home }).initialize();
  const custody = new ConnectionSigningKeyStore(home);
  const trust = await custody.initialize();
  let now = Date.now();
  const issuer = new ConnectionKeyCandidateIssuer(custody, () => now);
  const dbPath = join(home, 'broker.sqlite');
  const service = new SelfHostedBrokerService(dbPath, () => now);
  cleanup.push(() => service.close());
  const scope = {
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    routingGeneration: 1,
    browserOrigin: 'https://station.example',
  };
  const credentials = service.provision(scope, 600_000);
  const app = new Hono().route(
    '/broker/v1',
    createSelfHostedBrokerRoutes(service),
  );
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing listener');
  const brokerOrigin = `http://127.0.0.1:${address.port}`;
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  const publicKey = {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: jwk.x!,
    y: jwk.y!,
  };
  const surface = {
    kind: 'station-native' as const,
    appIdentifier: 'io.kontourai.station',
    channel: 'dev' as const,
    clientInstanceId: randomUUID(),
    keyThumbprint: await calculateJwkThumbprint(publicKey),
  };
  const invitation = service.issueNativeInvitation({
    scope,
    routingCredential: credentials.routing,
    brokerOrigin,
    surface,
    stationSigningKeyId: await stationConnectionSigningKeyId(trust),
    stationSigningGeneration: trust.generation,
  });
  const challenge = randomBytes(32).toString('base64url');
  async function proof(
    action: 'request' | 'read' | 'redeem',
    selected = invitation,
    nonce = challenge,
    privateKey = keys.privateKey,
  ) {
    return {
      publicKey,
      nonce,
      jws: await new CompactSign(
        action === 'redeem'
          ? serializeNativeBrokerRedemptionPayload(selected, nonce)
          : serializeNativeBrokerKeyCandidatePayload(selected, nonce, action),
      )
        .setProtectedHeader({
          alg: 'ES256',
          typ:
            action === 'redeem'
              ? 'station-broker-native-redemption+jws'
              : 'station-broker-native-key-candidate+jws',
        })
        .sign(privateKey),
    };
  }
  async function post(
    action: 'request' | 'read',
    selected = invitation,
    signed?: Awaited<ReturnType<typeof proof>>,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${brokerOrigin}/broker/v1/native/key-candidates/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        version: `station-broker-native-key-candidate-${action}/v1`,
        invitation: selected,
        proof: signed ?? (await proof(action, selected)),
      }),
    });
  }
  const client = new SelfHostedBrokerClient(
    brokerOrigin,
    scope,
    credentials.connector,
    fetch,
    () => now,
  );
  const trustOwner = {
    current: () => custody.readDescriptor(),
    isCurrent: (value: typeof trust) =>
      JSON.stringify(value) === JSON.stringify(custody.readDescriptor()),
  };
  const connector = new SelfHostedBrokerConnector(
    scope,
    client,
    trustOwner,
    async () => {
      throw new Error('unexpected application offer');
    },
  );
  const expected = {
    brokerOrigin,
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    clientInstanceId: surface.clientInstanceId,
    clientKeyThumbprint: surface.keyThumbprint,
    challenge,
    now: Math.floor(now / 1000),
  };
  function counts() {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return {
        invitations: db
          .prepare('SELECT consumed_at FROM broker_native_route_invitations')
          .all(),
        grants: db
          .prepare('SELECT count(*) n FROM broker_native_client_grants')
          .get(),
      };
    } finally {
      db.close();
    }
  }
  return {
    app,
    service,
    scope,
    credentials,
    brokerOrigin,
    invitation,
    challenge,
    surface,
    issuer,
    trust,
    trustOwner,
    custody,
    publicKey,
    keys,
    proof,
    post,
    client,
    connector,
    expected,
    counts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe.runIf(process.platform !== 'win32')(
  'pre-grant candidate courier',
  () => {
    test('production polling exchanges a signed candidate over loopback without opening traffic or consuming invitation', async () => {
      const f = await fixture();
      const startAdapter = vi.fn(async () => {
        throw new Error('no native or browser application traffic');
      });
      const runtime = createSelfHostedBrokerPionRuntime(
        {
          brokerOrigin: f.brokerOrigin,
          applicationOrigin: 'https://station.example',
          scope: f.scope,
          connectorCredential: f.credentials.connector,
          executable: '/unused',
          certificatePem: 'unused',
          privateKeyPem: 'unused',
          turn: { url: 'turn:unused', username: 'unused', password: 'unused' },
          trust: f.trustOwner,
          issuer: {
            issue: async () => {
              throw new Error('no connection proof');
            },
          },
          candidateIssuer: f.issuer,
          heartbeatMs: 30_000,
          renewMs: 10_000,
          pollMs: 1_000,
          maxPeerLifetimeMs: 60_000,
          maxPeers: 1,
        },
        {
          signal: new AbortController().signal,
          fetch: async () => new Response('unexpected'),
        },
        { startAdapter },
      );
      cleanup.push(() => runtime.shutdown());
      await runtime.start();
      const before = f.counts();
      const opened = await f.post('request');
      expect(opened.status).toBe(200);
      let result: SelfHostedBrokerNativeKeyCandidateResultV1 | undefined;
      await vi.waitFor(
        async () => {
          const response = await f.post('read');
          expect(response.status).toBe(200);
          result =
            (await response.json()) as SelfHostedBrokerNativeKeyCandidateResultV1;
          expect(result.candidate).not.toBeNull();
        },
        { timeout: 5_000 },
      );
      const candidate = result!.candidate!;
      expect(
        (await verifyStationConnectionKeyCandidate(candidate, f.expected))
          .status,
      ).toBe('candidate');
      expect(f.counts()).toEqual(before);
      expect(startAdapter).not.toHaveBeenCalled();
      expect(JSON.stringify(candidate)).not.toContain(
        f.invitation.invitationSecret,
      );
      expect(JSON.stringify(candidate)).not.toContain('PRIVATE KEY');
      const grant = await f.service.redeemNativeInvitation(
        f.invitation,
        await f.proof('redeem'),
      );
      expect(grant.credential.secret).toHaveLength(43);
      expect((await f.post('read')).status).toBe(401);
    });

    test('separates request, read and redemption proofs and rejects cross-client read and browser callers', async () => {
      const f = await fixture();
      await f.connector.register(new AbortController().signal);
      const requestProof = await f.proof('request');
      await expect(
        f.service.redeemNativeInvitation(f.invitation, requestProof),
      ).rejects.toThrow('invalid_native_proof');
      expect(
        (await f.post('request', f.invitation, await f.proof('redeem'))).status,
      ).toBe(400);
      expect((await f.post('request', f.invitation, requestProof)).status).toBe(
        200,
      );
      expect((await f.post('read', f.invitation, requestProof)).status).toBe(
        400,
      );
      const stranger = await generateKeyPair('ES256');
      expect(
        (
          await f.post(
            'read',
            f.invitation,
            await f.proof(
              'read',
              f.invitation,
              f.challenge,
              stranger.privateKey,
            ),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await f.post(
            'read',
            f.invitation,
            await f.proof(
              'read',
              f.invitation,
              randomBytes(32).toString('base64url'),
            ),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await f.post('read', f.invitation, undefined, {
            Origin: 'https://station.example',
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await f.post('request', f.invitation, undefined, {
            Cookie: 'session=ambient',
          })
        ).status,
      ).toBe(401);
      expect(f.counts().grants).toMatchObject({ n: 0 });
    });

    test('bounds replay and lifetime, checks current lease and refuses a different connector credential', async () => {
      const f = await fixture();
      const signal = new AbortController().signal;
      await f.connector.register(signal);
      const opened = await (await f.post('request')).json();
      expect(await (await f.post('request')).json()).toEqual(opened);
      expect(
        (
          await f.post(
            'request',
            f.invitation,
            await f.proof(
              'request',
              f.invitation,
              randomBytes(32).toString('base64url'),
            ),
          )
        ).status,
      ).toBe(409);
      expect(() =>
        f.service.nativeKeyCandidateOffers(f.scope, f.credentials.routing),
      ).toThrow('broker_credential_refused');
      await f.connector.pollNativeKeyCandidates(f.issuer, signal);
      f.advance(60_001);
      expect((await f.post('read')).status).toBe(401);
      // Refresh the lease, so replay refusal is specifically the expired queue entry.
      f.service.register(f.scope, f.credentials.connector);
      expect((await f.post('request')).status).toBe(409);
      f.service.withdraw(f.scope, f.credentials.connector);
      expect((await f.post('read')).status).toBe(401);
      expect(f.counts().grants).toMatchObject({ n: 0 });
    });

    test('rejects substitution at the verifier and pins the issuer to the invited Station generation', async () => {
      const f = await fixture();
      const signal = new AbortController().signal;
      await f.connector.register(signal);
      await f.post('request');
      await f.connector.pollNativeKeyCandidates(f.issuer, signal);
      const result = (await (
        await f.post('read')
      ).json()) as SelfHostedBrokerNativeKeyCandidateResultV1;
      const candidate = result.candidate!;
      for (const mismatch of [
        { challenge: 'B'.repeat(43) },
        { clientInstanceId: randomUUID() },
        { clientKeyThumbprint: 'B'.repeat(43) },
        { brokerOrigin: 'https://other.example' },
        { enrollmentId: randomUUID() },
      ])
        await expect(
          verifyStationConnectionKeyCandidate(candidate, {
            ...f.expected,
            ...mismatch,
          }),
        ).rejects.toThrow();
      expect(() =>
        f.service.answerNativeKeyCandidate(
          f.scope,
          f.credentials.connector,
          f.invitation.invitationId,
          f.challenge,
          { ...candidate, compactJws: 'different' },
        ),
      ).toThrow('connection_replayed');
      expect(() =>
        f.service.answerNativeKeyCandidate(
          f.scope,
          f.credentials.connector,
          f.invitation.invitationId,
          f.challenge,
          { ...candidate, compactJws: 'A'.repeat(256 * 1024) },
        ),
      ).toThrow('invalid_request');
      const invitation: SelfHostedBrokerNativeRouteInvitationV2 =
        f.service.issueNativeInvitation({
          scope: f.scope,
          routingCredential: f.credentials.routing,
          brokerOrigin: f.brokerOrigin,
          surface: f.surface,
          stationSigningKeyId: 'B'.repeat(43),
          stationSigningGeneration: f.trust.generation,
        });
      expect((await f.post('request', invitation)).status).toBe(200);
      await expect(
        f.connector.pollNativeKeyCandidates(f.issuer, signal),
      ).rejects.toThrow('broker_connector_native_station_binding_mismatch');
    });
    test('binds the exact invitation and retains bounded replay slots after explicit redemption', async () => {
      const f = await fixture();
      await f.connector.register(new AbortController().signal);
      for (const changed of [
        { scope: { ...f.invitation.scope, enrollmentId: randomUUID() } },
        { stationSigningGeneration: f.invitation.stationSigningGeneration + 1 },
        { expiresAt: f.invitation.expiresAt + 1 },
        { invitationSecret: 'B'.repeat(43) },
        { surface: { ...f.surface, clientInstanceId: randomUUID() } },
      ]) {
        const selected = { ...f.invitation, ...changed };
        expect((await f.post('request', selected)).status).toBe(401);
      }
      for (let i = 0; i < 64; i++) {
        const invitation =
          i === 0
            ? f.invitation
            : f.service.issueNativeInvitation({
                scope: f.scope,
                routingCredential: f.credentials.routing,
                brokerOrigin: f.brokerOrigin,
                surface: f.surface,
                stationSigningKeyId: f.invitation.stationSigningKeyId,
                stationSigningGeneration: f.trust.generation,
              });
        await f.service.requestNativeKeyCandidate(
          invitation,
          await f.proof('request', invitation),
        );
      }
      await f.service.redeemNativeInvitation(
        f.invitation,
        await f.proof('redeem'),
      );
      const next = f.service.issueNativeInvitation({
        scope: f.scope,
        routingCredential: f.credentials.routing,
        brokerOrigin: f.brokerOrigin,
        surface: f.surface,
        stationSigningKeyId: f.invitation.stationSigningKeyId,
        stationSigningGeneration: f.trust.generation,
      });
      expect((await f.post('request', next)).status).toBe(429);
      expect(
        f.service.nativeKeyCandidateOffers(f.scope, f.credentials.connector),
      ).toHaveLength(1);
    });
    test('rejects oversized requests, forged envelopes and cross-origin invitation delivery', async () => {
      const f = await fixture();
      const url = `${f.brokerOrigin}/broker/v1/native/key-candidates/request`;
      const signed = await f.proof('request');
      for (const body of [
        { version: 'wrong', invitation: f.invitation, proof: signed },
        {
          version: 'station-broker-native-key-candidate-request/v1',
          invitation: f.invitation,
          proof: signed,
          approved: true,
        },
      ])
        expect(
          (
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
          ).status,
        ).toBe(400);
      expect(
        (
          await f.app.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ padding: 'A'.repeat(256 * 1024) }),
          })
        ).status,
      ).toBe(413);
      expect(
        (
          await f.post('request', {
            ...f.invitation,
            brokerOrigin: 'https://other.example',
          })
        ).status,
      ).toBe(401);
      expect(f.counts().grants).toMatchObject({ n: 0 });
    });
  },
);
