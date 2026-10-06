import { createSocket, type Socket } from 'node:dgram';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { browserFinalizeAndActivateFreshRelayEnrollment } from '../lib/browser-application-account.mjs';
import { startPionFixture } from '../lib/browser-transport-pion.js';
import {
  runLabCommand,
  startLabRelay,
} from '../lib/local-collaboration-process.mjs';
import { startSelfHostedBrokerProcess } from '../lib/self-hosted-broker-process.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('resolves the fresh relay continuation client from the application-session SDK surface', async () => {
  const delivery = {
    state: 'delivered',
    enrollmentId: 'enrollment-1',
    bundle: {
      stationId: 'station-1',
      deviceId: 'device-1',
      continuation: { deviceId: 'device-1', clientOrigin: 'https://app.test' },
    },
  };
  const state = {
    key: { privateKey: 'key' },
    challenge: { enrollmentId: 'enrollment-1' },
    apiBase: 'https://relay.test',
    stationId: 'station-1',
    clientOrigin: 'https://app.test',
    requestHeaderEvidence: [] as string[][],
    transport: async () => ({ status: 200, json: async () => delivery }),
  };
  const constructed: unknown[][] = [];
  const stopAfterConstruction = new Error('stop after construction');
  vi.stubGlobal('window', {
    stationFreshRelayEnrollment: state,
    // The relay-enrollment surface must not be where the continuation client
    // comes from; constructing it here fails the test for that reason.
    stationRelayEnrollment: {
      RELAY_ENROLLMENT_CLIENT_PATHS: { finalize: '/finalize' },
      createRelayEnrollmentFinalizeProof: async () => 'proof',
      ApplicationSessionClient: class {
        constructor() {
          throw new Error('continuation client built from the relay surface');
        }
      },
    },
    stationApplicationChannel: {
      ApplicationSessionClient: class {
        constructor(...args: unknown[]) {
          constructed.push(args);
        }
        headers() {
          throw stopAfterConstruction;
        }
      },
    },
  });
  try {
    await expect(browserFinalizeAndActivateFreshRelayEnrollment()).rejects.toBe(
      stopAfterConstruction,
    );
  } finally {
    vi.unstubAllGlobals();
  }
  expect(constructed).toEqual([
    [
      'https://relay.test',
      'station-1',
      'https://app.test',
      { requireCredential: true, timeoutMs: 15000 },
      state.key,
    ],
  ]);
});
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'station-browser-fixture-test-'));
  roots.push(root);
  return root;
}

it('adds a late Station scope to the live broker while preserving the first scope and refusing foreign credentials', async () => {
  const root = temporaryRoot();
  const scope = {
    stationId: 'station-a-12345678',
    enrollmentId: 'enroll-a-12345678',
    routingGeneration: 1,
    browserOrigin: 'http://localhost:4173',
  };
  const broker = await startSelfHostedBrokerProcess({
    directory: root,
    scope,
    signal: new AbortController().signal,
  });
  try {
    expect((await broker.readLease()).state).toBe('offline');
    const second = await broker.addScope({
      directory: join(root, 'second'),
      scope: {
        ...scope,
        stationId: 'station-b-12345678',
        enrollmentId: 'enroll-b-12345678',
        browserOrigin: 'http://localhost:4174',
      },
    });
    expect(second.processId).toBe(broker.processId);
    expect(second.databasePath).toBe(broker.databasePath);
    expect(second.brokerOrigin).toBe(broker.brokerOrigin);
    expect(second.bundle.connector.id).not.toBe(broker.bundle.connector.id);
    expect(second.bundle.routing.id).not.toBe(broker.bundle.routing.id);
    expect((await broker.readLease()).state).toBe('offline');
    expect((await second.readLease()).state).toBe('offline');
    for (const [own, foreign] of [
      [broker, second],
      [second, broker],
    ]) {
      const refused = await fetch(
        `${own.brokerOrigin}/broker/v1/stations/status`,
        {
          method: 'POST',
          headers: {
            Origin: own.scope.browserOrigin,
            Authorization: `Bearer ${foreign.bundle.routing.secret}`,
            'X-Broker-Credential-Id': foreign.bundle.routing.id,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scope: own.scope }),
          signal: AbortSignal.timeout(5000),
        },
      );
      expect(refused.status).toBe(401);
    }
    await second.stop();
    await expect(broker.readLease()).rejects.toThrow();
  } finally {
    await broker.stop();
  }
}, 30000);
async function bind(socket: Socket, port = 0) {
  socket.bind(port, '127.0.0.1');
  await once(socket, 'listening');
  return socket.address().port;
}
async function receive(socket: Socket) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    const [bytes] = await once(socket, 'message', { signal: abort.signal });
    return bytes as Buffer;
  } finally {
    clearTimeout(timer);
  }
}

