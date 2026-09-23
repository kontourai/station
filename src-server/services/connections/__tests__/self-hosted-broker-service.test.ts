import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createSelfHostedBrokerRoutes } from '../../../routes/connections/self-hosted-broker.js';
import {
  assertSelfHostedBrokerPlatform,
  SelfHostedBrokerService,
} from '../self-hosted-broker-service.js';

const scope = {
  stationId: 'station-12345678',
  enrollmentId: 'enroll-12345678',
  routingGeneration: 1,
  browserOrigin: 'https://client.example',
};
test('fails closed where private path custody is not implemented', () => {
  expect(() => assertSelfHostedBrokerPlatform('win32')).toThrow(
    'self_hosted_broker_private_custody_unavailable_on_windows',
  );
});
describe.runIf(process.platform !== 'win32')(
  'self-hosted broker control plane',
  () => {
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
      database.exec('PRAGMA user_version=3');
      database.close();
      chmodSync(path, 0o600);
      expect(() => new SelfHostedBrokerService(path)).toThrow(
        'broker_database_version_refused',
      );
    });
    test('refuses a version-two database missing its grant-owner table', () => {
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
        ).toBe(2);
        expect(
          (
            upgraded
              .prepare(
                "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('broker_route_invitations','broker_client_grants','broker_connection_owners')",
              )
              .get() as { n: number }
          ).n,
        ).toBe(3);
        upgraded.close();
      } finally {
        service?.close();
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
