import { execFile } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import { expect } from '@playwright/test';
import { localLabEnvironment } from '../scripts/lib/local-collaboration-process.mjs';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  type LiveStation,
  startStation,
  stopStation,
} from './helpers/live-station-task';
import {
  instanceHome,
  poll,
  startTempHomeInstance,
} from './live/helpers/station-instance.mjs';

/**
 * #484/#106 — an ACTUAL two-independent-Station portable-execution proof.
 *
 * Two real server processes are booted from this checkout's committed source:
 * a CONTROLLER (the delegating Station) and a RECEIVER (the executing
 * Station), each in its own isolated home under its own STATION_ROOT with
 * non-default ports. Nothing here is an in-process Hono app, a spy, or a
 * fixture credential minted by the test: pairing runs the receiver's real
 * offer → request → operator-approval → exchange HTTP ceremony (kind
 * `delegation`), the resulting peer credential is saved through the
 * controller's real outbound peer-credential API, the receiver's offer is
 * configured through the real operator API `PUT /api/project-contributions/
 * offer`, and the delegation goes through the controller's real
 * `POST /api/orchestration/delegations` with `workspace.kind =
 * 'project-portable'`.
 *
 * THE CONTROLLER HOLDS NO OFFER. Per the controller/receiver admission
 * split, only the receiver admits the portable intent, so every refusal
 * below is exercised through the real peer hop and asserted by the typed
 * refusal CODE (`receiver_execution_*`) and exact status — never a bare 4xx.
 *
 * The ONLY modeled component is the model behind the turn: the receiver's
 * muse engine runs `STATION_E2E_MUSE_PROVIDER=echo`, muse's own key-less
 * provider. Echo output (`echo: <unique token>`) proves the PROVIDER
 * executed; it cannot prove the OS working directory, so the provider output
 * is kept strictly separate from (a) the DECLARED receipt
 * (`handle.resolution.environmentId` + resolved `workspace.cwd`) and (b) an
 * ACTUAL launch observation: a read-only PATH shim records the argv and cwd
 * of every muse process launch and then `exec`s the real binary. Launches
 * are counted per request (deltas), with the current turn's unique token in
 * the argv tying an observation to THIS turn.
 *
 * Operator credentials are read ONLY from each fixture's isolated home,
 * never from the operator's real home, and the receiver's operator secret is
 * never shared with the controller or the peer credential.
 *
 * Unsupported-peer (old receiver without `portableExecutionOffers`) is
 * deliberately NOT VERIFIED here: it needs a genuinely older receiver build,
 * and fabricating one would weaken the check, not prove it.
 */

const execFileAsync = promisify(execFile);
const NODE_BIN = process.execPath.replace(/\/node$/, '');
const ARTIFACT_DIR =
  process.env.PORTABLE_PROOF_ARTIFACT_DIR ??
  join(tmpdir(), 'portable-receiver-live-proof-artifacts');

/** The canonical remote BOTH fixture checkouts declare. Local-only; never fetched. */
const FIXTURE_REMOTE =
  'https://git-fixture.example.test/portable-proof/repo.git';
const OTHER_REMOTE =
  'https://git-fixture.example.test/portable-proof/other.git';
/** Canonicalized forms (Station strips scheme and .git); what offers compare. */
const FIXTURE_REMOTE_CANONICAL = 'git-fixture.example.test/portable-proof/repo';
const OTHER_REMOTE_CANONICAL = 'git-fixture.example.test/portable-proof/other';
const RECEIVER_SLUG = 'receiver-local-alias';
const CONTROLLER_SLUG = 'portable-source';
const EXECUTION_ROOT_PATH = 'service/inner';

const KNOWN_PORTABLE_REFUSAL_CODES = [
  'receiver_execution_not_offered',
  'receiver_execution_unavailable',
  'receiver_execution_authority_changed',
  'receiver_execution_forwarding_refused',
] as const;
type PortableRefusalCode = (typeof KNOWN_PORTABLE_REFUSAL_CODES)[number];

// --- Guaranteed teardown state (registered BEFORE any await) --------------
const ownedRoots: string[] = [];
const ownedCleanups: Array<{ label: string; run: () => Promise<unknown> }> = [];
let anyTestFailed = false;
let setupError: Error | undefined;
let fixture: ProofFixture | undefined;
let evidenceDestination: string | undefined;
/** Incremental, non-secret run metadata — written even on partial setup. */
const runInfo: Record<string, unknown> = {};
const ownedLogs: Array<{ label: string; path: string }> = [];

async function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    encoding: 'utf8',
  });
}

interface ApiResult {
  status: number;
  payload: any;
  setCookie?: string;
}

async function api(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(20_000),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // status-only endpoints
  }
  const setCookie = response.headers.get('set-cookie') ?? undefined;
  return { status: response.status, payload, setCookie };
}

function operatorHeaders(credential: string): Record<string, string> {
  return { Authorization: `Bearer ${credential}` };
}

/**
 * Mints a Station's LOCAL operator device session over HTTP: per-boot
 * local-grant secret → launcher capability → ui-bootstrap exchange, exactly
 * as the launcher's browser runs it. The resulting session is bound
 * `home-possession` at mint, which is the identity the offer leaf's
 * `canManage` derives from. The secret and the credential both live inside
 * the fixture home; the operator's real home is never touched.
 */
