import assert from 'node:assert/strict';
import { randomBytes, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { serveApplicationChannel } from '@kontourai/station-connect/application-channel';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import {
  connectionDescriptionDigest,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { chromium, type Page } from '@playwright/test';
import { build, stop as stopBundler } from 'esbuild';
import datachannel from 'node-datachannel';
import { ensureStationHomeSchemaSync } from '../src-server/domain/home-schema-gate.js';
import type { createStationConnectionProofIssuer } from '../src-server/services/ssh/connection-proof-issuer.js';
import { ConnectionSigningKeyStore } from '../src-server/services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../src-server/services/ssh/environment-security-service.js';
import { bridgeApplicationChannels } from './lib/application-ipc.js';
import {
  browserAcceptApplicationInvitation,
  browserAdoptBoundApplicationDevice,
  browserApplicationAccountRequest,
  browserLoginApplicationAccountAgain,
  browserRejectWrongBoundAccount,
  browserRenewApplicationAccount,
  browserRequestBoundApplicationDevice,
  browserRevokeApplicationContinuation,
  browserStartApplicationAccount,
  browserStopApplicationAccount,
} from './lib/browser-application-account.mjs';
import { browserCheckApplicationChannel } from './lib/browser-application-channel.mjs';
import {
  browserBrokerAdmitApplicationTransport,
  browserBrokerAdoptApplicationTransport,
  browserBrokerConnect,
  browserBrokerConnectionId,
  browserBrokerProbeOrigin,
  browserBrokerReadStatus,
  browserBrokerReconnect,
  browserBrokerTamperProof,
} from './lib/browser-self-hosted-broker.mjs';
import {
  browserAccept,
  browserChannelOpen,
  browserConnectionContext,
  browserFailed,
  browserHasNoRemoteDescription,
  browserOffer,
  browserReceived,
  browserRevokeConnectionTrust,
  browserSend,
  browserSetConnectionTrust,
  browserStats as readBrowserStats,
} from './lib/browser-transport-page.mjs';
import { startPionFixture } from './lib/browser-transport-pion.js';
import {
  runLabCommand,
  startLabRelay,
} from './lib/local-collaboration-process.mjs';
import { startRelayAccountStation } from './lib/local-collaboration-relay-account.js';
import { nodeApplicationChannel } from './lib/node-application-channel.js';
import { startSelfHostedBrokerLab } from './lib/self-hosted-broker-lab.js';

// Isolated transport evaluation; the opt-in account mode uses a real Station.
const TURN_IMAGE =
  'coturn/coturn@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3';
const args = process.argv.slice(2);
if (
  args.some(
    (arg) =>
      ![
        '--browser-turn=udp',
        '--browser-turn=tcp',
        '--keep',
        '--peer=pion',
        '--peer=node',
        '--fail-after-create',
        '--application-protocol',
        '--application-accounts',
        '--self-hosted-broker',
      ].includes(arg),
  ) ||
  args.filter((arg) => arg.startsWith('--browser-turn=')).length > 1 ||
  args.filter((arg) => arg.startsWith('--peer=')).length > 1
)
  throw new Error(
    'Use --browser-turn=udp or --browser-turn=tcp and optional --keep',
  );
const peerAdapter = args.includes('--peer=pion') ? 'pion' : 'node';
const selfHostedBroker = args.includes('--self-hosted-broker');
if (
  selfHostedBroker &&
  (peerAdapter !== 'pion' || !args.includes('--application-accounts'))
)
  throw new Error(
    '--self-hosted-broker requires --peer=pion --application-accounts',
  );
if (
  args.includes('--application-protocol') &&
  args.includes('--application-accounts')
)
  throw new Error('Choose one application fixture profile per run');
let accountStation:
  | Awaited<ReturnType<typeof startRelayAccountStation>>
  | undefined;
let brokerLab: Awaited<ReturnType<typeof startSelfHostedBrokerLab>> | undefined;
let accountReport: Record<string, unknown> | undefined;
let applicationProtocol:
  | { status: string; requestMarker: string; responseBytes: number }
  | undefined;
const browserTransport = args.includes('--browser-turn=tcp') ? 'tcp' : 'udp';
const pionExecutable = join(
  process.cwd(),
  '.kontourai/browser-transport',
  process.platform === 'win32' ? 'pion-peer.exe' : 'pion-peer',
);
process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), 'station-browser-transport-'));
const errors: unknown[] = [];
const abort = new AbortController();
const interrupt = () =>
  abort.abort(new Error('Browser transport lab interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
let report: Record<string, unknown> | undefined;
const dockerHost =
  process.platform === 'win32'
    ? 'npipe:////./pipe/docker_engine'
    : 'unix:///var/run/docker.sock';
const docker = async (args: string[]) => {
  const result = await runLabCommand(
    'docker',
    ['--host', dockerHost, '--config', join(root, 'docker-config'), ...args],
    root,
  );
  return args[0] === 'logs' ? result.stdout + result.stderr : result.stdout;
};
const username = 'station-fixture';
const password = randomBytes(24).toString('hex');
const containerOwner = randomBytes(16).toString('hex');
const containerName = `station-turn-${containerOwner}`;
let containerId: string | undefined;
let turnUdpPort: number | undefined;
let turnTcpPort: number | undefined;
let relay: Awaited<ReturnType<typeof startLabRelay>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
type LabPeer = {
  close(): void | Promise<void>;
  getSelectedCandidatePair(): {
    local: { type: string };
    remote: { type: string };
  } | null;
};
const peers: LabPeer[] = [];
let pionProvenance:
  | Awaited<ReturnType<typeof startPionFixture>>['provenance']
  | undefined;
const observers: (() => Promise<unknown>)[] = [];
let clientProofScript = '';
let connectionTrust: ApprovedStationConnectionTrust;
let proofIssuer: ReturnType<typeof createStationConnectionProofIssuer>;
const admittedConnections = new Set<string>();
const server = createServer((request, response) => {
  if (request.url === '/connection-proof.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(clientProofScript);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(
    '<!doctype html><title>Station browser transport fixture</title><script src="/connection-proof.js"></script>',
  );
});

async function cleanupContainer() {
  // Generation identity is durable before allocation: even a lost create
  // response cannot strand an unstarted container or justify generic cleanup.
  const ids = (
    await docker([
      'ps',
      '-a',
      '--no-trunc',
      '--filter',
      `label=station.fixture.owner=${containerOwner}`,
      '--format',
      '{{.ID}}',
    ])
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  if (!ids.length) return;
  assert.equal(ids.length, 1, 'Ambiguous container ownership');
  const id = ids[0];
  assert.match(id, /^[a-f0-9]{64}$/);
  if (containerId) assert.equal(id, containerId);
  const fact = JSON.parse(
    await docker(['inspect', '--format', '{{json .}}', id]),
  );
  assert.equal(fact.Config.Image, TURN_IMAGE);
  assert.equal(fact.Name, `/${containerName}`);
  assert.equal(fact.Config.Labels['station.fixture.owner'], containerOwner);
  try {
    writeFileSync(join(root, 'turn.log'), await docker(['logs', id]), {
      mode: 0o600,
    });
  } catch (error) {
    errors.push(error);
  }
  if (fact.State.Running) await docker(['stop', '--time', '3', id]);
  await docker(['rm', id]);
}

async function offer(page: Page, port: number) {
  const transport = browserTransport;
  await page.evaluate(browserSetConnectionTrust, {
    trust: connectionTrust,
    approvedKeyId: await stationConnectionSigningKeyId(connectionTrust),
  });
  return page.evaluate(browserOffer, {
    port: transport === 'udp' ? (turnUdpPort ?? port) : (turnTcpPort ?? port),
    username,
    password,
    transport,
  });
}

async function acceptSignedAnswer(
  page: Page,
  offer: string,
  sdp: string,
  pin: string,
  candidates: { candidate: string; sdpMid: string }[],
  revokeTrust = false,
) {
  const context = await page.evaluate(browserConnectionContext);
  const clientFingerprint = offer
    .match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]
    ?.trim();
  const stationFingerprint = sdp
    .match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]
    ?.trim();
  assert(clientFingerprint && stationFingerprint);
  const binding = {
    ...context,
    stationId: connectionTrust.stationId,
    enrollmentId: connectionTrust.enrollmentId,
    generation: connectionTrust.generation,
    clientFingerprint,
    stationFingerprint,
    offerSha256: await connectionDescriptionDigest(offer),
    answerSha256: await connectionDescriptionDigest(sdp),
  };
  admittedConnections.add(binding.connectionId);
  let proof: string;
  try {
    proof = await proofIssuer.issue(binding);
  } finally {
    admittedConnections.delete(binding.connectionId);
  }
  const [header, payload, signature] = proof.split('.');
  const invalid = `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  await assert.rejects(
    page.evaluate(browserAccept, { sdp, pin, candidates, proof: invalid }),
    /Station connection proof refused/,
  );
  if (revokeTrust) {
    const revoker = await page.context().newPage();
    try {
      await revoker.goto(page.url());
      await revoker.evaluate(
        browserRevokeConnectionTrust,
        connectionTrust.stationId,
      );
      await assert.rejects(
        page.evaluate(browserAccept, { sdp, pin, candidates, proof }),
        /Device signing trust changed before accepting the connection/,
      );
      assert.equal(await page.evaluate(browserHasNoRemoteDescription), true);
    } finally {
      await revoker.close();
    }
    return;
  }
  await page.evaluate(browserAccept, { sdp, pin, candidates, proof });
  await assert.rejects(
    page.evaluate(browserAccept, { sdp, pin, candidates, proof }),
    /Connection proof already consumed/,
  );
}

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${phase} did not settle within its liveness bound`),
            ),
          20000,
        );
      }),
    ]);
    abort.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function identity(name: string) {
  const home = join(root, name);
  mkdirSync(home, { mode: 0o700 });
  const key = join(home, 'key.pem');
  const cert = join(home, 'cert.pem');
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
      `/CN=${name}`,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    home,
  );
  return {
    key,
    cert,
    fingerprint: new X509Certificate(readFileSync(cert)).fingerprint256,
  };
}

