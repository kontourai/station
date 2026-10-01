import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApplicationChannelFetch } from '@kontourai/station-connect/application-channel';
import { PUBLIC_DEVICE_PAIRING_REQUEST_PATH } from '@kontourai/station-contracts/environment-security';
import type {
  NativeDeviceBindingCandidateV1,
  NativeDeviceProofBindingReadbackV1,
} from '@kontourai/station-contracts/native-device-proof';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import type { AccountSessionView } from '@kontourai/station-sdk/account-authentication';
import { stationConnectionSigningKeyId } from '@kontourai/station-shared/connection-proof';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { Hono } from 'hono';
import { runLabCommand } from '../../scripts/lib/local-collaboration-process.mjs';
import { provisionRelayAccountStation } from '../../scripts/lib/local-collaboration-relay-account.js';
import {
  acquireAccountLabPorts,
  startAccountLabStation,
} from '../../scripts/lib/local-collaboration-station.js';
import { createTurnFixture } from '../../scripts/lib/turn-fixture.js';
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
async function closeServer(server: {
  readonly listening: boolean;
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?: () => void;
}) {
  server.closeAllConnections?.();
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
    const stationInput = {
      directory: stationDirectory,
      name: `native-project-${randomBytes(8).toString('hex')}`,
      hostname: '127.0.0.1' as const,
      port,
      allowedProbePort,
      blockedProbePort,
      probeNonce,
      virtualApplicationOrigin: stationBase,
      ownedBrokerTcpPort: brokerAddress.port,
    };
    let station = await startAccountLabStation(
      {
        ...stationInput,
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
    let turn:
      | { tcp: number; udp: number; username: string; password: string }
      | undefined;
    let nativeEnabled = false;
    const operatorRequest = async <T>(
      path: string,
      method: string,
      body?: unknown,
    ): Promise<T> => {
      const response = await fetch(stationBase + path, {
        method,
        headers: {
          Authorization: `Bearer ${station.operator.credential}`,
          Origin: stationBase,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
        redirect: 'error',
      });
      const result = (await response.json()) as T;
      assert(
        response.ok,
        `Fixture operator operation failed (${response.status} ${path})`,
      );
      return result;
    };
    const bindingOperation = async (
      operation: 'create' | 'revoke',
      candidate: NativeDeviceBindingCandidateV1,
    ) => {
      assert.equal(candidate.stationId, identity.environmentId);
      const result = await operatorRequest<{
        data: NativeDeviceProofBindingReadbackV1;
      }>(
        `/api/pairing/native-device-bindings/${candidate.bindingId}/approve`,
        'POST',
        { operation, candidate },
      );
      assert.equal(result.data.binding.bindingId, candidate.bindingId);
      return result.data;
    };
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
      get station() {
        return station;
      },
      get turn() {
        assert(turn, 'Native TURN fixture has not started');
        return turn;
      },
      async enableNativeClient(surface: SelfHostedBrokerNativeClientSurfaceV2) {
        assert(!nativeEnabled, 'Native fixture can be enabled only once');
        input.signal.throwIfAborted();
        const resourceDirectory = join(directory, 'native-resources');
        mkdirSync(resourceDirectory, { mode: 0o700 });
        const username = `native-${randomBytes(8).toString('hex')}`;
        const password = randomBytes(24).toString('hex');
        const turnOwner = createTurnFixture({
          directory: resourceDirectory,
          username,
          password,
          signal: input.signal,
          lifetimeSeconds: 600,
        });
        cleanups.push(turnOwner.stop);
        const ports = await turnOwner.start();
        assert(
          ![ports.tcp, ports.udp].some((value) => [3000, 3141].includes(value)),
        );
        turn = { ...ports, username, password };
        const go = resolve(
          process.env.MISE_DATA_DIR ?? join(homedir(), '.local/share/mise'),
          'installs/go/1.26.7/bin/go',
        );
        assert(
          existsSync(go),
          'Pinned Go 1.26.7 is required by the native Pion fixture',
        );
        const moduleCache = join(homedir(), 'go', 'pkg', 'mod');
        assert(existsSync(moduleCache), 'Cached Pion Go modules are required');
        const buildCache = join(resourceDirectory, 'go-build-cache');
        mkdirSync(buildCache, { mode: 0o700 });
        const executable = join(resourceDirectory, 'pion-peer');
        await runLabCommand(
          '/usr/bin/env',
          [
            `GOMODCACHE=${moduleCache}`,
            `GOCACHE=${buildCache}`,
            go,
            'build',
            '-mod=readonly',
            '-trimpath',
            '-o',
            executable,
            '.',
          ],
          resolve(
            import.meta.dirname,
            '../../src-server/services/connections/pion-peer',
          ),
          120_000,
        );
        const key = join(resourceDirectory, 'station-key.pem');
        const certificate = join(resourceDirectory, 'station-cert.pem');
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
            '/CN=owned-native-project-fixture',
            '-keyout',
            key,
            '-out',
            certificate,
          ],
          resourceDirectory,
        );
        chmodSync(key, 0o600);
        chmodSync(certificate, 0o600);
        const credentialsPath = join(
          resourceDirectory,
          'broker-credentials.json',
        );
        writeFileSync(
          credentialsPath,
          JSON.stringify({
            version: 'station-self-hosted-broker-credentials/v1',
            scope,
            bundle: {
              connector: credentials.connector,
              routing: credentials.routing,
            },
          }),
          { mode: 0o600, flag: 'wx' },
        );
        const configPath = join(resourceDirectory, 'connector.json');
        writeFileSync(
          configPath,
          JSON.stringify({
            version: 'station-self-hosted-connector/v1',
            brokerOrigin,
            applicationOrigin: stationBase,
            credentialsPath,
            pionExecutable: executable,
            certificatePath: certificate,
            privateKeyPath: key,
            turn: {
              url: `turn:127.0.0.1:${ports.tcp}?transport=tcp`,
              username,
              password,
            },
            nativeClient: { ...surface, maxPeers: 16 },
            maxPeers: 16,
            maxPeerLifetimeMs: 120_000,
          }),
          { mode: 0o600, flag: 'wx' },
        );
        await station.stop();
        station = await startAccountLabStation(
          {
            ...stationInput,
            prepareSelfHostedBrokerConfig: () => configPath,
            nativeDeviceProofPilot: true,
          },
          input.signal,
        );
        cleanups.push(station.stop);
        assert.equal(station.stationId, identity.environmentId);
        assert.deepEqual(custody.readDescriptor(), stationTrust);
        nativeEnabled = true;
        return {
          turn,
          stationBase,
          stationId: station.stationId,
          scope,
          stationTrust,
        };
      },
      async issueNativeInvitation(
        surface: SelfHostedBrokerNativeClientSurfaceV2,
      ) {
        assert(
          nativeEnabled,
          'Native runtime must be enabled before routing grant issuance',
        );
        return service.issueNativeInvitation({
          scope,
          routingCredential: credentials.routing,
          brokerOrigin,
          surface,
          stationSigningKeyId:
            await stationConnectionSigningKeyId(stationTrust),
          stationSigningGeneration: stationTrust.generation,
          invitationTtlMs: 120_000,
          grantTtlMs: 600_000,
        });
      },
      async beginNativePairing(clientInstanceId: string) {
        const login = await fetch(
          `${stationBase}/api/account-auth${fixture.browser.signInPath}`,
          {
            method: 'POST',
            headers: {
              Origin: stationBase,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              username: fixture.browser.username,
              password: fixture.browser.password,
            }),
            signal: AbortSignal.any([
              input.signal,
              AbortSignal.timeout(15_000),
            ]),
            redirect: 'error',
          },
        );
        assert.equal(login.status, 200, 'Real fixture account login failed');
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        assert(cookie, 'Real provider did not issue its account cookie');
        await login.arrayBuffer();
        const accepted = await fetch(
          `${stationBase}/api/account-auth/accept-invitation`,
          {
            method: 'POST',
            headers: {
              Origin: stationBase,
              Cookie: cookie,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ token: fixture.browser.invitation }),
            signal: AbortSignal.any([
              input.signal,
              AbortSignal.timeout(15_000),
            ]),
            redirect: 'error',
          },
        );
        assert.equal(
          accepted.status,
          200,
          'Real Project invitation acceptance failed',
        );
        const acceptance = (await accepted.json()) as {
          data: {
            scope: ProjectMembershipScope;
            grantsDeviceAccess: boolean;
          };
        };
        assert.equal(acceptance.data.scope.stationId, station.stationId);
        assert.equal(
          acceptance.data.scope.localProjectSlug,
          fixture.sharedWork.slug,
        );
        assert.equal(acceptance.data.grantsDeviceAccess, false);
        const session = await fetch(`${stationBase}/api/account-auth/session`, {
          headers: { Origin: stationBase, Cookie: cookie },
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
          redirect: 'error',
        });
        assert.equal(
          session.status,
          200,
          'Real fixture account session lookup failed',
        );
        const { data: accountSession } = (await session.json()) as {
          data: AccountSessionView;
        };
        assert(accountSession.principal.id);
        await fixture.verifyMembership(accountSession.principal.id);
        const offer = await fixture.createBoundDeviceOffer();
        const requested = await fetch(
          stationBase + PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
          {
            method: 'POST',
            headers: {
              Origin: stationBase,
              'Content-Type': 'application/json',
              Cookie: cookie,
            },
            body: JSON.stringify({
              offerId: offer.offerId,
              proof: offer.challenge,
              deviceName: `Native fixture ${clientInstanceId}`,
              clientInstanceId,
            }),
            signal: AbortSignal.any([
              input.signal,
              AbortSignal.timeout(15_000),
            ]),
            redirect: 'error',
          },
        );
        assert.equal(
          requested.status,
          202,
          'Real account-bound pairing request failed',
        );
        const request = (await requested.json()) as { requestId: string };
        assert(request.requestId);
        await fixture.confirmBoundDevice(request.requestId);
        return {
          endpoint: stationBase,
          expectedStationId: station.stationId,
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: request.requestId,
        };
      },
      approveDeviceCandidate: (candidate: NativeDeviceBindingCandidateV1) =>
        bindingOperation('create', candidate),
      revokeBinding: (candidate: NativeDeviceBindingCandidateV1) =>
        bindingOperation('revoke', candidate),
      async revokeDevice(deviceId: string) {
        await operatorRequest(
          `/api/pairing/devices/${encodeURIComponent(deviceId)}`,
          'DELETE',
        );
      },
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