async function mintLocalOperatorCredential(
  home: string,
  apiBase: string,
  uiOrigin: string,
): Promise<string> {
  const secret = (
    await readFile(join(home, 'runtime', 'local-grant.secret'), 'utf8')
  ).trim();
  const minted = await api(
    apiBase,
    'POST',
    '/.well-known/station/v1/pairing/mint-ui-bootstrap',
    {
      body: { secret, purpose: 'launcher' },
      headers: { Origin: uiOrigin },
    },
  );
  expect(minted.status, JSON.stringify(minted.payload)).toBe(200);
  const bootstrapped = await api(
    apiBase,
    'POST',
    '/.well-known/station/v1/pairing/ui-bootstrap',
    {
      body: { token: (minted.payload as JsonRecord).token as string },
      headers: { Origin: uiOrigin },
    },
  );
  expect(bootstrapped.status, JSON.stringify(bootstrapped.payload)).toBe(200);
  const credential = (
    (bootstrapped.setCookie ?? '')
      .split(';')[0]
      ?.split('=')
      .slice(1)
      .join('=') ?? ''
  ).trim();
  expect(
    credential.length,
    `${apiBase} did not mint a local ui-bootstrap device session`,
  ).toBeGreaterThan(0);
  return credential;
}

/**
 * Sanitized launch environment for a fixture Station: OS launch inputs only,
 * HOME/TMP/XDG pointed INSIDE the fixture root, model credentials and any
 * inherited STATION_* configuration dropped.
 */
function stationEnvironment(root: string, extra: NodeJS.ProcessEnv = {}) {
  const lab = localLabEnvironment() as NodeJS.ProcessEnv;
  const homeInsideRoot = join(root, 'posix-home');
  const tmpInsideRoot = join(root, 'tmp');
  mkdirSync(homeInsideRoot, { recursive: true });
  mkdirSync(tmpInsideRoot, { recursive: true });
  return {
    ...lab,
    HOME: homeInsideRoot,
    USERPROFILE: homeInsideRoot,
    TMPDIR: tmpInsideRoot,
    TMP: tmpInsideRoot,
    TEMP: tmpInsideRoot,
    XDG_CONFIG_HOME: join(homeInsideRoot, '.config'),
    XDG_CACHE_HOME: join(homeInsideRoot, '.cache'),
    XDG_DATA_HOME: join(homeInsideRoot, '.local', 'share'),
    STATION_LOG_LEVEL: 'error',
    OTEL_SDK_DISABLED: 'true',
    AWS_EC2_METADATA_DISABLED: 'true',
    PATH: `${NODE_BIN}${delimiter}${lab.PATH ?? process.env.PATH ?? ''}`,
    ...extra,
  };
}

async function createFixtureCheckout(
  directory: string,
  remote: string,
  innerDirs: string[] = [],
) {
  mkdirSync(directory, { recursive: true });
  await run('git', ['init', '--initial-branch', 'main'], { cwd: directory });
  await run('git', ['config', 'user.email', 'portable-proof@example.test'], {
    cwd: directory,
  });
  await run('git', ['config', 'user.name', 'Portable Proof'], {
    cwd: directory,
  });
  await run('git', ['remote', 'add', 'origin', remote], { cwd: directory });
  let nested = directory;
  for (const segment of innerDirs) {
    nested = join(nested, segment);
    mkdirSync(nested, { recursive: true });
  }
  writeFileSync(join(nested, 'PROOF.md'), 'portable receiver proof\n');
  await run('git', ['add', '-A'], { cwd: directory });
  await run('git', ['commit', '-m', 'portable proof fixture'], {
    cwd: directory,
  });
}

interface JsonRecord {
  [key: string]: unknown;
}

interface ProofFixture {
  root: string;
  controller: LiveStation;
  receiver: LiveStation;
  receiverHome: string;
  receiverInstanceId: string;
  controllerOperator: string;
  receiverOperator: string;
  controllerLocalCredential: string;
  receiverLocalCredential: string;
  controllerEnv: NodeJS.ProcessEnv;
  receiverEnv: NodeJS.ProcessEnv;
  controllerHome: string;
  receiverCheckout: string;
  receiverExecutionRoot: string;
  identity: JsonRecord;
  portableProjectId: string;
  resourceId: string;
  receiverLocalProjectId: string;
  museAgentSlug: string;
  receiverEnvironmentId: string;
  delegationCredential: string;
  delegationScope: string;
  peerDeviceId: string;
  offerConfig: JsonRecord;
  museExecLaunches: () => Promise<Array<{ cwd: string; args: string }>>;
}

