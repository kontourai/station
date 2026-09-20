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
  generation: 1,
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
    ).toBe(200);
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
    now = 30_001;
    expect(() =>
      first.read(scope, issued.routing, 'client-abcdefgh', 'nonce-abcdefgh'),
    ).toThrow('broker_credential_refused');
    now = 20_000;
    const nextScope = { ...scope, generation: 2 };
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
    first.close();
  });
});