it('forwards binary UDP in both directions, captures it exactly, and releases only its listener', async () => {
  const root = temporaryRoot();
  const upstream = createSocket('udp4');
  const client = createSocket('udp4');
  const observed: Buffer[] = [];
  upstream.on('message', (bytes, source) => {
    observed.push(Buffer.from(bytes));
    upstream.send(Buffer.from(bytes).reverse(), source.port, source.address);
  });
  const target = await bind(upstream);
  await bind(client);
  let relay: Awaited<ReturnType<typeof startLabRelay>> | undefined;
  try {
    relay = await startLabRelay(target, root, 'forward', 'udp');
    const payload = Buffer.from(
      Array.from({ length: 2048 }, (_, i) => i % 256),
    );
    const expected = Buffer.from(payload).reverse();
    const returned = receive(client);
    client.send(payload, relay.port, '127.0.0.1');
    expect(await returned).toEqual(expected);
    expect(observed).toEqual([payload]);
    await relay.close();
    expect(readFileSync(relay.capturePath)).toEqual(
      Buffer.concat([payload, expected]),
    );
    const probe = createSocket('udp4');
    try {
      expect(await bind(probe, relay.port)).toBe(relay.port);
    } finally {
      probe.close();
    }
    const direct = receive(client);
    client.send(payload, target, '127.0.0.1');
    expect(await direct).toEqual(expected);
  } finally {
    await relay?.close();
    client.close();
    upstream.close();
  }
}, 30000);

it('retains bounded command diagnostics for the private failure owner', async () => {
  const root = temporaryRoot();
  const success = await runLabCommand(
    process.execPath,
    [
      '-e',
      'process.stdout.write("fixture stdout"); process.stderr.write("fixture stderr")',
    ],
    root,
  );
  expect(success).toEqual({
    stdout: 'fixture stdout',
    stderr: 'fixture stderr',
  });
  await expect(
    runLabCommand(
      process.execPath,
      ['-e', 'process.stderr.write("fixture failure"); process.exitCode = 7'],
      root,
    ),
  ).rejects.toMatchObject({ cause: { stdout: '', stderr: 'fixture failure' } });
}, 30000);

it('refuses an unsupported relay transport before spawning a child', async () => {
  await expect(
    startLabRelay(49152, temporaryRoot(), 'forward', 'unknown'),
  ).rejects.toThrow('Unsupported lab relay transport');
});

it.each(['tcp', 'udp'])(
  'enforces an explicitly bounded %s recorder lifetime',
  async (transport) => {
    const root = temporaryRoot();
    await expect(
      startLabRelay(49152, root, 'forward', transport, { lifetimeMs: 600_001 }),
    ).rejects.toThrow('Invalid lab relay lifetime');
    const relay = await startLabRelay(49152, root, 'forward', transport, {
      lifetimeMs: 1_000,
    });
    await expect
      .poll(() => existsSync(join(root, 'failed.json')), { timeout: 5_000 })
      .toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'failed.json'), 'utf8'))).toEqual(
      { reason: 'lifetime_exceeded' },
    );
    await expect(relay.close()).rejects.toThrow(
      'Relay failed its bounded lifecycle/capture contract',
    );
  },
  10_000,
);

it('refuses a missing Pion binary and an exited child before reporting a ready peer', async () => {
  const root = temporaryRoot();
  const input = {
    executable: join(root, 'missing-peer'),
    directory: join(root, 'peer'),
    certificate: 'unused-certificate',
    key: 'unused-key',
    offer: { type: 'offer', sdp: 'fixture' },
    turnPort: 49152,
    username: 'fixture',
    password: 'fixture',
  };
  await expect(startPionFixture(input)).rejects.toThrow(
    'Build the Pion fixture',
  );
  // Node cannot execute a directory containing only config.json as a module;
  // this deliberately exercises a real failed process, not a timer-only mock.
  // The adapter reads cert/key content (not paths), so the exited-child case
  // needs real temp files to reach the spawn stage at all.
  const certificate = join(root, 'fixture-cert.pem');
  const key = join(root, 'fixture-key.pem');
  writeFileSync(certificate, 'fixture certificate');
  writeFileSync(key, 'fixture key');
  await expect(
    startPionFixture({
      ...input,
      executable: process.execPath,
      certificate,
      key,
    }),
  ).rejects.toThrow('pion_process_exited');
}, 30000);
