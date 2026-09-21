import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { inspect } from 'node:util';
import {
  copyStationConnectionTrust,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { readEnvironmentSecurityRecord } from '@kontourai/station-shared/environment-security-record';
import { chromium } from '@playwright/test';
import { build, stop as stopBundler } from 'esbuild';
import { allocateFreePortBlock } from '../src-server/runtime/bootstrap/allocate-port-block.js';
import { runBrowserAccountScenario } from './lib/browser-account-scenario.js';
import { browserApplicationAccountRequest } from './lib/browser-application-account.mjs';
import { browserRemoteApplicationFetch } from './lib/browser-remote-relay.mjs';
import {
  browserBrokerAdmitApplicationTransport,
  browserBrokerAdoptApplicationTransport,
  browserBrokerConnect,
  browserBrokerReconnect,
} from './lib/browser-self-hosted-broker.mjs';
import { browserSetConnectionTrust } from './lib/browser-transport-page.mjs';
import {
  runLabCommand,
  startLabRelay,
} from './lib/local-collaboration-process.mjs';
import { provisionRelayAccountStation } from './lib/local-collaboration-relay-account.js';
import {
  startRemoteRelayForwards,
  startRemoteRelayProcess,
} from './lib/remote-relay-ssh.js';
import type {
  RelayDescriptor,
  RelayRunConfig,
} from './lib/remote-relay-station.js';
import { startSelfHostedBrokerProcess } from './lib/self-hosted-broker-process.js';
import { createTurnFixture, TURN_FIXTURE_IMAGE } from './lib/turn-fixture.js';

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i]!;
  if (name === '--keep') continue; // Evidence remains private and retained for qualification.
  assert(
    [
      '--ssh-host',
      '--remote-checkout',
      '--remote-node',
      '--pion-executable',
    ].includes(name) && !flags.has(name),
    'Unsupported or duplicate flag',
  );
  const value = process.argv[++i];
  assert(value && !value.startsWith('--'), 'Missing flag value');
  flags.set(name, value);
}
const host = flags.get('--ssh-host');
const checkout = flags.get('--remote-checkout');
const node = flags.get('--remote-node');
const pion = flags.get('--pion-executable');
assert(
  host && checkout && node && pion,
  'Required: --ssh-host --remote-checkout --remote-node --pion-executable',
);
assert(/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(host), 'Invalid SSH target');
function quote(path: string): string {
  assert(isAbsolute(path) && !/[\0\r\n]/.test(path), 'Invalid absolute path');
  return "'" + path.replaceAll("'", "'\\''") + "'";
}
for (const path of [checkout, node, pion]) quote(path);
assert(
  process.platform !== 'win32',
  'Remote lab controller requires POSIX private-file custody',
);
process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), 'station-remote-relay-'));
const remoteRoot = join(checkout, '.kontourai/remote-relay', randomUUID());
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Remote relay lab interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const errors: unknown[] = [];
let report: Record<string, unknown> | undefined;
let broker:
  | Awaited<ReturnType<typeof startSelfHostedBrokerProcess>>
  | undefined;
