import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApplicationChannelFetch } from '@kontourai/station-connect/application-channel';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { Hono } from 'hono';
import { provisionRelayAccountStation } from '../../scripts/lib/local-collaboration-relay-account.js';
import {
  acquireAccountLabPorts,
  startAccountLabStation,
} from '../../scripts/lib/local-collaboration-station.js';
import { createSelfHostedBrokerRoutes } from '../../src-server/routes/connections/self-hosted-broker.js';
import {
  allocateFreePortBlock,
  reserveContiguousBlock,
} from '../../src-server/runtime/bootstrap/allocate-port-block.js';
import { SelfHostedBrokerService } from '../../src-server/services/connections/self-hosted-broker-service.js';
import { ConnectionSigningKeyStore } from '../../src-server/services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../../src-server/services/ssh/environment-security-service.js';

async function listenProbe(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  assert(![3000, 3141].includes(address.port));
  return address.port;
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
}

/** Real isolated Station identity/account/Project bootstrap for the native fixture. */
export async function startNativeProjectRuntimeFixture(input: {
  readonly directory: string;
  readonly signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const directory = resolve(input.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = await acquireAccountLabPorts();
  const stationDirectory = join(directory, 'application-station');
  const home = join(stationDirectory, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const cleanups: Array<() => Promise<void> | void> = [release];
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      const errors: unknown[] = [];
      for (const cleanup of [...cleanups].reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          'Native Project fixture cleanup failed',
        );
    })());
  try {
    ensureStationHomeSchemaSync(home);
    const identity = await new EnvironmentSecurityService({
      homeDir: home,
    }).initialize();
    const custody = new ConnectionSigningKeyStore(home);
    const stationTrust = await custody.initialize();
    assert.equal(stationTrust.stationId, identity.environmentId);
    const port = await allocateFreePortBlock('127.0.0.1');
    const reservations = await reserveContiguousBlock('127.0.0.1', port, 4);
    assert(reservations, 'Native fixture Station listener reservation lost');
    const releasePorts = async () => {
      await Promise.all(
        reservations.map((server) =>
          server.listening
            ? new Promise<void>((resolveClose) =>
                server.close(() => resolveClose()),
              )
            : Promise.resolve(),
        ),
      );
    };
    cleanups.push(releasePorts);
    assert(
      ![3000, 3141].some((reserved) => reserved >= port && reserved < port + 4),
    );
    const stationBase = `http://127.0.0.1:${port}`;
    const scope = {
      stationId: stationTrust.stationId,
      enrollmentId: stationTrust.enrollmentId,
      routingGeneration: 1,
      browserOrigin: stationBase,
    };
    const service = new SelfHostedBrokerService(
      join(directory, 'broker.sqlite'),
    );
    cleanups.push(() => service.close());
    const credentials = service.provision(scope, 3_600_000);
    const broker = serve({
      fetch: new Hono().route(
        '/broker/v1',
        createSelfHostedBrokerRoutes(service),
      ).fetch,
      hostname: '127.0.0.1',
      port: 0,
    });
    cleanups.push(() => closeServer(broker));
    await once(broker, 'listening');
    const brokerAddress = broker.address();
    assert(brokerAddress && typeof brokerAddress !== 'string');
    assert(![3000, 3141].includes(brokerAddress.port));
    const brokerOrigin = `http://127.0.0.1:${brokerAddress.port}`;
    const probeNonce = randomBytes(32).toString('hex');
    const allowed = createServer((_request, response) =>
      response.end(probeNonce),
    );
    const blocked = createServer((_request, response) =>
      response.end('owned refusal control'),
    );
    cleanups.push(
      () => closeServer(allowed),
      () => closeServer(blocked),
    );
    const allowedProbePort = await listenProbe(allowed);
    const blockedProbePort = await listenProbe(blocked);
    assert(
      ![brokerAddress.port, allowedProbePort, blockedProbePort].some(
        (value) => value >= port && value < port + 4,
      ),
    );
    await releasePorts();
    const station = await startAccountLabStation(
      {
        directory: stationDirectory,
        name: `native-project-${randomBytes(8).toString('hex')}`,
        hostname: '127.0.0.1',
        port,
        allowedProbePort,
        blockedProbePort,
        probeNonce,
        virtualApplicationOrigin: stationBase,
        ownedBrokerTcpPort: brokerAddress.port,
      },
      input.signal,
    );
    cleanups.push(station.stop);
    assert.equal(station.stationId, identity.environmentId);
    assert(station.openApplicationChannel);
    const fixture = await provisionRelayAccountStation({
      station,
      browserOrigin: stationBase,
      signal: input.signal,
      stop,
      transport: createApplicationChannelFetch({
        origin: stationBase,
        signal: input.signal,
        open: async () => station.openApplicationChannel!(),
        assertCurrent: () => input.signal.throwIfAborted(),
      }),
    });
    return {
      stationBase,
      stationId: station.stationId,
      brokerOrigin,
      scope,
      stationTrust,
      account: {
        username: fixture.browser.username,
        password: fixture.browser.password,
      },
      projectSlug: fixture.sharedWork.slug,
      privateProjectSlug: 'relay-private',
      fixture,
      service,
      credentials,
      custody,
      station,
      directory,
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Native Project fixture startup and cleanup failed',
      );
    }
    throw error;
  }
}