async function buildFixture(): Promise<ProofFixture> {
  const root = mkdtempSync(join(tmpdir(), 'portable-receiver-proof-'));
  // Register the root the moment it exists, before anything can fail.
  ownedRoots.push(root);

  const controllerCheckout = join(root, 'controller', CONTROLLER_SLUG);
  const receiverCheckout = join(root, 'receiver', 'checkout-elsewhere');
  await createFixtureCheckout(controllerCheckout, FIXTURE_REMOTE);
  await createFixtureCheckout(receiverCheckout, FIXTURE_REMOTE, [
    'service',
    'inner',
  ]);
  const receiverExecutionRoot = realpathSync(
    join(receiverCheckout, ...EXECUTION_ROOT_PATH.split('/')),
  );

  // Muse launch observation shim: append-only JSONL of {cwd, args}, then exec
  // the REAL muse binary. Read-only observation; the provider path is intact.
  const museResolved = await run('sh', ['-c', 'command -v muse']);
  const museRealBinary = museResolved.stdout.trim();
  if (!museRealBinary)
    throw new Error(
      'muse is not on PATH; a host that cannot run muse cannot prove this journey',
    );
  const museLaunchLog = join(root, 'muse-launch-observations.jsonl');
  const shimDir = join(root, 'muse-observation-shim');
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, 'muse');
  writeFileSync(
    shimPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "{\\"cwd\\":\\"$PWD\\",\\"args\\":\\"$*\\"}" >> '${museLaunchLog}'`,
      `exec '${museRealBinary}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(shimPath, 0o755);

  // Ports/homes for the two Stations: two separate canonical allocations,
  // each an isolated sibling home/root outside 3141/3000.
  const controllerLive = await allocateLiveStation(
    'station-portable-proof-controller-',
    'portable-controller',
  );
  const receiverPorts = await allocateLiveStation(
    'station-portable-proof-receiver-',
    'portable-receiver',
  );
  if (receiverPorts.serverPort === controllerLive.serverPort)
    throw new Error('port allocation collided between the two Stations');

  // The receiver's instance name MUST land in the runner-owned namespace the
  // muse echo containment gate accepts (`/^e2e-smoke-live-[a-z0-9]+-[a-z0-9]+$/`
  // in src-server/providers/adapters/muse-adapter.ts) — that gate plus the
  // CLI-spawned `--temp-home` marker is what authorizes the echo provider.
  const receiverInstanceId = `e2e-smoke-live-rcv-${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const controllerEnv = stationEnvironment(join(root, 'controller'));
  const receiverEnv = stationEnvironment(join(root, 'receiver'), {
    STATION_E2E_MUSE_PROVIDER: 'echo',
    // Presence-only fixture credential: muse's readiness derivation requires
    // a credential to EXIST, and the echo provider never uses it (no key,
    // no network). Synthetic value inside the fixture environment only.
    META_API_KEY: 'e2e-echo-fixture-presence-only-key',
    PATH: `${shimDir}${delimiter}${NODE_BIN}${delimiter}${
      (controllerEnv.PATH as string) ?? ''
    }`,
  });

  // START the boot, register its cleanup BEFORE awaiting, then await — so a
  // partial or failed boot still gets a stop attempt in the guaranteed
  // afterAll lifecycle.
  ownedLogs.push(
    { label: 'controller-station', path: join(root, 'controller-station.log') },
    { label: 'receiver-station', path: join(root, 'receiver-station.log') },
    {
      label: 'muse-launch-observations',
      path: join(root, 'muse-launch-observations.jsonl'),
    },
  );
  const controllerBoot = startStation(controllerLive, true, {
    environment: controllerEnv,
    logFile: join(root, 'controller-station.log'),
  });
  ownedCleanups.push({
    label: `controller ${controllerLive.instance}`,
    run: () => stopStation(controllerLive, { environment: controllerEnv }),
  });
  await controllerBoot;
  runInfo.controller = {
    instance: controllerLive.instance,
    api: controllerLive.api,
    ui: controllerLive.ui,
  };

  const receiverBoot = startTempHomeInstance({
    root: process.cwd(),
    instance: receiverInstanceId,
    serverPort: receiverPorts.serverPort,
    uiPort: receiverPorts.uiPort,
    logPath: join(root, 'receiver-station.log'),
    env: receiverEnv,
    // `--temp-home` is REQUIRED here: the muse echo containment gate trusts
    // the CLI-spawned STATION_HOME_SOURCE marker, so the receiver must be
    // booted with the launcher's own throwaway home, not a `--base` home.
    home: undefined as unknown as string,
  });
  ownedCleanups.push({
    label: `receiver ${receiverInstanceId}`,
    run: async () => {
      const booted = (await receiverBoot.catch(() => null)) as {
        stop: () => Promise<unknown>;
      } | null;
      if (booted) await booted.stop();
    },
  });
  const receiverTempHome = await receiverBoot;
  const receiverHome = instanceHome(process.cwd(), receiverInstanceId);
  const receiver: LiveStation = {
    api: `http://127.0.0.1:${receiverPorts.serverPort}`,
    home: receiverHome,
    instance: receiverInstanceId,
    serverPort: receiverPorts.serverPort,
    ui: `http://127.0.0.1:${receiverPorts.uiPort}`,
    uiPort: receiverPorts.uiPort,
  };
  runInfo.receiver = {
    instance: receiverInstanceId,
    api: receiver.api,
    ui: receiver.ui,
  };

  const controllerOperator = readE2EOperatorCredential(controllerLive.home);
  const receiverOperator = readE2EOperatorCredential(receiverHome);
  const controllerLocalCredential = await mintLocalOperatorCredential(
    controllerLive.home,
    controllerLive.api,
    controllerLive.ui,
  );
  const receiverLocalCredential = await mintLocalOperatorCredential(
    receiverHome,
    receiver.api,
    receiver.ui,
  );
  expect(receiverLocalCredential).not.toBe(receiverOperator);

  // --- Controller side: real Project with the fixture portable identity.
  // NO controller offer: the controller/receiver split means only the
  // receiver admits, and the harness asserts that absence below.
  const created = await api(controllerLive.api, 'POST', '/api/projects', {
    body: {
      name: 'Portable Source',
      slug: CONTROLLER_SLUG,
      workingDirectory: controllerCheckout,
    },
    headers: operatorHeaders(controllerOperator),
  });
  expect(created.status, JSON.stringify(created.payload)).toBe(201);
  const prepared = await api(
    controllerLive.api,
    'POST',
    `/api/projects/${CONTROLLER_SLUG}/identity/prepare`,
    { headers: operatorHeaders(controllerOperator) },
  );
  expect(prepared.status, JSON.stringify(prepared.payload)).toBe(200);
  const identityView = (prepared.payload as JsonRecord).data as JsonRecord;
  const identity = identityView.identity as JsonRecord;
  // Inspect the PREPARE result: the portable id and the primary resource
  // must be real before anything downstream can be trusted.
  expect(typeof identity.id).toBe('string');
  expect((identity.id as string).length).toBeGreaterThan(0);
  const repos = identity.repos as Array<JsonRecord>;
  expect(repos.length).toBe(1);
  const resourceId = repos[0]!.id as string;
  expect(resourceId).toBe(FIXTURE_REMOTE_CANONICAL);

  // --- Receiver side: SAME portable identity, DIFFERENT slug and local path,
  // attached through the real attach API (which verifies the checkout's git
  // remote against the identity's canonical remote).
  const attached = await api(receiver.api, 'POST', '/api/projects/attach', {
    body: {
      name: 'Receiver Local Alias',
      slug: RECEIVER_SLUG,
      workingDirectory: receiverCheckout,
      identity,
    },
    headers: operatorHeaders(receiverOperator),
  });
  expect(attached.status, JSON.stringify(attached.payload)).toBe(201);
  const attachData = (attached.payload as JsonRecord).data as JsonRecord;
  const association = attachData.association as JsonRecord;
  const receiverLocalProjectId = association.localProjectId as string;

  // Nested execution root, set through the real identity API.
  const rooted = await api(
    receiver.api,
    'PUT',
    `/api/projects/${RECEIVER_SLUG}/identity/execution-root`,
    {
      body: {
        expectedIdentity: identity,
        expectedLocalProjectId: receiverLocalProjectId,
        executionRoot: { repoId: resourceId, path: EXECUTION_ROOT_PATH },
      },
      headers: operatorHeaders(receiverOperator),
    },
  );
  expect(rooted.status, JSON.stringify(rooted.payload)).toBe(200);

  // --- Receiver offer through the REAL operator API (the ONLY offer).
  const receiverIdentity = await api(
    receiver.api,
    'GET',
    `/api/projects/${RECEIVER_SLUG}/identity`,
    { headers: operatorHeaders(receiverOperator) },
  );
  expect(receiverIdentity.status).toBe(200);
  const offered = await api(
    receiver.api,
    'PUT',
    '/api/project-contributions/offer',
    {
      body: {
        portableProjectId: identity.id,
        localProjectId: receiverLocalProjectId,
        resourceId,
        expected: null,
        enabled: true,
      },
      headers: operatorHeaders(receiverLocalCredential),
    },
  );
  expect(offered.status, JSON.stringify(offered.payload)).toBe(200);
  const offerConfig = (offered.payload as JsonRecord).data as JsonRecord;

  // --- Receiver pairing ceremony (kind delegation), entirely over HTTP.
  const scope = pairingScopePresetString('delegation');
  const offer = await api(receiver.api, 'POST', '/api/pairing/offers', {
    body: { endpoint: receiver.api, scope, kind: 'delegation' },
    headers: operatorHeaders(receiverOperator),
  });
  expect(offer.status, JSON.stringify(offer.payload)).toBe(201);
  const offerData = offer.payload as JsonRecord;
  const pairingRequest = await api(
    receiver.api,
    'POST',
    '/.well-known/station/v1/pairing/request',
    {
      body: {
        deviceName: 'Portable proof controller',
        offerId: offerData.offerId,
        proof: offerData.challenge,
      },
      headers: { Origin: receiver.ui },
    },
  );
  expect(pairingRequest.status, JSON.stringify(pairingRequest.payload)).toBe(
    202,
  );
  const requestData = pairingRequest.payload as JsonRecord;
  const confirmed = await api(
    receiver.api,
    'POST',
    `/api/pairing/requests/${encodeURIComponent(
      requestData.requestId as string,
    )}/confirm`,
    { headers: operatorHeaders(receiverOperator) },
  );
  expect(confirmed.status, JSON.stringify(confirmed.payload)).toBe(200);
  const exchanged = await api(
    receiver.api,
    'POST',
    '/.well-known/station/v1/pairing/exchange',
    {
      body: {
        offerId: offerData.offerId,
        proof: offerData.challenge,
        requestId: requestData.requestId,
      },
      headers: { Origin: receiver.ui },
    },
  );
  expect(exchanged.status, JSON.stringify(exchanged.payload)).toBe(200);
  const exchangeData = exchanged.payload as JsonRecord;
  const delegationCredential = exchangeData.credential as string;
  const peerDeviceId = (exchangeData.device as JsonRecord | undefined)
    ?.id as string;
  expect(delegationCredential).toBeTruthy();
  expect(peerDeviceId).toBeTruthy();
  // The paired credential is a DELEGATION device credential, never the
  // receiver's operator secret.
  expect(delegationCredential).not.toBe(receiverOperator);

  // --- Receiver public handshake: capability + environment identity.
  const handshake = await api(receiver.api, 'GET', '/.well-known/station/v1');
  expect(handshake.status).toBe(200);
  const handshakeData = handshake.payload as JsonRecord;
  const receiverEnvironmentId = handshakeData.environmentId as string;
  expect(receiverEnvironmentId).toBeTruthy();
  const capabilities = handshakeData.capabilities as JsonRecord;
  expect(capabilities.portableExecutionOffers).toBe(true);

  // --- Controller: save the outbound peer credential through its REAL API.
  const savedPeer = await api(
    controllerLive.api,
    'POST',
    '/api/environments/peers',
    {
      body: {
        environmentId: receiverEnvironmentId,
        apiBase: receiver.api,
        credential: delegationCredential,
        scope,
        label: 'Portable proof receiver',
      },
      headers: operatorHeaders(controllerOperator),
    },
  );
  expect(savedPeer.status, JSON.stringify(savedPeer.payload)).toBe(201);

  // --- Receiver: materialize the muse engine's agent (canonical path).
  const materialized = await api(
    receiver.api,
    'POST',
    '/agents/materialize-engine',
    { body: { engineId: 'muse' }, headers: operatorHeaders(receiverOperator) },
  );
  // The materialize route answers 200, or 202 while runtime activation is
  // pending reconciliation — both are its contractual success statuses.
  expect([200, 202]).toContain(materialized.status);
  expect(materialized.status, JSON.stringify(materialized.payload)).toBeLessThan(300);
  const museAgentSlug = (
    (materialized.payload as JsonRecord).data as JsonRecord
  ).slug as string;
  expect(museAgentSlug).toBeTruthy();

  const museExecLaunches = async () => {
    if (!existsSync(museLaunchLog)) return [];
    const lines = (await readFile(museLaunchLog, 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0);
    return lines
      .map((line) => JSON.parse(line) as { cwd: string; args: string })
      .filter((entry) => entry.args.includes('exec'));
  };

  return {
    root,
    controller: controllerLive,
    receiver,
    receiverHome,
    receiverInstanceId,
    controllerOperator,
    receiverOperator,
    controllerLocalCredential,
    receiverLocalCredential,
    controllerEnv,
    receiverEnv,
    controllerHome: controllerLive.home,
    receiverCheckout,
    receiverExecutionRoot,
    identity,
    portableProjectId: identity.id as string,
    resourceId,
    receiverLocalProjectId,
    museAgentSlug,
    receiverEnvironmentId,
    delegationCredential,
    delegationScope: scope,
    peerDeviceId,
    offerConfig,
    museExecLaunches,
  };
}

