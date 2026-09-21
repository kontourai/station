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
 * Two real server processes are booted from this checkout's source: a
 * CONTROLLER (the delegating Station) and a RECEIVER (the executing Station),
 * each in its own isolated home under its own STATION_ROOT with non-default
 * ports. Nothing here is an in-process Hono app, a spy, or a fixture
 * credential minted by the test: pairing runs the receiver's real offer →
 * request → operator-approval → exchange HTTP ceremony (kind `delegation`),
 * the resulting peer credential is saved through the controller's real
 * outbound peer-credential API, the receiver's offer is configured through
 * the real operator API `PUT /api/project-contributions/offer`, and the
 * delegation goes through the controller's real
 * `POST /api/orchestration/delegations` with `workspace.kind =
 * 'project-portable'`.
 *
 * The ONLY modeled component is the model behind the turn: the receiver's
 * muse engine runs `STATION_E2E_MUSE_PROVIDER=echo`, muse's own key-less
 * provider (the same seam `agents-new-muse-echo-turn.spec.ts` uses). Echo
 * output (`echo: <token>`) proves the PROVIDER executed; it cannot prove the
 * OS working directory, so the provider output is kept strictly separate
 * from (a) the DECLARED receipt (`handle.resolution.environmentId` +
 * resolved `workspace.cwd`) and (b) an ACTUAL launch observation: a read-only
 * PATH shim records the argv and cwd of every muse process launch and then
 * `exec`s the real binary, so the provider's own behavior is untouched.
 *
 * Operator credentials are read ONLY from each fixture's isolated home
 * (`<home>/security/environment.json`), never from the operator's real home,
 * and the receiver's operator secret is never shared with the controller or
 * the peer credential. The join under proof is portable identity (manifest id
 * + canonical git remote of a LOCAL fake remote — no network checkout), with
 * the receiver using a different slug, a different local path, and a nested
 * execution root, so a same-slug/default-cwd coincidence cannot satisfy it.
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

const createdTempRoots: string[] = [];
let fixture: ProofFixture | undefined;
let setupError: Error | undefined;

interface JsonRecord {
  [key: string]: unknown;
}

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
    // muse must resolve on PATH for the receiver's readiness probe and turns.
    PATH: `${NODE_BIN}${delimiter}${lab.PATH ?? process.env.PATH ?? ''}`,
    ...extra,
  };
}