async function exchange(
  page: Page,
  key: Awaited<ReturnType<typeof identity>>,
  pin: string,
  substitute = false,
  revokeTrust = false,
) {
  assert(relay);
  assert(turnUdpPort);
  abort.signal.throwIfAborted();
  const remote = await bounded(
    offer(page, relay.port),
    'browser ICE gathering',
  );
  assert.match(remote.sdp, / typ relay/);
  if (peerAdapter === 'pion') {
    const fixture = await startPionFixture({
      executable: pionExecutable,
      directory: join(root, `pion-${peers.length}`),
      certificate: key.cert,
      key: key.key,
      offer: remote,
      turnPort: relay.port,
      username,
      password,
      signal: abort.signal,
      ...(args.includes('--application-protocol') || accountStation
        ? {
            application: {
              label: accountStation
                ? 'station-application-account-fixture'
                : 'station-application-protocol-fixture',
              accept(channel) {
                if (accountStation?.station.openApplicationChannel) {
                  bridgeApplicationChannels(
                    channel,
                    accountStation.station.openApplicationChannel(),
                    abort.signal,
                  );
                } else
                  serveApplicationChannel(
                    channel,
                    'https://fixture-station.invalid',
                    {
                      signal: abort.signal,
                      async fetch(request) {
                        const marker = await request.text();
                        assert.match(marker, /^sdk-request-[a-f0-9-]{36}$/);
                        const address = server.address();
                        assert(address && typeof address !== 'string');
                        const origin = `http://127.0.0.1:${address.port}`;
                        assert.equal(request.headers.get('Origin'), origin);
                        return new Response(marker.repeat(512), {
                          headers: { 'X-Fixture-Client-Origin': origin },
                        });
                      },
                    },
                  );
              },
            },
          }
        : {}),
    });
    peers.push(fixture.peer);
    if (pionProvenance) assert.deepEqual(fixture.provenance, pionProvenance);
    pionProvenance = fixture.provenance;
    observers.push(async () => ({
      state: fixture.diagnostics(),
      browser: await page.evaluate(readBrowserStats),
    }));
    assert.match(fixture.answer.sdp, / typ relay/);
    assert.equal(
      fixture.answer.sdp.match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]?.trim(),
      key.fingerprint,
    );
    const sdp = substitute
      ? fixture.answer.sdp.replace(key.fingerprint, pin)
      : fixture.answer.sdp;
    await acceptSignedAnswer(page, remote.sdp, sdp, pin, [], revokeTrust);
    return {
      peer: fixture.peer,
      get messages() {
        return fixture.readMessages();
      },
    };
  }
  const peer = new datachannel.PeerConnection('station-transport-fixture', {
    iceServers: [
      {
        hostname: '127.0.0.1',
        port: relay.port,
        username,
        password,
        relayType: 'TurnUdp',
      },
    ],
    bindAddress: '127.0.0.1',
    iceTransportPolicy: 'relay',
    disableFingerprintVerification: false,
    maxMessageSize: 65536,
    certificatePemFile: key.cert,
    keyPemFile: key.key,
  });
  peers.push(peer);
  const states: string[] = [];
  peer.onStateChange((state) => states.push(state));
  observers.push(async () => ({
    states,
    pair: peer.getSelectedCandidatePair(),
    description: peer.localDescription(),
    browser: await page.evaluate(readBrowserStats),
  }));
  const messages: string[] = [];
  const gathered = new Promise<void>((resolve) => {
    peer.onGatheringStateChange((state) => {
      if (state === 'complete') resolve();
    });
  });
  peer.onDataChannel((channel) => {
    if (channel.getLabel() === 'station-application-account-fixture') {
      if (!accountStation?.station.openApplicationChannel) {
        channel.close();
        return;
      }
      try {
        bridgeApplicationChannels(
          nodeApplicationChannel(channel),
          accountStation.station.openApplicationChannel(),
          abort.signal,
        );
      } catch {
        channel.close();
      }
      return;
    }
    if (channel.getLabel() === 'station-application-protocol-fixture') {
      if (!args.includes('--application-protocol')) {
        channel.close();
        return;
      }
      serveApplicationChannel(
        nodeApplicationChannel(channel),
        'https://fixture-station.invalid',
        {
          signal: abort.signal,
          async fetch(request) {
            if (
              new URL(request.url).pathname !== '/fixture/payload' ||
              request.method !== 'POST'
            )
              return new Response(null, { status: 404 });
            const marker = await request.text();
            assert.match(marker, /^sdk-request-[a-f0-9-]{36}$/);
            const address = server.address();
            assert(address && typeof address !== 'string');
            const origin = `http://127.0.0.1:${address.port}`;
            assert.equal(
              request.headers.get('Origin'),
              origin,
              'Virtual request must preserve the actual browser origin',
            );
            return new Response(marker.repeat(512), {
              headers: { 'X-Fixture-Client-Origin': origin },
            });
          },
        },
      );
      return;
    }
    channel.onMessage((value) => {
      assert.equal(typeof value, 'string');
      assert(String(value).length < 65536);
      messages.push(String(value));
      channel.sendMessage(String(value));
    });
  });
  peer.setRemoteDescription(remote.sdp, 'offer');
  await bounded(gathered, 'Station ICE gathering');
  const answer = peer.localDescription();
  assert(answer?.type === 'answer');
  assert.match(answer.sdp, / typ relay/);
  const fingerprint = answer.sdp
    .match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]
    ?.trim();
  assert.equal(fingerprint, key.fingerprint);
  const sdp = substitute
    ? answer.sdp.replace(key.fingerprint, pin)
    : answer.sdp;
  // Gathering is complete. The signed SDP is the complete candidate set;
  // do not append separate unsigned candidate callback events afterward.
  await acceptSignedAnswer(page, remote.sdp, sdp, pin, [], revokeTrust);
  return { peer, messages };
}