// ---------------------------------------------------------------------------
// Guaranteed lifecycle: afterAll runs even when tests fail; every owned
// runtime and root is registered BEFORE the await that creates it.
// ---------------------------------------------------------------------------

test.afterEach(({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) anyTestFailed = true;
});

test.afterAll(async () => {
  // 1. Stop every owned runtime in reverse registration order, remembering
  // which stops did not confirm.
  const unconfirmed: string[] = [];
  let stopError: unknown;
  for (const cleanup of [...ownedCleanups].reverse()) {
    try {
      await cleanup.run();
    } catch (error) {
      stopError = error;
      unconfirmed.push(cleanup.label);
    }
  }
  // 2. Independently confirm no owned listener remains: probe each recorded
  // port and expect the connection to be refused.
  const liveStations = [fixture?.controller, fixture?.receiver].filter(
    (live): live is LiveStation => Boolean(live),
  );
  for (const live of liveStations) {
    try {
      await fetch(
        `http://127.0.0.1:${live.serverPort}/.well-known/station/v1`,
        {
          signal: AbortSignal.timeout(2_000),
        },
      );
      unconfirmed.push(`port ${live.serverPort} still accepting`);
    } catch {
      // refused/timed out = stopped
    }
  }
  // 3. Preserve evidence UNTIL every owned process stop is confirmed — and
  // whenever any test failed. Only non-secret artifacts: station logs, the
  // muse launch observation ledger, and non-secret run metadata (ports,
  // ids). Fixture homes (credentials, key material) are never copied.
  if (anyTestFailed || setupError || unconfirmed.length > 0 || stopError) {
    try {
      mkdirSync(ARTIFACT_DIR, { recursive: true });
      const stamp = `${String(runInfo.receiver ? (runInfo.receiver as JsonRecord).instance : 'partial-setup')}-${Date.now()}`;
      evidenceDestination = join(ARTIFACT_DIR, stamp);
      mkdirSync(evidenceDestination, { recursive: true });
      for (const log of ownedLogs) {
        if (existsSync(log.path))
          cpSync(log.path, join(evidenceDestination, `${log.label}.log`));
      }
      writeFileSync(
        join(evidenceDestination, 'run-meta.json'),
        JSON.stringify(
          {
            outcome: setupError
              ? 'setup-failure'
              : anyTestFailed
                ? 'test-failure'
                : 'cleanup-unconfirmed',
            unconfirmed,
            controllerHasOffer: null,
            ...runInfo,
          },
          null,
          2,
        ),
      );
    } catch (copyError) {
      console.error('evidence preservation failed', copyError);
    }
  }
  // 4. Remove temporary roots ONLY when every stop confirmed and no test
  // failed. Never touch anything outside this run's mkdtemp roots.
  if (!anyTestFailed && unconfirmed.length === 0 && !stopError) {
    for (const root of ownedRoots)
      rmSync(root, { recursive: true, force: true });
  }
  ownedCleanups.length = 0;
  const preserveNote =
    evidenceDestination ??
    ownedRoots[ownedRoots.length - 1] ??
    'unknown location';
  fixture = undefined;
  if (stopError || unconfirmed.length > 0)
    throw new Error(
      `Failed to stop an owned fixture runtime (${unconfirmed.join(', ') || 'unknown'}); diagnostic homes preserved at ${preserveNote}`,
      { cause: stopError },
    );
});

