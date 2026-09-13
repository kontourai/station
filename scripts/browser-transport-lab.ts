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
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import {
  connectionDescriptionDigest,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { chromium, type Page } from '@playwright/test';
import { build, stop as stopBundler } from 'esbuild';
import datachannel from 'node-datachannel';
import type { createStationConnectionProofIssuer } from '../src-server/services/ssh/connection-proof-issuer.js';
import { ConnectionSigningKeyStore } from '../src-server/services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../src-server/services/ssh/environment-security-service.js';
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

// Transport evaluation only. No Station/account/provider API is enabled here.
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
      ].includes(arg),
  ) ||
  args.filter((arg) => arg.startsWith('--browser-turn=')).length > 1 ||
  args.filter((arg) => arg.startsWith('--peer=')).length > 1
)
  throw new Error(
    'Use --browser-turn=udp or --browser-turn=tcp and optional --keep',
  );
const peerAdapter = args.includes('--peer=pion') ? 'pion' : 'node';
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
  const authorityHome = join(root, 'station-authority');
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
  browser = await chromium.launch({ headless: true });
  abort.signal.throwIfAborted();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  const good = await exchange(page, approved, approved.fingerprint);
  await page.waitForFunction(browserChannelOpen, undefined, { timeout: 20000 });
  const marker = `private-station-content-${randomBytes(32).toString('hex')}`;
  await page.evaluate(browserSend, marker);
  await page.waitForFunction(browserReceived, marker, { timeout: 10000 });
  assert.deepEqual(good.messages, [marker]);
  const pair = good.peer.getSelectedCandidatePair();
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
  await context.close();
  await good.peer.close();

  const reconnectContext = await browser.newContext();
  const reconnectPage = await reconnectContext.newPage();
  await reconnectPage.goto(`http://127.0.0.1:${address.port}`);
  const reconnected = await exchange(
    reconnectPage,
    approved,
    approved.fingerprint,
  );
  await reconnectPage.waitForFunction(browserChannelOpen, undefined, {
    timeout: 20000,
  });
  await reconnectPage.evaluate(browserSend, marker);
  await reconnectPage.waitForFunction(browserReceived, marker, {
    timeout: 10000,
  });
  assert.deepEqual(reconnected.messages, [marker]);
  assert.equal(
    reconnected.peer.getSelectedCandidatePair()?.local.type,
    'relay',
  );
  assert.equal(
    reconnected.peer.getSelectedCandidatePair()?.remote.type,
    'relay',
  );
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
  await relay.close();
  const captured = readFileSync(relay.capturePath);
  assert(
    captured.length > 0,
    'Transport proof requires a nonempty relay capture',
  );
  assert.equal(captured.includes(Buffer.from(marker)), false);
  abort.signal.throwIfAborted();
  report = {
    scope: 'browser-transport-evaluation',
    status: 'passed',
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
      'application content echoed through encrypted data channel',
      'fresh browser and peer reconnect using the same approved Station certificate',
      'unapproved signaling fingerprint refused',
      'substituted endpoint fails DTLS fingerprint verification',
    ],
    fullBroker: 'not-implemented',
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
