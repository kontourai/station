import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HttpBindings, serve } from '@hono/node-server';
import {
  CLIENT_PROTOCOL_HEADER,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { createPeerCredentialRoutes } from '../../../routes/environments/peer-credential-routes.js';
import {
  configureDevicePairingHostRoutes,
  configureDevicePairingPublicRoutes,
} from '../../../runtime/routes/runtime-routes.js';
import { GRANTED_PAIRING_SCOPE_VAR } from '../../../security/pairing-route-scopes.js';
import { DevicePairingService } from '../../ssh/device-pairing-service.js';
import { HOST_STATION_COMPATIBILITY } from '../../ssh/environment-security-service.js';
import {
  PeerCredentialStore,
  type PeerCredentialStoreOptions,
} from '../peer-credential-store.js';
import { PeerEnrollmentService } from '../peer-enrollment-service.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function stations(storeOptions?: PeerCredentialStoreOptions) {
  const localHome = mkdtempSync(join(tmpdir(), 'station-peer-local-'));
  const remoteHome = mkdtempSync(join(tmpdir(), 'station-peer-receiver-'));
  cleanups.push(() => {
    rmSync(localHome, { recursive: true, force: true });
    rmSync(remoteHome, { recursive: true, force: true });
  });
  mkdirSync(join(remoteHome, 'security'), { mode: 0o700 });
  const environmentId = randomUUID();
  let receiverNow = Date.now();
  const pairing = new DevicePairingService({
    homeDir: remoteHome,
    environmentId,
    now: () => receiverNow,
  });
  const receiver = new Hono<{
    Bindings: HttpBindings;
    Variables: { stationGrantedPairingScope: string };
  }>();
  let exchangeMode: 'normal' | 'lost-response' | 'wrong-kind' | 'wrong-scope' =
    'normal';
  let redirectHandshake = false;
  let oversizedProof = false;
  let redirectFollowed = false;
  let exchangeCount = 0;
  const observedProtocols: Array<{
    path: string;
    protocol: string | undefined;
  }> = [];
  receiver.use('*', async (c, next) => {
    if (c.req.path.startsWith('/.well-known/station/v1/pairing/'))
      observedProtocols.push({
        path: c.req.path,
        protocol: c.req.header(CLIENT_PROTOCOL_HEADER),
      });
    if (redirectHandshake && c.req.path === '/.well-known/station/v1')
      return c.redirect('/redirect-target', 302);
    if (c.req.path === '/redirect-target') {
      redirectFollowed = true;
      return c.json({});
    }
    const accessRequest =
      c.req.path === '/.well-known/station/v1/pairing/access-request';
    const exchange = c.req.path === '/.well-known/station/v1/pairing/exchange';
    if (exchange) exchangeCount += 1;
    await next();
    if (accessRequest && oversizedProof && c.res.status === 202) {
      const body = await c.res.json();
      body.proof = '';
      const baseBytes = Buffer.byteLength(JSON.stringify(body));
      body.proof = 'P'.repeat(16_384 - baseBytes - 1);
      c.res = Response.json(body, { status: 202 });
    }
    if (!exchange || exchangeMode === 'normal' || c.res.status !== 200) return;
    if (exchangeMode === 'lost-response') {
      c.res = new Response('truncated', { status: 200 });
      return;
    }
    const body = await c.res.json();
    if (exchangeMode === 'wrong-kind') body.device.kind = 'device';
    if (exchangeMode === 'wrong-scope')
      body.device.scope += ' terminal:operate';
    c.res = Response.json(body);
  });
  receiver.use('/api/pairing/*', async (c, next) => {
    if (c.req.header('authorization') !== 'Bearer operator')
      return c.json({ error: 'Forbidden' }, 403);
    c.set(GRANTED_PAIRING_SCOPE_VAR, 'access:manage');
    await next();
  });
  receiver.get('/.well-known/station/v1', (c) =>
    c.json({
      schemaVersion: 1,
      environmentId,
      authentication: { scheme: 'bearer', protocolVersion: 1 },
      transports: { http: 1, sse: 1, websocket: 1 },
      compatibility: HOST_STATION_COMPATIBILITY,
    }),
  );
  configureDevicePairingPublicRoutes(receiver, pairing);
  configureDevicePairingHostRoutes(receiver, pairing, {
    isRequestPrincipalCurrent: (request) =>
      request.headers.get('authorization') === 'Bearer operator',
    verifyOperatorCredential: (credential) => credential === 'operator',
  });
  const server = serve({
    fetch: receiver.fetch,
    hostname: '127.0.0.1',
    port: 0,
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await new Promise<void>((resolve) =>
    server.listening ? resolve() : server.once('listening', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing receiver port');
  const apiBase = `http://127.0.0.1:${address.port}`;
  const store = new PeerCredentialStore(localHome, storeOptions);
  let authorized = true;
  const service = new PeerEnrollmentService(store, 'Kontour', localHome);
  const local = createPeerCredentialRoutes(
    store,
    undefined,
    () => authorized,
    service,
  );
  const input = { id: randomUUID(), apiBase, environmentId, label: 'Receiver' };
  const start = () => local.request('/enrollments', json(input));
  const complete = () =>
    local.request(`/enrollments/${input.id}/complete`, { method: 'POST' });
  const approve = () =>
    receiver.request(
      `/api/pairing/requests/${pairing.listRequests()[0].requestId}/confirm`,
      { method: 'POST', headers: { authorization: 'Bearer operator' } },
    );
  return {
    local,
    receiver,
    pairing,
    store,
    service,
    localHome,
    input,
    start,
    complete,
    approve,
    setExchangeMode: (mode: typeof exchangeMode) => {
      exchangeMode = mode;
    },
    expireReceiver: () => {
      receiverNow += 20 * 60_000;
    },
    returnOversizedProof: () => {
      oversizedProof = true;
    },
    redirectReceiver: () => {
      redirectHandshake = true;
    },
    redirectWasFollowed: () => redirectFollowed,
    exchangeCount: () => exchangeCount,
    observedProtocols: () => observedProtocols,
    revokeLocal: () => {
      authorized = false;
    },
    restoreLocal: () => {
      authorized = true;
    },
  };
}

describe('server-owned peer enrollment through Station routes', () => {
  test('independent receiver approval publishes a delegation credential without exposing it; exact-id retries reconcile', async () => {
    const h = await stations();
    const started = await h.start();
    expect(started.status).toBe(201);
    const startBody = await started.json();
    expect(startBody.data.status).toBe('pending');
    expect(h.pairing.listRequests()).toMatchObject([
      {
        deviceName: 'Kontour',
        kind: 'delegation',
        scope: 'orchestration:read orchestration:operate',
      },
    ]);
    expect((await (await h.start()).json()).data.id).toBe(h.input.id);
    expect(h.pairing.listRequests()).toHaveLength(1);
    expect((await (await h.complete()).json()).data.status).toBe('pending');
    expect((await h.approve()).status).toBe(200);
    const responses = await Promise.all([h.complete(), h.complete()]);
    for (const response of responses)
      expect((await response.json()).data.status).toBe('connected');
    expect(h.store.list()).toMatchObject([
      {
        environmentId: h.input.environmentId,
        apiBase: h.input.apiBase,
        scope: 'orchestration:read orchestration:operate',
      },
    ]);
    expect(h.observedProtocols()).toEqual(
      expect.arrayContaining([
        {
          path: '/.well-known/station/v1/pairing/access-request',
          protocol: String(STATION_COMPAT_PROTOCOL_VERSION),
        },
        {
          path: '/.well-known/station/v1/pairing/exchange',
          protocol: String(STATION_COMPAT_PROTOCOL_VERSION),
        },
      ]),
    );
    expect(h.pairing.listDevices()).toHaveLength(1);
    const credential = h.store.get(h.input.environmentId)?.credential;
    expect(credential).toBeTruthy();
    expect(h.pairing.verifyCredential(credential!)).toBe(true);
    const cancelledConnected = await h.local.request(
      `/enrollments/${h.input.id}`,
      { method: 'DELETE' },
    );
    expect(cancelledConnected.status).toBe(400);
    expect(h.store.list()).toHaveLength(1);
    expect(h.service.get(h.input.id, () => true).status).toBe('connected');
    const read = await h.local.request(`/enrollments/${h.input.id}`);
    const text = await read.text();
    expect(text).not.toContain(credential!);
    expect(text).not.toContain('proof');
    expect(text).not.toContain('offerId');
    const restarted = new PeerEnrollmentService(
      h.store,
      'Kontour',
      h.localHome,
    );
    expect(restarted.get(h.input.id, () => true).status).toBe('connected');
    expect(
      readFileSync(
        join(h.localHome, 'security', 'peer-enrollments', `${h.input.id}.json`),
        'utf8',
      ),
    ).not.toContain(credential!);
  });

  test('denial remains terminal and never installs a peer', async () => {
    const h = await stations();
    await h.start();
    const requestId = h.pairing.listRequests()[0].requestId;
    const denied = await h.receiver.request(
      `/api/pairing/requests/${requestId}`,
      { method: 'DELETE', headers: { authorization: 'Bearer operator' } },
    );
    expect(denied.status).toBe(200);
    expect((await (await h.complete()).json()).data.status).toBe('denied');
    expect((await (await h.complete()).json()).data.status).toBe('denied');
    expect(h.store.list()).toEqual([]);
  });

  test('local authority refusal performs no enrollment and mismatched identity performs no receiver request', async () => {
    const h = await stations();
    const mismatch = await h.local.request(
      '/enrollments',
      json({ ...h.input, environmentId: randomUUID() }),
    );
    expect((await mismatch.json()).data.status).toBe('identity-changed');
    expect(h.pairing.listRequests()).toEqual([]);
    h.revokeLocal();
    const refused = await h.local.request(
      '/enrollments',
      json({ ...h.input, id: randomUUID() }),
    );
    expect(refused.status).toBe(403);
    expect(h.pairing.listRequests()).toEqual([]);
    expect(h.store.list()).toEqual([]);
  });

  test('lost authority under the publication lock retains the issued grant across restart without another exchange', async () => {
    let revoke: () => void = () => {};
    const h = await stations({
      acquireMutationLock: async () => {
        revoke();
        return () => {};
      },
    });
    revoke = h.revokeLocal;
    await h.start();
    expect((await h.approve()).status).toBe(200);
    expect((await h.complete()).status).toBe(403);
    expect(h.store.list()).toEqual([]);
    expect(h.pairing.listDevices()).toHaveLength(1);
    const restartedStore = new PeerCredentialStore(h.localHome);
    const restarted = new PeerEnrollmentService(
      restartedStore,
      'Kontour',
      h.localHome,
    );
    expect(restarted.get(h.input.id, () => true).status).toBe(
      'persistence-failed',
    );
    expect((await restarted.complete(h.input.id, () => true)).status).toBe(
      'connected',
    );
    expect(h.pairing.listDevices()).toHaveLength(1);
    expect(
      h.pairing.verifyCredential(
        restartedStore.get(h.input.environmentId)!.credential,
      ),
    ).toBe(true);
  });

  test('lost exchange response is retained as unknown across restart and never exchanges again', async () => {
    const h = await stations();
    await h.start();
    await h.approve();
    h.setExchangeMode('lost-response');
    expect((await (await h.complete()).json()).data.status).toBe(
      'outcome-unknown',
    );
    expect(h.pairing.listDevices()).toHaveLength(1);
    const attempts = h.exchangeCount();
    const restarted = new PeerEnrollmentService(
      h.store,
      'Kontour',
      h.localHome,
    );
    expect((await restarted.complete(h.input.id, () => true)).status).toBe(
      'outcome-unknown',
    );
    expect(h.exchangeCount()).toBe(attempts);
    expect(h.store.list()).toEqual([]);
  });

  test.each(['wrong-kind', 'wrong-scope'] as const)(
    'refuses a receiver exchange with %s instead of the requested grant',
    async (mode) => {
      const h = await stations();
      await h.start();
      await h.approve();
      h.setExchangeMode(mode);
      expect((await (await h.complete()).json()).data.status).toBe('failed');
      expect(h.store.list()).toEqual([]);
    },
  );

  test('remote expiry and local cancellation remain distinct and neither installs a peer', async () => {
    const expired = await stations();
    await expired.start();
    expired.expireReceiver();
    expect((await (await expired.complete()).json()).data.status).toBe(
      'expired',
    );
    expect(expired.store.list()).toEqual([]);
    const cancelled = await stations();
    await cancelled.start();
    const response = await cancelled.local.request(
      `/enrollments/${cancelled.input.id}`,
      { method: 'DELETE' },
    );
    expect((await response.json()).data.status).toBe('cancelled');
    expect((await (await cancelled.complete()).json()).data.status).toBe(
      'cancelled',
    );
    expect(cancelled.pairing.listRequests()).toMatchObject([
      { status: 'pending' },
    ]);
    expect(cancelled.store.list()).toEqual([]);
  });

  test('does not follow a receiver redirect to a different route or start an access request', async () => {
    const h = await stations();
    h.redirectReceiver();
    expect((await (await h.start()).json()).data.status).toBe(
      'outcome-unknown',
    );
    expect(h.redirectWasFollowed()).toBe(false);
    expect(h.pairing.listRequests()).toEqual([]);
  });

  test('a near-limit malicious proof is rejected without creating an unreadable private record', async () => {
    const h = await stations();
    h.returnOversizedProof();
    expect((await (await h.start()).json()).data.status).toBe('failed');
    expect(h.pairing.listRequests()).toHaveLength(1);
    const raw = readFileSync(
      join(h.localHome, 'security', 'peer-enrollments', `${h.input.id}.json`),
      'utf8',
    );
    expect(Buffer.byteLength(raw)).toBeLessThan(16_384);
    const restarted = new PeerEnrollmentService(
      h.store,
      'Kontour',
      h.localHome,
    );
    expect(restarted.get(h.input.id, () => true).status).toBe('failed');
    expect((await restarted.complete(h.input.id, () => true)).status).toBe(
      'failed',
    );
    expect(h.exchangeCount()).toBe(0);
  });

  test('independent owners loading one pending record serialize the single-use remote exchange and observe terminal state', async () => {
    const h = await stations();
    await h.start();
    const other = new PeerEnrollmentService(
      new PeerCredentialStore(h.localHome),
      'Kontour',
      h.localHome,
    );
    await h.approve();
    const before = h.exchangeCount();
    const results = await Promise.all([
      h.service.complete(h.input.id, () => true),
      other.complete(h.input.id, () => true),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'connected',
      'connected',
    ]);
    expect(h.exchangeCount()).toBe(before + 1);
    expect(h.pairing.listDevices()).toHaveLength(1);
    await expect(other.cancel(h.input.id, () => true)).rejects.toThrow(
      'Remove the saved peer connection',
    );
    expect(h.service.get(h.input.id, () => true).status).toBe('connected');
    expect(h.store.list()).toHaveLength(1);
  });

  test('independent owners reserve the final capacity slot from current durable inventory', async () => {
    const h = await stations();
    for (let index = 0; index < 31; index += 1) {
      expect(
        (
          await h.service.start(
            { ...h.input, id: randomUUID(), environmentId: randomUUID() },
            () => true,
          )
        ).status,
      ).toBe('identity-changed');
    }
    const other = new PeerEnrollmentService(
      new PeerCredentialStore(h.localHome),
      'Kontour',
      h.localHome,
    );
    const intents = [
      { ...h.input, id: randomUUID() },
      { ...h.input, id: randomUUID() },
    ];
    const reserved = await Promise.allSettled([
      h.service.start(intents[0], () => true),
      other.start(intents[1], () => true),
    ]);
    expect(
      reserved.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      reserved.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(h.pairing.listRequests()).toHaveLength(1);
    const restarted = new PeerEnrollmentService(
      h.store,
      'Kontour',
      h.localHome,
    );
    const accepted = reserved.find((result) => result.status === 'fulfilled');
    if (accepted?.status !== 'fulfilled')
      throw new Error('Missing successful reservation');
    expect(restarted.get(accepted.value.id, () => true).status).toBe('pending');
  });

  test('completion and cancellation from independent owners preserve one durable outcome', async () => {
    const h = await stations();
    await h.start();
    const other = new PeerEnrollmentService(
      new PeerCredentialStore(h.localHome),
      'Kontour',
      h.localHome,
    );
    await h.approve();
    const [completion, cancellation] = await Promise.allSettled([
      h.service.complete(h.input.id, () => true),
      other.cancel(h.input.id, () => true),
    ]);
    expect(completion.status).toBe('fulfilled');
    const final = h.service.get(h.input.id, () => true);
    if (final.status === 'connected') {
      expect(cancellation.status).toBe('rejected');
      expect(h.store.list()).toHaveLength(1);
      expect(h.exchangeCount()).toBe(1);
    } else {
      expect(final.status).toBe('cancelled');
      expect(cancellation.status).toBe('fulfilled');
      expect(h.store.list()).toEqual([]);
      expect(h.exchangeCount()).toBe(0);
    }
    if (completion.status === 'fulfilled')
      expect(completion.value.status).toBe(final.status);
  });

  test('a reserved id cannot change destination and public HTTP is refused before contacting it', async () => {
    const h = await stations();
    await h.start();
    const changed = await h.local.request(
      '/enrollments',
      json({ ...h.input, environmentId: randomUUID() }),
    );
    expect(changed.status).toBe(400);
    const insecure = await h.local.request(
      '/enrollments',
      json({
        ...h.input,
        id: randomUUID(),
        apiBase: 'http://10.attacker.example',
      }),
    );
    expect(insecure.status).toBe(400);
    expect(h.pairing.listRequests()).toHaveLength(1);
  });
});