function delegationTarget(
  fixture: ProofFixture,
  overrides: {
    portableProjectId?: string;
    resourceId?: string;
    environmentId?: string;
  } = {},
) {
  return {
    environment: {
      kind: 'saved',
      id: overrides.environmentId ?? fixture.receiverEnvironmentId,
    },
    agent: fixture.museAgentSlug,
    workspace: {
      kind: 'project-portable',
      portableProjectId:
        overrides.portableProjectId ?? fixture.portableProjectId,
      resourceId: overrides.resourceId ?? fixture.resourceId,
    },
  };
}

async function delegateFromController(
  fixture: ProofFixture,
  target: JsonRecord,
  prompt = 'portable proof negative control',
): Promise<ApiResult> {
  // The controller intermittently refuses with a bounded, self-described
  // retry window right after any config mutation ("Agent catalog is
  // refreshing…"). Only THIS exact pre-effect refusal is retried (HTTP 400,
  // no handle, nothing dispatched), and the retry budget is bounded and
  // documented; a dispatch that already returned a handle is NEVER retried.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const delegated = await api(
      fixture.controller.api,
      'POST',
      '/api/orchestration/delegations',
      {
        body: { prompt, target },
        headers: operatorHeaders(fixture.controllerOperator),
      },
    );
    if (
      delegated.status === 400 &&
      String((delegated.payload as JsonRecord)?.error ?? '').includes(
        'Agent catalog is refreshing',
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    return delegated;
  }
}

/** Assert the EXACT typed refusal contract on the wire. */
function expectPortableRefusal(
  refused: ApiResult,
  code: PortableRefusalCode,
  message: string,
): void {
  expect(refused.status, JSON.stringify(refused.payload)).toBe(403);
  expect((refused.payload as JsonRecord).code).toBe(code);
  expect((refused.payload as JsonRecord).error).toBe(message);
}

