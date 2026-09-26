/**
 * Free, opt-in real local Station native-relay diagnostic acceptance.
 *
 * This fixture runs the real loopback broker HTTP routes, a Chromium WebRTC
 * client, a pinned local coturn container, the real Station signer/trust store,
 * the native-v2 broker client/connector and the real Pion diagnosticEcho
 * process. It never mounts in Station startup or opens an application channel.
 * Run only with: npm run lab:native-relay-diagnostic-echo -- --run-real-local-lab
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import {
  SELF_HOSTED_BROKER_NATIVE_REQUEST_PROOF_TYPE,
  type SelfHostedBrokerNativeClientGrantV2,
  type SelfHostedBrokerNativeClientSurfaceV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  connectionDescriptionDigest,
  createStationConnectionProofVerifier,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import {
  createStationTempDir,
  removeStationTempDir,
} from '@kontourai/station-shared/temp-dir';
import { Hono } from 'hono';
import {
  CompactSign,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { chromium } from 'playwright';
import { createSelfHostedBrokerRoutes } from '../src-server/routes/connections/self-hosted-broker.js';
import { createNativeV2PionDiagnosticLab } from '../src-server/services/connections/native-v2-pion-diagnostic-lab.js';
import { startPionApplicationAdapter } from '../src-server/services/connections/pion-application-adapter.js';
import {
  SelfHostedBrokerClient,
  SelfHostedBrokerNativeClient,
} from '../src-server/services/connections/self-hosted-broker-client.js';
import {
  createBrokerCredentialBundle,
  SelfHostedBrokerService,
  serializeNativeBrokerRedemptionPayload,
} from '../src-server/services/connections/self-hosted-broker-service.js';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../src-server/services/infra/process-utils.js';
import { ConnectionSigningKeyStore } from '../src-server/services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../src-server/services/ssh/environment-security-service.js';
import { runLabCommand } from './lib/local-collaboration-process.mjs';
import { createTurnFixture } from './lib/turn-fixture.js';

const optIn = '--run-real-local-lab';
if (!process.argv.includes(optIn)) {
  throw new Error(
    `This starts local Chromium, coturn and Pion. Repeat with ${optIn} to opt in.`,
  );
}
if (process.platform === 'win32')
  throw new Error('native_relay_diagnostic_echo_local_lab_requires_posix');

process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), 'station-native-echo-lab-'));
chmodSync(root, 0o700);
const controller = new AbortController();
const abort = (signal: string) =>
  controller.abort(new Error(`native echo lab interrupted by ${signal}`));
const onInt = () => abort('SIGINT');
const onTerm = () => abort('SIGTERM');
process.once('SIGINT', onInt);
process.once('SIGTERM', onTerm);

const turnUsername = 'station-lab';
const turnPassword = randomBytes(24).toString('hex');
const turn = createTurnFixture({
  directory: root,
  username: turnUsername,
  password: turnPassword,
  signal: controller.signal,
  lifetimeSeconds: 180,
});
let turnStarted = false;
let turnTcpPort: number | undefined;
let turnUdpPort: number | undefined;
let broker: SelfHostedBrokerService | undefined;
let brokerServer: ReturnType<typeof serve> | undefined;
let stationLab: ReturnType<typeof createNativeV2PionDiagnosticLab> | undefined;
let nativeClient: SelfHostedBrokerNativeClient | undefined;
let browserServer:
  | Awaited<ReturnType<typeof chromium.launchServer>>
  | undefined;
let browser: Awaited<ReturnType<typeof chromium.connect>> | undefined;
let pionPid: number | undefined;
let connectorRegistered = false;
let nativeGrantRedeemed = false;
let nativeGrantRevoked = false;
let echoConfirmed = false;
let sourceSha = 'unavailable';
let pionExecutableSha256: string | undefined;
let browserPid: number | undefined;
let brokerPort: number | undefined;
let connectorWithdrawn = false;
let stationPeerRetired = false;
let turnOwner: { owner: string; name: string; image: string } | undefined;
let turnContainerId: string | undefined;
let acceptanceReceipt: Record<string, unknown> | undefined;
let brokerStateAfterCleanup: string | undefined;
let brokerStationId: string | undefined;
let brokerLeaseWithdrawn = false;
let turnStoppedOnCleanup = false;
let brokerDatabasePath: string | undefined;
const cleanupErrors: string[] = [];

type BrowserDiagnosticChannel = {
  readonly label: string;
  readonly readyState: string;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  send(value: string): void;
};
type BrowserDiagnosticPeer = {
  readonly iceGatheringState: string;
  readonly localDescription: {
    readonly type: string;
    readonly sdp: string;
  } | null;
  readonly remoteDescription: unknown | null;
  createDataChannel(label: string): BrowserDiagnosticChannel;
  addEventListener(type: string, listener: () => void): void;
  createOffer(): Promise<{ readonly type: string; readonly sdp: string }>;
  setLocalDescription(description: {
    readonly type: string;
    readonly sdp: string;
  }): Promise<void>;
  setRemoteDescription(description: {
    readonly type: 'answer';
    readonly sdp: string;
  }): Promise<void>;
};
type BrowserDiagnosticState = {
  readonly peer: BrowserDiagnosticPeer;
  readonly channel: BrowserDiagnosticChannel;
  readonly received: string[];
};

declare const RTCPeerConnection: new (configuration: {
  iceServers: Array<{
    urls: string;
    username: string;
    credential: string;
  }>;
  iceTransportPolicy: 'relay';
}) => BrowserDiagnosticPeer;
type BrowserWindow = {
  __stationEcho?: BrowserDiagnosticState;
};

async function closeServer(server: ReturnType<typeof serve>) {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

function fingerprint(sdp: string) {
  const matches = [...sdp.matchAll(/^a=fingerprint:sha-256 (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  );
  const values = [...new Set(matches)];
  assert.equal(values.length, 1, 'SDP must contain one SHA-256 fingerprint');
  assert.match(values[0]!, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  return values[0]!;
}

function compactJws(
  payload: Uint8Array,
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'],
  typ: string,
) {
  return new CompactSign(payload)
    .setProtectedHeader({ alg: 'ES256', typ })
    .sign(privateKey);
}

async function main() {
  const git = await runLabCommand('git', ['rev-parse', 'HEAD'], process.cwd());
  sourceSha = git.stdout.trim();
  assert.match(sourceSha, /^[0-9a-f]{40}$/);

  const identityHome = join(root, 'station-home');
  mkdirSync(identityHome, { mode: 0o700 });
  await new EnvironmentSecurityService({ homeDir: identityHome }).initialize();
  const stationKeys = new ConnectionSigningKeyStore(identityHome);
  const approvedTrust = await stationKeys.initialize();
  const trustOwner = {
    current: () => stationKeys.readDescriptor(),
    isCurrent: (value: typeof approvedTrust) =>
      JSON.stringify(value) === JSON.stringify(stationKeys.readDescriptor()),
  };

  const databasePath = join(root, 'broker.sqlite');
  brokerDatabasePath = databasePath;
  broker = new SelfHostedBrokerService(databasePath);
  const scope = {
    stationId: approvedTrust.stationId,
    enrollmentId: approvedTrust.enrollmentId,
    routingGeneration: 1,
    browserOrigin: 'https://station.example',
  };
  brokerStationId = scope.stationId;
  const credentials = createBrokerCredentialBundle();
  broker.provision(scope, 600_000, credentials);
  const app = new Hono().route(
    '/broker/v1',
    createSelfHostedBrokerRoutes(broker),
  );
  brokerServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolveListening, reject) => {
    brokerServer!.once('listening', resolveListening);
    brokerServer!.once('error', reject);
  });
  const brokerAddress = brokerServer.address();
  assert.ok(brokerAddress && typeof brokerAddress !== 'string');
  assert.equal(brokerAddress.address, '127.0.0.1');
  brokerPort = brokerAddress.port;
  const brokerOrigin = `http://127.0.0.1:${brokerPort}`;

  const turnPorts = await turn.start();
  turnStarted = true;
  turnTcpPort = turnPorts.tcp;
  turnUdpPort = turnPorts.udp;
  const startedTurnOwner = JSON.parse(
    readFileSync(join(root, 'container-owner.json'), 'utf8'),
  ) as { owner: string; name: string; image: string };
  turnOwner = startedTurnOwner;
  const dockerHost =
    process.platform === 'win32'
      ? 'npipe:////./pipe/docker_engine'
      : 'unix:///var/run/docker.sock';
  const ownedTurnContainers = await runLabCommand(
    'docker',
    [
      '--host',
      dockerHost,
      '--config',
      join(root, 'docker-config'),
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      `label=station.fixture.owner=${startedTurnOwner.owner}`,
      '--format',
      '{{.ID}}',
    ],
    root,
  );
  turnContainerId = ownedTurnContainers.stdout.trim();
  assert.match(turnContainerId, /^[a-f0-9]{64}$/);

  const pionDirectory = resolve('src-server/services/connections/pion-peer');
  const pionExecutable = join(root, 'pion-peer');
  const goExecutable = resolve(
    process.env.MISE_DATA_DIR ?? join(homedir(), '.local/share/mise'),
    'installs/go/1.26.7/bin/go',
  );
  assert.ok(existsSync(goExecutable), 'pinned Go 1.26.7 toolchain is required');
  const goModuleCache = join(homedir(), 'go', 'pkg', 'mod');
  assert.ok(existsSync(goModuleCache), 'Go module cache is not available');
  const goBuildCache = join(root, 'go-build-cache');
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
  pionExecutableSha256 = createHash('sha256')
    .update(readFileSync(pionExecutable))
    .digest('hex');

  const keyPair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(keyPair.publicKey);
  const proofPublicKey = {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: publicJwk.x!,
    y: publicJwk.y!,
  };
  const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
    kind: 'station-native',
    appIdentifier: 'io.kontourai.station.local-echo-lab',
    channel: 'dev',
    clientInstanceId: randomUUID(),
    keyThumbprint: await calculateJwkThumbprint(proofPublicKey),
  };

  // Chromium owns the initiating peer and creates only the diagnostic channel.
  browserServer = await chromium.launchServer({ headless: true });
  browserPid = browserServer.process().pid;
  browser = await chromium.connect({ wsEndpoint: browserServer.wsEndpoint() });
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  await page.goto('about:blank');
  const offer = await page.evaluate(
    async ({ port, username, password }) => {
      const peer = new RTCPeerConnection({
        iceServers: [
          {
            urls: `turn:127.0.0.1:${port}?transport=tcp`,
            username,
            credential: password,
          },
        ],
        iceTransportPolicy: 'relay',
      });
      const channel = peer.createDataChannel('station-lab-v1');
      const received: string[] = [];
      channel.addEventListener('message', (event: { readonly data: unknown }) =>
        received.push(String(event.data)),
      );
      const gathered = new Promise<void>((resolveGathered) => {
        if (peer.iceGatheringState === 'complete') return resolveGathered();
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') resolveGathered();
        });
      });
      await peer.setLocalDescription(await peer.createOffer());
      await gathered;
      if (!peer.localDescription) throw new Error('browser offer missing');
      const windowValue: unknown = Reflect.get(globalThis, 'window');
      if (!windowValue || typeof windowValue !== 'object')
        throw new Error('browser window unavailable');
      const browserWindow = windowValue as BrowserWindow;
      browserWindow.__stationEcho = {
        peer,
        channel,
        received,
      };
      return {
        type: peer.localDescription.type,
        sdp: peer.localDescription.sdp,
      };
    },
    { port: turnTcpPort, username: turnUsername, password: turnPassword },
  );
  assert.equal(offer.type, 'offer');
  assert.match(offer.sdp, / typ relay(?:\s|\r?$)/m);
  const clientFingerprint = fingerprint(offer.sdp);
  const nonce = randomBytes(32).toString('base64url');

  const stationSigningKeyId =
    await stationConnectionSigningKeyId(approvedTrust);
  const invitation = broker.issueNativeInvitation({
    scope,
    routingCredential: credentials.routing,
    brokerOrigin,
    surface,
    stationSigningKeyId,
    stationSigningGeneration: approvedTrust.generation,
  });

  const redemptionNonce = randomBytes(32).toString('base64url');
  const redemptionProof = {
    publicKey: proofPublicKey,
    nonce: redemptionNonce,
    jws: await compactJws(
      serializeNativeBrokerRedemptionPayload(invitation, redemptionNonce),
      keyPair.privateKey,
      'station-broker-native-redemption+jws',
    ),
  };
  const redemption = await fetch(
    `${brokerOrigin}/broker/v1/native/grants/redeem`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitation, proof: redemptionProof }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(
    redemption.status,
    200,
    'native grant redemption must use real broker route',
  );
  const nativeGrant =
    (await redemption.json()) as SelfHostedBrokerNativeClientGrantV2;
  nativeGrantRedeemed = true;
  nativeClient = new SelfHostedBrokerNativeClient(
    nativeGrant,
    async (claims) =>
      await compactJws(
        Buffer.from(JSON.stringify(claims), 'utf8'),
        keyPair.privateKey,
        SELF_HOSTED_BROKER_NATIVE_REQUEST_PROOF_TYPE,
      ),
  );

  const connectorClient = new SelfHostedBrokerClient(
    brokerOrigin,
    scope,
    credentials.connector,
  );
  const trustKey = join(root, 'station-key.pem');
  const certPath = join(root, 'station-cert.pem');
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
      '/CN=station-native-echo-lab',
      '-keyout',
      trustKey,
      '-out',
      certPath,
    ],
    root,
  );
  const exactOfferDigest = await connectionDescriptionDigest(offer.sdp);
  const proofIssuer = stationKeys.createIssuer(
    (binding) =>
      binding.connectionId === surface.clientInstanceId &&
      binding.clientNonce === nonce &&
      binding.clientFingerprint === clientFingerprint &&
      binding.offerSha256 === exactOfferDigest,
  );
  stationLab = createNativeV2PionDiagnosticLab(
    {
      surface,
      scope,
      client: connectorClient,
      executable: pionExecutable,
      certificatePem: readFileSync(certPath, 'utf8'),
      privateKeyPem: readFileSync(trustKey, 'utf8'),
      turn: {
        url: `turn:127.0.0.1:${turnTcpPort}?transport=tcp`,
        username: turnUsername,
        password: turnPassword,
      },
      trust: trustOwner,
      issuer: proofIssuer,
    },
    {
      startAdapter: async (input) =>
        await startPionApplicationAdapter(input, {
          createTemp: createStationTempDir,
          removeTemp: removeStationTempDir,
          spawn: (command, args, options) => {
            const owned = spawnOwnedChild(command, args, options);
            pionPid = owned.proc.pid;
            return owned;
          },
          terminate: terminateProcessTree,
          write: writeFileSync,
          now: Date.now,
        }),
    },
  );
  await stationLab.register(controller.signal);
  connectorRegistered = true;
  await nativeClient.open({ nonce, offerSdp: offer.sdp }, controller.signal);
  const stationPoll = stationLab.pollNative(controller.signal).then(
    (result) => ({ kind: 'result' as const, result }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );

  const readDeadline = Date.now() + 30_000;
  let answer:
    | Awaited<ReturnType<SelfHostedBrokerNativeClient['read']>>
    | undefined;
  while (Date.now() < readDeadline) {
    controller.signal.throwIfAborted();
    answer = await nativeClient.read(nonce, controller.signal);
    if (answer.answerSdp && answer.stationProof) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(
    answer?.answerSdp && answer.stationProof,
    'real broker did not return Pion answer/proof',
  );
  const binding = {
    stationId: approvedTrust.stationId,
    enrollmentId: approvedTrust.enrollmentId,
    generation: approvedTrust.generation,
    connectionId: surface.clientInstanceId,
    clientNonce: nonce,
    clientFingerprint,
    stationFingerprint: fingerprint(answer.answerSdp),
    offerSha256: exactOfferDigest,
    answerSha256: await connectionDescriptionDigest(answer.answerSdp),
  };

  // Negative substituted Station-key control: this exact answer remains unapplied.
  const substitutePair = await generateKeyPair('ES256', { extractable: true });
  const substituteJwk = await exportJWK(substitutePair.publicKey);
  const substituteTrust = {
    ...approvedTrust,
    signingKey: {
      kty: 'EC' as const,
      crv: 'P-256' as const,
      x: substituteJwk.x!,
      y: substituteJwk.y!,
    },
  };
  const substitutedVerifier = createStationConnectionProofVerifier({
    trust: substituteTrust,
    expected: binding,
    isCurrent: () => true,
  });
  await assert.rejects(
    substitutedVerifier.verifyAndConsume(answer.stationProof),
    { code: 'connection_proof_refused' },
  );
  const beforeValidProof = await page.evaluate(() => {
    const windowValue: unknown = Reflect.get(globalThis, 'window');
    if (!windowValue || typeof windowValue !== 'object')
      throw new Error('browser window unavailable');
    const browserWindow = windowValue as BrowserWindow;
    const state = browserWindow.__stationEcho;
    return state?.peer.remoteDescription === null;
  });
  assert.equal(
    beforeValidProof,
    true,
    'substituted proof must fail before remote SDP',
  );

  const verifier = createStationConnectionProofVerifier({
    trust: approvedTrust,
    expected: binding,
    isCurrent: () => trustOwner.isCurrent(approvedTrust),
  });
  assert.deepEqual(
    await verifier.verifyAndConsume(answer.stationProof),
    binding,
  );
  verifier.assertStillCurrent();
  await page.evaluate(async (sdp) => {
    const windowValue: unknown = Reflect.get(globalThis, 'window');
    if (!windowValue || typeof windowValue !== 'object')
      throw new Error('browser window unavailable');
    const browserWindow = windowValue as BrowserWindow;
    const state = browserWindow.__stationEcho;
    if (!state?.peer || state.peer.remoteDescription !== null)
      throw new Error('remote SDP state changed before proof acceptance');
    await state.peer.setRemoteDescription({ type: 'answer', sdp });
  }, answer.answerSdp);
  await page.waitForFunction(
    () => {
      const windowValue: unknown = Reflect.get(globalThis, 'window');
      if (!windowValue || typeof windowValue !== 'object')
        throw new Error('browser window unavailable');
      const browserWindow = windowValue as BrowserWindow;
      const state = browserWindow.__stationEcho;
      return state?.channel.readyState === 'open';
    },
    undefined,
    { timeout: 15_000 },
  );

  const probe = `station-diagnostic-echo-${randomUUID()}`;
  await page.evaluate((value) => {
    const windowValue: unknown = Reflect.get(globalThis, 'window');
    if (!windowValue || typeof windowValue !== 'object')
      throw new Error('browser window unavailable');
    const browserWindow = windowValue as BrowserWindow;
    const state = browserWindow.__stationEcho;
    if (state?.channel.label !== 'station-lab-v1')
      throw new Error('diagnostic channel label changed');
    state.channel.send(value);
  }, probe);
  const echoed = await Promise.race([
    page.waitForFunction(
      (value) => {
        const windowValue: unknown = Reflect.get(globalThis, 'window');
        if (!windowValue || typeof windowValue !== 'object')
          throw new Error('browser window unavailable');
        const browserWindow = windowValue as BrowserWindow;
        const state = browserWindow.__stationEcho;
        return state?.received.includes(value) ?? false;
      },
      probe,
      { timeout: 15_000 },
    ),
    stationPoll.then((outcome) => {
      if (outcome.kind === 'error') throw outcome.error;
      if (!outcome.result.diagnosticEchoes?.includes(probe))
        throw new Error('Station Pion did not report the real echo');
    }),
  ]);
  void echoed;
  const pollOutcome = await stationPoll;
  if (pollOutcome.kind === 'error') throw pollOutcome.error;
  const pollResult = pollOutcome.result;
  assert.deepEqual(pollResult.diagnosticEchoes, [probe]);
  echoConfirmed = true;

  // A retired native grant cannot read the answer after revocation.
  await nativeClient.retire(controller.signal);
  nativeGrantRevoked = true;
  await assert.rejects(nativeClient.read(nonce, controller.signal));
  assert.equal(
    stationLab.activePeerCount,
    0,
    'echo completion must retire Pion peer',
  );

  // Retain the exact fixture-owned container identity before the helper stops it.
  const turnContainerName = startedTurnOwner.name;
  const receipt = {
    status: 'passed',
    sourceSha,
    pionExecutableSha256,
    versions: { pion: 'v4.2.20', go: 'go1.26.7' },
    mode: 'local-only diagnosticEcho; no Station startup mount; no app/account/Project route',
    proof: {
      substitutedStationKeyRejectedBeforeRemoteSdp: true,
      approvedStationProofVerifiedBeforeRemoteSdp: true,
      nonceBound: true,
      clientFingerprint: binding.clientFingerprint,
      stationFingerprint: binding.stationFingerprint,
      offerSha256: binding.offerSha256,
      answerSha256: binding.answerSha256,
    },
    dataChannel: { label: 'station-lab-v1', messageEchoed: true },
    broker: {
      origin: brokerOrigin,
      port: brokerPort,
      nativeGrantRedeemed,
      nativeGrantRevoked,
    },
    turn: {
      containerId: turnContainerId,
      containerName: turnContainerName,
      image: startedTurnOwner.image,
      tcpPort: turnTcpPort,
      udpPort: turnUdpPort,
    },
    ownedProcesses: {
      controllerPid: process.pid,
      chromiumPid: browserPid,
      pionPid,
      brokerListenerPid: process.pid,
      connectorRegistered,
    },
    echoConfirmed,
  };
  acceptanceReceipt = receipt;
}

let failure: unknown;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  for (const [label, close] of [
    [
      'native grant',
      async () => {
        if (nativeGrantRedeemed && !nativeGrantRevoked && nativeClient) {
          await nativeClient.retire(new AbortController().signal);
          nativeGrantRevoked = true;
        }
      },
    ],
    [
      'Station diagnostic lab',
      async () => {
        if (stationLab) {
          await stationLab.close(new AbortController().signal);
          connectorWithdrawn = connectorRegistered;
          stationPeerRetired = stationLab.activePeerCount === 0;
        }
      },
    ],
    [
      'Chromium browser',
      async () => {
        await browser?.close();
        await browserServer?.close();
      },
    ],
    [
      'broker listener',
      async () => {
        if (brokerServer) await closeServer(brokerServer);
      },
    ],
    [
      'broker service',
      async () => {
        broker?.close();
        if (!brokerDatabasePath) return;
        if (!brokerStationId)
          throw new Error('broker Station identity was not recorded');
        const database = new DatabaseSync(brokerDatabasePath, {
          readOnly: true,
        });
        try {
          const row = database
            .prepare(
              'SELECT withdrawn_at FROM broker_leases WHERE station_id=?',
            )
            .get(brokerStationId);
          brokerLeaseWithdrawn = Boolean(row && row.withdrawn_at !== null);
          brokerStateAfterCleanup = row
            ? brokerLeaseWithdrawn
              ? 'withdrawn'
              : 'still_active'
            : 'missing';
          assert.equal(brokerLeaseWithdrawn, connectorRegistered);
        } finally {
          database.close();
        }
      },
    ],
    [
      'TURN container',
      async () => {
        if (turnStarted) {
          await turn.stop();
          if (!turnOwner || !turnContainerId)
            throw new Error('owned TURN container identity was not recorded');
          const remaining = await runLabCommand(
            'docker',
            [
              '--host',
              process.platform === 'win32'
                ? 'npipe:////./pipe/docker_engine'
                : 'unix:///var/run/docker.sock',
              '--config',
              join(root, 'docker-config'),
              'ps',
              '-a',
              '--no-trunc',
              '--filter',
              `id=${turnContainerId}`,
              '--format',
              '{{.ID}}',
            ],
            root,
          );
          assert.equal(
            remaining.stdout.trim(),
            '',
            'owned TURN container remained after stop',
          );
          turnStoppedOnCleanup = true;
        }
      },
    ],
    [
      'temporary fixture root',
      async () => rmSync(root, { recursive: true, force: true }),
    ],
  ] as const) {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push(
        `${label}: ${error instanceof Error ? error.message : 'cleanup failed'}`,
      );
    }
  }
  const processAlive = (pid: number | undefined) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const chromiumStillAlive = processAlive(browserPid);
  const pionStillAlive = processAlive(pionPid);
  if (chromiumStillAlive)
    cleanupErrors.push('owned Chromium process remained after close');
  if (pionStillAlive)
    cleanupErrors.push('owned Pion process remained after close');
  const cleanupReceipt = {
    sourceSha,
    ports: { broker: brokerPort, turnTcp: turnTcpPort, turnUdp: turnUdpPort },
    ownedPids: { controller: process.pid, chromium: browserPid, pion: pionPid },
    processStillAlive: {
      chromium: chromiumStillAlive,
      pion: pionStillAlive,
    },
    grantRevoked: nativeGrantRevoked,
    connectorWithdrawn,
    stationPeerRetired,
    brokerStateAfterCleanup,
    brokerLeaseWithdrawn,
    turnStoppedOnCleanup,
    turnContainerId,
    cleanupErrors,
  };
  if (acceptanceReceipt && !failure && !cleanupErrors.length) {
    Object.assign(acceptanceReceipt, {
      cleanup: {
        connectorWithdrawn,
        stationPeerRetired,
        brokerStateAfterCleanup,
        brokerLeaseWithdrawn,
        turnStoppedOnCleanup,
        ownedPidsAlive: cleanupReceipt.processStillAlive,
      },
    });
    const receipt = {
      ...acceptanceReceipt,
      status: 'passed',
    };
    process.stdout.write(
      `STATION_NATIVE_RELAY_DIAGNOSTIC_ECHO ${JSON.stringify(receipt)}\n`,
    );
  }
  process.stdout.write(
    `STATION_NATIVE_RELAY_DIAGNOSTIC_ECHO_CLEANUP ${JSON.stringify(cleanupReceipt)}\n`,
  );
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
}
if (failure !== undefined || cleanupErrors.length) {
  if (failure) {
    process.stderr.write(
      `${failure instanceof Error ? failure.stack : String(failure)}\n`,
    );
    if (failure instanceof AggregateError && failure.cause)
      process.stderr.write(`${JSON.stringify(failure.cause)}\n`);
  }
  if (cleanupErrors.length)
    process.stderr.write(`${cleanupErrors.join('\n')}\n`);
  process.exitCode = 1;
}
