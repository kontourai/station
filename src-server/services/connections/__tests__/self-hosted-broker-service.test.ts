import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type {
  SelfHostedBrokerNativeClientGrantV2,
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeRequestProofClaimsV1,
  SelfHostedBrokerNativeRouteInvitationV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import { Hono } from 'hono';
import {
  CompactSign,
  calculateJwkThumbprint,
  compactVerify,
  importJWK,
} from 'jose';
import { describe, expect, test, vi } from 'vitest';
import { createSelfHostedBrokerRoutes } from '../../../routes/connections/self-hosted-broker.js';
import {
  BrokerNativeGrantRenewalConflictError,
  SelfHostedBrokerClient,
  SelfHostedBrokerNativeClient,
} from '../self-hosted-broker-client.js';
import {
  assertSelfHostedBrokerPlatform,
  SelfHostedBrokerService,
  serializeNativeBrokerRedemptionPayload,
} from '../self-hosted-broker-service.js';

const scope = {
  stationId: 'station-12345678',
  enrollmentId: 'enroll-12345678',
  routingGeneration: 1,
  browserOrigin: 'https://client.example',
};
const nativeScope = {
  stationId: scope.stationId,
  enrollmentId: scope.enrollmentId,
  routingGeneration: scope.routingGeneration,
};
async function createNativeClient() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const exported = pair.publicKey.export({ format: 'jwk' });
  const publicKey = {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: exported.x as string,
    y: exported.y as string,
  };
  const keyThumbprint = await calculateJwkThumbprint(publicKey);
  const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
    kind: 'station-native',
    appIdentifier: 'io.kontourai.station',
    channel: 'dev',
    clientInstanceId: '7c6f49aa-6925-4bb2-b7c4-22bb6e264105',
    keyThumbprint,
  };
  return { privateKey: pair.privateKey, publicKey, surface };
}
async function createNativeProof(
  invitation: SelfHostedBrokerNativeRouteInvitationV2,
  client: Awaited<ReturnType<typeof createNativeClient>>,
) {
  const nonce = randomBytes(32).toString('base64url');
  const invitationSecretDigest = createHash('sha256')
    .update(`native-route-invitation/v2:${invitation.invitationSecret}`)
    .digest('base64url');
  const payload = JSON.stringify({
    aud: 'station-self-hosted-broker',
    purpose: 'redeem-native-route-invitation',
    version: invitation.version,
    brokerOrigin: invitation.brokerOrigin,
    scope: {
      stationId: invitation.scope.stationId,
      enrollmentId: invitation.scope.enrollmentId,
      routingGeneration: invitation.scope.routingGeneration,
    },
    stationSigningKeyId: invitation.stationSigningKeyId,
    stationSigningGeneration: invitation.stationSigningGeneration,
    surface: {
      kind: invitation.surface.kind,
      appIdentifier: invitation.surface.appIdentifier,
      channel: invitation.surface.channel,
      clientInstanceId: invitation.surface.clientInstanceId,
      keyThumbprint: invitation.surface.keyThumbprint,
    },
    invitationId: invitation.invitationId,
    invitationSecretDigest,
    expiresAt: invitation.expiresAt,
    nonce,
  });
  const jws = await new CompactSign(Buffer.from(payload))
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'station-broker-native-redemption+jws',
    })
    .sign(client.privateKey);
  return { publicKey: client.publicKey, nonce, jws };
}
async function signNativeRequest(
  claims: SelfHostedBrokerNativeRequestProofClaimsV1,
  client: Awaited<ReturnType<typeof createNativeClient>>,
) {
  return new CompactSign(Buffer.from(JSON.stringify(claims)))
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'station-broker-native-request+jws',
    })
    .sign(client.privateKey);
}
async function rewriteNativeRequestProof(
  compact: string,
  client: Awaited<ReturnType<typeof createNativeClient>>,
  mutate: (claims: Record<string, unknown>) => void,
) {
  const claims = JSON.parse(
    Buffer.from(compact.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  mutate(claims);
  return new CompactSign(Buffer.from(JSON.stringify(claims)))
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'station-broker-native-request+jws',
    })
    .sign(client.privateKey);
}
test('fails closed where private path custody is not implemented', () => {
  expect(() => assertSelfHostedBrokerPlatform('win32')).toThrow(
    'self_hosted_broker_private_custody_unavailable_on_windows',
  );
});
describe.runIf(process.platform !== 'win32')(
  'self-hosted broker control plane',
  () => {
    test('publishes deterministic native redemption signing bytes without the invite secret', () => {
      const invitation: SelfHostedBrokerNativeRouteInvitationV2 = {
        version: 'station-broker-native-route-invitation/v2',
        brokerOrigin: 'https://broker.example',
        scope: {
          stationId: 'station-12345678',
          enrollmentId: 'enroll-12345678',
          routingGeneration: 9,
        },
        stationSigningKeyId: 'K'.repeat(43),
        stationSigningGeneration: 4,
        surface: {
          kind: 'station-native',
          appIdentifier: 'io.kontourai.station',
          channel: 'nightly',
          clientInstanceId: '7c6f49aa-6925-4bb2-b7c4-22bb6e264105',
          keyThumbprint: 'T'.repeat(43),
        },
        invitationId: 'invite-12345678',
        invitationSecret: 'A'.repeat(43),
        expiresAt: 1_700_000_000_123,
      };
      const bytes = serializeNativeBrokerRedemptionPayload(
        invitation,
        'N'.repeat(43),
      );
      const encoded = Buffer.from(bytes).toString('utf8');
      expect(encoded).toBe(
        '{"aud":"station-self-hosted-broker","purpose":"redeem-native-route-invitation","version":"station-broker-native-route-invitation/v2","brokerOrigin":"https://broker.example","scope":{"stationId":"station-12345678","enrollmentId":"enroll-12345678","routingGeneration":9},"stationSigningKeyId":"KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK","stationSigningGeneration":4,"surface":{"kind":"station-native","appIdentifier":"io.kontourai.station","channel":"nightly","clientInstanceId":"7c6f49aa-6925-4bb2-b7c4-22bb6e264105","keyThumbprint":"TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT"},"invitationId":"invite-12345678","invitationSecretDigest":"cwNHKhO8UqbEmG63NB3wWnIRQaHNpk7z6r78WuCtcPs","expiresAt":1700000000123,"nonce":"NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN"}',
      );
      expect(encoded).not.toContain(invitation.invitationSecret);
    });
    test('native client request proof matches the shared Rust golden bytes', async () => {
      const fixture = JSON.parse(
        readFileSync(
          new URL(
            '../../../../packages/contracts/fixtures/native-request-proof-v1.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as {
        brokerOrigin: string;
        grantId: string;
        scope: SelfHostedBrokerNativeRequestProofClaimsV1['scope'];
        surface: SelfHostedBrokerNativeClientSurfaceV2;
        stationSigningKeyId: string;
        stationSigningGeneration: number;
        bodyJson: string;
        bodySha256: string;
        ath: string;
        jti: string;
        iat: number;
        exp: number;
        claimsJson: string;
      };
      const clientKeys = await createNativeClient();
      const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
        ...fixture.surface,
        keyThumbprint: await calculateJwkThumbprint(clientKeys.publicKey),
      };
      const signingClient = { ...clientKeys, surface };
      const grant: SelfHostedBrokerNativeClientGrantV2 = {
        version: 'station-broker-native-client-grant/v2',
        brokerOrigin: fixture.brokerOrigin,
        scope: fixture.scope,
        stationSigningKeyId: fixture.stationSigningKeyId,
        stationSigningGeneration: fixture.stationSigningGeneration,
        surface,
        proofPublicKey: clientKeys.publicKey,
        credential: { id: fixture.grantId, secret: 'S'.repeat(43) },
        expiresAt: fixture.iat * 1000 + 60_000,
      };
      const now = fixture.iat * 1000;
      let claims: SelfHostedBrokerNativeRequestProofClaimsV1 | undefined;
      let body = '';
      let compact = '';
      const request: typeof fetch = async (input, init) => {
        expect(String(input)).toBe(
          'https://broker.example/broker/v1/native/connections/open',
        );
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(`Bearer ${'S'.repeat(43)}`);
        expect(headers.get('x-broker-credential-id')).toBe(fixture.grantId);
        expect(headers.get('origin')).toBeNull();
        expect(headers.get('cookie')).toBeNull();
        compact = headers.get('x-station-native-proof') ?? '';
        body = Buffer.from(init?.body as Uint8Array).toString('utf8');
        return new Response(
          JSON.stringify({
            version: 'station-broker-native-connection-opened/v2',
            expiresAt: now + 60_000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
      const client = new SelfHostedBrokerNativeClient(
        grant,
        async (value) => {
          claims = value;
          return signNativeRequest(value, signingClient);
        },
        request,
        () => now,
      );
      const fixtureBody = JSON.parse(fixture.bodyJson) as {
        connection: { nonce: string; offerSdp: string };
      };
      await client.open(fixtureBody.connection, new AbortController().signal);

      const expectedBody = fixture.bodyJson.replace(
        fixture.surface.keyThumbprint,
        surface.keyThumbprint,
      );
      const expectedBodySha256 = createHash('sha256')
        .update(expectedBody, 'utf8')
        .digest('base64url');
      expect(body).toBe(expectedBody);
      expect(claims?.bodySha256).toBe(expectedBodySha256);
      expect(claims?.ath).toBe(fixture.ath);
      expect(claims?.iat).toBe(fixture.iat);
      expect(claims?.exp).toBe(fixture.exp);
      expect(Buffer.from(claims?.jti ?? '', 'base64url')).toHaveLength(32);
      const normalizedClaims = {
        ...claims,
        surface: {
          ...claims!.surface,
          keyThumbprint: fixture.surface.keyThumbprint,
        },
        jti: fixture.jti,
        bodySha256: fixture.bodySha256,
      };
      expect(JSON.stringify(normalizedClaims)).toBe(fixture.claimsJson);

      const parts = compact.split('.');
      expect(parts).toHaveLength(3);
      expect(Buffer.from(parts[0]!, 'base64url').toString('utf8')).toBe(
        '{"alg":"ES256","typ":"station-broker-native-request+jws"}',
      );
      const verified = await compactVerify(
        compact,
        await importJWK(clientKeys.publicKey, 'ES256'),
        { algorithms: ['ES256'] },
      );
      expect(Buffer.from(verified.payload).toString('utf8')).toBe(
        JSON.stringify(claims),
      );
    });
    test('persists exact routing, refuses replay and invalidates pending work on withdrawal', async () => {
      const path = join(
        mkdtempSync(join(tmpdir(), 'station-broker-')),
        'broker.sqlite',
      );
      const service = new SelfHostedBrokerService(path, () => 1000);
      const provisioned = service.provision(scope);
      expect(service.status(scope, provisioned.routing).state).toBe('offline');
      service.register(scope, provisioned.connector);
      expect(service.status(scope, provisioned.routing).state).toBe('online');
      const app = new Hono();
      app.route('/broker', createSelfHostedBrokerRoutes(service));
      const post = (
        route: string,
        credential: { id: string; secret: string },
        body: unknown,
      ) =>
        app.request(`/broker${route}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential.secret}`,
            'x-broker-credential-id': credential.id,
            'content-type': 'application/json',
            origin: scope.browserOrigin,
          },
          body: JSON.stringify(body),
        });
      const preflight = (origin: string) =>
        app.request('/broker/connections', {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers':
              'Authorization, Content-Type, X-Broker-Credential-Id',
          },
        });
      expect((await preflight(scope.browserOrigin)).status).toBe(204);
      expect((await preflight('https://wrong.example')).status).toBe(401);
      const malformed = await post('/connections', provisioned.routing, {
        scope,
        connection: {
          clientId: 'client-12345678',
          nonce: 'nonce-12345678',
          offerSdp: 'offer',
        },
        extra: true,
      });
      expect(malformed.status).toBe(400);
      const invalidJson = await app.request('/broker/connections', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provisioned.routing.secret}`,
          'x-broker-credential-id': provisioned.routing.id,
          'content-type': 'application/json',
          origin: scope.browserOrigin,
        },
        body: '{',
      });
      expect(invalidJson.status).toBe(400);
      const nullNested = await post('/connections', provisioned.routing, {
        scope,
        connection: null,
      });
      expect(nullNested.status).toBe(400);
      const wrongStation = await post('/connections', provisioned.routing, {
        scope: { ...scope, stationId: 'station-wrong123' },
        connection: {
          clientId: 'client-12345678',
          nonce: 'nonce-wrong123',
          offerSdp: 'offer',
        },
      });
      expect(wrongStation.status).toBe(401);
      const opened = await post('/connections', provisioned.routing, {
        scope,
        connection: {
          clientId: 'client-12345678',
          nonce: 'nonce-12345678',
          offerSdp: 'offer',
        },
      });
      expect(opened.status).toBe(200);
      expect(opened.headers.get('access-control-allow-origin')).toBe(
        scope.browserOrigin,
      );
      expect(opened.headers.has('access-control-allow-credentials')).toBe(
        false,
      );
      expect(
        (
          await post('/connections/offers', provisioned.connector, {
            scope,
            limit: 32,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request('/broker/connections/offers', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${provisioned.connector.secret}`,
              'x-broker-credential-id': provisioned.connector.id,
              'content-type': 'application/json',
              origin: 'https://wrong.example',
            },
            body: JSON.stringify({ scope }),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await post('/connections', provisioned.routing, {
            scope,
            connection: {
              clientId: 'client-12345678',
              nonce: 'nonce-12345678',
              offerSdp: 'offer',
            },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await post('/connections/answer', provisioned.connector, {
            scope,
            connection: {
              clientId: 'client-12345678',
              nonce: 'nonce-12345678',
              answerSdp: 'answer',
              stationProof: 'opaque',
            },
          })
        ).status,
      ).toBe(200);
      service.close();
      const restarted = new SelfHostedBrokerService(path, () => 1000);
      expect(
        restarted.read(
          scope,
          provisioned.routing,
          'client-12345678',
          'nonce-12345678',
        ).answerSdp,
      ).toBe('answer');
      restarted.withdraw(scope, provisioned.connector);
      expect(() =>
        restarted.read(
          scope,
          provisioned.routing,
          'client-12345678',
          'nonce-12345678',
        ),
      ).toThrow('broker_credential_refused');
      restarted.close();
    });
    test('binds credential direction, generation, expiry and renewal revision', () => {
      const path = join(
        mkdtempSync(join(tmpdir(), 'station-broker-')),
        'broker.sqlite',
      );
      let now = 10_000;
      const first = new SelfHostedBrokerService(path, () => now);
      const issued = first.provision(scope, 10_000);
      const competing = new SelfHostedBrokerService(path, () => now);
      expect(() =>
        first.open(scope, issued.connector, {
          clientId: 'client-abcdefgh',
          nonce: 'nonce-abcdefgh',
          offerSdp: 'offer',
        }),
      ).toThrow('broker_credential_refused');
      first.open(scope, issued.routing, {
        clientId: 'client-abcdefgh',
        nonce: 'nonce-abcdefgh',
        offerSdp: 'offer',
      });
      expect(first.renew(scope, issued.connector, 0, 10_000)).toEqual({
        expiresAt: 20_000,
        revision: 1,
      });
      expect(() => first.renew(scope, issued.connector, 0, 10_000)).toThrow(
        'lease_conflict',
      );
      expect(() => competing.renew(scope, issued.connector, 0, 10_000)).toThrow(
        'lease_conflict',
      );
      now = 30_001;
      expect(() =>
        first.read(scope, issued.routing, 'client-abcdefgh', 'nonce-abcdefgh'),
      ).toThrow('broker_credential_refused');
      now = 20_000;
      const nextScope = { ...scope, routingGeneration: 2 };
      const next = first.provision(nextScope, 10_000);
      expect(first.status(nextScope, next.routing).state).toBe('offline');
      expect(first.renew(nextScope, next.connector, 0, 10_000).revision).toBe(
        1,
      );
      expect(() =>
        first.read(scope, issued.routing, 'client-abcdefgh', 'nonce-abcdefgh'),
      ).toThrow('broker_credential_refused');
      expect(() => first.provision(scope, 10_000)).toThrow('stale_generation');
      expect(() =>
        first.open(nextScope, next.routing, {
          clientId: 'client-abcdefgh',
          nonce: 'nonce-abcdefgh',
          offerSdp: 'offer',
        }),
      ).not.toThrow();
      first.open(nextScope, next.routing, {
        clientId: 'client-boundary',
        nonce: 'nonce-boundary',
        offerSdp: 'o'.repeat(128 * 1024),
      });
      first.answer(nextScope, next.connector, {
        clientId: 'client-boundary',
        nonce: 'nonce-boundary',
        answerSdp: 'a'.repeat(128 * 1024),
        stationProof: 'p'.repeat(4096),
      });
      expect(() =>
        first.open(nextScope, next.routing, {
          clientId: 'client-oversize',
          nonce: 'nonce-oversize',
          offerSdp: 'o'.repeat(128 * 1024 + 1),
        }),
      ).toThrow('offer_too_large');
      expect(() =>
        first.answer(nextScope, next.connector, {
          clientId: 'client-abcdefgh',
          nonce: 'nonce-abcdefgh',
          answerSdp: 'answer',
          stationProof: 'p'.repeat(4097),
        }),
      ).toThrow('answer_too_large');
      first.close();
      competing.close();
    });
    test('refuses future metadata even when a database has no tables', () => {
      const path = join(
        mkdtempSync(join(tmpdir(), 'station-broker-foreign-')),
        'broker.sqlite',
      );
      const database = new DatabaseSync(path);
      database.exec('PRAGMA user_version=7');
      database.close();
      chmodSync(path, 0o600);
      expect(() => new SelfHostedBrokerService(path)).toThrow(
        'broker_database_version_refused',
      );
    });
    test('refuses a version-four database missing its grant-owner table', () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-missing-owner-'));
      const path = join(root, 'broker.sqlite');
      try {
        const service = new SelfHostedBrokerService(path);
        service.close();
        const database = new DatabaseSync(path);
        database.exec('DROP TABLE broker_connection_owners');
        database.close();
        expect(() => new SelfHostedBrokerService(path)).toThrow(
          'broker_database_schema_refused',
        );
        const after = new DatabaseSync(path, { readOnly: true });
        expect(
          after
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='broker_connection_owners'",
            )
            .get(),
        ).toBeUndefined();
        after.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('refuses unsafe database parents, hard links, and symbolic links', () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-path-'));
      try {
        const path = join(root, 'broker.sqlite');
        const service = new SelfHostedBrokerService(path);
        service.close();
        const hard = join(root, 'hard.sqlite');
        linkSync(path, hard);
        expect(() => new SelfHostedBrokerService(hard)).toThrow(
          'broker_database_must_be_private',
        );
        rmSync(hard);
        const symbolic = join(root, 'symbolic.sqlite');
        symlinkSync(path, symbolic);
        expect(() => new SelfHostedBrokerService(symbolic)).toThrow(
          'broker_database_must_be_private',
        );
        rmSync(symbolic);
        chmodSync(root, 0o755);
        expect(
          () => new SelfHostedBrokerService(join(root, 'other.sqlite')),
        ).toThrow('broker_database_parent_must_be_private');
      } finally {
        chmodSync(root, 0o700);
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('compacts expired payloads, retains replay keys, and bounds tombstones', () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-retention-'));
      const path = join(root, 'broker.sqlite');
      let now = 1_000;
      let service: SelfHostedBrokerService | undefined;
      try {
        service = new SelfHostedBrokerService(path, () => now);
        const issued = service.provision(scope, 600_000);
        service.open(scope, issued.routing, {
          clientId: 'client-expired1',
          nonce: 'nonce-expired1',
          offerSdp: 'private-offer-marker',
        });
        now = 32_000;
        service.open(scope, issued.routing, {
          clientId: 'client-current1',
          nonce: 'nonce-current1',
          offerSdp: 'current',
        });
        expect(() =>
          service!.open(scope, issued.routing, {
            clientId: 'client-expired1',
            nonce: 'nonce-expired1',
            offerSdp: 'replay',
          }),
        ).toThrow('connection_replayed');
        service.close();
        service = undefined;
        const database = new DatabaseSync(path);
        expect(
          (
            database
              .prepare(
                'SELECT offer_sdp FROM broker_connections WHERE client_id=?',
              )
              .get('client-expired1') as { offer_sdp: string }
          ).offer_sdp,
        ).toBe('');
        database.exec('BEGIN IMMEDIATE');
        const insert = database.prepare(
          "INSERT INTO broker_connections VALUES(?,?,?,?,?,'',NULL,NULL,?,?)",
        );
        for (let index = 0; index < 10_238; index++)
          insert.run(
            scope.stationId,
            scope.enrollmentId,
            scope.routingGeneration,
            `retained-${index}`,
            `nonce-${index}`,
            1,
            2,
          );
        database.exec('COMMIT');
        database.close();
        service = new SelfHostedBrokerService(path, () => now);
        expect(() =>
          service!.open(scope, issued.routing, {
            clientId: 'client-blocked1',
            nonce: 'nonce-blocked1',
            offerSdp: 'offer',
          }),
        ).toThrow('pending_limit');
        now = 700_000;
        service.provision(scope, 600_000, issued);
        expect(() => service!.status(scope, issued.routing)).toThrow(
          'broker_credential_refused',
        );
      } finally {
        service?.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('enforces the per-Station pending quota and stale authority cannot touch a replacement generation', () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-quota-'));
      const path = join(root, 'broker.sqlite');
      const service = new SelfHostedBrokerService(path, () => 1_000);
      try {
        const first = service.provision(scope, 600_000);
        for (let index = 0; index < 32; index++)
          service.open(scope, first.routing, {
            clientId: `client-${index}-aaaa`,
            nonce: `nonce-${index}-aaaa`,
            offerSdp: 'offer',
          });
        expect(() =>
          service.open(scope, first.routing, {
            clientId: 'client-overflow',
            nonce: 'nonce-overflow',
            offerSdp: 'offer',
          }),
        ).toThrow('pending_limit');
        const nextScope = { ...scope, routingGeneration: 2 };
        const next = service.provision(nextScope, 600_000);
        service.open(nextScope, next.routing, {
          clientId: 'client-nextgen',
          nonce: 'nonce-nextgen',
          offerSdp: 'offer',
        });
        expect(() => service.withdraw(scope, first.connector)).toThrow(
          'broker_credential_refused',
        );
        expect(service.offers(nextScope, next.connector)).toHaveLength(1);
        expect(() =>
          service.open(
            nextScope,
            { ...next.routing, id: first.routing.id },
            {
              clientId: 'client-wrongid',
              nonce: 'nonce-wrongid',
              offerSdp: 'offer',
            },
          ),
        ).toThrow('broker_credential_refused');
        expect(() =>
          service.open(
            { ...nextScope, enrollmentId: 'enroll-wrong123' },
            next.routing,
            {
              clientId: 'client-wrongen',
              nonce: 'nonce-wrongen',
              offerSdp: 'offer',
            },
          ),
        ).toThrow('broker_credential_refused');
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('enforces the global live-offer quota independently of one Station', () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-global-'));
      const path = join(root, 'broker.sqlite');
      let service: SelfHostedBrokerService | undefined;
      try {
        service = new SelfHostedBrokerService(path, () => 1_000);
        const issued = service.provision(scope, 600_000);
        service.close();
        service = undefined;
        const database = new DatabaseSync(path);
        database.exec('BEGIN IMMEDIATE');
        const insert = database.prepare(
          "INSERT INTO broker_connections VALUES(?,?,?,?,?,'offer',NULL,NULL,?,?)",
        );
        for (let index = 0; index < 1024; index++)
          insert.run(
            `station-${Math.floor(index / 32)}-aaaa`,
            scope.enrollmentId,
            1,
            `client-${index}-aaaa`,
            `nonce-${index}-aaaa`,
            1_000,
            31_000,
          );
        database.exec('COMMIT');
        database.close();
        service = new SelfHostedBrokerService(path, () => 1_000);
        expect(() =>
          service!.open(scope, issued.routing, {
            clientId: 'client-global1',
            nonce: 'nonce-global1',
            offerSdp: 'offer',
          }),
        ).toThrow('pending_limit');
      } finally {
        service?.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('two independent SQLite owners racing one lease revision produce one winner', async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-cas-'));
      const path = join(root, 'broker.sqlite');
      const owner = new SelfHostedBrokerService(path, () => 1_000);
      const issued = owner.provision(scope, 600_000);
      owner.close();
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const state = new Int32Array(barrier);
      const source = `import {parentPort,workerData} from 'node:worker_threads';import {SelfHostedBrokerService} from ${JSON.stringify(new URL('../self-hosted-broker-service.ts', import.meta.url).href)};const state=new Int32Array(workerData.barrier);Atomics.add(state,0,1);Atomics.notify(state,0);Atomics.wait(state,1,0);const service=new SelfHostedBrokerService(workerData.path,()=>1000);try{service.renew(workerData.scope,workerData.credential,0,60000);parentPort.postMessage('won');}catch(error){parentPort.postMessage(error instanceof Error?error.message:'failed');}finally{service.close();}`;
      const workers = [0, 1].map(
        () =>
          new Worker(source, {
            eval: true,
            workerData: { barrier, path, scope, credential: issued.connector },
            execArgv: ['--import', 'tsx'],
          }),
      );
      try {
        const deadline = Date.now() + 5_000;
        while (Atomics.load(state, 0) < 2) {
          if (Date.now() > deadline)
            throw new Error('CAS workers missed readiness bound');
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        }
        Atomics.store(state, 1, 1);
        Atomics.notify(state, 1, 2);
        const results = await Promise.all(
          workers.map(
            (worker) =>
              new Promise<string>((resolveResult, reject) => {
                worker.once('message', resolveResult);
                worker.once('error', reject);
              }),
          ),
        );
        expect(results.sort()).toEqual(['lease_conflict', 'won']);
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('upgrades a version-one database without reassigning legacy signaling', () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-upgrade-'));
      const path = join(root, 'broker.sqlite');
      let service: SelfHostedBrokerService | undefined;
      try {
        service = new SelfHostedBrokerService(path, () => 1_000);
        const issued = service.provision(scope, 600_000);
        service.open(scope, issued.routing, {
          clientId: 'client-legacy123',
          nonce: 'nonce-legacy123',
          offerSdp: 'offer',
        });
        service.close();
        service = undefined;
        const old = new DatabaseSync(path);
        old.exec(`DROP TABLE broker_connection_owners;
          DROP TABLE broker_client_grants;
          DROP TABLE broker_route_invitations;
          DROP TABLE broker_native_connections;
          DROP TABLE broker_native_request_proofs;
          DROP TABLE broker_native_grant_renewals;
          DROP TABLE broker_native_client_grants;
          DROP TABLE broker_native_route_invitations;
          PRAGMA user_version=1;`);
        old.close();
        service = new SelfHostedBrokerService(path, () => 1_000);
        expect(
          service.read(
            scope,
            issued.routing,
            'client-legacy123',
            'nonce-legacy123',
          ).answerSdp,
        ).toBeNull();
        service.close();
        service = undefined;
        const upgraded = new DatabaseSync(path);
        expect(
          (
            upgraded.prepare('PRAGMA user_version').get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(6);
        expect(
          (
            upgraded
              .prepare(
                "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('broker_route_invitations','broker_client_grants','broker_connection_owners','broker_native_route_invitations','broker_native_client_grants','broker_native_connections')",
              )
              .get() as { n: number }
          ).n,
        ).toBe(6);
        upgraded.close();
      } finally {
        service?.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('upgrades v2 to v4 while preserving a browser v1 grant across restart', async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-upgrade-v2-'));
      const path = join(root, 'broker.sqlite');
      let service: SelfHostedBrokerService | undefined;
      try {
        service = new SelfHostedBrokerService(path, () => 1_000);
        const issued = service.provision(scope, 600_000);
        const invitation = service.issueInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          clientOrigin: scope.browserOrigin,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const browserGrant = service.redeemInvitation(
          invitation,
          scope.browserOrigin,
        );
        service.close();
        service = undefined;
        const old = new DatabaseSync(path);
        old.exec(`DROP TABLE broker_native_connections;
          DROP TABLE broker_native_grant_renewals;
          DROP TABLE broker_native_request_proofs;
          DROP TABLE broker_native_client_grants;
          DROP TABLE broker_native_route_invitations;
          PRAGMA user_version=2;`);
        old.close();
        service = new SelfHostedBrokerService(path, () => 1_000);
        expect(service.status(scope, browserGrant.credential).state).toBe(
          'offline',
        );
        expect(service.listClientGrants(scope, issued.routing)).toHaveLength(1);
        expect(service.listNativeClientGrants(scope, issued.routing)).toEqual(
          [],
        );
        const migrated = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            migrated.prepare('PRAGMA user_version').get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(6);
        migrated.close();
      } finally {
        service?.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('v4 to v6 PoP and renewal migration rolls back atomically and resumes on restart', () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-upgrade-v6-'));
      const path = join(root, 'broker.sqlite');
      let service: SelfHostedBrokerService | undefined;
      try {
        service = new SelfHostedBrokerService(path, () => 1_000);
        const issued = service.provision(scope, 600_000);
        service.close();
        service = undefined;
        const legacy = new DatabaseSync(path);
        legacy.exec(`DROP TABLE broker_native_grant_renewals;
          DROP TABLE broker_native_request_proofs;
          PRAGMA user_version=4;
          CREATE VIEW broker_native_grant_renewals AS SELECT 1 AS ignored;`);
        legacy.close();

        expect(() => new SelfHostedBrokerService(path, () => 1_000)).toThrow();
        const failed = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            failed.prepare('PRAGMA user_version').get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(4);
        expect(
          (
            failed
              .prepare(
                "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='broker_native_request_proofs'",
              )
              .get() as { n: number }
          ).n,
        ).toBe(0);
        failed.close();

        const repair = new DatabaseSync(path);
        repair.exec('DROP VIEW broker_native_grant_renewals');
        repair.close();
        service = new SelfHostedBrokerService(path, () => 1_000);
        expect(service.status(scope, issued.routing).state).toBe('offline');
        service.close();
        service = undefined;
        const migrated = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            migrated.prepare('PRAGMA user_version').get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(6);
        migrated.close();
      } finally {
        service?.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('v5 to v6 migration preserves PoP grants and JTI rows across restart', async () => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-broker-upgrade-v5-renewal-'),
      );
      const path = join(root, 'broker.sqlite');
      let service: SelfHostedBrokerService | undefined;
      const now = 1_000;
      try {
        service = new SelfHostedBrokerService(path, () => now);
        const issued = service.provision(scope, 15 * 24 * 60 * 60_000);
        const native = await createNativeClient();
        const invitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: native.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const grant = await service.redeemNativeInvitation(
          invitation,
          await createNativeProof(invitation, native),
        );
        const firstApp = new Hono();
        firstApp.route('/broker/v1', createSelfHostedBrokerRoutes(service));
        const firstRequest: typeof fetch = async (input, init) =>
          firstApp.fetch(new Request(input, init));
        const client = new SelfHostedBrokerNativeClient(
          grant,
          (claims) => signNativeRequest(claims, native),
          firstRequest,
          () => now,
        );
        await client.open(
          { nonce: 'nonce-v5-proof-preserved', offerSdp: 'v5-offer' },
          new AbortController().signal,
        );
        service.close();
        service = undefined;

        const v5 = new DatabaseSync(path);
        v5.exec(`DROP TABLE broker_native_grant_renewals;
          PRAGMA user_version=5;`);
        expect(
          (
            v5
              .prepare(
                'SELECT count(*) n FROM broker_native_request_proofs WHERE grant_id=?',
              )
              .get(grant.credential.id) as { n: number }
          ).n,
        ).toBe(1);
        v5.close();

        service = new SelfHostedBrokerService(path, () => now);
        expect(
          service.listNativeClientGrants(scope, issued.routing),
        ).toHaveLength(1);
        service.close();
        service = undefined;
        const migrated = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            migrated.prepare('PRAGMA user_version').get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(6);
        expect(
          (
            migrated
              .prepare(
                "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='broker_native_grant_renewals'",
              )
              .get() as { n: number }
          ).n,
        ).toBe(1);
        const columns = migrated
          .prepare('PRAGMA table_info(broker_native_grant_renewals)')
          .all() as { name: string }[];
        expect(columns.map((column) => column.name).sort()).toEqual([
          'expected_expires_at',
          'grant_id',
          'receipt_expires_at',
          'renewal_id',
          'request_digest',
          'result_expires_at',
        ]);
        expect(
          (
            migrated
              .prepare(
                'SELECT count(*) n FROM broker_native_request_proofs WHERE grant_id=?',
              )
              .get(grant.credential.id) as { n: number }
          ).n,
        ).toBe(1);
        expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        migrated.close();

        service = new SelfHostedBrokerService(path, () => now);
        expect(
          service.listNativeClientGrants(scope, issued.routing),
        ).toHaveLength(1);
        service.close();
        service = undefined;
        const restarted = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            restarted
              .prepare(
                'SELECT count(*) n FROM broker_native_request_proofs WHERE grant_id=?',
              )
              .get(grant.credential.id) as { n: number }
          ).n,
        ).toBe(1);
        restarted.close();
      } finally {
        service?.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('upgrades v3 native grants to v4 native connections and preserves them across restart', async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-upgrade-v3-'));
      const path = join(root, 'broker.sqlite');
      let service: SelfHostedBrokerService | undefined;
      try {
        service = new SelfHostedBrokerService(path, () => 1_000);
        const issued = service.provision(scope, 600_000);
        const client = await createNativeClient();
        const invitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const grant = await service.redeemNativeInvitation(
          invitation,
          await createNativeProof(invitation, client),
        );
        service.close();
        service = undefined;
        const old = new DatabaseSync(path);
        old.exec(`DROP TABLE broker_native_connections;
          DROP TABLE broker_native_grant_renewals;
          DROP TABLE broker_native_request_proofs;
          PRAGMA user_version=3;`);
        old.close();
        service = new SelfHostedBrokerService(path, () => 1_000);
        expect(
          service.listNativeClientGrants(scope, issued.routing),
        ).toHaveLength(1);
        expect(
          service.openNativeConnection(
            nativeScope,
            grant.credential,
            client.surface,
            {
              version: 'station-broker-native-connection-open/v2',
              nonce: 'nonce-v3-migrated',
              offerSdp: 'migrated-offer',
            },
          ).version,
        ).toBe('station-broker-native-connection-opened/v2');
        service.close();
        service = new SelfHostedBrokerService(path, () => 1_000);
        expect(
          service.readNativeConnection(
            nativeScope,
            grant.credential,
            client.surface,
            'nonce-v3-migrated',
          ),
        ).toMatchObject({ answerSdp: null, stationProof: null });
        const migrated = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            migrated.prepare('PRAGMA user_version').get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(6);
        migrated.close();
      } finally {
        service?.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('v3-to-v4 migration failure rolls back the version marker', () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-upgrade-fault-'));
      const path = join(root, 'broker.sqlite');
      let service: SelfHostedBrokerService | undefined;
      try {
        service = new SelfHostedBrokerService(path, () => 1_000);
        service.close();
        service = undefined;
        const old = new DatabaseSync(path);
        old.exec(`DROP TABLE broker_native_connections;
          CREATE VIEW broker_native_connections AS SELECT 1 AS expires_at;
          PRAGMA user_version=3;`);
        old.close();
        expect(() => new SelfHostedBrokerService(path, () => 1_000)).toThrow();
        const after = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            after.prepare('PRAGMA user_version').get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(3);
        expect(
          (
            after
              .prepare(
                "SELECT type FROM sqlite_master WHERE name='broker_native_connections'",
              )
              .get() as { type: string }
          ).type,
        ).toBe('view');
        after.close();
      } finally {
        service?.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('generation replacement and lease withdrawal clear native signaling rows before grants', async () => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-broker-native-retirement-'),
      );
      const path = join(root, 'broker.sqlite');
      const service = new SelfHostedBrokerService(path, () => 1_000);
      try {
        const issued = service.provision(scope, 600_000);
        const client = await createNativeClient();
        const issue = (
          currentScope: typeof scope,
          routingCredential: { id: string; secret: string },
        ) =>
          service.issueNativeInvitation({
            scope: currentScope,
            routingCredential,
            brokerOrigin: 'https://broker.example',
            surface: client.surface,
            stationSigningKeyId: 'K'.repeat(43),
            stationSigningGeneration: 1,
          });
        const firstInvitation = issue(scope, issued.routing);
        const firstGrant = await service.redeemNativeInvitation(
          firstInvitation,
          await createNativeProof(firstInvitation, client),
        );
        service.openNativeConnection(
          nativeScope,
          firstGrant.credential,
          client.surface,
          {
            version: 'station-broker-native-connection-open/v2',
            nonce: 'nonce-native-gen-one',
            offerSdp: 'generation-one-offer',
          },
        );
        const nextScope = { ...scope, routingGeneration: 2 };
        const nextIssued = service.provision(nextScope, 600_000);
        const afterGeneration = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            afterGeneration
              .prepare('SELECT count(*) n FROM broker_native_connections')
              .get() as { n: number }
          ).n,
        ).toBe(0);
        expect(
          (
            afterGeneration
              .prepare('SELECT count(*) n FROM broker_native_client_grants')
              .get() as { n: number }
          ).n,
        ).toBe(0);
        afterGeneration.close();

        const nextInvitation = issue(nextScope, nextIssued.routing);
        const nextGrant = await service.redeemNativeInvitation(
          nextInvitation,
          await createNativeProof(nextInvitation, client),
        );
        const nextNativeScope = {
          stationId: nextScope.stationId,
          enrollmentId: nextScope.enrollmentId,
          routingGeneration: nextScope.routingGeneration,
        };
        service.openNativeConnection(
          nextNativeScope,
          nextGrant.credential,
          client.surface,
          {
            version: 'station-broker-native-connection-open/v2',
            nonce: 'nonce-native-before-withdraw',
            offerSdp: 'generation-two-offer',
          },
        );
        service.withdraw(nextScope, nextIssued.connector);
        const afterWithdrawal = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            afterWithdrawal
              .prepare('SELECT count(*) n FROM broker_native_connections')
              .get() as { n: number }
          ).n,
        ).toBe(0);
        expect(
          (
            afterWithdrawal
              .prepare('SELECT count(*) n FROM broker_native_client_grants')
              .get() as { n: number }
          ).n,
        ).toBe(0);
        afterWithdrawal.close();
        expect(() =>
          service.readNativeConnection(
            nextNativeScope,
            nextGrant.credential,
            client.surface,
            'nonce-native-before-withdraw',
          ),
        ).toThrow('broker_credential_refused');
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('one-time client grants isolate signaling and revoke independently', async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-grants-'));
      const path = join(root, 'broker.sqlite');
      let now = 1_000;
      let service = new SelfHostedBrokerService(path, () => now);
      try {
        const issued = service.provision(scope, 600_000);
        service.register(scope, issued.connector);
        const app = new Hono();
        app.route('/broker', createSelfHostedBrokerRoutes(service));
        const invitationInput = {
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          clientOrigin: scope.browserOrigin,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 2,
        };
        const invitationA = service.issueInvitation(invitationInput);
        const invitationB = service.issueInvitation(invitationInput);
        const redeem = (
          invitation: typeof invitationA,
          origin = scope.browserOrigin,
        ) =>
          app.request('/broker/grants/redeem', {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify({ invitation }),
          });
        expect(
          (
            await app.request('/broker/grants/redeem', {
              method: 'OPTIONS',
              headers: {
                origin: scope.browserOrigin,
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'Content-Type',
              },
            })
          ).status,
        ).toBe(204);
        expect(
          (await redeem(invitationA, 'https://wrong.example')).status,
        ).toBe(401);
        expect(
          (
            await redeem({
              ...invitationA,
              stationSigningKeyId: 'X'.repeat(43),
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await redeem({
              ...invitationA,
              brokerOrigin: 'https://wrong-broker.example',
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await redeem({
              ...invitationA,
              scope: { ...scope, routingGeneration: 2 },
            })
          ).status,
        ).toBe(401);
        const first = await redeem(invitationA);
        expect(first.status).toBe(200);
        const grantA = (await first.json()) as {
          credential: { id: string; secret: string };
        };
        expect((await redeem(invitationA)).status).toBe(401);
        const second = await redeem(invitationB);
        expect(second.status).toBe(200);
        const grantB = (await second.json()) as {
          credential: { id: string; secret: string };
        };
        expect(grantA.credential.id).not.toBe(grantB.credential.id);
        const post = (
          route: string,
          credential: { id: string; secret: string },
          body: unknown,
          origin = scope.browserOrigin,
        ) =>
          app.request(`/broker${route}`, {
            method: 'POST',
            headers: {
              origin,
              authorization: `Bearer ${credential.secret}`,
              'x-broker-credential-id': credential.id,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          });
        const zachOrigin = 'https://zach.example';
        const zachInvitation = service.issueInvitation({
          ...invitationInput,
          clientOrigin: zachOrigin,
        });
        expect(
          (
            await app.request('/broker/grants/redeem', {
              method: 'OPTIONS',
              headers: {
                origin: zachOrigin,
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'Content-Type',
              },
            })
          ).status,
        ).toBe(204);
        expect((await redeem(zachInvitation, scope.browserOrigin)).status).toBe(
          401,
        );
        const zachResponse = await redeem(zachInvitation, zachOrigin);
        expect(zachResponse.status).toBe(200);
        const zachGrant = (await zachResponse.json()) as {
          credential: { id: string; secret: string };
        };
        expect(
          (
            await post(
              '/stations/status',
              zachGrant.credential,
              { scope: zachInvitation.scope },
              zachOrigin,
            )
          ).status,
        ).toBe(200);
        const retiredZach = await post(
          '/grants/retire',
          zachGrant.credential,
          { scope: zachInvitation.scope },
          zachOrigin,
        );
        expect(retiredZach.status).toBe(200);
        expect(retiredZach.headers.get('access-control-allow-origin')).toBe(
          zachOrigin,
        );
        const invitationC = service.issueInvitation(invitationInput);
        const third = await redeem(invitationC);
        expect(third.status).toBe(200);
        const grantC = (await third.json()) as {
          credential: { id: string; secret: string };
        };
        expect(
          (await post('/grants/retire', issued.routing, { scope })).status,
        ).toBe(401);
        expect(
          (await post('/grants/retire', grantC.credential, { scope })).status,
        ).toBe(200);
        expect(
          (await post('/stations/status', grantC.credential, { scope })).status,
        ).toBe(401);
        expect(
          (
            await post('/connections', grantA.credential, {
              scope,
              connection: {
                clientId: 'client-grantaaaa',
                nonce: 'nonce-grantaaaa',
                offerSdp: 'offer-A',
              },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await post('/connections/read', grantB.credential, {
              scope,
              clientId: 'client-grantaaaa',
              nonce: 'nonce-grantaaaa',
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await post(
              '/connections/read',
              zachGrant.credential,
              {
                scope: zachInvitation.scope,
                clientId: 'client-grantaaaa',
                nonce: 'nonce-grantaaaa',
              },
              zachOrigin,
            )
          ).status,
        ).toBe(401);
        expect(
          (
            await post('/connections/read', issued.routing, {
              scope,
              clientId: 'client-grantaaaa',
              nonce: 'nonce-grantaaaa',
            })
          ).status,
        ).toBe(401);
        expect(service.offers(scope, issued.connector).length).toBe(1);
        service.revokeClientGrant(scope, issued.routing, grantA.credential.id);
        expect(service.offers(scope, issued.connector)).toHaveLength(0);
        expect(() =>
          service.open(scope, grantB.credential, {
            clientId: 'client-grantaaaa',
            nonce: 'nonce-grantaaaa',
            offerSdp: 'different-offer',
          }),
        ).toThrow('connection_replayed');
        expect(() =>
          service.answer(scope, issued.connector, {
            clientId: 'client-grantaaaa',
            nonce: 'nonce-grantaaaa',
            answerSdp: 'answer',
            stationProof: 'proof',
          }),
        ).toThrow('connection_unavailable');
        expect(
          (await post('/stations/status', grantA.credential, { scope })).status,
        ).toBe(401);
        expect(
          (await post('/stations/status', grantB.credential, { scope })).status,
        ).toBe(200);
        expect(
          (
            await post(
              '/stations/status',
              zachGrant.credential,
              { scope: zachInvitation.scope },
              zachOrigin,
            )
          ).status,
        ).toBe(401);
        expect(service.register(scope, issued.connector).revision).toBe(0);
        const expiring = service.issueInvitation({
          ...invitationInput,
          invitationTtlMs: 100,
        });
        now += 101;
        expect((await redeem(expiring)).status).toBe(401);
        service.close();
        service = new SelfHostedBrokerService(path, () => now);
        expect(() =>
          service.redeemInvitation(invitationA, scope.browserOrigin),
        ).toThrow('invitation_refused');
        expect(service.status(scope, grantB.credential).state).toBe('online');
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('two broker owners racing one invitation publish exactly one grant', async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-invite-race-'));
      const path = join(root, 'broker.sqlite');
      const owner = new SelfHostedBrokerService(path, () => 1_000);
      const issued = owner.provision(scope, 600_000);
      const invitation = owner.issueInvitation({
        scope,
        routingCredential: issued.routing,
        brokerOrigin: 'https://broker.example',
        clientOrigin: scope.browserOrigin,
        stationSigningKeyId: 'K'.repeat(43),
        stationSigningGeneration: 1,
      });
      owner.close();
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
      const state = new Int32Array(barrier);
      const source = `import {parentPort,workerData} from 'node:worker_threads';import {SelfHostedBrokerService} from ${JSON.stringify(new URL('../self-hosted-broker-service.ts', import.meta.url).href)};const state=new Int32Array(workerData.barrier);Atomics.add(state,0,1);Atomics.notify(state,0);Atomics.wait(state,1,0);const service=new SelfHostedBrokerService(workerData.path,()=>1000);try{service.redeemInvitation(workerData.invitation,workerData.origin);parentPort.postMessage('won');}catch(error){parentPort.postMessage(error instanceof Error?error.message:'failed');}finally{service.close();}`;
      const workers = [0, 1].map(
        () =>
          new Worker(source, {
            eval: true,
            workerData: {
              barrier,
              path,
              invitation,
              origin: scope.browserOrigin,
            },
            execArgv: ['--import', 'tsx'],
          }),
      );
      try {
        const deadline = Date.now() + 5_000;
        while (Atomics.load(state, 0) < 2) {
          if (Date.now() > deadline)
            throw new Error('Invitation workers missed readiness bound');
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        }
        Atomics.store(state, 1, 1);
        Atomics.notify(state, 1, 2);
        const results = await Promise.all(
          workers.map(
            (worker) =>
              new Promise<string>((resolveResult, reject) => {
                worker.once('message', resolveResult);
                worker.once('error', reject);
              }),
          ),
        );
        expect(results.sort()).toEqual(['invitation_refused', 'won']);
        const reopened = new SelfHostedBrokerService(path, () => 1_000);
        expect(reopened.listClientGrants(scope, issued.routing)).toHaveLength(
          1,
        );
        expect(() =>
          reopened.redeemInvitation(invitation, scope.browserOrigin),
        ).toThrow('invitation_refused');
        reopened.close();
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('native v2 binds a one-use install proof and remains outside v1 signaling', async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-native-v2-'));
      const path = join(root, 'broker.sqlite');
      let now = 1_000;
      let service = new SelfHostedBrokerService(path, () => now);
      try {
        const issued = service.provision(scope, 600_000);
        const client = await createNativeClient();
        const invitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
          invitationTtlMs: 500,
          grantTtlMs: 10_000,
        });

        const otherClient = await createNativeClient();
        await expect(
          service.redeemNativeInvitation(
            invitation,
            await createNativeProof(invitation, otherClient),
          ),
        ).rejects.toThrow('invalid_native_proof');
        const changedChannel = {
          ...invitation,
          surface: { ...invitation.surface, channel: 'beta' as const },
        };
        await expect(
          service.redeemNativeInvitation(
            changedChannel,
            await createNativeProof(changedChannel, client),
          ),
        ).rejects.toThrow('native_invitation_refused');
        const changedApp = {
          ...invitation,
          surface: {
            ...invitation.surface,
            appIdentifier: 'io.kontourai.station.other',
          },
        };
        await expect(
          service.redeemNativeInvitation(
            changedApp,
            await createNativeProof(changedApp, client),
          ),
        ).rejects.toThrow('native_invitation_refused');
        const changedStation = {
          ...invitation,
          scope: { ...invitation.scope, stationId: 'station-other1234' },
        };
        await expect(
          service.redeemNativeInvitation(
            changedStation,
            await createNativeProof(changedStation, client),
          ),
        ).rejects.toThrow('native_invitation_refused');
        const changedGeneration = {
          ...invitation,
          scope: { ...invitation.scope, routingGeneration: 2 },
        };
        await expect(
          service.redeemNativeInvitation(
            changedGeneration,
            await createNativeProof(changedGeneration, client),
          ),
        ).rejects.toThrow('native_invitation_refused');
        const validProof = await createNativeProof(invitation, client);
        const proofPayload = Buffer.from(
          validProof.jws.split('.')[1],
          'base64url',
        ).toString('utf8');
        expect(proofPayload).not.toContain(invitation.invitationSecret);
        const reorderedPayload = JSON.stringify(
          Object.fromEntries(
            Object.entries(
              JSON.parse(proofPayload) as Record<string, unknown>,
            ).reverse(),
          ),
        );
        const reorderedJws = await new CompactSign(
          Buffer.from(reorderedPayload),
        )
          .setProtectedHeader({
            alg: 'ES256',
            typ: 'station-broker-native-redemption+jws',
          })
          .sign(client.privateKey);
        await expect(
          service.redeemNativeInvitation(invitation, {
            ...validProof,
            jws: reorderedJws,
          }),
        ).rejects.toThrow('invalid_native_proof');
        await expect(
          service.redeemNativeInvitation(invitation, {
            ...validProof,
            nonce: randomBytes(32).toString('base64url'),
          }),
        ).rejects.toThrow('invalid_native_proof');

        const fault = new DatabaseSync(path);
        fault.exec(`CREATE TRIGGER fail_native_grant_insert
          BEFORE INSERT ON broker_native_client_grants
          BEGIN SELECT RAISE(ABORT, 'injected_native_grant_failure'); END;`);
        fault.close();
        await expect(
          service.redeemNativeInvitation(invitation, validProof),
        ).rejects.toThrow('injected_native_grant_failure');
        const rollback = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            rollback
              .prepare(
                'SELECT consumed_at FROM broker_native_route_invitations WHERE invitation_id=?',
              )
              .get(invitation.invitationId) as { consumed_at: number | null }
          ).consumed_at,
        ).toBeNull();
        expect(
          (
            rollback
              .prepare('SELECT count(*) n FROM broker_native_client_grants')
              .get() as { n: number }
          ).n,
        ).toBe(0);
        rollback.close();
        const repair = new DatabaseSync(path);
        repair.exec('DROP TRIGGER fail_native_grant_insert');
        repair.close();

        const grant = await service.redeemNativeInvitation(
          invitation,
          validProof,
        );
        expect(grant).toMatchObject({
          version: 'station-broker-native-client-grant/v2',
          scope: nativeScope,
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
        });
        expect(() => service.status(scope, grant.credential)).toThrow(
          'broker_credential_refused',
        );
        expect(() => service.register(scope, grant.credential)).toThrow(
          'broker_credential_refused',
        );
        expect(() => service.renew(scope, grant.credential, 0)).toThrow(
          'broker_credential_refused',
        );
        expect(() => service.withdraw(scope, grant.credential)).toThrow(
          'broker_credential_refused',
        );
        expect(() =>
          service.open(scope, grant.credential, {
            clientId: 'client-native123',
            nonce: 'nonce-native123',
            offerSdp: 'offer',
          }),
        ).toThrow('broker_credential_refused');
        expect(() =>
          service.read(
            scope,
            grant.credential,
            'client-native123',
            'nonce-native123',
          ),
        ).toThrow('broker_credential_refused');
        expect(() => service.offers(scope, grant.credential)).toThrow(
          'broker_credential_refused',
        );
        expect(() =>
          service.answer(scope, grant.credential, {
            clientId: 'client-native123',
            nonce: 'nonce-native123',
            answerSdp: 'answer',
            stationProof: 'proof',
          }),
        ).toThrow('broker_credential_refused');
        expect(() =>
          service.revokeClientGrant(scope, issued.routing, grant.credential.id),
        ).toThrow('grant_unavailable');
        expect(() =>
          service.retireOwnClientGrant(scope, grant.credential),
        ).toThrow('broker_credential_refused');
        await expect(
          service.redeemNativeInvitation(invitation, validProof),
        ).rejects.toThrow('native_invitation_refused');
        const inventory = service.listNativeClientGrants(scope, issued.routing);
        expect(inventory).toMatchObject([
          {
            grantId: grant.credential.id,
            appIdentifier: client.surface.appIdentifier,
            channel: client.surface.channel,
            clientInstanceId: client.surface.clientInstanceId,
            keyThumbprint: client.surface.keyThumbprint,
            revokedAt: null,
          },
        ]);
        const inventoryJson = JSON.stringify(inventory);
        expect(inventoryJson).not.toContain(grant.credential.secret);
        expect(inventoryJson).not.toContain(invitation.invitationSecret);
        expect(inventoryJson).not.toContain(JSON.stringify(client.publicKey));

        service.close();
        service = new SelfHostedBrokerService(path, () => now);
        expect(
          service.listNativeClientGrants(scope, issued.routing),
        ).toHaveLength(1);
        service.revokeNativeClientGrant(
          scope,
          issued.routing,
          grant.credential.id,
        );
        expect(
          service.listNativeClientGrants(scope, issued.routing),
        ).toMatchObject([{ grantId: grant.credential.id, revokedAt: now }]);

        const expiringClient = await createNativeClient();
        const expiring = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: expiringClient.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
          invitationTtlMs: 100,
        });
        const expiringProof = await createNativeProof(expiring, expiringClient);
        now += 101;
        await expect(
          service.redeemNativeInvitation(expiring, expiringProof),
        ).rejects.toThrow('native_invitation_refused');
        const retainedClient = await createNativeClient();
        const retainedInvitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: retainedClient.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        await service.redeemNativeInvitation(
          retainedInvitation,
          await createNativeProof(retainedInvitation, retainedClient),
        );
        const nextScope = { ...scope, routingGeneration: 2 };
        const next = service.provision(nextScope, 600_000);
        expect(service.listNativeClientGrants(nextScope, next.routing)).toEqual(
          [],
        );
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('native grant cleanup preserves renewal grace and later purges expired tombstones', async () => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-broker-native-fk-purge-'),
      );
      const path = join(root, 'broker.sqlite');
      let now = 1_000;
      const service = new SelfHostedBrokerService(path, () => now);
      try {
        const issued = service.provision(scope, 15 * 24 * 60 * 60_000);
        const [clientA, clientB, clientC] = await Promise.all([
          createNativeClient(),
          createNativeClient(),
          createNativeClient(),
        ]);
        const clients = [clientA, clientB, clientC].map((client, index) => ({
          ...client,
          surface: {
            ...client.surface,
            clientInstanceId: [
              '11111111-1111-4111-8111-111111111111',
              '22222222-2222-4222-8222-222222222222',
              '33333333-3333-4333-8333-333333333333',
            ][index]!,
          },
        }));
        const invite = (
          client: (typeof clients)[number],
          grantTtlMs?: number,
        ) =>
          service.issueNativeInvitation({
            scope,
            routingCredential: issued.routing,
            brokerOrigin: 'https://broker.example',
            surface: client.surface,
            stationSigningKeyId: 'K'.repeat(43),
            stationSigningGeneration: 1,
            ...(grantTtlMs === undefined ? {} : { grantTtlMs }),
          });

        const inviteA = invite(clients[0]!);
        const grantA = await service.redeemNativeInvitation(
          inviteA,
          await createNativeProof(inviteA, clients[0]!),
        );
        service.openNativeConnection(
          nativeScope,
          grantA.credential,
          clients[0]!.surface,
          {
            version: 'station-broker-native-connection-open/v2',
            nonce: 'nonce-native-revoked-tombstone',
            offerSdp: 'revoked-native-offer',
          },
        );
        service.revokeNativeClientGrant(
          scope,
          issued.routing,
          grantA.credential.id,
        );
        const revokedTombstone = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            revokedTombstone
              .prepare(
                'SELECT count(*) n FROM broker_native_connections WHERE grant_id=?',
              )
              .get(grantA.credential.id) as { n: number }
          ).n,
        ).toBe(1);
        revokedTombstone.close();

        now += 330_001;
        const inviteB = invite(clients[1]!, 100);
        const grantB = await service.redeemNativeInvitation(
          inviteB,
          await createNativeProof(inviteB, clients[1]!),
        );
        const afterRevokedPurge = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            afterRevokedPurge
              .prepare(
                'SELECT count(*) n FROM broker_native_connections WHERE grant_id=?',
              )
              .get(grantA.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        expect(
          (
            afterRevokedPurge
              .prepare(
                'SELECT count(*) n FROM broker_native_client_grants WHERE grant_id=?',
              )
              .get(grantA.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        afterRevokedPurge.close();

        service.openNativeConnection(
          nativeScope,
          grantB.credential,
          clients[1]!.surface,
          {
            version: 'station-broker-native-connection-open/v2',
            nonce: 'nonce-native-expired-tombstone',
            offerSdp: 'expired-native-offer',
          },
        );
        const renewalB = service.renewNativeClientGrant(
          nativeScope,
          grantB.credential,
          clients[1]!.surface,
          {
            version: 'station-broker-native-grant-renew/v2',
            scope: nativeScope,
            surface: clients[1]!.surface,
            renewalId: 'renewal-cleanup-01',
            expectedExpiresAt: grantB.expiresAt,
          },
          'D'.repeat(43),
        );
        now = renewalB.expiresAt + 1;
        const inviteC = invite(clients[2]!);
        await service.redeemNativeInvitation(
          inviteC,
          await createNativeProof(inviteC, clients[2]!),
        );
        const afterExpiredPurge = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            afterExpiredPurge
              .prepare(
                'SELECT count(*) n FROM broker_native_connections WHERE grant_id=? AND offer_sdp=? AND answer_sdp IS NULL AND station_proof IS NULL',
              )
              .get(grantB.credential.id, '') as { n: number }
          ).n,
        ).toBe(0);
        expect(
          (
            afterExpiredPurge
              .prepare(
                'SELECT count(*) n FROM broker_native_client_grants WHERE grant_id=?',
              )
              .get(grantB.credential.id) as { n: number }
          ).n,
        ).toBe(1);
        expect(
          (
            afterExpiredPurge
              .prepare(
                'SELECT count(*) n FROM broker_native_grant_renewals WHERE grant_id=?',
              )
              .get(grantB.credential.id) as { n: number }
          ).n,
        ).toBe(1);
        afterExpiredPurge.close();
        now = renewalB.expiresAt + 7 * 24 * 60 * 60_000 + 1;
        const inviteD = invite(clients[2]!);
        await service.redeemNativeInvitation(
          inviteD,
          await createNativeProof(inviteD, clients[2]!),
        );
        const afterGracePurge = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            afterGracePurge
              .prepare(
                'SELECT count(*) n FROM broker_native_connections WHERE grant_id=?',
              )
              .get(grantB.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        expect(
          (
            afterGracePurge
              .prepare(
                'SELECT count(*) n FROM broker_native_grant_renewals WHERE grant_id=?',
              )
              .get(grantB.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        expect(
          (
            afterGracePurge
              .prepare(
                'SELECT count(*) n FROM broker_native_client_grants WHERE grant_id=?',
              )
              .get(grantB.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        afterGracePurge.close();
        expect(
          service.nativeOffers(scope, issued.connector, clients[1]!.surface),
        ).toEqual([]);
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('native redeem endpoint requires a signed v2 invite and forbids downgrade', async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-native-route-'));
      const path = join(root, 'broker.sqlite');
      const service = new SelfHostedBrokerService(path, () => 1_000);
      try {
        const issued = service.provision(scope, 600_000);
        const app = new Hono();
        app.route('/broker/v1', createSelfHostedBrokerRoutes(service));
        const operatorPost = (
          route: string,
          body: unknown,
          origin = scope.browserOrigin,
        ) =>
          app.request(`/broker/v1${route}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${issued.routing.secret}`,
              'x-broker-credential-id': issued.routing.id,
              origin,
            },
            body: JSON.stringify(body),
          });
        const client = await createNativeClient();
        const issueBody = {
          scope,
          brokerOrigin: 'https://broker.example',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        };
        expect(
          (
            await operatorPost(
              '/native/grants/invitations/issue',
              issueBody,
              'https://untrusted.example',
            )
          ).status,
        ).toBe(401);
        const issueResponse = await operatorPost(
          '/native/grants/invitations/issue',
          issueBody,
        );
        expect(issueResponse.status).toBe(200);
        const nativeInvitation =
          (await issueResponse.json()) as SelfHostedBrokerNativeRouteInvitationV2;
        const nativeProof = await createNativeProof(nativeInvitation, client);
        const browserInvitation = service.issueInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          clientOrigin: scope.browserOrigin,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const nativeBody = JSON.stringify({
          invitation: nativeInvitation,
          proof: nativeProof,
        });
        const nativeResponse = await app.request(
          '/broker/v1/native/grants/redeem',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: nativeBody,
          },
        );
        expect(nativeResponse.status).toBe(200);
        const nativeGrant = (await nativeResponse.json()) as {
          credential: { id: string; secret: string };
        };
        expect(nativeGrant.credential.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const v1Attempts = [
          ['/stations/status', { scope }],
          ['/leases/register', { scope }],
          ['/leases/renew', { scope, expectedRevision: 0 }],
          ['/leases/withdraw', { scope }],
          ['/grants/revoke', { scope, grantId: nativeGrant.credential.id }],
          ['/grants/retire', { scope }],
          ['/connections/offers', { scope, limit: 1 }],
          [
            '/connections',
            {
              scope,
              connection: {
                clientId: 'client-native123',
                nonce: 'nonce-native123',
                offerSdp: 'offer',
              },
            },
          ],
          [
            '/connections/answer',
            {
              scope,
              connection: {
                clientId: 'client-native123',
                nonce: 'nonce-native123',
                answerSdp: 'answer',
                stationProof: 'proof',
              },
            },
          ],
          [
            '/connections/read',
            { scope, clientId: 'client-native123', nonce: 'nonce-native123' },
          ],
        ] as const;
        for (const [path, body] of v1Attempts) {
          const refused = await app.request(`/broker/v1${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${nativeGrant.credential.secret}`,
              'x-broker-credential-id': nativeGrant.credential.id,
              origin: scope.browserOrigin,
            },
            body: JSON.stringify(body),
          });
          expect(refused.status, path).toBe(401);
        }
        const listed = await operatorPost('/native/grants/list', { scope });
        expect(listed.status).toBe(200);
        const listedBody = await listed.text();
        expect(listedBody).toContain(nativeGrant.credential.id);
        expect(listedBody).not.toContain(nativeGrant.credential.secret);
        const revoke = await operatorPost('/native/grants/revoke', {
          scope,
          grantId: nativeGrant.credential.id,
        });
        expect(revoke.status).toBe(200);
        expect(await revoke.json()).toEqual({ revoked: true });
        const listedAfterRevoke = await operatorPost('/native/grants/list', {
          scope,
        });
        expect(await listedAfterRevoke.json()).toMatchObject([
          { grantId: nativeGrant.credential.id, revokedAt: 1_000 },
        ]);
        const originResponse = await app.request(
          '/broker/v1/native/grants/redeem',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'https://untrusted.example',
            },
            body: JSON.stringify({
              invitation: nativeInvitation,
              proof: nativeProof,
            }),
          },
        );
        expect(originResponse.status).toBe(401);
        const downgrade = await app.request('/broker/v1/grants/redeem', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: scope.browserOrigin,
          },
          body: JSON.stringify({ invitation: nativeInvitation }),
        });
        expect(downgrade.status).toBe(400);
        expect(await downgrade.json()).toEqual({ error: 'invalid_invitation' });
        const upgradeRefusal = await app.request(
          '/broker/v1/native/grants/redeem',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              invitation: browserInvitation,
              proof: nativeProof,
            }),
          },
        );
        expect(upgradeRefusal.status).toBe(400);
        expect(await upgradeRefusal.json()).toEqual({
          error: 'invalid_native_invitation',
        });
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('native host open/read/retire and connector v2 offers stay isolated from v1', async () => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-broker-native-signaling-'),
      );
      const path = join(root, 'broker.sqlite');
      const service = new SelfHostedBrokerService(path, () => 1_000);
      try {
        const issued = service.provision(scope, 600_000);
        const client = await createNativeClient();
        const invitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const grant = await service.redeemNativeInvitation(
          invitation,
          await createNativeProof(invitation, client),
        );
        const app = new Hono();
        app.route('/broker/v1', createSelfHostedBrokerRoutes(service));
        const observedHeaders: Headers[] = [];
        const observedRequests: {
          input: Request | string | URL;
          init?: RequestInit;
        }[] = [];
        const request: typeof fetch = async (input, init) => {
          observedHeaders.push(new Headers(init?.headers));
          observedRequests.push({ input, init });
          return app.fetch(new Request(input, init));
        };
        const native = new SelfHostedBrokerNativeClient(
          grant,
          (claims) => signNativeRequest(claims, client),
          request,
          () => 1_000,
        );
        const signal = new AbortController().signal;
        const faultPath = '/broker/v1/native/connections/open';
        const faultBody = JSON.stringify({
          scope: nativeScope,
          surface: client.surface,
          connection: {
            version: 'station-broker-native-connection-open/v2',
            nonce: 'nonce-native-proof-fault',
            offerSdp: 'native-fault-offer',
          },
        });
        const faultClaims: SelfHostedBrokerNativeRequestProofClaimsV1 = {
          version: 'station-broker-native-request-proof/v1',
          aud: 'https://broker.example',
          purpose: 'station-native-connection-open-v2',
          brokerOrigin: 'https://broker.example',
          method: 'POST',
          path: faultPath,
          grantId: grant.credential.id,
          scope: nativeScope,
          surface: client.surface,
          stationSigningKeyId: grant.stationSigningKeyId,
          stationSigningGeneration: grant.stationSigningGeneration,
          bodySha256: createHash('sha256')
            .update(faultBody)
            .digest('base64url'),
          ath: createHash('sha256')
            .update(grant.credential.secret)
            .digest('base64url'),
          jti: randomBytes(32).toString('base64url'),
          iat: 1,
          exp: 31,
        };
        const faultProof = await signNativeRequest(faultClaims, client);
        const db = new DatabaseSync(path);
        db.exec(`CREATE TRIGGER reject_native_proof_insert
          BEFORE INSERT ON broker_native_request_proofs
          BEGIN SELECT RAISE(ABORT, 'injected proof insert failure'); END;`);
        db.close();
        const faultRequest: RequestInit = {
          method: 'POST',
          headers: {
            authorization: `Bearer ${grant.credential.secret}`,
            'x-broker-credential-id': grant.credential.id,
            'x-station-native-proof': faultProof,
            'content-type': 'application/json',
          },
          body: faultBody,
        };
        const failedInsert = await app.request(
          `https://broker.example${faultPath}`,
          faultRequest,
        );
        expect(failedInsert.status).toBe(500);
        expect(await failedInsert.json()).toEqual({
          error: 'broker_unavailable',
        });
        const removeTrigger = new DatabaseSync(path);
        removeTrigger.exec('DROP TRIGGER reject_native_proof_insert');
        removeTrigger.close();
        const retryAfterStorageFailure = await app.request(
          `https://broker.example${faultPath}`,
          faultRequest,
        );
        expect(retryAfterStorageFailure.status).toBe(200);
        service.answerNativeConnection(scope, issued.connector, {
          version: 'station-broker-native-connection-answer/v2',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
          clientId: client.surface.clientInstanceId,
          nonce: 'nonce-native-proof-fault',
          answerSdp: 'fault-answer',
          stationProof: 'fault-station-proof',
        });
        const opened = await native.open(
          { nonce: 'nonce-native-signaling', offerSdp: 'native-offer' },
          signal,
        );
        expect(opened).toMatchObject({
          version: 'station-broker-native-connection-opened/v2',
          expiresAt: 31_000,
        });
        expect(observedHeaders[0]?.has('origin')).toBe(false);
        expect(observedHeaders[0]?.has('cookie')).toBe(false);
        const openedRequest = observedRequests[0];
        expect(openedRequest).toBeDefined();
        const originalHeaders = new Headers(openedRequest!.init?.headers);
        const originalProof = originalHeaders.get('x-station-native-proof');
        expect(originalProof).toBeTruthy();
        const invalidClaims: Array<(claims: Record<string, unknown>) => void> =
          [
            (claims) => {
              claims.aud = 'https://wrong.example';
            },
            (claims) => {
              claims.path = '/broker/v1/native/connections/read';
            },
            (claims) => {
              claims.purpose = 'station-native-connection-read-v2';
            },
            (claims) => {
              claims.stationSigningGeneration = 2;
            },
            (claims) => {
              claims.scope = {
                stationId: 'station-other123',
                enrollmentId: scope.enrollmentId,
                routingGeneration: 1,
              };
            },
            (claims) => {
              claims.surface = { ...client.surface, channel: 'stable' };
            },
            (claims) => {
              claims.bodySha256 = 'B'.repeat(43);
            },
            (claims) => {
              claims.ath = 'C'.repeat(43);
            },
            (claims) => {
              claims.method = 'GET';
            },
            (claims) => {
              claims.exp = 0;
            },
          ];
        for (const mutate of invalidClaims) {
          const proof = await rewriteNativeRequestProof(
            originalProof!,
            client,
            mutate,
          );
          const headers = new Headers(originalHeaders);
          headers.set('x-station-native-proof', proof);
          const invalid = await app.request(openedRequest!.input, {
            ...openedRequest!.init,
            headers,
          });
          expect(invalid.status).toBe(400);
        }
        const replayedOpen = await app.request(
          openedRequest!.input,
          openedRequest!.init,
        );
        expect(replayedOpen.status).toBe(409);
        const changedBody = `${String(openedRequest!.init?.body)} `;
        const changedBodyRequest = await app.request(openedRequest!.input, {
          ...openedRequest!.init,
          body: changedBody,
        });
        expect(changedBodyRequest.status).toBe(400);
        const wrongBearerHeaders = new Headers(originalHeaders);
        wrongBearerHeaders.set('authorization', `Bearer ${'Z'.repeat(43)}`);
        expect(
          (
            await app.request(openedRequest!.input, {
              ...openedRequest!.init,
              headers: wrongBearerHeaders,
            })
          ).status,
        ).toBe(401);
        const disallowedNativeHeaders = {
          'content-type': 'application/json',
          authorization: `Bearer ${grant.credential.secret}`,
          'x-broker-credential-id': grant.credential.id,
        };
        const disallowedNativeBody = JSON.stringify({
          scope: nativeScope,
          surface: client.surface,
          connection: {
            version: 'station-broker-native-connection-open/v2',
            nonce: 'nonce-native-origin',
            offerSdp: 'native-offer',
          },
        });
        const browserOriginRefusal = await app.request(
          '/broker/v1/native/connections/open',
          {
            method: 'POST',
            headers: {
              ...disallowedNativeHeaders,
              origin: scope.browserOrigin,
            },
            body: disallowedNativeBody,
          },
        );
        const bearerOnlyRefusal = await app.request(
          '/broker/v1/native/connections/open',
          {
            method: 'POST',
            headers: disallowedNativeHeaders,
            body: disallowedNativeBody,
          },
        );
        const cookieRefusal = await app.request(
          '/broker/v1/native/connections/open',
          {
            method: 'POST',
            headers: { ...disallowedNativeHeaders, cookie: 'session=blocked' },
            body: disallowedNativeBody,
          },
        );
        expect(browserOriginRefusal.status).toBe(401);
        expect(bearerOnlyRefusal.status).toBe(401);
        expect(cookieRefusal.status).toBe(401);

        const operator = new SelfHostedBrokerClient(
          'https://broker.example',
          scope,
          issued.connector,
          request,
          () => 1_000,
        );
        expect(await operator.offers(signal)).toEqual([]);
        const nativeOffers = await operator.nativeOffers(
          client.surface,
          signal,
        );
        expect(nativeOffers).toMatchObject([
          {
            version: 'station-broker-native-connection-offer/v2',
            scope: nativeScope,
            surface: client.surface,
            stationSigningKeyId: 'K'.repeat(43),
            stationSigningGeneration: 1,
            clientId: client.surface.clientInstanceId,
            nonce: 'nonce-native-signaling',
            offerSdp: 'native-offer',
          },
        ]);
        await expect(
          operator.answerNative(
            {
              surface: client.surface,
              clientId: nativeOffers[0]!.clientId,
              nonce: nativeOffers[0]!.nonce,
              stationSigningKeyId: 'X'.repeat(43),
              stationSigningGeneration: 1,
              answerSdp: 'wrong-key-answer',
              stationProof: 'wrong-key-proof',
            },
            signal,
          ),
        ).rejects.toThrow('broker_request_refused_401');
        await expect(
          operator.answerNative(
            {
              surface: client.surface,
              clientId: nativeOffers[0]!.clientId,
              nonce: nativeOffers[0]!.nonce,
              stationSigningKeyId: 'K'.repeat(43),
              stationSigningGeneration: 2,
              answerSdp: 'wrong-generation-answer',
              stationProof: 'wrong-generation-proof',
            },
            signal,
          ),
        ).rejects.toThrow('broker_request_refused_401');
        await operator.answerNative(
          {
            surface: client.surface,
            clientId: nativeOffers[0]!.clientId,
            nonce: nativeOffers[0]!.nonce,
            stationSigningKeyId: 'K'.repeat(43),
            stationSigningGeneration: 1,
            answerSdp: 'native-answer',
            stationProof: 'native-station-proof',
          },
          signal,
        );
        expect(await native.read('nonce-native-signaling', signal)).toEqual({
          version: 'station-broker-native-connection-answer/v2',
          answerSdp: 'native-answer',
          stationProof: 'native-station-proof',
          expiresAt: 31_000,
        });

        const appPreflight = await app.request(
          '/broker/v1/native/connections/open',
          {
            method: 'OPTIONS',
            headers: {
              origin: scope.browserOrigin,
              'access-control-request-method': 'POST',
              'access-control-request-headers':
                'Authorization, Content-Type, X-Broker-Credential-Id',
            },
          },
        );
        const connectorPreflight = await app.request(
          '/broker/v1/native/connections/offers',
          {
            method: 'OPTIONS',
            headers: {
              origin: scope.browserOrigin,
              'access-control-request-method': 'POST',
              'access-control-request-headers':
                'Authorization, Content-Type, X-Broker-Credential-Id',
            },
          },
        );
        const renewalPreflight = await app.request(
          '/broker/v1/native/grants/renew',
          {
            method: 'OPTIONS',
            headers: {
              origin: scope.browserOrigin,
              'access-control-request-method': 'POST',
              'access-control-request-headers':
                'Authorization, Content-Type, X-Broker-Credential-Id',
            },
          },
        );
        expect(appPreflight.status).toBe(401);
        expect(connectorPreflight.status).toBe(401);
        expect(renewalPreflight.status).toBe(401);

        service.revokeNativeClientGrant(
          scope,
          issued.routing,
          grant.credential.id,
        );
        expect(await operator.nativeOffers(client.surface, signal)).toEqual([]);
        const staleNativeClient = new SelfHostedBrokerNativeClient(
          grant,
          (claims) => signNativeRequest(claims, client),
          request,
          () => 1_000,
        );
        await expect(
          staleNativeClient.read('nonce-native-signaling', signal),
        ).rejects.toThrow('broker_request_refused_401');
        expect(await native.retire(signal)).toEqual({
          version: 'station-broker-native-grant-retire/v2',
          retired: true,
        });
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('native grant renewal is proof-bound, idempotent across expiry and generation-safe', async () => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-broker-native-renewal-'),
      );
      const path = join(root, 'broker.sqlite');
      let now = 1_000;
      const service = new SelfHostedBrokerService(path, () => now);
      try {
        const issued = service.provision(scope, 15 * 24 * 60 * 60_000);
        const native = await createNativeClient();
        const invitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: native.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const grant = await service.redeemNativeInvitation(
          invitation,
          await createNativeProof(invitation, native),
        );
        const app = new Hono();
        app.route('/broker/v1', createSelfHostedBrokerRoutes(service));
        const bearerOnlyRetire = await app.request(
          '/broker/v1/native/grants/retire',
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${grant.credential.secret}`,
              'x-broker-credential-id': grant.credential.id,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              version: 'station-broker-native-grant-retire/v2',
              scope: grant.scope,
              surface: grant.surface,
            }),
          },
        );
        expect(bearerOnlyRetire.status).toBe(401);
        const renewalRequests: {
          input: Request | string | URL;
          init?: RequestInit;
        }[] = [];
        const directRequest: typeof fetch = async (input, init) => {
          renewalRequests.push({ input, init });
          return app.fetch(new Request(input, init));
        };
        const signer = (claims: SelfHostedBrokerNativeRequestProofClaimsV1) =>
          signNativeRequest(claims, native);
        const early = new SelfHostedBrokerNativeClient(
          grant,
          signer,
          directRequest,
          () => now,
        );
        await expect(
          early.renew('renewal-too-early-01', new AbortController().signal),
        ).rejects.toBeInstanceOf(BrokerNativeGrantRenewalConflictError);

        now = grant.expiresAt - 12 * 60 * 60_000;
        const faultDatabase = new DatabaseSync(path);
        faultDatabase.exec(`CREATE TRIGGER reject_native_renewal_receipt
          BEFORE INSERT ON broker_native_grant_renewals
          BEGIN SELECT RAISE(ABORT, 'injected renewal receipt failure'); END;`);
        faultDatabase.close();
        const faultClient = new SelfHostedBrokerNativeClient(
          grant,
          signer,
          directRequest,
          () => now,
        );
        const faultRenewalId = 'renewal-storage-fault-01';
        await expect(
          faultClient.renew(faultRenewalId, new AbortController().signal),
        ).rejects.toThrow('broker_request_transient');
        const afterInsertFailure = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            afterInsertFailure
              .prepare(
                'SELECT expires_at FROM broker_native_client_grants WHERE grant_id=?',
              )
              .get(grant.credential.id) as { expires_at: number }
          ).expires_at,
        ).toBe(grant.expiresAt);
        expect(
          (
            afterInsertFailure
              .prepare(
                'SELECT count(*) n FROM broker_native_grant_renewals WHERE grant_id=?',
              )
              .get(grant.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        expect(
          (
            afterInsertFailure
              .prepare(
                'SELECT count(*) n FROM broker_native_request_proofs WHERE grant_id=?',
              )
              .get(grant.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        afterInsertFailure.close();
        const clearFault = new DatabaseSync(path);
        clearFault.exec('DROP TRIGGER reject_native_renewal_receipt');
        clearFault.close();
        const firstRenewal = await faultClient.renew(
          faultRenewalId,
          new AbortController().signal,
        );
        const firstExpiry = firstRenewal.expiresAt;

        now = firstExpiry - 12 * 60 * 60_000;
        let dropRenewalResponse = true;
        const dropOnceRequest: typeof fetch = async (input, init) => {
          const response = await app.fetch(new Request(input, init));
          const url = input instanceof Request ? input.url : String(input);
          if (
            dropRenewalResponse &&
            new URL(url).pathname.endsWith('/native/grants/renew')
          ) {
            dropRenewalResponse = false;
            await response.arrayBuffer();
            throw new TypeError('simulated lost renewal response');
          }
          return response;
        };
        const client = new SelfHostedBrokerNativeClient(
          { ...grant, expiresAt: firstExpiry },
          signer,
          dropOnceRequest,
          () => now,
        );
        const renewalId = 'renewal-lost-reply-01';
        await expect(
          client.renew(renewalId, new AbortController().signal),
        ).rejects.toThrow('broker_request_transient');
        const committedExpiry = now + 24 * 60 * 60_000;
        const afterFirstCommit = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            afterFirstCommit
              .prepare(
                'SELECT expires_at AS expiresAt FROM broker_native_client_grants WHERE grant_id=?',
              )
              .get(grant.credential.id) as { expiresAt: number }
          ).expiresAt,
        ).toBe(committedExpiry);
        afterFirstCommit.close();

        now = committedExpiry + 36 * 60 * 60_000;
        const staleLocalGrant = new SelfHostedBrokerNativeClient(
          { ...grant, expiresAt: now + 60_000 },
          signer,
          directRequest,
          () => now,
        );
        await expect(
          staleLocalGrant.open(
            { nonce: 'nonce-renew-expired', offerSdp: 'expired-offer' },
            new AbortController().signal,
          ),
        ).rejects.toThrow('broker_request_refused_401');
        await expect(
          staleLocalGrant.read(
            'nonce-renew-expired',
            new AbortController().signal,
          ),
        ).rejects.toThrow('broker_request_refused_401');

        const recovered = await client.renew(
          renewalId,
          new AbortController().signal,
        );
        expect(recovered).toEqual({
          version: 'station-broker-native-grant-renewed/v2',
          renewalId,
          expiresAt: committedExpiry,
        });
        await expect(
          client.open(
            { nonce: 'nonce-renew-expired-client', offerSdp: 'offer' },
            new AbortController().signal,
          ),
        ).rejects.toThrow('broker_native_grant_expired');
        await expect(
          client.renew(renewalId, new AbortController().signal),
        ).rejects.toMatchObject({
          currentExpiresAt: committedExpiry,
        });
        const changedIntentRequest = renewalRequests.at(-1)!;
        const wrongBearerHeaders = new Headers(
          changedIntentRequest.init?.headers,
        );
        wrongBearerHeaders.set('authorization', `Bearer ${'Z'.repeat(43)}`);
        const unauthenticatedConflict = await app.request(
          changedIntentRequest.input,
          {
            ...changedIntentRequest.init,
            headers: wrongBearerHeaders,
          },
        );
        expect(unauthenticatedConflict.status).toBe(401);
        expect(await unauthenticatedConflict.json()).toEqual({
          error: 'broker_credential_refused',
        });

        const nextRenewalId = 'renewal-after-grace-start-01';
        const next = await client.renew(
          nextRenewalId,
          new AbortController().signal,
        );
        expect(next.expiresAt).toBe(now + 24 * 60 * 60_000);
        service.revokeNativeClientGrant(
          scope,
          issued.routing,
          grant.credential.id,
        );
        await expect(
          client.renew(nextRenewalId, new AbortController().signal),
        ).rejects.toThrow('broker_request_refused_401');

        const replacement = await createNativeClient();
        const replacementInvitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: replacement.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const replacementGrant = await service.redeemNativeInvitation(
          replacementInvitation,
          await createNativeProof(replacementInvitation, replacement),
        );
        const replacementClient = new SelfHostedBrokerNativeClient(
          replacementGrant,
          (claims) => signNativeRequest(claims, replacement),
          directRequest,
          () => now,
        );
        now = replacementGrant.expiresAt - 12 * 60 * 60_000;
        await replacementClient.renew(
          'renewal-stale-generation-01',
          new AbortController().signal,
        );
        const replacementScope = {
          ...scope,
          routingGeneration: scope.routingGeneration + 1,
        };
        const nextLease = service.provision(
          replacementScope,
          15 * 24 * 60 * 60_000,
        );
        const afterGenerationReplace = new DatabaseSync(path, {
          readOnly: true,
        });
        expect(
          (
            afterGenerationReplace
              .prepare(
                'SELECT count(*) n FROM broker_native_grant_renewals WHERE grant_id=?',
              )
              .get(replacementGrant.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        expect(
          (
            afterGenerationReplace
              .prepare(
                'SELECT count(*) n FROM broker_native_request_proofs WHERE grant_id=?',
              )
              .get(replacementGrant.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        afterGenerationReplace.close();
        await expect(
          replacementClient.renew(
            'renewal-stale-generation-01',
            new AbortController().signal,
          ),
        ).rejects.toThrow('broker_request_refused_401');

        const withdrawn = await createNativeClient();
        const withdrawnInvitation = service.issueNativeInvitation({
          scope: replacementScope,
          routingCredential: nextLease.routing,
          brokerOrigin: 'https://broker.example',
          surface: withdrawn.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const withdrawnGrant = await service.redeemNativeInvitation(
          withdrawnInvitation,
          await createNativeProof(withdrawnInvitation, withdrawn),
        );
        const withdrawnClient = new SelfHostedBrokerNativeClient(
          withdrawnGrant,
          (claims) => signNativeRequest(claims, withdrawn),
          directRequest,
          () => now,
        );
        now = withdrawnGrant.expiresAt - 12 * 60 * 60_000;
        await withdrawnClient.renew(
          'renewal-withdrawn-lease-01',
          new AbortController().signal,
        );
        service.withdraw(replacementScope, nextLease.connector);
        await expect(
          withdrawnClient.renew(
            'renewal-withdrawn-lease-01',
            new AbortController().signal,
          ),
        ).rejects.toThrow('broker_request_refused_401');
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('native renewal receipt storage is bounded per grant over the HTTP route', async () => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-broker-native-renewal-limit-'),
      );
      const path = join(root, 'broker.sqlite');
      let now = 1_000;
      const service = new SelfHostedBrokerService(path, () => now);
      try {
        const issued = service.provision(scope, 15 * 24 * 60 * 60_000);
        const native = await createNativeClient();
        const invitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: native.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const grant = await service.redeemNativeInvitation(
          invitation,
          await createNativeProof(invitation, native),
        );
        const app = new Hono();
        app.route('/broker/v1', createSelfHostedBrokerRoutes(service));
        const request: typeof fetch = async (input, init) =>
          app.fetch(new Request(input, init));
        const client = new SelfHostedBrokerNativeClient(
          grant,
          (claims) => signNativeRequest(claims, native),
          request,
          () => now,
        );
        const database = new DatabaseSync(path);
        const insert = database.prepare(
          `INSERT INTO broker_native_grant_renewals
           (grant_id,renewal_id,expected_expires_at,request_digest,
            result_expires_at,receipt_expires_at)
           VALUES(?,?,?,?,?,?)`,
        );
        for (let index = 0; index < 16; index++) {
          const resultExpiry = grant.expiresAt + 24 * 60 * 60_000;
          insert.run(
            grant.credential.id,
            `renewal-capacity-${index.toString().padStart(2, '0')}`,
            grant.expiresAt,
            'D'.repeat(43),
            resultExpiry,
            resultExpiry + 7 * 24 * 60 * 60_000,
          );
        }
        database.close();
        now = grant.expiresAt - 12 * 60 * 60_000;
        await expect(
          client.renew(
            'renewal-capacity-overflow-01',
            new AbortController().signal,
          ),
        ).rejects.toThrow('broker_request_transient');
        const afterRefusal = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            afterRefusal
              .prepare(
                'SELECT count(*) n FROM broker_native_grant_renewals WHERE grant_id=?',
              )
              .get(grant.credential.id) as { n: number }
          ).n,
        ).toBe(16);
        expect(
          (
            afterRefusal
              .prepare(
                'SELECT count(*) n FROM broker_native_request_proofs WHERE grant_id=?',
              )
              .get(grant.credential.id) as { n: number }
          ).n,
        ).toBe(0);
        afterRefusal.close();
        await expect(
          client.renew('short', new AbortController().signal),
        ).rejects.toThrow('broker_request_invalid');
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('native grant defaults to and is capped at 24 hours while browser v1 stays at 30 days', async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-native-ttl-'));
      const path = join(root, 'broker.sqlite');
      const maxNativeGrantAgeMs = 24 * 60 * 60_000;
      let now = 1_000;
      let service = new SelfHostedBrokerService(path, () => now);
      try {
        const issued = service.provision(scope, maxNativeGrantAgeMs * 2);
        const client = await createNativeClient();
        const nativeIssue = {
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        };
        expect(() =>
          service.issueNativeInvitation({
            ...nativeIssue,
            grantTtlMs: maxNativeGrantAgeMs + 1,
          }),
        ).toThrow('invalid_invitation_lifetime');
        const nativeInvitation = service.issueNativeInvitation(nativeIssue);
        const nativeGrant = await service.redeemNativeInvitation(
          nativeInvitation,
          await createNativeProof(nativeInvitation, client),
        );
        expect(nativeGrant.expiresAt - now).toBe(maxNativeGrantAgeMs);

        const browserInvitation = service.issueInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          clientOrigin: scope.browserOrigin,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const browserGrant = service.redeemInvitation(
          browserInvitation,
          scope.browserOrigin,
        );
        expect(browserGrant.expiresAt - now).toBe(30 * 24 * 60 * 60_000);

        service.close();
        service = new SelfHostedBrokerService(path, () => now);
        expect(
          service.listNativeClientGrants(scope, issued.routing),
        ).toMatchObject([
          {
            grantId: nativeGrant.credential.id,
            expiresAt: nativeGrant.expiresAt,
          },
        ]);
        service.revokeNativeClientGrant(
          scope,
          issued.routing,
          nativeGrant.credential.id,
        );
        expect(
          service.listNativeClientGrants(scope, issued.routing),
        ).toMatchObject([
          { grantId: nativeGrant.credential.id, revokedAt: now },
        ]);

        const expiringClient = await createNativeClient();
        const expiringInvitation = service.issueNativeInvitation({
          ...nativeIssue,
          surface: expiringClient.surface,
        });
        const expiringGrant = await service.redeemNativeInvitation(
          expiringInvitation,
          await createNativeProof(expiringInvitation, expiringClient),
        );
        now = expiringGrant.expiresAt + 1;
        expect(() =>
          service.readNativeConnection(
            nativeScope,
            expiringGrant.credential,
            expiringClient.surface,
            'nonce-native-expired',
          ),
        ).toThrow('broker_credential_refused');
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('read-only access scrubs expired native offer and answer bytes durably', async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-native-scrub-'));
      const path = join(root, 'broker.sqlite');
      let now = 1_000;
      let service = new SelfHostedBrokerService(path, () => now);
      try {
        const issued = service.provision(scope, 60_000);
        const client = await createNativeClient();
        const invitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
          grantTtlMs: 40_000,
        });
        const grant = await service.redeemNativeInvitation(
          invitation,
          await createNativeProof(invitation, client),
        );
        service.openNativeConnection(
          nativeScope,
          grant.credential,
          client.surface,
          {
            version: 'station-broker-native-connection-open/v2',
            nonce: 'nonce-native-read-scrub',
            offerSdp: 'sensitive-native-offer',
          },
        );
        service.answerNativeConnection(scope, issued.connector, {
          version: 'station-broker-native-connection-answer/v2',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
          clientId: client.surface.clientInstanceId,
          nonce: 'nonce-native-read-scrub',
          answerSdp: 'sensitive-native-answer',
          stationProof: 'sensitive-native-station-proof',
        });
        now = 31_001;
        expect(() =>
          service.readNativeConnection(
            nativeScope,
            grant.credential,
            client.surface,
            'nonce-native-read-scrub',
          ),
        ).toThrow('connection_unavailable');
        const beforeRestart = new DatabaseSync(path, { readOnly: true });
        expect(
          beforeRestart
            .prepare(
              'SELECT offer_sdp,answer_sdp,station_proof FROM broker_native_connections WHERE nonce=?',
            )
            .get('nonce-native-read-scrub'),
        ).toEqual({ offer_sdp: '', answer_sdp: null, station_proof: null });
        beforeRestart.close();
        service.close();
        service = new SelfHostedBrokerService(path, () => now);
        const afterRestart = new DatabaseSync(path, { readOnly: true });
        expect(
          afterRestart
            .prepare(
              'SELECT offer_sdp,answer_sdp,station_proof FROM broker_native_connections WHERE nonce=?',
            )
            .get('nonce-native-read-scrub'),
        ).toEqual({ offer_sdp: '', answer_sdp: null, station_proof: null });
        afterRestart.close();
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('idle native expiry sweep scrubs only native rows and stops when broker closes', async () => {
      vi.useFakeTimers();
      const root = mkdtempSync(
        join(tmpdir(), 'station-broker-native-maintenance-'),
      );
      const path = join(root, 'broker.sqlite');
      let now = 1_000;
      let service: SelfHostedBrokerService | undefined;
      try {
        service = new SelfHostedBrokerService(path, () => now);
        const issued = service.provision(scope, 100_000);
        const client = await createNativeClient();
        const invitation = service.issueNativeInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
          grantTtlMs: 90_000,
        });
        const grant = await service.redeemNativeInvitation(
          invitation,
          await createNativeProof(invitation, client),
        );
        service.openNativeConnection(
          nativeScope,
          grant.credential,
          client.surface,
          {
            version: 'station-broker-native-connection-open/v2',
            nonce: 'nonce-native-idle-sweep',
            offerSdp: 'native-expiring-offer',
          },
        );
        service.answerNativeConnection(scope, issued.connector, {
          version: 'station-broker-native-connection-answer/v2',
          surface: client.surface,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
          clientId: client.surface.clientInstanceId,
          nonce: 'nonce-native-idle-sweep',
          answerSdp: 'native-expiring-answer',
          stationProof: 'native-expiring-proof',
        });
        service.open(scope, issued.routing, {
          clientId: 'client-browser-idle',
          nonce: 'nonce-browser-idle',
          offerSdp: 'browser-v1-offer',
        });
        expect(vi.getTimerCount()).toBe(1);
        now = 31_001;
        await vi.advanceTimersByTimeAsync(10_000);
        const snapshot = new DatabaseSync(path, { readOnly: true });
        expect(
          snapshot
            .prepare(
              'SELECT offer_sdp,answer_sdp,station_proof,created_at,expires_at FROM broker_native_connections WHERE nonce=?',
            )
            .get('nonce-native-idle-sweep'),
        ).toEqual({
          offer_sdp: '',
          answer_sdp: null,
          station_proof: null,
          created_at: 1_000,
          expires_at: 31_000,
        });
        expect(
          snapshot
            .prepare(
              'SELECT offer_sdp,answer_sdp,station_proof FROM broker_connections WHERE nonce=?',
            )
            .get('nonce-browser-idle'),
        ).toEqual({
          offer_sdp: 'browser-v1-offer',
          answer_sdp: null,
          station_proof: null,
        });
        snapshot.close();
        await vi.advanceTimersByTimeAsync(10_000);
        const repeatedSweep = new DatabaseSync(path, { readOnly: true });
        expect(
          repeatedSweep
            .prepare(
              'SELECT offer_sdp,answer_sdp,station_proof,created_at,expires_at FROM broker_native_connections WHERE nonce=?',
            )
            .get('nonce-native-idle-sweep'),
        ).toEqual({
          offer_sdp: '',
          answer_sdp: null,
          station_proof: null,
          created_at: 1_000,
          expires_at: 31_000,
        });
        repeatedSweep.close();
        now = 331_001;
        await vi.advanceTimersByTimeAsync(10_000);
        const afterTombstoneWindow = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            afterTombstoneWindow
              .prepare('SELECT count(*) n FROM broker_native_connections')
              .get() as { n: number }
          ).n,
        ).toBe(0);
        expect(
          afterTombstoneWindow
            .prepare(
              'SELECT offer_sdp,answer_sdp,station_proof FROM broker_connections WHERE nonce=?',
            )
            .get('nonce-browser-idle'),
        ).toEqual({
          offer_sdp: 'browser-v1-offer',
          answer_sdp: null,
          station_proof: null,
        });
        afterTombstoneWindow.close();
        service.close();
        service = undefined;
        expect(vi.getTimerCount()).toBe(0);
        now += 20_000;
        await vi.advanceTimersByTimeAsync(20_000);
      } finally {
        service?.close();
        vi.useRealTimers();
        rmSync(root, { recursive: true, force: true });
      }
    });
    test('expired grants retire pending offers and generation replacement retires old grants', () => {
      const root = mkdtempSync(join(tmpdir(), 'station-broker-grant-expiry-'));
      const path = join(root, 'broker.sqlite');
      let now = 1_000;
      const service = new SelfHostedBrokerService(path, () => now);
      try {
        const issued = service.provision(scope, 600_000);
        const invitation = service.issueInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          clientOrigin: scope.browserOrigin,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
          grantTtlMs: 100,
        });
        const grant = service.redeemInvitation(invitation, scope.browserOrigin);
        service.open(scope, grant.credential, {
          clientId: 'client-expire123',
          nonce: 'nonce-expire123',
          offerSdp: 'offer',
        });
        now += 101;
        expect(() => service.status(scope, grant.credential)).toThrow(
          'broker_credential_refused',
        );
        expect(service.offers(scope, issued.connector)).toHaveLength(0);
        const replacementInvitation = service.issueInvitation({
          scope,
          routingCredential: issued.routing,
          brokerOrigin: 'https://broker.example',
          clientOrigin: scope.browserOrigin,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 1,
        });
        const replacement = service.redeemInvitation(
          replacementInvitation,
          scope.browserOrigin,
        );
        expect(() =>
          service.open(scope, replacement.credential, {
            clientId: 'client-expire123',
            nonce: 'nonce-expire123',
            offerSdp: 'new-offer',
          }),
        ).toThrow('connection_replayed');
        expect(() =>
          service.read(
            scope,
            grant.credential,
            'client-expire123',
            'nonce-expire123',
          ),
        ).toThrow('broker_credential_refused');
        const nextScope = { ...scope, routingGeneration: 2 };
        service.provision(nextScope, 600_000);
        expect(() =>
          service.listClientGrants(nextScope, issued.routing),
        ).toThrow('broker_credential_refused');
        const oldRows = new DatabaseSync(path, { readOnly: true });
        expect(
          (
            oldRows
              .prepare('SELECT count(*) n FROM broker_client_grants')
              .get() as {
              n: number;
            }
          ).n,
        ).toBe(0);
        oldRows.close();
      } finally {
        service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