/** Captured per-request no-effect oracle: launch delta + usage delta. */
interface EffectBaseline {
  launches: number;
  usageByModel: JsonRecord;
}

async function captureEffectBaseline(
  fixture: ProofFixture,
): Promise<EffectBaseline> {
  const usage = await api(fixture.receiver.api, 'GET', '/api/analytics/usage', {
    headers: operatorHeaders(fixture.receiverLocalCredential),
  });
  expect(usage.status, JSON.stringify(usage.payload)).toBe(200);
  const stats = ((usage.payload as JsonRecord).data ?? {}) as JsonRecord;
  return {
    launches: (await fixture.museExecLaunches()).length,
    usageByModel: (stats.byModel ?? {}) as JsonRecord,
  };
}

async function assertNoProviderEffect(
  fixture: ProofFixture,
  baseline: EffectBaseline,
): Promise<void> {
  const launches = await fixture.museExecLaunches();
  expect(
    launches.length - baseline.launches,
    'muse exec launched after a refusal',
  ).toBe(0);
  // Captured DELTA of the receiver's model usage counters: identical before
  // and after the refusal. (Lifetime emptiness is NOT the oracle; the turn
  // in the positive test may legitimately create rows.)
  const usage = await api(fixture.receiver.api, 'GET', '/api/analytics/usage', {
    headers: operatorHeaders(fixture.receiverLocalCredential),
  });
  expect(usage.status).toBe(200);
  const stats = ((usage.payload as JsonRecord).data ?? {}) as JsonRecord;
  expect((stats.byModel ?? {}) as JsonRecord).toEqual(baseline.usageByModel);
}

