/**
 * Manual macOS acceptance lanes for native v2 relay custody. They use a real
 * main Tauri WebView, actual Keychain storage and loopback-only broker
 * fixtures. The optional diagnostic echo lane negotiates only station-lab-v1;
 * neither lane establishes Project/account authority or app-data ingress.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import {
  formatStationConnectionKeyConfirmationCode,
  stationConnectionKeyConfirmationCode,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import {
  createStationTempDir,
  removeStationTempDir,
} from '@kontourai/station-shared/temp-dir';
import { build } from 'esbuild';
import { Hono } from 'hono';
import { runLabCommand } from '../../scripts/lib/local-collaboration-process.mjs';
import { createTurnFixture } from '../../scripts/lib/turn-fixture.js';
import { createSelfHostedBrokerRoutes } from '../../src-server/routes/connections/self-hosted-broker.js';
import { createSelfHostedBrokerPionRuntime } from '../../src-server/runtime/bootstrap/self-hosted-broker-pion-runtime.js';
import { SelfHostedBrokerRuntime } from '../../src-server/runtime/bootstrap/self-hosted-broker-runtime.js';
import { createNativeV2PionDiagnosticAdapter } from '../../src-server/services/connections/native-v2-pion-diagnostic-adapter.js';
import { startPionApplicationAdapter } from '../../src-server/services/connections/pion-application-adapter.js';
import { SelfHostedBrokerClient } from '../../src-server/services/connections/self-hosted-broker-client.js';
import {
  type BrokerNativeOfferAdapter,
  SelfHostedBrokerConnector,
} from '../../src-server/services/connections/self-hosted-broker-connector.js';
import { SelfHostedBrokerService } from '../../src-server/services/connections/self-hosted-broker-service.js';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../../src-server/services/infra/process-utils.js';
import { ConnectionKeyCandidateIssuer } from '../../src-server/services/ssh/connection-key-candidate-issuer.js';
import { ConnectionSigningKeyStore } from '../../src-server/services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../../src-server/services/ssh/environment-security-service.js';
import {
  startTauriShellFixture,
  type TauriShellFixture,
} from './direct-webdriver.js';

const APP_IDENTIFIER = 'io.kontourai.station.webdriver.relaygrant';
const CREDENTIAL_SERVICE = 'io.kontourai.station';
const PROOF_SERVICE = 'io.kontourai.station.relay-proof';
const TRUST_SERVICE = 'io.kontourai.station.connection-trust';
const CLEANUP_OWNER_PREFIX = 'relay-native-client-grant:cleanup-owners:v1:dev:';
const NATIVE_ECHO_LANE =
  process.env.STATION_TAURI_E2E_NATIVE_DIAGNOSTIC_ECHO === '1';
const INJECT_ECHO_CLEANUP_FAILURE =
  NATIVE_ECHO_LANE &&
  process.env.STATION_TAURI_E2E_INJECT_ECHO_CLEANUP_FAILURE === '1';
const INJECT_ECHO_JOURNEY_FAILURE =
  NATIVE_ECHO_LANE &&
  process.env.STATION_TAURI_E2E_INJECT_ECHO_JOURNEY_FAILURE === '1';

type KeychainItem = { service: string; account: string };
type NativeEchoPollResult = Awaited<
  ReturnType<SelfHostedBrokerConnector['pollNative']>
>;
type NativeEchoPollWaiter = {
  signal: AbortSignal;
  resolve(value: NativeEchoPollResult): void;
  reject(reason: unknown): void;
  cleanup(): void;
};

async function assertLoopbackPortClosed(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`owned loopback port ${port} remained open`));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

function keychainStatus(item: KeychainItem) {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', item.service, '-a', item.account],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  if (result.error || ![0, 44].includes(result.status ?? -1))
    throw new Error('Keychain lookup failed; fixture ownership is unresolved.');
  return result.status;
}

function keychainDelete(item: KeychainItem) {
  if (keychainStatus(item) === 44) return;
  const deleted = spawnSync(
    'security',
    ['delete-generic-password', '-s', item.service, '-a', item.account],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  assert.equal(
    deleted.status,
    0,
    `could not remove exact Keychain item ${item.account}`,
  );
  assert.equal(
    keychainStatus(item),
    44,
    `Keychain item remained: ${item.account}`,
  );
}

function appHash() {
  return createHash('sha256').update(APP_IDENTIFIER).digest('base64url');
}

function proofItem(clientInstanceId: string): KeychainItem {
  return {
    service: PROOF_SERVICE,
    account: `native-proof:v1:dev:${appHash()}:${clientInstanceId}`,
  };
}

function trustItem(stationId: string): KeychainItem {
  const parts = [APP_IDENTIFIER, 'dev', stationId];
  const canonical = `station-connection-trust-account/v1\0${parts
    .map((part) => `${part.length}:${part}:`)
    .join('')}`;
  return {
    service: TRUST_SERVICE,
    account: `station-connection-trust:v1:${createHash('sha256')
      .update(canonical)
      .digest('base64url')}`,
  };
}

function ownerIndexItem(): KeychainItem {
  return {
    service: CREDENTIAL_SERVICE,
    account: `${CLEANUP_OWNER_PREFIX}${appHash()}`,
  };
}

function grantIndexItem(clientInstanceId: string): KeychainItem {
  return {
    service: CREDENTIAL_SERVICE,
    account: `relay-native-client-grant:index:v2:dev:${appHash()}:${clientInstanceId}`,
  };
}

function grantCleanupIndexItem(clientInstanceId: string): KeychainItem {
  return {
    service: CREDENTIAL_SERVICE,
    account: `relay-native-client-grant:cleanup-index:v2:dev:${appHash()}:${clientInstanceId}`,
  };
}

function grantItem(
  clientInstanceId: string,
  route: {
    brokerOrigin: string;
    stationId: string;
    enrollmentId: string;
    routingGeneration: number;
    grantId: string;
  },
): KeychainItem {
  const account = [
    APP_IDENTIFIER,
    'dev',
    clientInstanceId,
    route.brokerOrigin,
    route.stationId,
    route.enrollmentId,
    String(route.routingGeneration),
    route.grantId,
  ]
    .map((part) => `${part.length}:${part}:`)
    .join('');
  return {
    service: CREDENTIAL_SERVICE,
    account: `relay-native-client-grant:v2:${account}`,
  };
}

function trackFixtureLocalBearerItems(
  stationRoot: string,
  ownedItems: KeychainItem[],
) {
  const profilesPath = join(stationRoot, 'config', 'profiles.json');
  if (!existsSync(profilesPath)) return;
  const saved = JSON.parse(readFileSync(profilesPath, 'utf8')) as {
    profiles?: Array<{
      credentialRef?: { kind?: string; id?: string };
    }>;
  };
  for (const profile of saved.profiles ?? []) {
    const reference = profile.credentialRef;
    if (
      reference?.kind !== 'station-bearer' ||
      !reference.id?.startsWith('local-grant:')
    )
      continue;
    const item = {
      service: CREDENTIAL_SERVICE,
      account: `profile:station-bearer:${reference.id}`,
    };
    if (!ownedItems.some((owned) => owned.account === item.account))
      ownedItems.push(item);
  }
}

async function startBroker(echoMode = false) {
  const home = mkdtempSync(join(tmpdir(), 'station-native-grant-shell-'));
  chmodSync(home, 0o700);
  const cleanups: Array<() => void | Promise<void>> = [
    () => rmSync(home, { recursive: true, force: true }),
  ];
  let echoController: AbortController | undefined;
  let echoAdapter:
    | ReturnType<typeof createNativeV2PionDiagnosticAdapter>
    | undefined;
  let echoConnector: SelfHostedBrokerConnector | undefined;
  let candidateIssuer: ConnectionKeyCandidateIssuer | undefined;
  let candidateController: AbortController | undefined;
  let candidatePollingEnabled = false;
  let nativeEchoEnabled = false;
  const nativeEchoPollResults: NativeEchoPollResult[] = [];
  const nativeEchoPollWaiters: NativeEchoPollWaiter[] = [];
  let turnFixture: ReturnType<typeof createTurnFixture> | undefined;
  let turnContainerId: string | undefined;
  const echoPionChildren: ChildProcess[] = [];
  const candidatePollTasks = new Set<Promise<unknown>>();
  let echoPionProcessesExited = false;
  let echoBrokerLeaseWithdrawn = false;
  let echoTurnContainerRemoved = false;
  let candidatePollerStoppedBeforeEcho = false;
  let brokerListenerClosed = false;
  let brokerPort: number | undefined;
  let brokerOrigin = '';
  let runtime: SelfHostedBrokerRuntime | undefined;
  let echoTurn:
    | { tcp: number; udp: number; username: string; password: string }
    | undefined;
  let echoSurface:
    | {
        kind: 'station-native';
        appIdentifier: string;
        channel: 'dev';
        clientInstanceId: string;
        keyThumbprint: string;
      }
    | undefined;
  let cleaned = false;
  const stop = async () => {
    if (cleaned) return;
    cleaned = true;
    let firstError: unknown;
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };
  try {
    await new EnvironmentSecurityService({ homeDir: home }).initialize();
    const custody = new ConnectionSigningKeyStore(home);
    const trust = await custody.initialize();
    const service = new SelfHostedBrokerService(join(home, 'broker.sqlite'));
    cleanups.push(() => service.close());
    const scope = {
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      routingGeneration: 1,
      browserOrigin: 'https://station.example',
    };
    const credentials = service.provision(scope, 600_000);
    const app = new Hono().route(
      '/broker/v1',
      createSelfHostedBrokerRoutes(service),
    );
    let failRetirement = false;
    let dropNextRenewalResponse = false;
    let renewalRequests = 0;
    const server = serve({
      fetch: async (request) => {
        const renewalRequest =
          new URL(request.url).pathname === '/broker/v1/native/grants/renew';
        if (
          failRetirement &&
          new URL(request.url).pathname === '/broker/v1/native/grants/retire'
        ) {
          return new Response('fixture retirement outage', { status: 503 });
        }
        if (renewalRequest) renewalRequests += 1;
        const response = await app.fetch(request);
        if (
          dropNextRenewalResponse &&
          response.status === 200 &&
          renewalRequest
        ) {
          dropNextRenewalResponse = false;
          return new Response('injected lost renewal receipt', { status: 503 });
        }
        return response;
      },
      hostname: '127.0.0.1',
      port: 0,
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (brokerPort !== undefined) {
        await assertLoopbackPortClosed(brokerPort);
        brokerListenerClosed = true;
      }
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('loopback broker fixture did not bind a TCP port');
    brokerPort = address.port;
    brokerOrigin = `http://127.0.0.1:${address.port}`;
    const trustOwner = {
      current: () => custody.readDescriptor(),
      isCurrent: (value: typeof trust) =>
        JSON.stringify(value) === JSON.stringify(custody.readDescriptor()),
    };
    if (!echoMode) {
      runtime = createSelfHostedBrokerPionRuntime(
        {
          brokerOrigin,
          applicationOrigin: 'https://station.example',
          scope,
          connectorCredential: credentials.connector,
          executable: '/unused',
          certificatePem: 'unused',
          privateKeyPem: 'unused',
          turn: { url: 'turn:unused', username: 'unused', password: 'unused' },
          trust: trustOwner,
          issuer: {
            issue: async () => {
              throw new Error(
                'unexpected application offer in grant acceptance lane',
              );
            },
          },
          candidateIssuer: new ConnectionKeyCandidateIssuer(custody),
          heartbeatMs: 30_000,
          renewMs: 10_000,
          pollMs: 1_000,
          maxPeerLifetimeMs: 60_000,
          maxPeers: 1,
          observeStatus: () => undefined,
        },
        {
          signal: new AbortController().signal,
          fetch: async () => new Response('unused'),
        },
        {
          startAdapter: async () => {
            throw new Error('application adapter must remain unused');
          },
        },
      );
      cleanups.push(async () => {
        await runtime?.shutdown();
      });
      await runtime.start();
    }

    const startEchoRuntime = async (surface: {
      kind: 'station-native';
      appIdentifier: string;
      channel: 'dev';
      clientInstanceId: string;
      keyThumbprint: string;
    }) => {
      if (!echoMode || runtime || echoSurface)
        throw new Error('native diagnostic echo runtime is unavailable');
      echoSurface = Object.freeze({ ...surface });
      echoController = new AbortController();
      candidateController = new AbortController();
      candidateIssuer = new ConnectionKeyCandidateIssuer(custody);
      echoConnector = new SelfHostedBrokerConnector(
        scope,
        new SelfHostedBrokerClient(brokerOrigin, scope, credentials.connector),
        trustOwner,
        async () => {
          throw new Error('native_pion_diagnostic_browser_offer_forbidden');
        },
        {
          surface: echoSurface,
          answer: async (
            ...[offer, approved, signal]: Parameters<
              BrokerNativeOfferAdapter['answer']
            >
          ) => {
            if (!nativeEchoEnabled || !echoAdapter)
              throw new Error('native_pion_diagnostic_approval_required');
            return await echoAdapter.adapter.answer(offer, approved, signal);
          },
        },
      );
      candidatePollingEnabled = true;
      const connector = echoConnector;
      const issuer = candidateIssuer;
      const candidateAbort = candidateController;
      const lifecycle = {
        register: (signal: AbortSignal) => connector.register(signal),
        renew: (signal: AbortSignal) => connector.renew(signal),
        poll: async (signal: AbortSignal) => {
          if (candidatePollingEnabled) {
            const joinedSignal = AbortSignal.any([
              signal,
              candidateAbort.signal,
            ]);
            const task = connector.pollNativeKeyCandidates(
              issuer,
              joinedSignal,
            );
            candidatePollTasks.add(task);
            try {
              return await task;
            } catch (error) {
              if (candidateAbort.signal.aborted && !signal.aborted) return;
              throw error;
            } finally {
              candidatePollTasks.delete(task);
            }
          }
          if (!nativeEchoEnabled) return;
          const result = await connector.pollNative(signal);
          if (result.observed > 0) {
            const waiter = nativeEchoPollWaiters.shift();
            if (waiter) {
              waiter.resolve(result);
            } else if (nativeEchoPollResults.length < 2) {
              nativeEchoPollResults.push(result);
            }
          }
          return result;
        },
        withdraw: async (signal: AbortSignal) => {
          const results = await Promise.allSettled([
            connector.withdraw(signal),
            Promise.resolve().then(async () => await echoAdapter?.close()),
          ]);
          const errors = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (errors.length)
            throw new AggregateError(
              errors,
              'native_echo_connector_cleanup_failed',
            );
        },
      };
      runtime = new SelfHostedBrokerRuntime({
        origin: scope.browserOrigin,
        configuredOrigin: scope.browserOrigin,
        application: {
          signal: echoController.signal,
          fetch: async () =>
            new Response('native diagnostic echo only', { status: 404 }),
        },
        connector: lifecycle,
        heartbeatMs: 30_000,
        renewMs: 10_000,
        pollMs: 1_000,
      });
      const cleanupEchoRuntime = async () => {
        candidatePollingEnabled = false;
        candidateAbort.abort(new Error('native candidate polling stopped'));
        await runtime?.shutdown();
        runtime = undefined;
        await Promise.allSettled([...candidatePollTasks]);
        assert.equal(
          echoAdapter?.activePeerCount ?? 0,
          0,
          'Pion peer remained after cleanup',
        );
        echoPionProcessesExited = true;
        for (const child of echoPionChildren) {
          if (child.exitCode === null && child.signalCode === null) {
            await Promise.race([
              new Promise<void>((resolve) =>
                child.once('exit', () => resolve()),
              ),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error('owned Pion process remained')),
                  5_000,
                ),
              ),
            ]);
          }
          assert.ok(child.exitCode !== null || child.signalCode !== null);
        }
        const database = new DatabaseSync(join(home, 'broker.sqlite'), {
          readOnly: true,
        });
        try {
          const row = database
            .prepare(
              'SELECT withdrawn_at FROM broker_leases WHERE station_id=?',
            )
            .get(trust.stationId) as
            | { withdrawn_at?: number | null }
            | undefined;
          assert.ok(
            row && row.withdrawn_at !== null,
            'broker lease remained active',
          );
          echoBrokerLeaseWithdrawn = true;
        } finally {
          database.close();
        }
      };
      cleanups.push(async () => {
        if (!turnFixture) {
          echoTurnContainerRemoved = true;
          return;
        }
        await turnFixture.stop();
        const dockerHost =
          process.platform === 'win32'
            ? 'npipe:////./pipe/docker_engine'
            : 'unix:///var/run/docker.sock';
        const remaining = await runLabCommand(
          'docker',
          [
            '--host',
            dockerHost,
            '--config',
            join(home, 'docker-config'),
            'ps',
            '-a',
            '--no-trunc',
            '--filter',
            `id=${turnContainerId}`,
            '--format',
            '{{.ID}}',
          ],
          home,
        );
        assert.equal(
          remaining.stdout.trim(),
          '',
          'owned TURN container remained',
        );
        echoTurnContainerRemoved = true;
      });
      cleanups.push(cleanupEchoRuntime);
      await runtime.start();
    };

    const startNativeEcho = async (surface: {
      kind: 'station-native';
      appIdentifier: string;
      channel: 'dev';
      clientInstanceId: string;
      keyThumbprint: string;
    }) => {
      if (
        !echoMode ||
        !runtime ||
        !echoConnector ||
        !echoSurface ||
        !echoController ||
        !candidateController ||
        nativeEchoEnabled
      )
        throw new Error('native diagnostic echo fixture is unavailable');
      if (JSON.stringify(surface) !== JSON.stringify(echoSurface))
        throw new Error('native diagnostic echo surface changed');
      candidatePollingEnabled = false;
      candidateController.abort(
        new Error('native key candidate polling complete'),
      );
      await Promise.allSettled([...candidatePollTasks]);
      assert.equal(
        candidatePollTasks.size,
        0,
        'native key candidate poll did not settle',
      );
      const database = new DatabaseSync(join(home, 'broker.sqlite'), {
        readOnly: true,
      });
      try {
        const row = database
          .prepare('SELECT withdrawn_at FROM broker_leases WHERE station_id=?')
          .get(trust.stationId) as { withdrawn_at?: number | null } | undefined;
        assert.ok(
          row && row.withdrawn_at === null,
          'single broker lease was withdrawn during native echo handoff',
        );
        candidatePollerStoppedBeforeEcho = true;
      } finally {
        database.close();
      }
      echoTurn = {
        tcp: 0,
        udp: 0,
        username: `station-shell-${randomUUID()}`,
        password: randomUUID() + randomUUID(),
      };
      mkdirSync(join(home, 'docker-config'), { recursive: true, mode: 0o700 });
      turnFixture = createTurnFixture({
        directory: home,
        username: echoTurn.username,
        password: echoTurn.password,
        signal: echoController.signal,
        lifetimeSeconds: 180,
      });
      const ports = await turnFixture.start();
      echoTurn = { ...echoTurn, ...ports };
      const dockerHost =
        process.platform === 'win32'
          ? 'npipe:////./pipe/docker_engine'
          : 'unix:///var/run/docker.sock';
      const owner = JSON.parse(
        readFileSync(join(home, 'container-owner.json'), 'utf8'),
      ) as { owner: string };
      turnContainerId = (
        await runLabCommand(
          'docker',
          [
            '--host',
            dockerHost,
            '--config',
            join(home, 'docker-config'),
            'ps',
            '-a',
            '--no-trunc',
            '--filter',
            `label=station.fixture.owner=${owner.owner}`,
            '--format',
            '{{.ID}}',
          ],
          home,
        )
      ).stdout.trim();
      assert.match(turnContainerId, /^[a-f0-9]{64}$/);

      const goExecutable = resolve(
        process.env.MISE_DATA_DIR ?? join(homedir(), '.local/share/mise'),
        'installs/go/1.26.7/bin/go',
      );
      assert.ok(
        existsSync(goExecutable),
        'pinned Go 1.26.7 toolchain is required',
      );
      const goModuleCache = join(homedir(), 'go', 'pkg', 'mod');
      assert.ok(existsSync(goModuleCache), 'Go module cache is not available');
      const pionDirectory = resolve(
        import.meta.dirname,
        '../../src-server/services/connections/pion-peer',
      );
      const pionExecutable = join(home, 'pion-peer');
      const goBuildCache = join(home, 'go-build-cache');
      mkdirSync(goBuildCache, { mode: 0o700 });
      await runLabCommand(
        '/usr/bin/env',
        [
          `GOMODCACHE=${goModuleCache}`,
          `GOCACHE=${goBuildCache}`,
          goExecutable,
          'build',
          '-mod=readonly',
          '-trimpath',
          '-o',
          pionExecutable,
          '.',
        ],
        pionDirectory,
        120_000,
      );
      assert.ok(existsSync(pionExecutable));
      const keyPath = join(home, 'station-key.pem');
      const certificatePath = join(home, 'station-cert.pem');
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
          '/CN=station-native-shell-echo',
          '-keyout',
          keyPath,
          '-out',
          certificatePath,
        ],
        home,
      );
      echoAdapter = createNativeV2PionDiagnosticAdapter(
        {
          surface,
          executable: pionExecutable,
          certificatePem: readFileSync(certificatePath, 'utf8'),
          privateKeyPem: readFileSync(keyPath, 'utf8'),
          turn: {
            url: `turn:127.0.0.1:${ports.tcp}?transport=tcp`,
            username: echoTurn.username,
            password: echoTurn.password,
          },
          trust: trustOwner,
          issuer: custody.createIssuer(
            (binding) =>
              binding.stationId === trust.stationId &&
              binding.enrollmentId === trust.enrollmentId &&
              binding.generation === trust.generation &&
              binding.connectionId === surface.clientInstanceId &&
              /^[A-Za-z0-9_-]{43}$/.test(binding.clientNonce) &&
              /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(
                binding.clientFingerprint,
              ) &&
              /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(
                binding.stationFingerprint,
              ),
          ),
        },
        {
          startAdapter: async (input) =>
            await startPionApplicationAdapter(input, {
              createTemp: createStationTempDir,
              removeTemp: removeStationTempDir,
              spawn: (command, args, options) => {
                const owned = spawnOwnedChild(command, args, options);
                echoPionChildren.push(owned.proc);
                return owned;
              },
              terminate: terminateProcessTree,
              write: writeFileSync,
              now: Date.now,
            }),
        },
      );
      nativeEchoEnabled = true;
      return Object.freeze({ ...echoTurn });
    };

    const waitForNativeEchoPoll = (signal: AbortSignal) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      const queued = nativeEchoPollResults.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<NativeEchoPollResult>((resolve, reject) => {
        let timer: NodeJS.Timeout;
        let settled = false;
        const waiter: NativeEchoPollWaiter = {
          signal,
          resolve: (value) => finish(() => resolve(value)),
          reject: (reason) => finish(() => reject(reason)),
          cleanup: () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            const index = nativeEchoPollWaiters.indexOf(waiter);
            if (index >= 0) nativeEchoPollWaiters.splice(index, 1);
          },
        };
        const finish = (settle: () => void) => {
          if (settled) return;
          settled = true;
          waiter.cleanup();
          settle();
        };
        const onAbort = () => waiter.reject(signal.reason);
        nativeEchoPollWaiters.push(waiter);
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(
          () => waiter.reject(new Error('native echo poll timed out')),
          60_000,
        );
        if (signal.aborted) onAbort();
      });
    };

    return {
      brokerOrigin,
      scope,
      trust,
      custody,
      credentials,
      service,
      issueInvitation: async (surface: {
        kind: 'station-native';
        appIdentifier: string;
        channel: 'dev';
        clientInstanceId: string;
        keyThumbprint: string;
      }) => {
        if (echoMode) await startEchoRuntime(surface);
        return await service.issueNativeInvitation({
          scope,
          routingCredential: credentials.routing,
          brokerOrigin,
          surface,
          stationSigningKeyId: await stationConnectionSigningKeyId(trust),
          stationSigningGeneration: trust.generation,
          grantTtlMs: echoMode ? 12 * 60 * 60_000 : undefined,
        });
      },
      setFailRetirement: (value: boolean) => {
        failRetirement = value;
      },
      dropNextRenewalResponse: () => {
        dropNextRenewalResponse = true;
      },
      get renewalRequests() {
        return renewalRequests;
      },
      get echoTurn() {
        return echoTurn;
      },
      get echoTurnContainerId() {
        return turnContainerId;
      },
      get echoCleanupReceipt() {
        return {
          pionProcessesExited: echoPionProcessesExited,
          brokerLeaseWithdrawn: echoBrokerLeaseWithdrawn,
          turnContainerRemoved: echoTurnContainerRemoved,
          brokerListenerClosed,
          candidatePollerStoppedBeforeEcho,
        };
      },
      startNativeEcho,
      pollNativeEcho: waitForNativeEchoPoll,
      stop,
    };
  } catch (error) {
    await stop().catch((cleanupError) => {
      console.error('broker fixture cleanup failed:', cleanupError);
      process.exitCode = 1;
    });
    throw error;
  }
}

type IpcResult<T> = { ipcResult?: T; ipcError?: string };

async function buildNativeEchoWebViewBundle() {
  const result = await build({
    entryPoints: [
      resolve(import.meta.dirname, 'native-relay-diagnostic-echo-webview.ts'),
    ],
    bundle: true,
    format: 'iife',
    globalName: 'StationNativeDiagnosticEchoAcceptance',
    platform: 'browser',
    target: 'safari17',
    write: false,
    sourcemap: false,
  });
  const source = result.outputFiles?.[0]?.text;
  assert.ok(
    source,
    'test-only native diagnostic client bundle was not emitted',
  );
  return source;
}

async function runNativeEchoInMainWebView(
  fixture: TauriShellFixture,
  bundle: string,
  input: {
    profileName: string;
    profileRevision: number;
    turnPort: number;
    turnUsername: string;
    turnPassword: string;
    tamperProof: boolean;
  },
) {
  const stateKey = '__stationNativeDiagnosticEchoShellE2E';
  const script = `
    const done = arguments[arguments.length - 1];
    const input = arguments[0];
    const stateKey = arguments[1];
    if (!window.__TAURI_INTERNALS__?.invoke) {
      done({ started: false, error: 'main_webview_tauri_ipc_missing' });
      return;
    }
    if (Object.hasOwn(window, stateKey)) {
      done({ started: false, error: 'main_webview_test_state_already_exists' });
      return;
    }
    ${bundle}
    const state = { status: 'running', value: null };
    Object.defineProperty(window, stateKey, {
      value: state,
      configurable: true,
      enumerable: false,
    });
    Promise.resolve(
      StationNativeDiagnosticEchoAcceptance.runNativeDiagnosticEchoShellAttempt(input),
    ).then(
      (value) => { state.status = 'complete'; state.value = value; },
      (error) => {
        state.status = 'complete';
        state.value = { status: 'harness-error', failure: String(error) };
      },
    );
    done({ started: true });
  `;
  const started = await fixture.driver.executeAsyncSource<
    { started: boolean; error?: string },
    [typeof input, string]
  >(script, input, stateKey);
  assert.equal(
    started.started,
    true,
    started.error ?? 'main WebView diagnostic did not start',
  );
  let completed: { status?: string; value?: unknown } | undefined;
  await fixture.driver.waitUntil(
    async () => {
      completed = await fixture.driver.execute((key) => {
        const value = (window as unknown as Record<string, unknown>)[key];
        if (!value || typeof value !== 'object') return undefined;
        return value as { status?: string; value?: unknown };
      }, stateKey);
      return completed?.status === 'complete';
    },
    {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: 'native WebView diagnostic echo client did not settle',
    },
  );
  const value = completed?.value;
  await fixture.driver.execute((key) => {
    delete (window as unknown as Record<string, unknown>)[key];
  }, stateKey);
  assert.ok(value && typeof value === 'object');
  return value as {
    status: 'resolved' | 'rejected' | 'harness-error';
    failure?: string;
    result?: { stationId: string; echoed: boolean };
    remoteDescriptionCalls: number;
    sentMessages: string[];
    createdChannels: string[];
    usedRelayCandidate: boolean;
  };
}

async function invoke<T>(
  fixture: TauriShellFixture,
  command: string,
  args: Record<string, unknown> = {},
): Promise<IpcResult<T>> {
  return fixture.driver.executeAsync<
    IpcResult<T>,
    [string, Record<string, unknown>]
  >(
    (commandName, commandArgs, done) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__?: {
            invoke?: (
              name: string,
              payload: Record<string, unknown>,
            ) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!internals?.invoke) {
        done({ ipcError: 'main WebView Tauri IPC bridge is missing' });
        return;
      }
      void internals
        .invoke(commandName, commandArgs)
        .then((ipcResult) => done({ ipcResult: ipcResult as T }))
        .catch((error: unknown) => done({ ipcError: String(error) }));
    },
    command,
    args,
  );
}

async function invokeDroppingSuccessReply<T>(
  fixture: TauriShellFixture,
  command: string,
  args: Record<string, unknown>,
): Promise<IpcResult<T>> {
  return fixture.driver.executeAsync<
    IpcResult<T>,
    [string, Record<string, unknown>]
  >(
    (commandName, commandArgs, done) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__?: {
            invoke?: (
              name: string,
              payload: Record<string, unknown>,
            ) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!internals?.invoke) {
        done({ ipcError: 'main WebView Tauri IPC bridge is missing' });
        return;
      }
      void internals
        .invoke(commandName, commandArgs)
        .then(() =>
          done({
            ipcError: 'injected successful Tauri response loss after commit',
          }),
        )
        .catch((error: unknown) => done({ ipcError: String(error) }));
    },
    command,
    args,
  );
}

function isWebDriverScriptTimeout(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'webDriverError' in error &&
    error.webDriverError === 'script timeout'
  );
}

async function navigateToRelayApprovalSurface(fixture: TauriShellFixture) {
  const url = 'tauri://localhost/connections/computers';
  let navigationTimedOut = false;
  try {
    await fixture.driver.navigate(url);
  } catch (error) {
    if (!isWebDriverScriptTimeout(error)) throw error;
    navigationTimedOut = true;
  }
  let prepare: string | undefined;
  const waitForPrepare = (timeout: number) =>
    fixture.driver.waitUntil(
      async () => {
        prepare = await fixture.driver.findElement(
          '.relay-route-key-approval__prepare button',
        );
        return Boolean(prepare);
      },
      {
        timeout,
        timeoutMsg: 'saved relay route did not expose native proof preparation',
      },
    );
  try {
    await waitForPrepare(navigationTimedOut ? 10_000 : 60_000);
  } catch (error) {
    if (!navigationTimedOut) throw error;
    try {
      await fixture.driver.navigate(url);
    } catch (retryError) {
      if (!isWebDriverScriptTimeout(retryError)) throw retryError;
    }
    await waitForPrepare(60_000);
  }
  assert.ok(prepare, 'saved route did not expose native proof preparation');
  return prepare;
}

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('native relay grant lifecycle shell proof requires macOS');
  const clientInstanceId = randomUUID();
  const ownerIndex = ownerIndexItem();
  assert.equal(
    keychainStatus(ownerIndex),
    44,
    'dedicated native grant shell owner index already exists; refusing to overwrite it',
  );
  assert.equal(
    keychainStatus(grantIndexItem(clientInstanceId)),
    44,
    'dedicated native grant index already exists; refusing to overwrite it',
  );
  assert.equal(
    keychainStatus(grantCleanupIndexItem(clientInstanceId)),
    44,
    'dedicated native grant cleanup index already exists; refusing to overwrite it',
  );
  const broker = await startBroker(NATIVE_ECHO_LANE);
  const proof = proofItem(clientInstanceId);
  const trust = trustItem(broker.trust.stationId);
  const route = {
    name: `relay-grant-${clientInstanceId.slice(0, 8)}`,
    endpoint: 'https://station.example',
    brokerOrigin: broker.brokerOrigin,
    stationId: broker.trust.stationId,
    enrollmentId: broker.trust.enrollmentId,
    clientInstanceId,
  };
  let fixture: TauriShellFixture | undefined;
  let grantId: string | undefined;
  let cleanupId: string | undefined;
  let expectedProfileRevision = 0;
  let grantCustodyStatusVerified = false;
  let lostRedeemResponseRecovered = false;
  let lostRenewalResponseRecovered = false;
  let nativeEchoEvidence:
    | {
        readonly negativeProofRejectedBeforeSdp: boolean;
        readonly validProofAppliedOnce: boolean;
        readonly candidatePollerStoppedBeforeEcho: boolean;
        readonly lostRedeemResponseRecovered: boolean;
        readonly lostRenewalResponseRecovered: boolean;
        readonly echoed: string;
        readonly turnContainerId: string;
      }
    | undefined;
  const ownedItems: KeychainItem[] = [
    proof,
    trust,
    grantIndexItem(clientInstanceId),
    grantCleanupIndexItem(clientInstanceId),
  ];
  let journeyFailed = false;
  let journeyError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    fixture = await startTauriShellFixture({
      seedRemoteProfile: false,
      seedRelayRoute: route,
      realCredentialStore: true,
    });
    const driver = fixture.driver;
    const prepare = await navigateToRelayApprovalSurface(fixture);
    trackFixtureLocalBearerItems(fixture.stationRoot, ownedItems);
    await driver.clickElement(prepare);
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.findElement(
            'section[aria-label="Public install proof metadata"]',
          ),
        ),
      {
        timeout: 30_000,
        timeoutMsg: 'proof key metadata did not reach the WebView',
      },
    );
    const surface = await driver.execute(() => {
      const section = document.querySelector(
        'section[aria-label="Public install proof metadata"]',
      );
      if (!section) return null;
      return Object.fromEntries(
        Array.from(section.querySelectorAll('dl > div')).map((entry) => [
          entry.querySelector('dt')?.textContent?.trim() ?? '',
          entry.querySelector('dd')?.textContent?.trim() ?? '',
        ]),
      );
    });
    assert.ok(surface);
    assert.equal(surface.App, APP_IDENTIFIER);
    assert.equal(surface.Channel, 'dev');
    assert.equal(surface['Client instance'], clientInstanceId);
    assert.equal(
      keychainStatus(proof),
      0,
      'proof private key is not in Keychain',
    );
    let echoBundle: string | undefined;
    if (NATIVE_ECHO_LANE) echoBundle = await buildNativeEchoWebViewBundle();
    const invitation = await broker.issueInvitation({
      kind: 'station-native',
      appIdentifier: surface.App,
      channel: 'dev',
      clientInstanceId,
      keyThumbprint: surface['Key thumbprint'],
    });
    const invitationInput = await driver.findElement(
      'section[aria-label="Public install proof metadata"] textarea',
    );
    const discover = await driver.findElement(
      'section[aria-label="Public install proof metadata"] > button:nth-of-type(2)',
    );
    assert.ok(invitationInput && discover);
    await driver.typeElement(invitationInput, JSON.stringify(invitation));
    await driver.clickElement(discover);
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.findElement(
            'section[aria-label="Candidate from native verification"]',
          ),
        ),
      {
        timeout: 30_000,
        timeoutMsg: 'signed Station candidate did not reach the WebView',
      },
    );
    const keyId = await stationConnectionSigningKeyId(broker.trust);
    const confirmation = await stationConnectionKeyConfirmationCode(
      broker.trust,
    );
    const codeInput = await driver.findElement(
      'section[aria-label="Candidate from native verification"] input[id$="-code"]',
    );
    const keyInput = await driver.findElement(
      'section[aria-label="Candidate from native verification"] input[id$="-key-id"]',
    );
    const attestation = await driver.findElement(
      '.relay-route-key-approval__attestation input',
    );
    assert.ok(codeInput && keyInput && attestation);
    await driver.typeElement(
      codeInput,
      formatStationConnectionKeyConfirmationCode(confirmation).toLowerCase(),
    );
    await driver.typeElement(keyInput, keyId);
    await driver.clickElement(attestation);
    const approve = await driver.findElement(
      'section[aria-label="Candidate from native verification"] > button:first-of-type',
    );
    assert.ok(approve);
    await driver.clickElement(approve);
    try {
      await driver.waitUntil(
        async () =>
          Boolean(
            await driver.execute(() =>
              document
                .querySelector('.relay-route-key-approval')
                ?.textContent?.includes('Station key approved'),
            ),
          ),
        {
          timeout: 30_000,
          timeoutMsg: 'operator-approved trust was not committed',
        },
      );
    } catch (error) {
      const state = await driver.execute(() => {
        const root = document.querySelector('.relay-route-key-approval');
        const section = document.querySelector(
          'section[aria-label="Candidate from native verification"]',
        );
        const button = section?.querySelector('button');
        const code =
          section?.querySelector<HTMLInputElement>('input[id$="-code"]');
        const key = section?.querySelector<HTMLInputElement>(
          'input[id$="-key-id"]',
        );
        const attestation = document.querySelector<HTMLInputElement>(
          '.relay-route-key-approval__attestation input',
        );
        return {
          candidatePresent: Boolean(section),
          buttonText: button?.textContent?.trim() ?? null,
          buttonDisabled: button?.hasAttribute('disabled') ?? null,
          codeLength: code?.value.length ?? null,
          keyLength: key?.value.length ?? null,
          attested: attestation?.checked ?? null,
          approvedVisible:
            root?.textContent?.includes('Station key approved') ?? false,
        };
      });
      throw new Error(
        `operator-approved trust was not committed: ${JSON.stringify(state)}`,
        { cause: error },
      );
    }
    assert.equal(
      keychainStatus(trust),
      0,
      'approved Station trust is not in Keychain',
    );
    const savedProfiles = JSON.parse(
      readFileSync(
        join(fixture.stationRoot, 'config', 'profiles.json'),
        'utf8',
      ),
    ) as { revision?: number; profiles?: Array<{ name?: string }> };
    trackFixtureLocalBearerItems(fixture.stationRoot, ownedItems);
    assert.ok(
      Number.isSafeInteger(savedProfiles.revision),
      'isolated saved Station store has no valid revision',
    );
    assert.ok(
      savedProfiles.profiles?.some((profile) => profile.name === route.name),
      'isolated saved Station disappeared before grant redemption',
    );
    expectedProfileRevision = savedProfiles.revision as number;
    console.log(
      `native relay grant fixture profile revision: ${expectedProfileRevision}`,
    );
    if (NATIVE_ECHO_LANE)
      await broker.startNativeEcho({
        kind: 'station-native',
        appIdentifier: surface.App,
        channel: 'dev',
        clientInstanceId,
        keyThumbprint: surface['Key thumbprint'],
      });

    const initialStatus = await invoke<{
      grants?: unknown[];
      cleanups?: unknown[];
    }>(fixture, 'station_native_relay_grant_status', {
      profileName: route.name,
    });
    assert.ok(
      initialStatus.ipcResult,
      initialStatus.ipcError ?? 'grant status IPC failed',
    );
    assert.deepEqual(initialStatus.ipcResult.grants, []);

    if (NATIVE_ECHO_LANE) broker.dropNextRenewalResponse();
    const redemption = NATIVE_ECHO_LANE
      ? await invokeDroppingSuccessReply<{
          status?: string;
          grant?: { route?: { grantId?: string } };
          failure?: { primary?: string; cleanup?: unknown; recovery?: unknown };
        }>(fixture, 'station_native_relay_grant_redeem', {
          profileName: route.name,
          expectedProfileRevision,
          invitation,
        })
      : await invoke<{
          status?: string;
          grant?: { route?: { grantId?: string } };
          failure?: { primary?: string; cleanup?: unknown; recovery?: unknown };
        }>(fixture, 'station_native_relay_grant_redeem', {
          profileName: route.name,
          expectedProfileRevision,
          invitation,
        });
    if (NATIVE_ECHO_LANE) {
      assert.equal(
        redemption.ipcError,
        'injected successful Tauri response loss after commit',
      );
      lostRedeemResponseRecovered = true;
    } else {
      assert.ok(
        redemption.ipcResult,
        redemption.ipcError ?? 'grant redemption IPC failed',
      );
      assert.equal(
        redemption.ipcResult.status,
        'redeemed',
        `secret-free redemption failure: ${JSON.stringify(redemption.ipcResult.failure)}`,
      );
    }

    const afterRedeem = await invoke<{
      profileRevision?: number;
      grants?: Array<{
        metadata?: {
          expiresAt?: number;
          route?: {
            brokerOrigin?: string;
            stationId?: string;
            enrollmentId?: string;
            routingGeneration?: number;
            grantId?: string;
          };
        };
      }>;
    }>(fixture, 'station_native_relay_grant_status', {
      profileName: route.name,
    });
    assert.ok(
      afterRedeem.ipcResult,
      afterRedeem.ipcError ?? 'post-redemption status IPC failed',
    );
    assert.equal(
      afterRedeem.ipcResult.profileRevision,
      expectedProfileRevision,
    );
    assert.equal(afterRedeem.ipcResult.grants?.length, 1);
    const recoveredRoute = afterRedeem.ipcResult.grants?.[0]?.metadata?.route;
    grantId = recoveredRoute?.grantId;
    assert.ok(
      grantId,
      'host status did not recover the committed grant identity',
    );
    assert.equal(recoveredRoute?.brokerOrigin, broker.brokerOrigin);
    assert.equal(recoveredRoute?.stationId, broker.trust.stationId);
    assert.equal(recoveredRoute?.enrollmentId, broker.trust.enrollmentId);
    assert.equal(recoveredRoute?.routingGeneration, 1);
    if (!NATIVE_ECHO_LANE)
      assert.equal(redemption.ipcResult?.grant?.route?.grantId, grantId);
    ownedItems.push(
      grantItem(clientInstanceId, {
        brokerOrigin: recoveredRoute?.brokerOrigin ?? '',
        stationId: recoveredRoute?.stationId ?? '',
        enrollmentId: recoveredRoute?.enrollmentId ?? '',
        routingGeneration: recoveredRoute?.routingGeneration ?? 0,
        grantId,
      }),
    );

    if (NATIVE_ECHO_LANE) {
      await driver.execute(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await driver.waitUntil(
        async () => {
          if (broker.renewalRequests < 2) return false;
          const current = await invoke<{
            grants?: Array<{ metadata?: { expiresAt?: number } }>;
          }>(fixture!, 'station_native_relay_grant_status', {
            profileName: route.name,
          });
          return (
            (current.ipcResult?.grants?.[0]?.metadata?.expiresAt ?? 0) >
            Date.now() + 18 * 60 * 60_000
          );
        },
        {
          timeout: 45_000,
          timeoutMsg:
            'native supervisor did not recover the lost renewal receipt',
        },
      );
      const beforeStaleRenewal = broker.renewalRequests;
      const staleRenewal = await invoke<unknown>(
        fixture,
        'station_native_relay_grant_renew',
        {
          profileName: route.name,
          expectedProfileRevision: expectedProfileRevision + 1,
        },
      );
      assert.equal(staleRenewal.ipcResult, undefined);
      assert.match(staleRenewal.ipcError ?? '', /could not renew/i);
      assert.equal(
        broker.renewalRequests,
        beforeStaleRenewal,
        'stale profile revision reached broker renewal',
      );
      lostRenewalResponseRecovered = true;
      assert.ok(echoBundle, 'test-only WebView echo bundle is missing');
      const echoTurn = broker.echoTurn;
      assert.ok(echoTurn, 'loopback TURN fixture was not started');
      const runAttempt = async (tamperProof: boolean) => {
        const pollController = new AbortController();
        const stationPoll = broker
          .pollNativeEcho(pollController.signal)
          .then((value) => ({ kind: 'result' as const, value }))
          .catch((error: unknown) => ({ kind: 'error' as const, error }));
        try {
          const webView = await runNativeEchoInMainWebView(
            fixture!,
            echoBundle!,
            {
              profileName: route.name,
              profileRevision: expectedProfileRevision,
              turnPort: echoTurn.tcp,
              turnUsername: echoTurn.username,
              turnPassword: echoTurn.password,
              tamperProof,
            },
          );
          const station = await stationPoll;
          if (station.kind === 'error') throw station.error;
          return { webView, station: station.value };
        } catch (error) {
          pollController.abort(error);
          await stationPoll;
          throw error;
        }
      };

      const rejected = await runAttempt(true);
      assert.equal(rejected.webView.status, 'rejected');
      assert.match(
        rejected.webView.failure ?? '',
        /connection_proof_refused/,
        'a substituted Station proof was not rejected by the real client',
      );
      assert.equal(
        rejected.webView.remoteDescriptionCalls,
        0,
        'invalid Station proof reached RTCPeerConnection.setRemoteDescription',
      );
      assert.deepEqual(rejected.webView.sentMessages, []);
      assert.deepEqual(rejected.webView.createdChannels, ['station-lab-v1']);
      assert.deepEqual(rejected.station.diagnosticEchoes ?? [], []);

      const accepted = await runAttempt(false);
      assert.equal(accepted.webView.status, 'resolved');
      assert.equal(accepted.webView.result?.echoed, true);
      assert.equal(accepted.webView.result?.stationId, broker.trust.stationId);
      assert.equal(accepted.webView.remoteDescriptionCalls, 1);
      assert.equal(accepted.webView.usedRelayCandidate, true);
      assert.deepEqual(accepted.webView.createdChannels, ['station-lab-v1']);
      assert.equal(accepted.webView.sentMessages.length, 1);
      assert.equal(accepted.webView.sentMessages[0]?.length, 43);
      assert.deepEqual(
        accepted.station.diagnosticEchoes,
        accepted.webView.sentMessages,
      );
      assert.equal(accepted.station.observed, 1);
      assert.equal(accepted.station.answered, 1);
      assert.equal(
        broker.echoCleanupReceipt.candidatePollerStoppedBeforeEcho,
        true,
      );
      const echoContainerId = broker.echoTurnContainerId;
      assert.ok(echoContainerId, 'owned TURN container identity is missing');
      nativeEchoEvidence = {
        negativeProofRejectedBeforeSdp: true,
        validProofAppliedOnce: true,
        candidatePollerStoppedBeforeEcho:
          broker.echoCleanupReceipt.candidatePollerStoppedBeforeEcho,
        lostRedeemResponseRecovered,
        lostRenewalResponseRecovered,
        echoed: accepted.webView.sentMessages[0]!,
        turnContainerId: echoContainerId,
      };
    }

    broker.setFailRetirement(true);
    const revoke = await invoke<{
      grants?: unknown[];
      cleanups?: Array<{ cleanupId?: string }>;
    }>(fixture, 'station_native_relay_grant_revoke', {
      profileName: route.name,
      expectedProfileRevision,
    });
    assert.ok(revoke.ipcResult, revoke.ipcError ?? 'grant revoke IPC failed');
    assert.deepEqual(revoke.ipcResult.grants, []);
    cleanupId = revoke.ipcResult.cleanups?.[0]?.cleanupId;
    assert.ok(
      cleanupId,
      'broker failure did not remain in durable cleanup status',
    );
    const pending = await invoke<Array<{ cleanupId?: string }>>(
      fixture,
      'station_native_relay_grant_cleanup_pending',
    );
    assert.ok(
      pending.ipcResult,
      pending.ipcError ?? 'pending cleanup IPC failed',
    );
    assert.ok(pending.ipcResult.some((item) => item.cleanupId === cleanupId));

    broker.setFailRetirement(false);
    const retried = await invoke<Array<{ cleanupId?: string }>>(
      fixture,
      'station_native_relay_grant_cleanup_retry',
      { cleanupId },
    );
    assert.ok(
      retried.ipcResult,
      retried.ipcError ?? 'cleanup retry IPC failed',
    );
    assert.ok(!retried.ipcResult.some((item) => item.cleanupId === cleanupId));
    const finalStatus = await invoke<{
      grants?: unknown[];
      cleanups?: unknown[];
    }>(fixture, 'station_native_relay_grant_status', {
      profileName: route.name,
    });
    assert.ok(
      finalStatus.ipcResult,
      finalStatus.ipcError ?? 'final grant status IPC failed',
    );
    assert.deepEqual(finalStatus.ipcResult.grants, []);
    assert.deepEqual(finalStatus.ipcResult.cleanups, []);
    assert.equal(
      keychainStatus(proof),
      0,
      'proof key unexpectedly disappeared before cleanup',
    );
    assert.equal(
      keychainStatus(trust),
      0,
      'approved trust unexpectedly disappeared before cleanup',
    );

    const outputDir = resolve(
      import.meta.dirname,
      '../../.kontourai/tauri-shell-e2e',
    );
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, 'native-relay-grant-lifecycle.png'),
      await driver.screenshot(),
    );
    console.log(
      `native relay grant lifecycle: main WebView IPC redeemed ${grantId}, persisted status, staged retirement failure ${cleanupId}, then retried cleanup; source ${process.env.STATION_TAURI_E2E_SOURCE_SHA ?? 'unrecorded'}`,
    );
    if (INJECT_ECHO_JOURNEY_FAILURE)
      throw new Error('injected native echo journey failure');
  } catch (error) {
    journeyFailed = true;
    journeyError = error;
  } finally {
    try {
      if (fixture && expectedProfileRevision > 0) {
        try {
          // Also cover assertion/driver failures after a broker grant was
          // returned but before its ID could be added to the local cleanup
          // ledger. Route revoke discovers only this saved profile's grants.
          broker.setFailRetirement(false);
          const recovered = await invoke<{
            grants?: unknown[];
            cleanups?: Array<{ cleanupId?: string }>;
          }>(fixture, 'station_native_relay_grant_revoke', {
            profileName: route.name,
            expectedProfileRevision,
          });
          if (!recovered.ipcResult) {
            console.error(
              'fixture route cleanup did not complete:',
              recovered.ipcError,
            );
            process.exitCode = 1;
          } else {
            for (const cleanup of recovered.ipcResult.cleanups ?? []) {
              if (!cleanup.cleanupId) continue;
              const retried = await invoke<Array<{ cleanupId?: string }>>(
                fixture,
                'station_native_relay_grant_cleanup_retry',
                { cleanupId: cleanup.cleanupId },
              );
              if (
                !retried.ipcResult ||
                retried.ipcResult.some(
                  (item) => item.cleanupId === cleanup.cleanupId,
                )
              ) {
                console.error(
                  'fixture cleanup remains pending:',
                  cleanup.cleanupId,
                  retried.ipcError,
                );
                process.exitCode = 1;
              }
            }
          }
        } catch (error) {
          console.error(
            'fixture route cleanup invocation failed:',
            String(error),
          );
          process.exitCode = 1;
        }
      }
      if (!fixture || expectedProfileRevision === 0) {
        grantCustodyStatusVerified = true;
      } else {
        try {
          const finalStatus = await invoke<{
            grants?: Array<{
              metadata?: {
                route?: {
                  brokerOrigin?: string;
                  stationId?: string;
                  enrollmentId?: string;
                  routingGeneration?: number;
                  grantId?: string;
                };
              };
            }>;
            cleanups?: Array<{
              route?: {
                brokerOrigin?: string;
                stationId?: string;
                enrollmentId?: string;
                routingGeneration?: number;
                grantId?: string;
              };
            }>;
          }>(fixture, 'station_native_relay_grant_status', {
            profileName: route.name,
          });
          const registeredOwners = await invoke<
            Array<{ cleanupId?: string; route?: { grantId?: string } }>
          >(fixture, 'station_native_relay_grant_cleanup_pending');
          const addIndexedGrant = (value: {
            brokerOrigin?: string;
            stationId?: string;
            enrollmentId?: string;
            routingGeneration?: number;
            grantId?: string;
          }) => {
            if (
              !value.brokerOrigin ||
              !value.stationId ||
              !value.enrollmentId ||
              !Number.isSafeInteger(value.routingGeneration) ||
              !value.grantId
            )
              return;
            const item = grantItem(clientInstanceId, {
              brokerOrigin: value.brokerOrigin,
              stationId: value.stationId,
              enrollmentId: value.enrollmentId,
              routingGeneration: value.routingGeneration as number,
              grantId: value.grantId,
            });
            if (!ownedItems.some((owned) => owned.account === item.account))
              ownedItems.push(item);
          };
          for (const item of finalStatus.ipcResult?.grants ?? [])
            if (item.metadata?.route) addIndexedGrant(item.metadata.route);
          for (const item of finalStatus.ipcResult?.cleanups ?? [])
            if (item.route) addIndexedGrant(item.route);

          grantCustodyStatusVerified =
            !!finalStatus.ipcResult &&
            Array.isArray(finalStatus.ipcResult.grants) &&
            finalStatus.ipcResult.grants.length === 0 &&
            Array.isArray(finalStatus.ipcResult.cleanups) &&
            finalStatus.ipcResult.cleanups.length === 0 &&
            !!registeredOwners.ipcResult &&
            registeredOwners.ipcResult.length === 0;
          if (NATIVE_ECHO_LANE) {
            console.log(
              `STATION_NATIVE_RELAY_GRANT_CLEANUP_STATUS ${JSON.stringify({
                profileRevision: expectedProfileRevision,
                stationId: route.stationId,
                enrollmentId: route.enrollmentId,
                grantStatusAvailable: !!finalStatus.ipcResult,
                grantStatusErrorPresent: !!finalStatus.ipcError,
                grantCount: finalStatus.ipcResult?.grants?.length ?? null,
                cleanupCount: finalStatus.ipcResult?.cleanups?.length ?? null,
                ownerRegistryAvailable: !!registeredOwners.ipcResult,
                ownerRegistryErrorPresent: !!registeredOwners.ipcError,
                pendingOwnerCount: registeredOwners.ipcResult?.length ?? null,
                ownerIndexEmpty:
                  !!registeredOwners.ipcResult &&
                  registeredOwners.ipcResult.length === 0,
                custodyVerified: grantCustodyStatusVerified,
              })}`,
            );
          }
          if (!grantCustodyStatusVerified) {
            console.error(
              'fixture native grant owner registry could not be proven empty; retaining owned native Keychain custody',
              finalStatus.ipcError,
              registeredOwners.ipcError,
            );
            process.exitCode = 1;
          }
        } catch (error) {
          console.error(
            'fixture native grant owner registry could not be read; retaining owned native Keychain custody:',
            String(error),
          );
          process.exitCode = 1;
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try {
        await fixture?.stop();
        if (INJECT_ECHO_CLEANUP_FAILURE)
          cleanupErrors.push(new Error('injected native echo cleanup failure'));
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (NATIVE_ECHO_LANE && fixture?.cleanupReceipt)
        console.log(
          `STATION_TAURI_SHELL_FIXTURE_STOP ${JSON.stringify(fixture.cleanupReceipt)}`,
        );
      try {
        await broker.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const item of ownedItems) {
        const nativeCustodyItem =
          item.service === PROOF_SERVICE ||
          item.service === TRUST_SERVICE ||
          item.account.startsWith('relay-native-client-grant:');
        const fixtureProfileBearer = item.account.startsWith(
          'profile:station-bearer:local-grant:',
        );
        if (
          grantCustodyStatusVerified ||
          !nativeCustodyItem ||
          fixtureProfileBearer
        ) {
          try {
            keychainDelete(item);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
      if (grantCustodyStatusVerified) {
        try {
          keychainDelete(ownerIndex);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (
        NATIVE_ECHO_LANE &&
        nativeEchoEvidence &&
        !journeyFailed &&
        cleanupErrors.length === 0 &&
        process.exitCode !== 1
      ) {
        const receipt = fixture?.cleanupReceipt;
        assert.equal(receipt?.processGroupSettled, true);
        assert.equal(receipt?.fixtureRootRemoved, true);
        assert.equal(receipt?.fixtureRootExistsAfterQuietPeriod, false);
        assert.equal(grantCustodyStatusVerified, true);
        assert.deepEqual(broker.echoCleanupReceipt, {
          pionProcessesExited: true,
          brokerLeaseWithdrawn: true,
          turnContainerRemoved: true,
          brokerListenerClosed: true,
          candidatePollerStoppedBeforeEcho: true,
        });
        for (const item of ownedItems) assert.equal(keychainStatus(item), 44);
        assert.equal(keychainStatus(ownerIndex), 44);
        console.log(
          `STATION_NATIVE_RELAY_TAURI_ECHO ${JSON.stringify({
            sourceSha: process.env.STATION_TAURI_E2E_SOURCE_SHA ?? 'unrecorded',
            appIdentifier: APP_IDENTIFIER,
            negativeProofRejectedBeforeRemoteSdp:
              nativeEchoEvidence.negativeProofRejectedBeforeSdp,
            validProofAppliedOnce: nativeEchoEvidence.validProofAppliedOnce,
            candidatePollerStoppedBeforeEcho:
              nativeEchoEvidence.candidatePollerStoppedBeforeEcho,
            lostRedeemResponseRecovered:
              nativeEchoEvidence.lostRedeemResponseRecovered,
            lostRenewalResponseRecovered:
              nativeEchoEvidence.lostRenewalResponseRecovered,
            dataChannel: 'station-lab-v1',
            echoed: true,
            turnContainerId: nativeEchoEvidence.turnContainerId,
            cleanup: {
              exactKeychainItemsRemoved: true,
              ...broker.echoCleanupReceipt,
            },
          })}`,
        );
      }
    }
  }
  const terminalErrors = [
    ...(journeyFailed ? [journeyError] : []),
    ...cleanupErrors,
  ];
  if (terminalErrors.length === 1) throw terminalErrors[0];
  if (terminalErrors.length > 1)
    throw new AggregateError(
      terminalErrors,
      'Native relay shell journey failed',
    );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
