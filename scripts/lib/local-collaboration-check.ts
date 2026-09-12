import assert from 'node:assert/strict';
import { randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import {
  type DevicePairingBearerExchangeResponse,
  type DevicePairingOffer,
  PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
  PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { startLocalSecurityEndpoint } from './local-collaboration-endpoint.js';
import {
  runLabCommand,
  startLabRelay,
} from './local-collaboration-process.mjs';

type Endpoint = Awaited<ReturnType<typeof startLocalSecurityEndpoint>>;

function client(endpoint: Endpoint, port: number) {
  return async function send<T>(
    path: string,
    options: {
      method?: string;
      credential?: string;
      body?: unknown;
    } = {},
  ): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          servername: 'localhost',
          path,
          ca: endpoint.cert,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
          maxVersion: 'TLSv1.3',
          agent: false,
          method: options.method ?? 'GET',
          headers: {
            ...(options.credential
              ? { Authorization: `Bearer ${options.credential}` }
              : {}),
            ...(options.body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
        },
        (res) => {
          const tls = res.socket as TLSSocket;
          try {
            assert.equal(tls.authorized, true);
            assert.equal(tls.getProtocol(), 'TLSv1.3');
            assert.equal(
              tls.getPeerCertificate().fingerprint256,
              new X509Certificate(endpoint.cert).fingerprint256,
            );
          } catch (error) {
            res.destroy();
            reject(error);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 128 * 1024)
              res.destroy(new Error('Lab response exceeded bound'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () =>
        req.destroy(new Error('Lab HTTPS request timed out')),
      );
      req.end(
        options.body === undefined ? undefined : JSON.stringify(options.body),
      );
    });
  };
}

async function certificate(home: string) {
  mkdirSync(home, { mode: 0o700 });
  await runLabCommand(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      join(home, 'tls.key'),
      '-out',
      join(home, 'tls.crt'),
    ],
    home,
  );
  chmodSync(join(home, 'tls.key'), 0o600);
}

async function enroll(
  endpoint: Endpoint,
  send: ReturnType<typeof client>,
  name: string,
  person?: string,
) {
  const offer = await send<DevicePairingOffer>('/api/pairing/offers', {
    method: 'POST',
    credential: endpoint.operatorCredential,
    body: {
      endpoint: `https://localhost:${endpoint.port}`,
      scope: pairingScopePresetString('read-only'),
    },
  });
  assert.equal(offer.status, 201, 'operator creates offer');
  const proof = { offerId: offer.body.offerId, proof: offer.body.challenge };
  // Deliberate fixture seam: synthetic verified-identity provenance enters the
  // real store privately. It is not a production HTTP trust header or WhoIs test.
  const pending = person
    ? endpoint.security.devicePairing.requestPairing({
        ...proof,
        deviceName: name,
        requesterPosition: 'off-box',
        source: 'tailnet',
        requester: { provider: 'tailscale-serve', login: person },
      })
    : (
        await send<{ requestId: string }>(PUBLIC_DEVICE_PAIRING_REQUEST_PATH, {
          method: 'POST',
          body: { ...proof, deviceName: name },
        })
      ).body;
  const approve = await send<{ personBindingApproved?: boolean }>(
    `/api/pairing/requests/${pending.requestId}/confirm`,
    {
      method: 'POST',
      credential: endpoint.operatorCredential,
      body: person ? { bindVerifiedIdentity: true } : {},
    },
  );
  assert.equal(approve.status, 200, 'current operator approves');
  assert.equal(approve.body.personBindingApproved, person ? true : undefined);
  const exchangeBody = { ...proof, requestId: pending.requestId };
  const session = await send<DevicePairingBearerExchangeResponse>(
    PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
    { method: 'POST', body: exchangeBody },
  );
  assert.equal(session.status, 200, 'approved device exchanges credential');
  const replay = await send(PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH, {
    method: 'POST',
    body: exchangeBody,
  });
  assert.equal(replay.status, 409, 'exchange cannot be replayed');
  return session.body;
}

type Probe = {
  marker: string;
  environmentId: string;
  deviceId: string;
  person: string | null;
};

export async function checkLocalCollaborationSecurity(
  root: string,
  signal: AbortSignal,
) {
  const checks: string[] = [];
  const errors: unknown[] = [];
  let result:
    | { checks: string[]; stationIds: string[]; ports: number[] }
    | undefined;
  const endpoints: Endpoint[] = [];
  const relays: Awaited<ReturnType<typeof startLabRelay>>[] = [];
  const marker = `application-content-${randomBytes(24).toString('hex')}`;
  const closeAll = () =>
    Promise.allSettled([
      ...relays.map((value) => value.close()),
      ...endpoints.map((value) => value.close()),
    ]);
  const onAbort = () => {
    void closeAll();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const relay = async (target: Endpoint, name: string, mode = 'forward') => {
    const directory = join(root, name);
    mkdirSync(directory, { mode: 0o700 });
    const value = await startLabRelay(target.port, directory, mode);
    relays.push(value);
    return value;
  };
  try {
    for (const name of ['station-a', 'station-b']) {
      signal.throwIfAborted();
      const home = join(root, name);
      await certificate(home);
      signal.throwIfAborted();
      endpoints.push(await startLocalSecurityEndpoint(home, marker));
    }
    const [a, b] = endpoints;
    assert(a && b);
    assert.notEqual(a.operatorCredential, b.operatorCredential);
    const relayA = await relay(a, 'relay-a');
    const relayB = await relay(b, 'relay-b');
    const sendA = client(a, relayA.port);
    const sendB = client(b, relayB.port);
    assert.equal((await sendA('/api/projects/local-lab-probe')).status, 401);
    const one = await enroll(
      a,
      sendA,
      'Synthetic A laptop',
      'person-a@fixture.invalid',
    );
    const two = await enroll(
      a,
      sendA,
      'Synthetic A phone',
      'person-a@fixture.invalid',
    );
    const other = await enroll(
      a,
      sendA,
      'Synthetic B viewer',
      'person-b@fixture.invalid',
    );
    assert.notEqual(one.credential, two.credential);
    const probe = async (
      send: ReturnType<typeof client>,
      credential: string,
    ) => {
      const result = await send<Probe>('/api/projects/local-lab-probe', {
        credential,
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.marker, marker);
      return result.body;
    };
    const first = await probe(sendA, one.credential);
    const second = await probe(sendA, two.credential);
    const third = await probe(sendA, other.credential);
    assert.equal(first.person, 'person-a@fixture.invalid');
    assert.equal(second.person, first.person);
    assert.notEqual(third.person, first.person);
    assert.notEqual(second.deviceId, first.deviceId);
    checks.push(
      'two distinct synthetic people; one person bound to two independent read-only devices',
    );
    const ordinary = await enroll(b, sendB, 'Unbound device');
    const ordinaryProbe = await probe(sendB, ordinary.credential);
    assert.equal(ordinaryProbe.person, null);
    assert.equal(
      (
        await sendB('/api/projects/local-lab-probe', {
          credential: one.credential,
        })
      ).status,
      401,
    );
    assert.equal(
      (await sendA('/api/pairing/devices', { credential: other.credential }))
        .status,
      401,
    );
    assert.equal(
      (
        await sendA('/api/projects/local-lab-probe', {
          method: 'POST',
          credential: other.credential,
          body: {},
        })
      ).status,
      403,
    );
    checks.push(
      'unbound pairing preserved; cross-Station credential and operator inventory refused',
    );

    const before = b.requests();
    await assert.rejects(
      client(a, relayB.port)('/api/projects/local-lab-probe', {
        credential: one.credential,
      }),
      { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
    );
    assert.equal(
      b.requests(),
      before,
      'replacement endpoint receives no HTTP credentials or content',
    );
    checks.push(
      'wrong endpoint certificate refused before application request',
    );
    const hostile = await relay(a, 'relay-tamper', 'tamper');
    const beforeTamper = a.requests();
    const rejectedBefore = a.rejectedTlsHandshakes();
    await assert.rejects(
      client(a, hostile.port)('/api/projects/local-lab-probe', {
        credential: one.credential,
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPROTO' || error.code === 'ECONNRESET'),
    );
    assert.equal(a.requests(), beforeTamper);
    assert(
      a.rejectedTlsHandshakes() > rejectedBefore,
      'TLS implementation must reject the modified handshake',
    );
    await probe(sendA, one.credential);
    checks.push('modified TLS traffic cannot reach the application');

    const revoked = await sendA(`/api/pairing/devices/${first.deviceId}`, {
      method: 'DELETE',
      credential: a.operatorCredential,
    });
    assert.equal(revoked.status, 200);
    assert.equal(
      (
        await sendA('/api/projects/local-lab-probe', {
          credential: one.credential,
        })
      ).status,
      401,
    );
    await probe(sendA, two.credential);
    checks.push(
      'revoking one device preserves the other device for the same person',
    );

    await relayA.close();
    await probe(client(a, a.port), two.credential);
    const replacement = await relay(a, 'relay-reconnect');
    await probe(client(a, replacement.port), two.credential);
    checks.push(
      'direct access with relay stopped; reconnect through a new relay with existing trust',
    );
    // Persistence is checked through a fresh security owner, not by inspecting
    // the existing service's cached binding.
    const { EnvironmentSecurityService } = await import(
      '../../src-server/services/ssh/environment-security-service.js'
    );
    const reopened = new EnvironmentSecurityService({
      homeDir: join(root, 'station-a'),
    });
    await reopened.initialize();
    assert.equal(
      reopened.identifyDevice(two.credential)?.principalBinding?.subject,
      first.person,
    );
    assert.equal(reopened.verifyCredential(one.credential), false);
    checks.push(
      'binding and revocation survive reopening the durable security store',
    );

    for (const value of relays) await value.close();
    for (const value of relays) {
      const bytes = readFileSync(value.capturePath);
      assert(bytes.length > 0 && bytes.length <= 1024 * 1024);
      for (const secret of [
        marker,
        one.credential,
        two.credential,
        other.credential,
        ordinary.credential,
        a.operatorCredential,
        b.operatorCredential,
      ])
        assert.equal(
          bytes.includes(Buffer.from(secret)),
          false,
          'relay capture contains application plaintext',
        );
    }
    checks.push(
      'TLS 1.3 authenticated peer checks plus bounded relay capture without fixture plaintext',
    );
    signal.throwIfAborted();
    result = {
      checks,
      stationIds: [first.environmentId, ordinaryProbe.environmentId],
      ports: [...endpoints, ...relays].map((value) => value.port),
    };
  } catch (error) {
    errors.push(error);
  }
  // Preserve the causal check failure alongside any cleanup failures.
  signal.removeEventListener('abort', onAbort);
  for (const outcome of await closeAll())
    if (outcome.status === 'rejected') errors.push(outcome.reason);
  if (errors.length)
    throw new AggregateError(
      errors,
      'Local lab verification or cleanup failed',
    );
  assert(result);
  return result;
}