test.describe
  .serial('portable receiver live proof (#484/#106)', () => {
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      // Two Station boots plus the full offer/pairing chain exceed the
      // default 30s hook timeout; the setup gets its own explicit budget.
      testInfo.setTimeout(600_000);
      try {
        fixture = await buildFixture();
      } catch (error) {
        setupError = error as Error;
        throw error;
      }
      // The controller MUST NOT hold an offer: the controller/receiver split
      // means sender-side admission would mask receiver refusals. Read the
      // controller's fixture config and assert the contribution scope absent.
      const controllerConfig = JSON.parse(
        await readFile(
          join(fixture.controllerHome, 'config', 'app.json'),
          'utf8',
        ),
      ) as JsonRecord;
      expect(controllerConfig.contribution ?? null).toBeNull();
    });

    test('delegates a project-portable turn and completes it on the receiver via the echo provider', async () => {
      test.setTimeout(600_000);
      test.fixme(setupError !== undefined, 'setup failed');
      const current = fixture!;
      const baseline = await captureEffectBaseline(current);
      const turnToken = `portable-proof-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;

      const delegated = await delegateFromController(
        current,
        delegationTarget(current) as unknown as JsonRecord,
        `Return this token unchanged: ${turnToken}`,
      );
      expect(delegated.status, JSON.stringify(delegated.payload)).toBe(200);
      const handle = (delegated.payload as JsonRecord).data as JsonRecord;
      const resolution = handle.resolution as JsonRecord;
      const taskId = handle.taskId as string;
      expect(taskId).toBeTruthy();

      // DECLARED receipt: the receiver's own environment resolved it. (The
      // handle is the RECEIVER's projection of the task, so its environment
      // names the receiver by id; `kind` is the receiver's self-view.)
      expect(handle.environment).toMatchObject({
        id: current.receiverEnvironmentId,
      });
      expect(resolution.environmentId).toBe(current.receiverEnvironmentId);
      const workspace = resolution.workspace as JsonRecord;
      expect(workspace?.cwd).toBe(current.receiverExecutionRoot);

      // ACTUAL launch observation: exactly ONE new muse exec, spawned INSIDE
      // the receiver's nested execution root, carrying THIS turn's unique
      // token and the echo provider flag in its argv — the launch identity of
      // the current turn, not a stale matching line.
      await poll('the muse exec launch observation', 120_000, async () => {
        const launches = await current.museExecLaunches();
        return launches.some(
          (entry) =>
            entry.cwd === current.receiverExecutionRoot &&
            entry.args.includes(turnToken),
        );
      });
      const launchesAfter = await current.museExecLaunches();
      const turnLaunches = launchesAfter.slice(baseline.launches);
      expect(turnLaunches.length).toBe(1);
      expect(turnLaunches[0]!.cwd).toBe(current.receiverExecutionRoot);
      expect(turnLaunches[0]!.args).toContain('--provider');
      expect(turnLaunches[0]!.args).toContain('echo');
      expect(turnLaunches[0]!.args).toContain(turnToken);

      // PROVIDER output, read from the authoritative receiver conversation.
      const readReceiverSnapshot = async () => {
        const observed = await api(
          current.receiver.api,
          'GET',
          `/api/orchestration/delegations/${encodeURIComponent(taskId)}`,
          { headers: operatorHeaders(current.delegationCredential) },
        );
        return {
          status: observed.status,
          data: (observed.payload as JsonRecord)?.data as
            | JsonRecord
            | undefined,
          error: (observed.payload as JsonRecord)?.error,
        };
      };
      await poll(
        'the delegated turn to complete on the receiver',
        240_000,
        async () => {
          const data = await readReceiverSnapshot();
          return (
            data.status === 200 &&
            (data.data?.status === 'completed' ||
              data.data?.status === 'failed')
          );
        },
      );
      const receiverSnapshot = await readReceiverSnapshot();
      expect(receiverSnapshot.status, JSON.stringify(receiverSnapshot)).toBe(
        200,
      );
      expect(receiverSnapshot.data?.status).toBe('completed');
      expect(receiverSnapshot.data?.provider).toBe('muse');
      expect(receiverSnapshot.data?.projectSlug).toBe(RECEIVER_SLUG);

      const events = await api(
        current.receiver.api,
        'GET',
        `/api/orchestration/delegations/${encodeURIComponent(taskId)}/events`,
        { headers: operatorHeaders(current.delegationCredential) },
      );
      expect(events.status, JSON.stringify(events.payload)).toBe(200);
      const eventText = JSON.stringify(events.payload);
      expect(
        eventText,
        'the receiver conversation never recorded the echo provider answer; the echo output is kept separate from the declared receipt and the launch observation',
      ).toMatch(new RegExp(`echo:[\\s\\S]*${turnToken}`));

      // Controller convergence, with the exact lag samples preserved as
      // evidence (see the artifact report for the investigated cause).
      const convergence: Array<Record<string, unknown>> = [];
      let controllerSnapshot:
        | Awaited<ReturnType<typeof readControllerSnapshot>>
        | undefined;
      const readControllerSnapshot = async (): Promise<{
        status: number;
        data: JsonRecord | undefined;
        error: unknown;
      }> => {
        const observed = await api(
          current.controller.api,
          'GET',
          `/api/orchestration/delegations/${encodeURIComponent(taskId)}?environmentId=${encodeURIComponent(current.receiverEnvironmentId)}`,
          { headers: operatorHeaders(current.controllerOperator) },
        );
        return {
          status: observed.status,
          data: (observed.payload as JsonRecord)?.data as
            | JsonRecord
            | undefined,
          error: (observed.payload as JsonRecord)?.error,
        };
      };
      await poll('the controller snapshot to converge', 300_000, async () => {
        controllerSnapshot = await readControllerSnapshot();
        if (
          controllerSnapshot.status !== 200 ||
          (controllerSnapshot.data?.status !== 'completed' &&
            controllerSnapshot.data?.status !== 'failed')
        )
          convergence.push({
            at: new Date().toISOString(),
            taskId,
            environmentId: current.receiverEnvironmentId,
            via: 'controller',
            status: controllerSnapshot.status,
            error: controllerSnapshot.error,
          });
        return (
          controllerSnapshot.status === 200 &&
          (controllerSnapshot.data?.status === 'completed' ||
            controllerSnapshot.data?.status === 'failed')
        );
      });
      expect(
        controllerSnapshot?.data?.status,
        `the controller snapshot never converged; lag samples: ${JSON.stringify(convergence)}`,
      ).toBe('completed');
      console.log(
        `[portable-proof] controller convergence samples for ${taskId}: ${JSON.stringify(convergence)}`,
      );
    });

    test('refuses an undeclared resource at the receiver, over the real peer hop', async () => {
      test.setTimeout(120_000);
      test.fixme(setupError !== undefined, 'setup failed');
      const current = fixture!;
      const baseline = await captureEffectBaseline(current);
      // The controller holds NO offer, so nothing sender-side can pre-refuse:
      // the wrong-resource intent reaches the RECEIVER, whose offer does not
      // declare the second resource.
      const refused = await delegateFromController(
        current,
        delegationTarget(current, {
          resourceId: OTHER_REMOTE_CANONICAL,
        }) as unknown as JsonRecord,
      );
      expectPortableRefusal(
        refused,
        'receiver_execution_not_offered',
        'This Station does not currently offer execution for the requested Project resource.',
      );
      // The same intent refused DIRECTLY at the receiver answers identically —
      // proving the controller relayed the receiver's own closed refusal.
      const direct = await api(
        current.receiver.api,
        'POST',
        '/api/orchestration/delegations',
        {
          body: {
            prompt: 'direct receiver check',
            target: delegationTarget(current, {
              resourceId: OTHER_REMOTE_CANONICAL,
            }) as unknown as JsonRecord,
          },
          headers: operatorHeaders(current.delegationCredential),
        },
      );
      expectPortableRefusal(
        direct,
        'receiver_execution_not_offered',
        'This Station does not currently offer execution for the requested Project resource.',
      );
      await assertNoProviderEffect(current, baseline);
    });

    test('refuses an unknown portable project identity at the receiver', async () => {
      test.setTimeout(120_000);
      test.fixme(setupError !== undefined, 'setup failed');
      const current = fixture!;
      const baseline = await captureEffectBaseline(current);
      const refused = await delegateFromController(
        current,
        delegationTarget(current, {
          portableProjectId: 'portable-id-never-offered',
        }) as unknown as JsonRecord,
      );
      expectPortableRefusal(
        refused,
        'receiver_execution_not_offered',
        'This Station does not currently offer execution for the requested Project resource.',
      );
      await assertNoProviderEffect(current, baseline);
    });

    test('joins on portable identity, not slug: an equal slug with a different identity cannot be offered', async () => {
      test.setTimeout(120_000);
      test.fixme(setupError !== undefined, 'setup failed');
      const current = fixture!;
      // A receiver-local project with the CONTROLLER's slug but a different
      // checkout (different remote, therefore a different manifest id). If
      // slug were the join, offering it under the controller's portable id
      // would have to succeed.
      const sameSlugCheckout = join(current.root, 'receiver', CONTROLLER_SLUG);
      await createFixtureCheckout(sameSlugCheckout, OTHER_REMOTE);
      const created = await api(current.receiver.api, 'POST', '/api/projects', {
        body: {
          name: 'Same slug, different identity',
          slug: CONTROLLER_SLUG,
          workingDirectory: sameSlugCheckout,
        },
        headers: operatorHeaders(current.receiverOperator),
      });
      expect(created.status, JSON.stringify(created.payload)).toBe(201);
      const prepared = await api(
        current.receiver.api,
        'POST',
        `/api/projects/${CONTROLLER_SLUG}/identity/prepare`,
        { headers: operatorHeaders(current.receiverOperator) },
      );
      expect(prepared.status, JSON.stringify(prepared.payload)).toBe(200);
      const otherIdentityView = (prepared.payload as JsonRecord)
        .data as JsonRecord;
      const otherId = (otherIdentityView.identity as JsonRecord).id as string;
      expect(otherId).not.toBe(current.portableProjectId);
      const otherProjectId = (
        (created.payload as JsonRecord).data as JsonRecord
      ).id as string;

      const refusedOffer = await api(
        current.receiver.api,
        'PUT',
        '/api/project-contributions/offer',
        {
          body: {
            portableProjectId: current.portableProjectId,
            localProjectId: otherProjectId,
            resourceId: OTHER_REMOTE_CANONICAL,
            expected: null,
            enabled: true,
          },
          headers: operatorHeaders(current.receiverLocalCredential),
        },
      );
      expect(refusedOffer.status, JSON.stringify(refusedOffer.payload)).toBe(
        404,
      );
      expect((refusedOffer.payload as JsonRecord).error).toBe(
        'Project contribution is unavailable.',
      );
    });

    test('refuses when the saved environment does not match the receiver handshake', async () => {
      test.setTimeout(120_000);
      test.fixme(setupError !== undefined, 'setup failed');
      const current = fixture!;
      const baseline = await captureEffectBaseline(current);
      // A peer credential saved under an environmentId the receiver will not
      // confirm back: the controller's portable pre-wire check must refuse
      // locally, before any dispatch.
      const misnamed = await api(
        current.controller.api,
        'POST',
        '/api/environments/peers',
        {
          body: {
            environmentId: 'portable-proof-wrong-environment',
            apiBase: current.receiver.api,
            credential: current.delegationCredential,
            scope: current.delegationScope,
            label: 'Portable proof misnamed environment',
          },
          headers: operatorHeaders(current.controllerOperator),
        },
      );
      expect(misnamed.status, JSON.stringify(misnamed.payload)).toBe(201);
      const refused = await delegateFromController(
        current,
        delegationTarget(current, {
          environmentId: 'portable-proof-wrong-environment',
        }) as unknown as JsonRecord,
      );
      expectPortableRefusal(
        refused,
        'receiver_execution_not_offered',
        'This Station does not currently offer execution for the requested Project resource.',
      );
      const removed = await api(
        current.controller.api,
        'DELETE',
        '/api/environments/peers/portable-proof-wrong-environment',
        { headers: operatorHeaders(current.controllerOperator) },
      );
      expect(removed.status, JSON.stringify(removed.payload)).toBe(200);
      await assertNoProviderEffect(current, baseline);
    });

    test('refuses with the unavailable code when the receiver checkout drifts off the offered resource', async () => {
      test.setTimeout(120_000);
      test.fixme(setupError !== undefined, 'setup failed');
      const current = fixture!;
      const baseline = await captureEffectBaseline(current);
      // Drift the receiver checkout away from the offered canonical remote
      // (fixture-local mutation only). The offer is still on, the association
      // is unchanged, but the resource can no longer verify as bound — the
      // receiver must refuse with the unavailable code, never re-target.
      await run('git', ['remote', 'remove', 'origin'], {
        cwd: current.receiverCheckout,
      });
      const refused = await delegateFromController(
        current,
        delegationTarget(current) as unknown as JsonRecord,
      );
      expectPortableRefusal(
        refused,
        'receiver_execution_unavailable',
        'The offered Project resource is unavailable.',
      );
      await assertNoProviderEffect(current, baseline);
    });

    test('refuses after the operator withdraws the offer', async () => {
      test.setTimeout(120_000);
      test.fixme(setupError !== undefined, 'setup failed');
      const current = fixture!;
      const baseline = await captureEffectBaseline(current);
      const withdrawn = await api(
        current.receiver.api,
        'PUT',
        '/api/project-contributions/offer',
        {
          body: {
            portableProjectId: current.portableProjectId,
            localProjectId: current.receiverLocalProjectId,
            resourceId: current.resourceId,
            expected: current.offerConfig,
            enabled: false,
          },
          headers: operatorHeaders(current.receiverLocalCredential),
        },
      );
      expect(withdrawn.status, JSON.stringify(withdrawn.payload)).toBe(200);
      const refused = await delegateFromController(
        current,
        delegationTarget(current) as unknown as JsonRecord,
      );
      expectPortableRefusal(
        refused,
        'receiver_execution_not_offered',
        'This Station does not currently offer execution for the requested Project resource.',
      );
      await assertNoProviderEffect(current, baseline);
    });

    test('stops honoring a revoked peer credential with the typed authority refusal', async () => {
      test.setTimeout(120_000);
      test.fixme(setupError !== undefined, 'setup failed');
      const current = fixture!;
      const baseline = await captureEffectBaseline(current);
      const revoked = await api(
        current.receiver.api,
        'DELETE',
        `/api/pairing/devices/${encodeURIComponent(current.peerDeviceId)}`,
        { headers: operatorHeaders(current.receiverOperator) },
      );
      expect(revoked.status, JSON.stringify(revoked.payload)).toBe(200);

      // The SAME credential is refused by the receiver on the contribution
      // query it was previously authorized for — exact 401.
      const query = await api(
        current.receiver.api,
        'POST',
        '/api/project-contributions/query',
        {
          body: {
            portableProjectId: current.portableProjectId,
            resourceId: current.resourceId,
          },
          headers: operatorHeaders(current.delegationCredential),
        },
      );
      expect(query.status, JSON.stringify(query.payload)).toBe(401);

      // And the controller turns the peer's authority failure into the
      // actionable typed refusal — never a controller-local 401, never relayed
      // peer text, never a plain 400.
      const refused = await delegateFromController(
        current,
        delegationTarget(current) as unknown as JsonRecord,
      );
      expectPortableRefusal(
        refused,
        'receiver_execution_authority_changed',
        'Portable execution authority changed before forwarding.',
      );
      await assertNoProviderEffect(current, baseline);
    });
  });
