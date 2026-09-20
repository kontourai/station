import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createSelfHostedBrokerRoutes } from '../../../routes/connections/self-hosted-broker.js';
import { SelfHostedBrokerService } from '../self-hosted-broker-service.js';

const scope = {
  stationId: 'station-12345678',
  enrollmentId: 'enroll-12345678',
  routingGeneration: 1,
  browserOrigin: 'https://client.example',
};
describe('self-hosted broker control plane', () => {
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
    const post = (route: string, credential: any, body: any) =>
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
    expect(opened.headers.has('access-control-allow-credentials')).toBe(false);
    expect(
      (await post('/connections/offers', provisioned.connector, { scope }))
        .status,
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
      expiresAt: 30_000,
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
});
