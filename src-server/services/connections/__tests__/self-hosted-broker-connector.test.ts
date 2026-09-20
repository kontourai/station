import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSelfHostedBrokerRoutes } from '../../../routes/connections/self-hosted-broker.js';
import { SelfHostedBrokerClient } from '../self-hosted-broker-client.js';
import { SelfHostedBrokerConnector } from '../self-hosted-broker-connector.js';
import { SelfHostedBrokerService } from '../self-hosted-broker-service.js';

const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});
const scope = {
  stationId: 'station-12345678',
  enrollmentId: 'enroll-12345678',
  routingGeneration: 1,
  browserOrigin: 'https://client.example',
};
const descriptor: ApprovedStationConnectionTrust = {
  stationId: scope.stationId,
  enrollmentId: scope.enrollmentId,
  generation: 7,
  signingKey: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-broker-connector-'));
  roots.add(root);
  const service = new SelfHostedBrokerService(
    join(root, 'broker.sqlite'),
    () => 1_000,
  );
  const credentials = service.provision(scope, 600_000);
  const app = new Hono();
  app.route('/broker/v1', createSelfHostedBrokerRoutes(service));
  const request: typeof fetch = async (input, init) =>
    await app.fetch(new Request(input, init));
  return { service, credentials, request };
}

describe.runIf(process.platform !== 'win32')(
  'self-hosted broker connector',
  () => {
    test('registers, polls and answers through the real durable broker without conflating routing and signing generations', async () => {
      const f = fixture();
      try {
        f.service.open(scope, f.credentials.routing, {
          clientId: 'client-12345678',
          nonce: 'nonce-12345678',
          offerSdp: 'offer',
        });
        f.service.open(scope, f.credentials.routing, {
          clientId: 'client-second12',
          nonce: 'nonce-second12',
          offerSdp: 'offer-two',
        });
        let current = true;
        const answer = vi.fn(async () => ({
          answerSdp: 'answer',
          stationProof: 'opaque-proof',
        }));
        const connector = new SelfHostedBrokerConnector(
          scope,
          new SelfHostedBrokerClient(
            'https://broker.example',
            scope,
            f.credentials.connector,
            f.request,
            () => 1_000,
          ),
          { current: () => descriptor, isCurrent: () => current },
          answer,
        );
        const signal = new AbortController().signal;
        await connector.register(signal);
        expect((await connector.renew(signal)).revision).toBe(1);
        expect(await connector.poll(signal)).toEqual({
          observed: 2,
          answered: 2,
        });
        expect(answer).toHaveBeenCalledWith(
          expect.objectContaining({ offerSdp: 'offer' }),
          descriptor,
          signal,
        );
        expect(
          f.service.read(
            scope,
            f.credentials.routing,
            'client-12345678',
            'nonce-12345678',
          ),
        ).toMatchObject({ answerSdp: 'answer', stationProof: 'opaque-proof' });
        current = false;
        await expect(connector.poll(signal)).rejects.toThrow(
          'broker_connector_trust_retired',
        );
        current = true;
        const restarted = new SelfHostedBrokerConnector(
          scope,
          new SelfHostedBrokerClient(
            'https://broker.example',
            scope,
            f.credentials.connector,
            f.request,
            () => 1_000,
          ),
          { current: () => descriptor, isCurrent: () => true },
          answer,
        );
        expect((await restarted.register(signal)).revision).toBe(1);
        expect((await restarted.renew(signal)).revision).toBe(2);
        await connector.withdraw(signal);
        expect(() => f.service.status(scope, f.credentials.routing)).toThrow(
          'broker_credential_refused',
        );
        await expect(connector.renew(signal)).rejects.toThrow(
          'broker_connector_withdrawn',
        );
        await expect(connector.register(signal)).rejects.toThrow(
          'broker_connector_withdrawn',
        );
      } finally {
        f.service.close();
      }
    });
    test('requires current Station and enrollment trust before reading offers', async () => {
      const f = fixture();
      try {
        const connector = new SelfHostedBrokerConnector(
          scope,
          new SelfHostedBrokerClient(
            'https://broker.example',
            scope,
            f.credentials.connector,
            f.request,
            () => 1_000,
          ),
          {
            current: () => ({ ...descriptor, stationId: 'station-other123' }),
            isCurrent: () => true,
          },
          vi.fn(),
        );
        await connector.register(new AbortController().signal);
        await expect(
          connector.poll(new AbortController().signal),
        ).rejects.toThrow('broker_connector_trust_unavailable');
      } finally {
        f.service.close();
      }
    });
    test('the fixed endpoint client refuses redirects, malformed and oversized responses', async () => {
      const credential = { id: 'credential-12345678', secret: 's'.repeat(43) };
      const signal = new AbortController().signal;
      for (const response of [
        new Response('not-json', { status: 200 }),
        new Response(JSON.stringify({ registeredAt: 1 }), {
          status: 302,
          headers: { Location: 'https://other.example' },
        }),
        new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }),
      ]) {
        const client = new SelfHostedBrokerClient(
          'https://broker.example',
          scope,
          credential,
          async () => response,
        );
        await expect(client.register(signal)).rejects.toThrow();
      }
    });
    test('disposes provisional answer resources when publication fails', async () => {
      const f = fixture();
      try {
        f.service.open(scope, f.credentials.routing, {
          clientId: 'client-dispose1',
          nonce: 'nonce-dispose1',
          offerSdp: 'offer',
        });
        const dispose = vi.fn();
        const connector = new SelfHostedBrokerConnector(
          scope,
          new SelfHostedBrokerClient(
            'https://broker.example',
            scope,
            f.credentials.connector,
            f.request,
            () => 1_000,
          ),
          { current: () => descriptor, isCurrent: () => true },
          async () => {
            f.service.withdraw(scope, f.credentials.connector);
            return { answerSdp: 'answer', stationProof: 'proof', dispose };
          },
        );
        const signal = new AbortController().signal;
        await connector.register(signal);
        await expect(connector.poll(signal)).rejects.toThrow(
          'broker_request_refused_401',
        );
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        f.service.close();
      }
    });
  },
);