try {
  const authorityHome = args.includes('--application-accounts')
    ? join(root, 'application-station', 'home')
    : join(root, 'station-authority');
  if (args.includes('--application-accounts'))
    ensureStationHomeSchemaSync(authorityHome);
  const environment = new EnvironmentSecurityService({
    homeDir: authorityHome,
  });
  const environmentIdentity = await environment.initialize();
  connectionTrust = await new ConnectionSigningKeyStore(
    authorityHome,
  ).initialize();
  assert.equal(connectionTrust.stationId, environmentIdentity.environmentId);
  const reopenedKeys = new ConnectionSigningKeyStore(authorityHome);
  assert.deepEqual(reopenedKeys.readDescriptor(), connectionTrust);
  proofIssuer = reopenedKeys.createIssuer((binding) =>
    admittedConnections.has(binding.connectionId),
  );
  const bundled = await build({
    stdin: {
      contents: `
    import {createStationConnectionProofVerifier, connectionDescriptionDigest} from '@kontourai/station-shared/connection-proof';
    import {createStationProofNonce} from './packages/connect/src/core/environmentProof.ts';
    import {openDeviceConnectionTrustStore} from '@kontourai/station-connect/connection-trust';
    window.stationConnectionProof = {createStationConnectionProofVerifier, connectionDescriptionDigest, newNonce: createStationProofNonce, openDeviceConnectionTrustStore};
    import {createApplicationChannelFetch, browserApplicationChannel} from '@kontourai/station-connect/application-channel';
    import {authenticatedFetch, setClientCredentialResolver, StationHttpError} from '@kontourai/station-sdk/client';
    import {ApplicationSessionClient, createApplicationSessionKey} from '@kontourai/station-sdk/application-session';
    window.stationApplicationChannel = {createApplicationChannelFetch, browserApplicationChannel, authenticatedFetch, setClientCredentialResolver, StationHttpError, ApplicationSessionClient, createApplicationSessionKey};
    ${
      selfHostedBroker
        ? `import {SelfHostedBrokerBrowserClient, createBrowserPionConnection, createSelfHostedApplicationTransport} from './packages/connect/src/core/selfHostedBrowser.ts';
    window.stationSelfHostedBroker = {SelfHostedBrokerBrowserClient, createBrowserPionConnection, createSelfHostedApplicationTransport};`
        : ''
    }
  `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  assert.equal(bundled.outputFiles.length, 1);
  clientProofScript = bundled.outputFiles[0].text;
  stopBundler();
  writeFileSync(
    join(root, 'container-owner.json'),
    JSON.stringify({
      owner: containerOwner,
      name: containerName,
      image: TURN_IMAGE,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const created = await docker([
    'create',
    '--label',
    'station.fixture=browser-transport',
    '--label',
    `station.fixture.owner=${containerOwner}`,
    '--name',
    containerName,
    '--init',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '128m',
    '--cpus',
    '1',
    '--publish',
    '127.0.0.1::3478/tcp',
    '--publish',
    '127.0.0.1::3478/udp',
    '--entrypoint',
    '/bin/sh',
    TURN_IMAGE,
    '-c',
    'exec timeout -s TERM -k 5 120 turnserver "$@"',
    '--',
    '-n',
    '-v',
    '--log-file=stdout',
    '--simple-log',
    '--no-tls',
    '--relay-threads=1',
    '--listening-port=3478',
    '--lt-cred-mech',
    '--realm=station-fixture.invalid',
    `--user=${username}:${password}`,
    '--no-multicast-peers',
    '--min-port=50000',
    '--max-port=50031',
    '--pidfile=/tmp/turn.pid',
  ]);
  containerId = created.trim();
  assert.match(containerId, /^[a-f0-9]{64}$/);
  if (args.includes('--fail-after-create')) {
    containerId = undefined;
    throw new Error('Injected failure after owned container allocation');
  }
  abort.signal.throwIfAborted();
  await docker(['start', containerId]);
  const published = (await docker(['port', containerId, '3478/tcp'])).trim();
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  const turnPort = Number(published.split(':').at(-1));
  turnTcpPort = turnPort;
  const publishedUdp = (await docker(['port', containerId, '3478/udp'])).trim();
  assert.match(publishedUdp, /^127\.0\.0\.1:\d+$/);
  turnUdpPort = Number(publishedUdp.split(':').at(-1));
  const relayRoot = join(root, 'relay');
  mkdirSync(relayRoot, { mode: 0o700 });
  relay = await startLabRelay(
    peerAdapter === 'pion' ? turnTcpPort : turnUdpPort,
    relayRoot,
    'forward',
    peerAdapter === 'pion' ? 'tcp' : 'udp',
  );
  const approved = await identity('approved-station');
  const substituted = await identity('unapproved-station');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  if (args.includes('--application-accounts'))
    accountStation = await startRelayAccountStation(
      root,
      `http://127.0.0.1:${address.port}`,
      abort.signal,
    );
  if (accountStation)
    assert.equal(
      accountStation.station.stationId,
      connectionTrust.stationId,
      'Application and transport must be the same Station',
    );
  browser = await chromium.launch({ headless: true });
  abort.signal.throwIfAborted();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  let brokerJourney: Record<string, unknown> | undefined;
  let brokerLeaseBefore = 0;
  let brokerReconnectAdapterIndex = 0;
  let brokerReconnectForJourney:
    | { previous: string | undefined; connectionId: string }
    | undefined;
  if (selfHostedBroker) {
    assert(accountStation?.station.openApplicationChannel);
    assert(relay);
    // The admitted Device trust is identical to the legacy path: read from
    // the same independently approved store, never minted by the broker.
    await page.evaluate(browserSetConnectionTrust, {
      trust: connectionTrust,
      approvedKeyId: await stationConnectionSigningKeyId(connectionTrust),
    });
    const pageOrigin = `http://127.0.0.1:${address.port}`;
    brokerLab = await startSelfHostedBrokerLab({
      directory: root,
      browserOrigin: pageOrigin,
      applicationOrigin: accountStation.station.base,
      stationId: connectionTrust.stationId,
      enrollmentId: connectionTrust.enrollmentId,
      heartbeatMs: 5_000,
      renewMs: 10_000,
      pollMs: 1_000,
      executable: pionExecutable,
      certificatePem: readFileSync(approved.cert, 'utf8'),
      privateKeyPem: readFileSync(approved.key, 'utf8'),
      turn: {
        url: `turn:127.0.0.1:${relay.port}?transport=tcp`,
        username,
        password,
      },
      trust: {
        current: () => connectionTrust,
        // Exact descriptor semantics against the real key owner: identity
        // comparison against a cloned/reopened descriptor refuses every
        // peer, so compare station, enrollment, and generation exactly.
        isCurrent: (value) =>
          value?.stationId === connectionTrust.stationId &&
          value?.enrollmentId === connectionTrust.enrollmentId &&
          value?.generation === connectionTrust.generation &&
          value.signingKey.kty === connectionTrust.signingKey.kty &&
          value.signingKey.crv === connectionTrust.signingKey.crv &&
          value.signingKey.x === connectionTrust.signingKey.x &&
          value.signingKey.y === connectionTrust.signingKey.y,
      },
      // Explicit fixture accepted binding: the issuer admission callback
      // requires the admitted set, so admit the exact connectionId before
      // issue and retire it after, as the direct fixture does. The proof
      // check itself is never disabled.
      issuer: {
        issue: async (binding: { connectionId: string }) => {
          admittedConnections.add(binding.connectionId);
          try {
            return await (
              proofIssuer as unknown as {
                issue(b: unknown): Promise<string>;
              }
            ).issue(binding);
          } finally {
            admittedConnections.delete(binding.connectionId);
          }
        },
      },
      openApplicationChannel: () =>
        accountStation!.station.openApplicationChannel!(),
      signal: abort.signal,
    });
    // Browser TURN/UDP uses the direct UDP allocation; the recording relay
    // forward is TCP-only for the Station-side Pion peer. Never aim browser
    // UDP at the TCP recording relay port.
    const brokerBrowserPort =
      browserTransport === 'udp' ? turnUdpPort : relay.port;
    assert(brokerBrowserPort);
    const connected = await bounded(
      page.evaluate(browserBrokerConnect, {
        brokerOrigin: brokerLab.brokerOrigin,
        scope: brokerLab.scope,
        routingId: brokerLab.routing.id,
        routingSecret: brokerLab.routing.secret,
        applicationOrigin: accountStation.station.base,
        port: brokerBrowserPort,
        username,
        password,
        transport: browserTransport,
      }),
      'broker Pion connect',
    );
    assert.match(connected.connectionId, /^[a-f0-9-]{36}$/);
    await page.evaluate(browserBrokerAdmitApplicationTransport);
    brokerLeaseBefore = (await brokerLab.readLease()).expiresAt;
    assert(brokerLab.adapterMetadata.length > 0);
  }
  const good = selfHostedBroker
    ? undefined
    : await exchange(page, approved, approved.fingerprint);
  const applicationPion =
    peerAdapter === 'pion' &&
    (args.includes('--application-protocol') ||
      args.includes('--application-accounts'));
  const marker = `private-station-content-${randomBytes(32).toString('hex')}`;
  if (!selfHostedBroker) {
    assert(good);
    if (!applicationPion) {
      await page.waitForFunction(browserChannelOpen, undefined, {
        timeout: 20000,
      });
      await page.evaluate(browserSend, marker);
      await page.waitForFunction(browserReceived, marker, { timeout: 10000 });
      assert.deepEqual(good.messages, [marker]);
    }
    let pair = good.peer.getSelectedCandidatePair();
    const pairDeadline = Date.now() + 10_000;
    while (!pair && Date.now() < pairDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      pair = good.peer.getSelectedCandidatePair();
    }
    assert.equal(pair?.local.type, 'relay');
    assert.equal(pair?.remote.type, 'relay');
    const browserStats = await page.evaluate(readBrowserStats);
    assert(browserStats.some((entry) => entry.dtlsState === 'connected'));
    assert(
      browserStats.some(
        (entry) =>
          entry.type === 'certificate' &&
          entry.fingerprint === approved.fingerprint,
      ),
    );
  }
  if (args.includes('--application-protocol')) {
    applicationProtocol = await bounded(
      page.evaluate(browserCheckApplicationChannel),
      'SDK application protocol',
    );
    assert.equal(applicationProtocol.status, 'passed');
    assert(applicationProtocol.responseBytes > 16 * 1024);
  }
  if (accountStation) {
    let directApplicationAttempts = 0;
    await page.route(`${accountStation.station.base}/**`, async (route) => {
      directApplicationAttempts++;
      await route.abort('blockedbyclient');
    });
    const account = await bounded(
      page.evaluate(browserStartApplicationAccount, accountStation.browser),
      'encrypted account login',
    );
    assert.equal(account.stationId, accountStation.station.stationId);
    const self = await page.evaluate(browserApplicationAccountRequest, {
      path: '/api/account-auth/session',
    });
    assert.equal(self.status, 200, self.body);
    assert.equal(JSON.parse(self.body).data.principal.id, account.principalId);
    const replay = await page.evaluate(browserApplicationAccountRequest, {
      path: '/api/account-auth/session',
      replay: true,
    });
    assert.equal(replay.status, 401);
    const accepted = await page.evaluate(browserAcceptApplicationInvitation);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.grantsDeviceAccess, false);
    await accountStation.verifyMembership(account.principalId);
    const replacementOffer = await accountStation.createBoundDeviceOffer();
    const replacementRequest = await page.evaluate(
      browserRequestBoundApplicationDevice,
      { offerId: replacementOffer.offerId, proof: replacementOffer.challenge },
    );
    assert.equal(replacementRequest.status, 202);
    await accountStation.confirmBoundDevice(replacementRequest.body.requestId);
    await page.evaluate(browserRevokeApplicationContinuation);
    const boundDevice = await accountStation.exchangeBoundDevice(
      replacementOffer,
      replacementRequest.body.requestId,
    );
    assert.equal(
      (await page.evaluate(browserAdoptBoundApplicationDevice, boundDevice))
        .principalId,
      account.principalId,
    );
    assert.equal(await page.evaluate(browserRejectWrongBoundAccount), true);
    const sharedRead = await page.evaluate(browserApplicationAccountRequest, {
      path: '/api/projects/relay-shared',
    });
    assert.equal(
      sharedRead.status,
      200,
      'Permitted Project is the positive resource control',
    );
    assert(sharedRead.body.includes('Relay shared fixture'));
    const sharedView = JSON.parse(sharedRead.body).data;
    assert.equal(sharedView.version, 'station.member-project/v1');
    assert.equal(sharedView.kind, 'member-project');
    assert.deepEqual(sharedView.actions, ['view']);
    const memberKeys = new Set([
      'version',
      'kind',
      'id',
      'slug',
      'name',
      'icon',
      'description',
      'actions',
    ]);
    assert(Object.keys(sharedView).every((key) => memberKeys.has(key)));
    const catalogue = await page.evaluate(browserApplicationAccountRequest, {
      path: '/api/projects',
    });
    assert.equal(catalogue.status, 200);
    const memberProjects = JSON.parse(catalogue.body).data;
    assert.equal(memberProjects.length, 1);
    assert.equal(memberProjects[0].id, sharedView.id);
    assert.deepEqual(memberProjects[0].actions, ['view']);
    assert(Object.keys(memberProjects[0]).every((key) => memberKeys.has(key)));
    assert(!catalogue.body.includes(accountStation.browser.privateName));
    const privateRead = await page.evaluate(browserApplicationAccountRequest, {
      path: '/api/projects/relay-private',
    });
    const [bearerOnlyDirect, bearerOnlyVirtual] = await Promise.all([
      accountStation.readPrivateWithBearerOnlyDirect(),
      accountStation.readPrivateWithBearerOnlyVirtual(),
    ]);
    const privateBoundary = {
      status: privateRead.status,
      containsPrivateMarker: privateRead.body.includes(
        accountStation.browser.privateName,
      ),
      path: '/api/projects/relay-private',
      deviceScope: 'orchestration:read',
      principalId: account.principalId,
      bearerOnlyDirect: {
        status: bearerOnlyDirect.status,
        containsPrivateMarker: bearerOnlyDirect.body.includes(
          accountStation.browser.privateName,
        ),
      },
      bearerOnlyVirtual: {
        status: bearerOnlyVirtual.status,
        containsPrivateMarker: bearerOnlyVirtual.body.includes(
          accountStation.browser.privateName,
        ),
      },
    };
    writeFileSync(
      join(root, 'account-boundary.json'),
      JSON.stringify(privateBoundary, null, 2),
      { mode: 0o600 },
    );
    const privateRefused =
      privateRead.status === 404 &&
      !privateBoundary.containsPrivateMarker &&
      JSON.parse(privateRead.body).error === 'Project not found' &&
      bearerOnlyDirect.status === 401 &&
      !privateBoundary.bearerOnlyDirect.containsPrivateMarker &&
      bearerOnlyVirtual.status === 401 &&
      !privateBoundary.bearerOnlyVirtual.containsPrivateMarker;
    if (!privateRefused)
      errors.push(
        new Error(
          `Unshared Project boundary failed: ${JSON.stringify(privateBoundary)}`,
        ),
      );
    await page.evaluate(browserRenewApplicationAccount);
    await page.evaluate(browserRevokeApplicationContinuation);
    assert.equal(
      (
        await page.evaluate(browserApplicationAccountRequest, {
          path: '/api/projects/relay-shared',
        })
      ).status,
      401,
      'Continuation revocation refuses a permitted Project read',
    );
    assert.equal(
      (await page.evaluate(browserLoginApplicationAccountAgain)).principalId,
      account.principalId,
    );
    await accountStation.revokeAccount();
    assert.equal(
      (
        await page.evaluate(browserApplicationAccountRequest, {
          path: '/api/projects/relay-shared',
        })
      ).status,
      401,
      'Provider-session revocation refuses a permitted Project read',
    );
    assert.equal(
      (await page.evaluate(browserLoginApplicationAccountAgain)).principalId,
      account.principalId,
    );
    assert.equal(
      (
        await page.evaluate(browserApplicationAccountRequest, {
          path: '/api/projects/relay-shared',
        })
      ).status,
      200,
      'A fresh provider session restores the permitted Project read',
    );
    await accountStation.revokeMembership(account.principalId);
    assert.equal(
      (
        await page.evaluate(browserApplicationAccountRequest, {
          path: '/api/projects/relay-shared',
        })
      ).status,
      404,
      'Membership revocation independently refuses the Project read',
    );
    const replacementInvitation = await accountStation.inviteAgain();
    assert.equal(
      (
        await page.evaluate(
          browserAcceptApplicationInvitation,
          replacementInvitation,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await page.evaluate(browserApplicationAccountRequest, {
          path: '/api/projects/relay-shared',
        })
      ).status,
      200,
      'Restored membership proves Device revocation is independent',
    );
    // Reconnect BEFORE Device revocation: the fresh transport must serve a
    // permitted read while the Device is still admitted. The fixture SDK
    // credential resolver is re-pointed at the new transport with the
    // current Device credential; no relogin with the bootstrap grant.
    if (selfHostedBroker) {
      assert(brokerLab);
      const reconnected = await bounded(
        page.evaluate(browserBrokerReconnect),
        'broker reconnect',
      );
      assert.notEqual(reconnected.connectionId, reconnected.previous);
      await page.evaluate(browserBrokerAdmitApplicationTransport);
      await page.evaluate(browserBrokerAdoptApplicationTransport);
      assert.equal(
        (
          await page.evaluate(browserApplicationAccountRequest, {
            path: '/api/projects/relay-shared',
          })
        ).status,
        200,
        'Fresh broker peer restores the permitted Project read',
      );
      brokerReconnectForJourney = reconnected;
      brokerReconnectAdapterIndex = brokerLab.adapterMetadata.length - 1;
    }
    await accountStation.revokeDevice();
    assert.equal(
      (
        await page.evaluate(browserApplicationAccountRequest, {
          path: '/api/projects/relay-shared',
        })
      ).status,
      401,
    );
    await page.evaluate(browserStopApplicationAccount);
    assert.equal(
      directApplicationAttempts,
      0,
      'Account traffic must not bypass the encrypted channel',
    );
    accountReport = {
      status: privateRefused ? 'passed' : 'failed',
      directApplicationAttempts,
      stationId: account.stationId,
      principalId: account.principalId,
      keyExtractable: account.keyExtractable,
      scope:
        'full source Station account, Device and membership APIs; no guest UI or compute',
      checks: [
        'encrypted provider login',
        'account self and proof replay refusal',
        'invitation acceptance without new Device authority',
        'operator-observed viewer membership and permitted Project read',
        'continuation renewal and revocation',
        'provider-session revocation and stable relogin',
        'membership revocation and invitation-based restoration',
        'Device revocation independently refuses a permitted Project read',
      ],
      privateProject: privateBoundary,
    };
    writeFileSync(
      join(root, 'account-scenario.json'),
      JSON.stringify(accountReport, null, 2),
      { mode: 0o600 },
    );
  }
  if (selfHostedBroker) {
    assert(brokerLab);
    assert(accountStation);
    const lab = brokerLab;
    // Actual broker CORS from the admitted page origin: the browser emits
    // Origin itself; no forbidden Origin header is ever set. The non-simple
    // POST triggers the real browser preflight; the incoming OPTIONS and
    // its ACAO are observed at the owned Node broker listener.
    const cors = await bounded(
      page.evaluate(browserBrokerProbeOrigin, {
        brokerOrigin: lab.brokerOrigin,
        scope: lab.scope,
        routingId: lab.routing.id,
        routingSecret: lab.routing.secret,
      }),
      'broker CORS and credential refusal',
    );
    assert.equal(cors.pageOrigin, `http://127.0.0.1:${address.port}`);
    assert.equal(cors.status, 200);
    assert.equal((cors.statusBody as { state: string }).state, 'online');
    // The browser's successful cross-origin fetch is the CORS control. This
    // separate protocol probe checks the actual broker's preflight response.
    const observedPreflight = await lab.preflight();
    assert.equal(observedPreflight.status, 204);
    assert.equal(observedPreflight.allowOrigin, cors.pageOrigin);
    assert.equal(cors.wrongStatus, 401);
    assert.equal(
      (cors.wrongBody as { error: string }).error,
      'broker_credential_refused',
    );
    // Heartbeat + lease renewal: the Station-side runtime already renewed at
    // least once during the account journey, so the lease expiry observed
    // after the journey must extend past the pre-journey observation.
    let leaseAfter = (await lab.readLease()).expiresAt;
    const renewDeadline = Date.now() + 30_000;
    while (leaseAfter <= brokerLeaseBefore && Date.now() < renewDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      leaseAfter = (await lab.readLease()).expiresAt;
    }
    assert(
      leaseAfter > brokerLeaseBefore,
      'Broker lease renewal must extend the observed expiry',
    );
    assert.equal((await lab.readLease()).state, 'online');
    // Answer/proof tamper refused by the real production consumer before
    // any SDP is accepted: the wrapper fetched the REAL answer and altered
    // ONLY the proof.
    const tamper = await bounded(
      page.evaluate(browserBrokerTamperProof),
      'broker proof tamper refusal',
    );
    assert.equal(tamper.tampered, true, 'Tamper must alter a real answer');
    assert.equal(tamper.tamperedRefused, true, tamper.refusal);
    assert.match(tamper.refusal, /proof|refused|invalid/i);
    // The admitted Station-side peer actually selected relay transport:
    // read the live candidate pair now, not an early null snapshot.
    assert(lab.adapterMetadata.length > 0);
    const observedAdapter = lab.adapterMetadata[brokerReconnectAdapterIndex]!;
    let selectedPair = observedAdapter.pair();
    const pairDeadline = Date.now() + 10_000;
    while (
      (!selectedPair ||
        selectedPair.local.type !== 'relay' ||
        selectedPair.remote.type !== 'relay') &&
      Date.now() < pairDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      selectedPair = observedAdapter.pair();
    }
    assert.equal(selectedPair?.local.type, 'relay');
    assert.equal(selectedPair?.remote.type, 'relay');
    pionProvenance = observedAdapter.provenance;
    assert(brokerReconnectForJourney);
    const reconnected = brokerReconnectForJourney;
    brokerJourney = {
      status: 'passed',
      connectionId: reconnected.connectionId,
      leaseRenewed: leaseAfter > brokerLeaseBefore,
      cors: {
        status: cors.status,
        allowOrigin: cors.allowOrigin,
        preflight: observedPreflight.status,
        preflightAllowOrigin: observedPreflight.allowOrigin,
        wrongStatus: cors.wrongStatus,
      },
      proofTamperRefused: tamper.tamperedRefused,
      proofTamperObserved: tamper.tampered,
      adapterPeersObserved: lab.adapterMetadata.length,
      adapterRelaySelected: selectedPair,
      scope:
        'same Station/enrollment plus browser origin; separate routing and connector credentials',
    };
    // Trust retirement refusal: revoke the admitted Device trust in the SAME
    // profile (a fresh context has isolated storage and no trust to revoke),
    // then require the next broker admission to refuse before SDP acceptance.
    const brokerRevokePage = await context.newPage();
    try {
      await brokerRevokePage.goto(`http://127.0.0.1:${address.port}`);
      await brokerRevokePage.evaluate(
        browserRevokeConnectionTrust,
        connectionTrust.stationId,
      );
      await assert.rejects(
        page.evaluate(browserBrokerReconnect),
        /trust_retired|authority_retired/,
      );
      assert.equal(await page.evaluate(browserBrokerConnectionId), undefined);
    } finally {
      await brokerRevokePage.close();
    }
    // Connector withdrawal retires the lease: routing status must refuse.
    await lab.withdraw();
    await assert.rejects(
      page.evaluate(browserBrokerReadStatus),
      /broker_request_refused_401/,
    );
    await assert.rejects(lab.readLease(), /broker_request_refused_401/);
    brokerJourney = {
      ...(brokerJourney as Record<string, unknown>),
      trustRetirementRefused: true,
      withdrawOffline: true,
    };
    await context.close();
    await lab.stop();
    brokerLab = undefined;
  } else {
    await context.close();
    assert(good);
    await good.peer.close();
  }

  if (!selfHostedBroker) {
    const reconnectContext = await browser.newContext();
    const reconnectPage = await reconnectContext.newPage();
    await reconnectPage.goto(`http://127.0.0.1:${address.port}`);
    const reconnected = await exchange(
      reconnectPage,
      approved,
      approved.fingerprint,
    );
    if (!applicationPion) {
      await reconnectPage.waitForFunction(browserChannelOpen, undefined, {
        timeout: 20000,
      });
      await reconnectPage.evaluate(browserSend, marker);
      await reconnectPage.waitForFunction(browserReceived, marker, {
        timeout: 10000,
      });
      assert.deepEqual(reconnected.messages, [marker]);
    }
    let reconnectPair = reconnected.peer.getSelectedCandidatePair();
    const reconnectPairDeadline = Date.now() + 10_000;
    while (!reconnectPair && Date.now() < reconnectPairDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      reconnectPair = reconnected.peer.getSelectedCandidatePair();
    }
    assert.equal(reconnectPair?.local.type, 'relay');
    assert.equal(reconnectPair?.remote.type, 'relay');
    await reconnectContext.close();
    await reconnected.peer.close();

    const revokedContext = await browser.newContext();
    const revokedPage = await revokedContext.newPage();
    await revokedPage.goto(`http://127.0.0.1:${address.port}`);
    const revokedPeer = await exchange(
      revokedPage,
      approved,
      approved.fingerprint,
      false,
      true,
    );
    assert.equal(await revokedPage.evaluate(browserChannelOpen), false);
    assert.deepEqual(revokedPeer.messages, []);
    await revokedPeer.peer.close();
    await revokedContext.close();

    const replacementContext = await browser.newContext();
    const replacementPage = await replacementContext.newPage();
    await replacementPage.goto(`http://127.0.0.1:${address.port}`);
    await assert.rejects(
      exchange(replacementPage, substituted, approved.fingerprint),
      /station_fingerprint_not_approved/,
    );
    await replacementContext.close();

    const hostileContext = await browser.newContext();
    const hostilePage = await hostileContext.newPage();
    await hostilePage.goto(`http://127.0.0.1:${address.port}`);
    const hostile = await exchange(
      hostilePage,
      substituted,
      approved.fingerprint,
      true,
    );
    await hostilePage.waitForFunction(browserFailed, undefined, {
      timeout: 20000,
    });
    const hostileStats = await hostilePage.evaluate(readBrowserStats);
    assert(hostileStats.some((entry) => entry.dtlsState === 'failed'));
    assert.deepEqual(hostile.messages, []);
    await hostileContext.close();
    await hostile.peer.close();
  }
  await relay.close();
  const captured = readFileSync(relay.capturePath);
  assert(
    captured.length > 0,
    'Transport proof requires a nonempty relay capture',
  );
  assert.equal(captured.includes(Buffer.from(marker)), false);
  if (accountStation) {
    for (const secret of [
      accountStation.browser.password,
      accountStation.browser.credential,
      accountStation.browser.invitation,
    ])
      assert.equal(captured.includes(Buffer.from(secret)), false);
  }
  if (applicationProtocol)
    assert.equal(
      captured.includes(Buffer.from(applicationProtocol.requestMarker)),
      false,
    );
  abort.signal.throwIfAborted();
  report = {
    scope: 'browser-transport-evaluation',
    status: 'passed',
    applicationAccounts: accountReport ?? { status: 'not-run' },
    applicationProtocol: applicationProtocol
      ? {
          status: 'passed',
          responseBytes: applicationProtocol.responseBytes,
          scope: 'SDK framing fixture; no account or Station application API',
        }
      : { status: 'not-run' },
    browser: browser.version(),
    peerAdapter,
    ...(peerAdapter === 'pion'
      ? pionProvenance
      : {
          nodeDatachannel: '0.33.3',
          libdatachannel: datachannel.getLibraryVersion(),
        }),
    browserTurnTransport: browserTransport,
    stationTurnTransport: peerAdapter === 'pion' ? 'tcp' : 'udp',
    captureBytes: captured.length,
    turnImage: TURN_IMAGE,
    checks: [
      'TURN relay selected at both peers',
      'Station-signed exact client, generation and SDP proof verified and consumed in the browser',
      'Station signing identity restored from its private home before proof issuance',
      'tampered proof refused before accepting the connection description',
      'Device trust persisted and rechecked after crypto; cross-tab revocation refused before SDP acceptance',
      'browser-native DTLS connected',
      applicationPion
        ? 'authenticated SDK application payload crossed the production Pion channel without diagnostic echo'
        : 'application content echoed through encrypted data channel',
      'fresh browser and peer reconnect using the same approved Station certificate',
      'unapproved signaling fingerprint refused',
      'substituted endpoint fails DTLS fingerprint verification',
    ],
    selfHostedBroker: brokerJourney ?? { status: 'not-run' },
    fullBroker: selfHostedBroker ? 'lab-composition' : 'not-implemented',
    productionKeyAdmission: 'not-implemented',
  };
} catch (error) {
  errors.push(error);
  writeFileSync(
    join(root, 'protocol-diagnostics.json'),
    JSON.stringify(
      await Promise.allSettled(
        observers.map((read) => bounded(read(), 'protocol diagnostics')),
      ),
      null,
      2,
    ),
    { mode: 0o600 },
  );
} finally {
  stopBundler();
  for (const peer of peers) {
    try {
      await peer.close();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const cleanup of [
    () => (browser ? bounded(browser.close(), 'browser cleanup') : undefined),
    () => brokerLab?.stop(),
    () => accountStation?.stop(),
    () => relay?.close(),
    cleanupContainer,
  ]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  datachannel.cleanup();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
if (!report && !errors.length)
  errors.push(new Error('No completed browser transport report'));
if (errors.length) {
  writeFileSync(join(root, 'failure.txt'), inspect(errors, { depth: 5 }), {
    mode: 0o600,
  });
  process.exitCode = 1;
}
const finalReport = errors.length
  ? {
      scope: 'browser-transport-evaluation',
      status: 'failed',
      browserTurnTransport: browserTransport,
    }
  : report;
writeFileSync(join(root, 'report.json'), JSON.stringify(finalReport, null, 2), {
  mode: 0o600,
});
process.stdout.write(
  `STATION_BROWSER_TRANSPORT_REPORT ${JSON.stringify(finalReport)}\n`,
);
if (errors.length || args.includes('--keep'))
  process.stdout.write(`Private evidence: ${root}\n`);
else rmSync(root, { recursive: true, force: true });