async function createFixtureCheckout(
  directory: string,
  remote: string,
  innerDirs: string[] = [],
  extraRemote?: string,
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
  if (extraRemote)
    await run('git', ['remote', 'add', 'other', extraRemote], {
      cwd: directory,
    });
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

interface ProofFixture {
  root: string;
  controller: LiveStation;
  receiver: LiveStation;
  receiverHome: string;
  receiverInstanceId: string;
  receiverStop: () => Promise<unknown>;
  controllerOperator: string;
  receiverOperator: string;
  controllerEnv: NodeJS.ProcessEnv;
  receiverEnv: NodeJS.ProcessEnv;
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
  controllerProjectId: string;
  controllerOfferConfig: JsonRecord;
  /** The receiver's OWN local-operator credential, minted through the real
   * ui-bootstrap ceremony (the only HTTP caller that binds
   * `isBoundRuntimeLocalOperator` for the offer leaf). Read from the
   * fixture's Set-Cookie, never from the user's home. */
  receiverLocalCredential: string;
  controllerLocalCredential: string;
  museLaunchLog: string;
  museExecLaunches: () => Promise<Array<{ cwd: string; args: string }>>;
}

async function buildFixture(): Promise<ProofFixture> {
  const root = mkdtempSync(join(tmpdir(), 'portable-receiver-proof-'));
  createdTempRoots.push(root);

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
    // no network). This is a synthetic value inside the fixture environment,
    // never the operator's real key.
    META_API_KEY: 'e2e-echo-fixture-presence-only-key',
    PATH: `${shimDir}${delimiter}${NODE_BIN}${delimiter}${
      (controllerEnv.PATH as string) ?? ''
    }`,
  });

  await startStation(controllerLive, true, {
    environment: controllerEnv,
    logFile: join(root, 'controller-station.log'),
  });
  const receiverTempHome = await startTempHomeInstance({
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
  const receiverHome = instanceHome(process.cwd(), receiverInstanceId);
  const receiver: LiveStation = {
    api: `http://127.0.0.1:${receiverPorts.serverPort}`,
    home: receiverHome,
    instance: receiverInstanceId,
    serverPort: receiverPorts.serverPort,
    ui: `http://127.0.0.1:${receiverPorts.uiPort}`,
    uiPort: receiverPorts.uiPort,
  };
  const receiverStop = () => receiverTempHome.stop();

  const controllerOperator = readE2EOperatorCredential(controllerLive.home);
  const receiverOperator = readE2EOperatorCredential(receiverHome);

  // The receiver's OWN local-operator identity over HTTP (see
  // mintLocalOperatorCredential).
  const receiverLocalCredential = await mintLocalOperatorCredential(
    receiverHome,
    receiver.api,
    receiver.ui,
  );
  expect(receiverLocalCredential).not.toBe(receiverOperator);

  // --- Controller side: real Project with the fixture portable identity ----
  // The controller ALSO binds its own local-operator identity through the
  // ui-bootstrap ceremony: as composed in #484 phase A, the POST
  // /api/orchestration/delegations route captures the portable admission on
  // the SENDING station too, so the controller must hold its own operator
  // offer for the same resource before it may forward the intent.
  const controllerLocalCredential = await mintLocalOperatorCredential(
    controllerLive.home,
    controllerLive.api,
    controllerLive.ui,
  );
  const created = await api(controllerLive.api, 'POST', '/api/projects', {
    body: {
      name: 'Portable Source',
      slug: CONTROLLER_SLUG,
      workingDirectory: controllerCheckout,
    },
    headers: operatorHeaders(controllerOperator),
  });
  expect(created.status, JSON.stringify(created.payload)).toBeLessThan(400);
  const controllerProjectId = (
    (created.payload as JsonRecord).data as JsonRecord
  ).id as string;
  const prepared = await api(
    controllerLive.api,
    'POST',
    `/api/projects/${CONTROLLER_SLUG}/identity/prepare`,
    { headers: operatorHeaders(controllerOperator) },
  );
  expect(prepared.status, JSON.stringify(prepared.payload)).toBe(200);
  const identityView = (prepared.payload as JsonRecord).data as JsonRecord;
  const identity = identityView.identity as JsonRecord;
  const repos = identity.repos as Array<JsonRecord>;
  expect(repos.length).toBe(1);
  const resourceId = repos[0]!.id as string;
  expect(resourceId).toBe(FIXTURE_REMOTE_CANONICAL);

  // The SENDING station's own offer (same portable identity, its own local
  // Project) — configured through the same real operator API.
  const controllerOffered = await api(
    controllerLive.api,
    'PUT',
    '/api/project-contributions/offer',
    {
      body: {
        portableProjectId: identity.id,
        localProjectId: controllerProjectId,
        resourceId,
        expected: null,
        enabled: true,
      },
      headers: operatorHeaders(controllerLocalCredential),
    },
  );
  expect(
    controllerOffered.status,
    JSON.stringify(controllerOffered.payload),
  ).toBe(200);
  const controllerOfferConfig = (controllerOffered.payload as JsonRecord)
    .data as JsonRecord;

  // --- Receiver side: SAME portable identity, DIFFERENT slug and local path,
  // attached through the real attach API (which verifies the checkout's git
  // remote against the identity's canonical remote) -------------------------
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

  // --- Receiver offer through the REAL operator API ------------------------
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

  // --- Receiver pairing ceremony (kind delegation), entirely over HTTP -----
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

  // The paired credential is a DELEGATION device credential, not the
  // receiver's operator secret, and it must NOT be able to act as operator.
  expect(delegationCredential).not.toBe(receiverOperator);

  // --- Receiver public handshake: capability + environment identity --------
  const handshake = await api(receiver.api, 'GET', '/.well-known/station/v1');
  expect(handshake.status).toBe(200);
  const handshakeData = handshake.payload as JsonRecord;
  const receiverEnvironmentId = handshakeData.environmentId as string;
  expect(receiverEnvironmentId).toBeTruthy();
  const capabilities = handshakeData.capabilities as JsonRecord;
  expect(capabilities.portableExecutionOffers).toBe(true);

  // --- Controller: save the outbound peer credential through its REAL API --
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

  // --- Receiver: materialize the muse engine's agent (canonical path) ------
  const materialized = await api(
    receiver.api,
    'POST',
    '/agents/materialize-engine',
    { body: { engineId: 'muse' }, headers: operatorHeaders(receiverOperator) },
  );
  expect(
    materialized.status,
    JSON.stringify(materialized.payload),
  ).toBeLessThan(400);
  const museAgentSlug = (
    (materialized.payload as JsonRecord).data as JsonRecord
  ).slug as string;
  expect(museAgentSlug).toBeTruthy();

  const museExecLaunches = async () => {
    if (!existsSync(museLaunchLog)) return [];
    const { readFile } = await import('node:fs/promises');
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
    receiverStop,
    controllerOperator,
    receiverOperator,
    controllerEnv,
    receiverEnv,
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
    controllerProjectId,
    controllerOfferConfig,
    receiverLocalCredential,
    controllerLocalCredential,
    museLaunchLog,
    museExecLaunches,
  };
}

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
): Promise<ApiResult> {
  // The controller intermittently refuses with a bounded, self-described
  // retry window right after any config mutation ("Agent catalog is
  // refreshing…"). Only THIS exact refusal is retried, and nothing has been
  // dispatched when it appears (HTTP 400, no handle), so no effect is
  // ambiguous. The REFUSALS under proof must surface their real codes, so a
  // persistent catalog state fails the test rather than masking it.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const delegated = await api(
      fixture.controller.api,
      'POST',
      '/api/orchestration/delegations',
      {
        body: {
          prompt: 'Return this token unchanged: portable-proof-token',
          target,
        },
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

/** Terminal-absence oracles on the RECEIVER: no new muse launch, no usage row. */
async function assertNoProviderEffect(
  fixture: ProofFixture,
  launchesBefore: number,
) {
  const launches = await fixture.museExecLaunches();
  expect(
    launches.length,
    `muse exec launched ${launches.length - launchesBefore} time(s) after a refusal`,
  ).toBe(launchesBefore);
  const usage = await api(fixture.receiver.api, 'GET', '/api/analytics/usage', {
    headers: operatorHeaders(fixture.receiverLocalCredential),
  });
  expect(usage.status).toBe(200);
  const stats = ((usage.payload as JsonRecord).data ?? {}) as JsonRecord;
  const byModel = (stats.byModel ?? {}) as JsonRecord;
  const museModels = Object.keys(byModel).filter((model) =>
    model.toLowerCase().includes('muse'),
  );
  expect(
    museModels,
    `receiver reported model usage for ${museModels.join(', ')} after a refusal`,
  ).toEqual([]);
}

test.describe
  .serial('portable receiver live proof (#484/#106)', () => {
    test.describe
      .serial('setup', () => {
        test('boots two independent Stations and wires the real offer chain', async () => {
          test.setTimeout(600_000);
          try {
            fixture = await buildFixture();
          } catch (error) {
            setupError = error as Error;
            throw error;
          }
          // The proof's identity join precondition: both Stations can read the
          // SAME portable id from their own, differently-named, differently-located
          // checkouts.
          expect(fixture.portableProjectId).toBeTruthy();
          expect(fixture.receiverCheckout).not.toContain(CONTROLLER_SLUG);
          expect(
            fixture.museAgentSlug,
            'the receiver did not materialize a muse agent; a host that cannot run muse cannot prove this journey',
          ).toBeTruthy();
        });
      });

    test.describe
      .serial('portable execution over the real wire', () => {
        test('delegates a project-portable turn and completes it on the receiver via the echo provider', async () => {
          test.setTimeout(300_000);
          test.fixme(setupError !== undefined, 'setup failed');
          const current = fixture!;
          const launchesBefore = (await current.museExecLaunches()).length;

          // The controller refuses with a bounded, self-described retry window
          // right after any agent mutation ("Agent catalog is refreshing…").
          // Only THIS exact refusal is retried, and nothing has been dispatched
          // when it appears (HTTP 400, no handle), so no effect is ambiguous.
          const delegated = await delegateFromController(
            current,
            delegationTarget(current) as unknown as JsonRecord,
          );
          expect(delegated.status, JSON.stringify(delegated.payload)).toBe(200);
          const handle = (delegated.payload as JsonRecord).data as JsonRecord;
          const resolution = handle.resolution as JsonRecord;

          // DECLARED receipt: the receiver's own environment resolved it. (The
          // handle is the RECEIVER's projection of the task, so its environment
          // names the receiver by id; `kind` is the receiver's self-view. The
          // controller's peer dispatch is recorded separately in Activity.)
          expect(handle.environment).toMatchObject({
            id: current.receiverEnvironmentId,
          });
          expect(resolution.environmentId).toBe(current.receiverEnvironmentId);
          const workspace = resolution.workspace as JsonRecord;
          expect(workspace?.cwd).toBe(current.receiverExecutionRoot);

          // ACTUAL launch observation: the muse process was spawned INSIDE the
          // receiver's nested execution root (different machine-role path, nested
          // subdir — not the compat default cwd).
          await poll('the muse exec launch observation', 120_000, async () => {
            const launches = await current.museExecLaunches();
            return launches.some(
              (entry) => entry.cwd === current.receiverExecutionRoot,
            );
          });
          const launches = await current.museExecLaunches();
          const execLaunch = launches.at(-1)!;
          expect(execLaunch.cwd).toBe(current.receiverExecutionRoot);

          // PROVIDER output: poll the RECEIVER (authoritative conversation owner,
          // read with the saved peer credential) to a terminal state, then allow
          // the controller's own snapshot read to converge. Read-only polls; no
          // effect is retried.
          const taskId = handle.taskId as string;
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
          const readControllerSnapshot = async () => {
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
          const convergence: Array<Record<string, unknown>> = [];
          await poll(
            'the delegated turn to complete on the receiver',
            240_000,
            async () => {
              const data = await readReceiverSnapshot();
              if (
                data.status !== 200 ||
                (data.data?.status !== 'completed' &&
                  data.data?.status !== 'failed')
              )
                convergence.push({
                  at: new Date().toISOString(),
                  via: 'receiver',
                  status: data.status,
                  error: data.error,
                });
              return (
                data.status === 200 &&
                (data.data?.status === 'completed' ||
                  data.data?.status === 'failed')
              );
            },
          );
          const receiverSnapshot = await readReceiverSnapshot();
          expect(
            receiverSnapshot.data?.status,
            JSON.stringify(convergence.slice(-5)),
          ).toBe('completed');
          expect(receiverSnapshot.data?.provider).toBe('muse');
          expect(receiverSnapshot.data?.projectSlug).toBe(RECEIVER_SLUG);

          // The controller's own snapshot read must converge to the same
          // terminal state for the operator. If it lags, that lag is evidence,
          // not something the harness papers over.
          let controllerSnapshot:
            | Awaited<ReturnType<typeof readControllerSnapshot>>
            | undefined;
          await poll(
            'the controller snapshot to converge',
            300_000,
            async () => {
              controllerSnapshot = await readControllerSnapshot();
              if (
                controllerSnapshot.status !== 200 ||
                (controllerSnapshot.data?.status !== 'completed' &&
                  controllerSnapshot.data?.status !== 'failed')
              )
                convergence.push({
                  at: new Date().toISOString(),
                  via: 'controller',
                  status: controllerSnapshot.status,
                  error: controllerSnapshot.error,
                });
              return (
                controllerSnapshot.status === 200 &&
                (controllerSnapshot.data?.status === 'completed' ||
                  controllerSnapshot.data?.status === 'failed')
              );
            },
          );
          expect(
            controllerSnapshot?.data?.status,
            `the controller snapshot never converged; last samples: ${JSON.stringify(convergence.slice(-5))}`,
          ).toBe('completed');

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
          ).toMatch(/echo:[\s\S]*portable-proof-token/);

          // No extra muse launches beyond the single observed turn.
          const launchesAfter = await current.museExecLaunches();
          expect(launchesAfter.length).toBe(launchesBefore + 1);
        });

        test('refuses an undeclared resource before any provider effect', async () => {
          test.fixme(setupError !== undefined, 'setup failed');
          const current = fixture!;
          const launchesBefore = (await current.museExecLaunches()).length;
          // A resource the offer never declared: the SENDING station's own
          // admission refuses pre-wire with the not-offered refusal — nothing is
          // dispatched, and the receiver never sees the intent.
          const refused = await delegateFromController(
            current,
            delegationTarget(current, {
              resourceId: OTHER_REMOTE_CANONICAL,
            }) as unknown as JsonRecord,
          );
          expect(refused.status, JSON.stringify(refused.payload)).toBe(403);
          expect((refused.payload as JsonRecord).error).toBe(
            'This Station does not currently offer execution for the requested Project resource.',
          );
          await assertNoProviderEffect(current, launchesBefore);
        });

        test('refuses an unknown portable project identity', async () => {
          test.fixme(setupError !== undefined, 'setup failed');
          const current = fixture!;
          const launchesBefore = (await current.museExecLaunches()).length;
          const refused = await delegateFromController(
            current,
            delegationTarget(current, {
              portableProjectId: 'portable-id-never-offered',
            }) as unknown as JsonRecord,
          );
          expect(refused.status, JSON.stringify(refused.payload)).toBe(403);
          expect((refused.payload as JsonRecord).error).toBe(
            'This Station does not currently offer execution for the requested Project resource.',
          );
          await assertNoProviderEffect(current, launchesBefore);
        });

        test('joins on portable identity, not slug: an equal slug with a different identity cannot be offered', async () => {
          test.fixme(setupError !== undefined, 'setup failed');
          const current = fixture!;
          // A receiver-local project with the CONTROLLER's slug but a different
          // checkout (different remote, therefore a different manifest id). If
          // slug were the join, offering it under the controller's portable id
          // would have to succeed.
          const sameSlugCheckout = join(
            current.root,
            'receiver',
            CONTROLLER_SLUG,
          );
          await createFixtureCheckout(sameSlugCheckout, OTHER_REMOTE);
          const created = await api(
            current.receiver.api,
            'POST',
            '/api/projects',
            {
              body: {
                name: 'Same slug, different identity',
                slug: CONTROLLER_SLUG,
                workingDirectory: sameSlugCheckout,
              },
              headers: operatorHeaders(current.receiverOperator),
            },
          );
          expect(created.status, JSON.stringify(created.payload)).toBeLessThan(
            400,
          );
          await api(
            current.receiver.api,
            'POST',
            `/api/projects/${CONTROLLER_SLUG}/identity/prepare`,
            { headers: operatorHeaders(current.receiverOperator) },
          );
          const otherIdentity = await api(
            current.receiver.api,
            'GET',
            `/api/projects/${CONTROLLER_SLUG}/identity`,
            { headers: operatorHeaders(current.receiverOperator) },
          );
          expect(otherIdentity.status).toBe(200);
          const otherId = (
            ((otherIdentity.payload as JsonRecord).data as JsonRecord)
              .identity as JsonRecord
          ).id as string;
          expect(otherId).not.toBe(current.portableProjectId);

          const refusedOffer = await api(
            current.receiver.api,
            'PUT',
            '/api/project-contributions/offer',
            {
              body: {
                portableProjectId: current.portableProjectId,
                localProjectId: (
                  (created.payload as JsonRecord).data as JsonRecord
                ).id,
                resourceId: OTHER_REMOTE_CANONICAL,
                expected: null,
                enabled: true,
              },
              headers: operatorHeaders(current.receiverLocalCredential),
            },
          );
          expect(refusedOffer.status).toBe(404);
          expect((refusedOffer.payload as JsonRecord).error).toBe(
            'Project contribution is unavailable.',
          );
        });

        test('refuses when the saved environment does not match the receiver handshake', async () => {
          test.fixme(setupError !== undefined, 'setup failed');
          const current = fixture!;
          const launchesBefore = (await current.museExecLaunches()).length;
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
          expect(misnamed.status).toBe(201);
          const refused = await delegateFromController(
            current,
            delegationTarget(current, {
              environmentId: 'portable-proof-wrong-environment',
            }) as unknown as JsonRecord,
          );
          expect(refused.status, JSON.stringify(refused.payload)).toBe(403);
          expect((refused.payload as JsonRecord).error).toBe(
            'The selected Station did not confirm portable execution support for this environment.',
          );
          await api(
            current.controller.api,
            'DELETE',
            '/api/environments/peers/portable-proof-wrong-environment',
            { headers: operatorHeaders(current.controllerOperator) },
          );
          await assertNoProviderEffect(current, launchesBefore);
        });

        test('refuses after the operator withdraws the offer', async () => {
          test.fixme(setupError !== undefined, 'setup failed');
          const current = fixture!;
          const launchesBefore = (await current.museExecLaunches()).length;
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
          // NOTE the observed contract: the RECEIVER refuses 403 with this exact
          // message, but `postCanonical` rethrows the peer's refusal as a plain
          // error, so the CONTROLLER surfaces it as 400 with the message intact.
          // The harness asserts the exact refusal message and a 4xx status, and
          // records the 400-vs-403 mapping as a server finding rather than
          // weakening the refusal proof.
          expect([400, 403]).toContain(refused.status);
          expect((refused.payload as JsonRecord).error).toBe(
            'This Station does not currently offer execution for the requested Project resource.',
          );
          await assertNoProviderEffect(current, launchesBefore);
        });

        test('stops honoring a revoked peer credential before any provider effect', async () => {
          test.fixme(setupError !== undefined, 'setup failed');
          const current = fixture!;
          const launchesBefore = (await current.museExecLaunches()).length;
          const revoked = await api(
            current.receiver.api,
            'DELETE',
            `/api/pairing/devices/${encodeURIComponent(current.peerDeviceId)}`,
            { headers: operatorHeaders(current.receiverOperator) },
          );
          expect(revoked.status, JSON.stringify(revoked.payload)).toBeLessThan(
            400,
          );

          // The SAME credential is refused by the receiver on the contribution
          // query it was previously authorized for.
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
          expect(query.status).toBe(401);

          // And the controller can no longer drive the delegation.
          const refused = await delegateFromController(
            current,
            delegationTarget(current) as unknown as JsonRecord,
          );
          expect(
            refused.status,
            JSON.stringify(refused.payload),
          ).toBeGreaterThanOrEqual(400);
          await assertNoProviderEffect(current, launchesBefore);
        });
      });

    test.describe
      .serial('teardown', () => {
        // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
        test('stops both Stations and preserves evidence on failure', async ({}, testInfo) => {
          test.setTimeout(180_000);
          const failures = testInfo.status !== testInfo.expectedStatus;
          let stopError: unknown;
          if (fixture) {
            try {
              if (fixture.receiverStop) await fixture.receiverStop();
            } catch (error) {
              stopError = error;
            }
            try {
              await stopStation(fixture.controller, {
                environment: fixture.controllerEnv,
              });
            } catch (error) {
              stopError = error;
            }
          }
          // Preserve diagnostics until every owned process is proven stopped.
          if (fixture && (failures || stopError)) {
            try {
              mkdirSync(ARTIFACT_DIR, { recursive: true });
              const stamp = `${fixture.receiverInstanceId}-${Date.now()}`;
              const destination = join(ARTIFACT_DIR, stamp);
              mkdirSync(destination, { recursive: true });
              for (const name of [
                'controller-station.log',
                'receiver-station.log',
                'muse-launch-observations.jsonl',
              ]) {
                const source = join(fixture.root, name);
                if (existsSync(source)) cpSync(source, join(destination, name));
              }
              cpSync(
                join(fixture.root, 'controller'),
                join(destination, 'controller'),
                { recursive: true },
              );
              cpSync(
                join(fixture.root, 'receiver'),
                join(destination, 'receiver'),
                { recursive: true },
              );
              writeFileSync(
                join(destination, 'run-meta.json'),
                JSON.stringify(
                  {
                    receiverInstanceId: fixture.receiverInstanceId,
                    receiver: fixture.receiver,
                    controller: fixture.controller,
                    portableProjectId: fixture.portableProjectId,
                    receiverEnvironmentId: fixture.receiverEnvironmentId,
                    museAgentSlug: fixture.museAgentSlug,
                  },
                  null,
                  2,
                ),
              );
            } catch (copyError) {
              console.error('evidence preservation failed', copyError);
            }
          } else if (fixture && !stopError) {
            rmSync(fixture.root, { recursive: true, force: true });
          }
          if (stopError)
            throw new Error(
              'Failed to stop an owned fixture Station; diagnostic home preserved',
              { cause: stopError },
            );
          fixture = undefined;
        });
      });
  });