let turn: ReturnType<typeof createTurnFixture> | undefined;
let relay: Awaited<ReturnType<typeof startLabRelay>> | undefined;
let forwards: Awaited<ReturnType<typeof startRemoteRelayForwards>> | undefined;
let remote: Awaited<ReturnType<typeof startRemoteRelayProcess>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let clientScript = '';
const pageServer = createServer((request, response) => {
  response.writeHead(200, {
    'Content-Type':
      request.url === '/client.js' ? 'text/javascript' : 'text/html',
  });
  response.end(
    request.url === '/client.js'
      ? clientScript
      : '<!doctype html><title>Remote Station relay fixture</title><script src="/client.js"></script>',
  );
});
const sshOptions = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
];
async function ssh(command: string) {
  abort.signal.throwIfAborted();
  return runLabCommand('ssh', [...sshOptions, host!, command], root, 90_000);
}
async function sendFile(local: string, target: string, mode: '0600' | '0700') {
  // SCP uses the default SFTP protocol; each path is one process argument.
  await runLabCommand(
    'scp',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      local,
      host + ':' + target,
    ],
    root,
    60_000,
  );
  await ssh('chmod ' + mode + ' -- ' + quote(target));
}
try {
  const localSha = (
    await runLabCommand('git', ['rev-parse', 'HEAD'], process.cwd())
  ).stdout.trim();
  assert.match(localSha, /^[a-f0-9]{40}$/);
  const localDirty = Boolean(
    (
      await runLabCommand('git', ['status', '--porcelain'], process.cwd())
    ).stdout.trim(),
  );
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: [
        "import {createStationConnectionProofVerifier,connectionDescriptionDigest} from '@kontourai/station-shared/connection-proof';",
        "import {createStationProofNonce} from './packages/connect/src/core/environmentProof.ts';",
        "import {openDeviceConnectionTrustStore} from '@kontourai/station-connect/connection-trust';",
        'window.stationConnectionProof={createStationConnectionProofVerifier,connectionDescriptionDigest,newNonce:createStationProofNonce,openDeviceConnectionTrustStore};',
        "import {createApplicationChannelFetch,browserApplicationChannel} from '@kontourai/station-connect/application-channel';",
        "import {authenticatedFetch,setClientCredentialResolver,StationHttpError} from '@kontourai/station-sdk/client';",
        "import {ApplicationSessionClient,createApplicationSessionKey} from '@kontourai/station-sdk/application-session';",
        'window.stationApplicationChannel={createApplicationChannelFetch,browserApplicationChannel,authenticatedFetch,setClientCredentialResolver,StationHttpError,ApplicationSessionClient,createApplicationSessionKey};',
        "import {SelfHostedBrokerBrowserClient,createBrowserPionConnection,createSelfHostedApplicationTransport} from '@kontourai/station-connect/self-hosted-browser';",
        'window.stationSelfHostedBroker={SelfHostedBrokerBrowserClient,createBrowserPionConnection,createSelfHostedApplicationTransport};',
      ].join('\n'),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  assert.equal(bundle.outputFiles.length, 1);
  clientScript = bundle.outputFiles[0]!.text;
  stopBundler();
  pageServer.listen(0, '127.0.0.1');
  await once(pageServer, 'listening');
  const address = pageServer.address();
  assert(address && typeof address !== 'string');
  const browserOrigin = 'http://127.0.0.1:' + address.port;
  const initCommand =
    'umask 077 && mkdir -p -- ' +
    quote(join(checkout, '.kontourai/remote-relay')) +
    ' && mkdir -- ' +
    quote(remoteRoot) +
    ' && cd -- ' +
    quote(checkout) +
    ' && exec ' +
    quote(node) +
    ' --import tsx scripts/lib/remote-relay-station.ts init ' +
    quote(remoteRoot);
  const descriptor = JSON.parse(
    (await ssh(initCommand)).stdout,
  ) as RelayDescriptor;
  assert.equal(descriptor.version, 'remote-relay-descriptor/v1');
  assert.match(descriptor.sourceSha, /^[a-f0-9]{40}$/);
  const trust = copyStationConnectionTrust(descriptor.trust);
  assert.equal(descriptor.stationId, trust.stationId);
  assert.equal(await stationConnectionSigningKeyId(trust), descriptor.keyId);
  broker = await startSelfHostedBrokerProcess({
    directory: root,
    scope: {
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      routingGeneration: 1,
      browserOrigin,
    },
    signal: abort.signal,
  });
  const turnRoot = join(root, 'turn');
  mkdirSync(turnRoot, { mode: 0o700 });
  const username = 'station-fixture';
  const password = randomBytes(24).toString('hex');
  turn = createTurnFixture({
    directory: turnRoot,
    username,
    password,
    signal: abort.signal,
    lifetimeSeconds: 300,
  });
  const turnPorts = await turn.start();
  const relayRoot = join(root, 'relay');
  mkdirSync(relayRoot, { mode: 0o700 });
  relay = await startLabRelay(turnPorts.tcp, relayRoot, 'forward', 'tcp');
  const controlPort = await allocateFreePortBlock('127.0.0.1');
  forwards = await startRemoteRelayForwards({
    host,
    brokerPort: Number(new URL(broker.brokerOrigin).port),
    turnPort: relay.port,
    remoteStationPort: descriptor.stationPort,
    localControlPort: controlPort,
    directory: root,
    signal: abort.signal,
  });
  // Refuse a host policy that broadens the reverse listeners beyond loopback.
  const sockets = (await ssh('ss -H -lnt')).stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[3])
    .filter(Boolean);
  for (const port of [
    Number(new URL(forwards.brokerOrigin).port),
    forwards.turnPort,
  ]) {
    const matches = sockets.filter((value) => value.endsWith(':' + port));
    assert(
      matches.length > 0 &&
        matches.every(
          (value) => value === '127.0.0.1:' + port || value === '[::1]:' + port,
        ),
      'Reverse forwarding is not confined to loopback',
    );
  }
  const remoteBundle = join(remoteRoot, 'broker-credentials.json');
  const remotePion = join(remoteRoot, 'pion-peer');
  await sendFile(broker.credentialsPath, remoteBundle, '0600');
  await sendFile(pion, remotePion, '0700');
  const binarySha256 = createHash('sha256')
    .update(readFileSync(pion))
    .digest('hex');
  const uploadedHash = (
    await ssh('sha256sum -- ' + quote(remotePion))
  ).stdout.split(/\s+/)[0];
  assert.equal(uploadedHash, binarySha256);
  const config: RelayRunConfig = {
    version: 'remote-relay-run/v1',
    runRoot: remoteRoot,
    expectedSourceSha: descriptor.sourceSha,
    stationPort: descriptor.stationPort,
    applicationOrigin: forwards.controlOrigin,
    browserOrigin,
    brokerOrigin: forwards.brokerOrigin,
    connectorCredentialsPath: remoteBundle,
    pionExecutable: remotePion,
    turn: {
      url: 'turn:127.0.0.1:' + forwards.turnPort + '?transport=tcp',
      username,
      password,
    },
  };
  const configPath = join(root, 'remote-config.json');
  writeFileSync(configPath, JSON.stringify(config), {
    flag: 'wx',
    mode: 0o600,
  });
  const remoteConfigPath = join(remoteRoot, 'run-config.json');
  await sendFile(configPath, remoteConfigPath, '0600');
  remote = await startRemoteRelayProcess({
    host,
    checkout,
    nodeExecutable: node,
    configPath: remoteConfigPath,
    directory: root,
    signal: abort.signal,
  });
  assert.equal(remote.stationId, trust.stationId);
  assert.equal(remote.port, descriptor.stationPort);
  assert.equal(remote.provenance.sourceSha, descriptor.sourceSha);
  assert.equal(remote.provenance.fixtureSha256, descriptor.fixtureSha256);
  const securityPath = join(root, 'remote-environment.json');
  await runLabCommand(
    'scp',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      host + ':' + join(remoteRoot, 'home/security/environment.json'),
      securityPath,
    ],
    root,
    60_000,
  );
  chmodSync(securityPath, 0o600);
  const security = readEnvironmentSecurityRecord(securityPath);
  assert.equal(security.environmentId, trust.stationId);
  const identityResponse = await fetch(
    forwards.controlOrigin + '/api/system/identity',
    {
      headers: { Authorization: 'Bearer ' + security.credential },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    },
  );
  assert.equal(identityResponse.status, 200);
  const identity = await identityResponse.json();
  assert(
    identity &&
      typeof identity === 'object' &&
      'sha' in identity &&
      'instanceId' in identity &&
      'bootId' in identity,
    'Invalid runtime identity',
  );
  assert.equal(identity.sha, descriptor.sourceSha);
  assert.equal(identity.instanceId, 'remote-relay-fixture');
  assert.equal(identity.bootId, remote.provenance.bootId);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let directApplicationAttempts = 0;
  const applicationOrigin = forwards.controlOrigin;
  await page.route(applicationOrigin + '/**', async (route) => {
    directApplicationAttempts++;
    await route.abort('blockedbyclient');
  });
  await page.goto(browserOrigin);
  await page.evaluate(browserSetConnectionTrust, {
    trust,
    approvedKeyId: descriptor.keyId,
  });
  await page.evaluate(browserBrokerConnect, {
    brokerOrigin: broker.brokerOrigin,
    scope: broker.scope,
    routingId: broker.bundle.routing.id,
    routingSecret: broker.bundle.routing.secret,
    applicationOrigin,
    port: relay.port,
    username,
    password,
    transport: 'tcp',
  });
  await page.evaluate(browserBrokerAdmitApplicationTransport);
  const leaseBefore = await broker.readLease();
  const browserFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, applicationOrigin);
    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : await request.text();
    assert(
      !body || Buffer.byteLength(body) <= 16 * 1024,
      'Fixture request exceeds application channel bound',
    );
    request.signal.throwIfAborted();
    const result = await page.evaluate(browserRemoteApplicationFetch, {
      url: request.url,
      origin: applicationOrigin,
      method: request.method,
      headers: [...request.headers],
      body,
    });
    request.signal.throwIfAborted();
    return new Response(
      [204, 205, 304].includes(result.status) ? null : result.body,
      { status: result.status, headers: result.headers },
    );
  };
  const account = await provisionRelayAccountStation({
    station: {
      base: applicationOrigin,
      stationId: trust.stationId,
      operator: {
        credential: security.credential,
        credentialOrigin: applicationOrigin,
        requireCredential: true,
        headers: { Origin: applicationOrigin },
        redirect: 'error',
        timeoutMs: 15000,
        maxResponseBytes: 128 * 1024,
        signal: abort.signal,
      },
    },
    browserOrigin,
    signal: abort.signal,
    transport: browserFetch,
    stop: remote.stop,
  });
  let reconnected = false;
  const accountReport = await runBrowserAccountScenario(
    page,
    account,
    root,
    async () => {
      const connection = await page.evaluate(browserBrokerReconnect);
      assert.notEqual(connection.previous, connection.connectionId);
      await page.evaluate(browserBrokerAdmitApplicationTransport);
      await page.evaluate(browserBrokerAdoptApplicationTransport);
      assert.equal(
        (
          await page.evaluate(browserApplicationAccountRequest, {
            path: '/api/projects/relay-shared',
          })
        ).status,
        200,
      );
      reconnected = true;
    },
  );
  assert.equal(accountReport.status, 'passed');
  assert.equal(directApplicationAttempts, 0);
  assert(reconnected);
  const leaseDeadline = Date.now() + 20_000;
  while ((await broker.readLease()).expiresAt <= leaseBefore.expiresAt) {
    assert(Date.now() < leaseDeadline, 'Broker lease did not renew');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  await remote.stop();
  await assert.rejects(broker.readLease(), /broker_request_refused_401/);
  await relay.close();
  const capture = readFileSync(relay.capturePath);
  assert(capture.length > 0, 'Relay capture is empty');
  for (const secret of [
    account.browser.password,
    account.browser.credential,
    account.browser.invitation,
    'Relay shared fixture',
  ])
    assert(
      !capture.includes(Buffer.from(secret)),
      'Application content was readable in TURN capture',
    );
  report = {
    scope: 'remote-station-relay-acceptance',
    status: 'passed',
    localSourceSha: localSha,
    localDirty,
    remoteSourceSha: descriptor.sourceSha,
    remoteDirty: descriptor.dirty,
    fixtureSha256: descriptor.fixtureSha256,
    binarySha256,
    browser: browser.version(),
    turnImage: TURN_FIXTURE_IMAGE,
    topology:
      'Mac Chromium and TURN; Linux Station/Pion; TURN and signaling over explicit SSH reverse TCP; Node-only operator control over SSH',
    account: accountReport,
    directApplicationAttempts,
    leaseRenewed: true,
    reconnected,
    withdrawalRefused: true,
    captureBytes: capture.length,
    limits: [
      'synthetic accounts and preapproved fixture Device',
      'no fresh guest or normal UI enrollment',
      'no native/real-human proof',
      'not native remote UDP or direct tailnet transport',
    ],
  };
} catch (error) {
  errors.push(error);
} finally {
  stopBundler();
  for (const cleanup of [
    () => browser?.close(),
    () => remote?.stop(),
    () => forwards?.stop(),
    () => broker?.stop(),
    () => relay?.close(),
    () => turn?.stop(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  pageServer.closeAllConnections();
  if (pageServer.listening)
    await new Promise<void>((resolveClose) =>
      pageServer.close(() => resolveClose()),
    );
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
if (!report && !errors.length)
  errors.push(new Error('No completed remote relay report'));
if (errors.length) {
  writeFileSync(join(root, 'failure.txt'), inspect(errors, { depth: 5 }), {
    mode: 0o600,
  });
  report = {
    scope: 'remote-station-relay-acceptance',
    status: 'failed',
    remoteRoot,
  };
  process.exitCode = 1;
}
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
console.log('STATION_REMOTE_RELAY_REPORT ' + JSON.stringify(report));
console.log('Private evidence: ' + root);
console.log('Owned remote fixture retained: ' + remoteRoot);
