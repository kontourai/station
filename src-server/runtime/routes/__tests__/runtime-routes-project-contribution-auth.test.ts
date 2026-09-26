/**
 * Review correction 5 for the project execution offers slice: the route
 * FACTORY tests (`project-contribution-routes.test.ts`) prove only that
 * `authority.canManage`/`canQuery` gate their handlers — they cannot prove
 * that the production composition derives those verdicts from REAL
 * credentials. This file drives `configureRuntimeRoutes` over the REAL auth
 * path (real `configureRuntimeHttp` bearer parsing, real
 * `DevicePairingService`-backed verification, real pairing-scope
 * enforcement — never a hand-set `RuntimeAuthenticatedRequestPrincipal` or a
 * fake trust header), using the same fixture shape
 * `runtime-routes-device-session-chat-principal.test.ts` established:
 *
 * - a CURRENT, APPROVED delegation-kind paired credential queries POSITIVE;
 * - an ordinary paired Device queries NEGATIVE;
 * - an account-bound guest's device credential queries NEGATIVE (its grant
 *   is the person's, never a delegation);
 * - a REVOKED delegation credential is refused outright;
 * - the operator credential performs the offer mutation POSITIVE against a
 *   real Project + manifest (the per-boot internal token is refused by the
 *   station-control authority guard, #2377).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { createApplicationSessionRuntime } from '../../../services/identity/application-session-runtime.js';
import { loadLocalAccounts } from '../../../services/identity/local-account-runtime.js';
import { readCheckoutRemotes } from '../../../services/projects/checkout-remote-reader.js';
import { ProjectBindingsStore } from '../../../services/projects/project-binding-store.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import {
  DevicePairingService,
  type PairingApproval,
} from '../../../services/ssh/device-pairing-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { configureRuntimeRoutes as configureRuntimeRoutesProduction } from '../runtime-routes.js';

// The runtime support composition is out of scope here; the credential
// pipeline under test is NOT mocked.
vi.mock('../runtime-route-support.js', () => {
  const runtimeSupportStub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: runtimeSupportStub,
      notificationService: runtimeSupportStub,
      attentionProjection: runtimeSupportStub,
      webPushService: runtimeSupportStub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => runtimeSupportStub,
  };
});

function deepCallable(): unknown {
  return new Proxy(() => undefined, {
    get: (_target, property) =>
      property === 'then' ? undefined : deepCallable(),
    apply: () => deepCallable(),
  });
}

function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      return deepCallable();
    },
  }) as T;
}

const operatorApproval: PairingApproval = { kind: 'presented-credential' };
const OPERATOR_CREDENTIAL = 'test-only-operator-credential-contribution-auth';
const REMOTE_TAILNET_ENV = {
  incoming: { socket: { remoteAddress: '100.96.12.7' } },
} as never;
const LOOPBACK_ENV = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;

const REPO_REMOTE = 'https://git.example/acme/repo.git';

function makeGitCheckout(directory: string) {
  mkdirSync(directory, { recursive: true });
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: directory,
      stdio: 'ignore',
      windowsHide: true,
    });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(directory, 'README.md'), 'fixture\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'fixture']);
  git(['remote', 'add', 'origin', REPO_REMOTE]);
}

/**
 * An explicitly OWNED temp root for this suite's Station home. `os.tmpdir()`
 * is honored (portable), EXCEPT when the ambient TMPDIR nests inside the
 * ambient shared Station root — the home-admission gate then refuses such a
 * home BY DESIGN (a home the shared root contains is never admissible), so
 * the owned temp is created as a SIBLING of the shared root instead. Either
 * way the caller owns the directory and removes it.
 */
function ownedTempRoot(prefix: string): string {
  const ambientRoot = resolveStationRoot();
  const base = resolve(tmpdir());
  const insideSharedRoot =
    ambientRoot === base ||
    base.startsWith(
      ambientRoot.endsWith(sep) ? ambientRoot : ambientRoot + sep,
    );
  return mkdtempSync(
    join(insideSharedRoot ? dirname(ambientRoot) : base, prefix),
  );
}

describe('project contribution routes over the REAL auth path (execution offers review 5)', () => {
  const directories: string[] = [];
  const ambientHome = process.env.STATION_HOME;
  const ambientRoot = process.env.STATION_ROOT;
  // Per-test lifecycle: every test owns ONE temp tree with `home/` and
  // `root/` as SIBLINGS (the admission gate refuses a home that contains the
  // root), the environment binds to it for exactly that test, and afterEach
  // restores the ambient environment BEFORE removing the tree — nothing is
  // shared across tests and nothing leaks.
  beforeEach(() => {
    const owned = ownedTempRoot('station-contribution-auth-');
    directories.push(owned);
    mkdirSync(join(owned, 'home'));
    mkdirSync(join(owned, 'root'));
    process.env.STATION_HOME = join(owned, 'home');
    process.env.STATION_ROOT = join(owned, 'root');
  });
  afterEach(() => {
    if (ambientHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = ambientHome;
    if (ambientRoot === undefined) delete process.env.STATION_ROOT;
    else process.env.STATION_ROOT = ambientRoot;
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function pairDelegationDevice(
    pairing: DevicePairingService,
    kind: 'device' | 'delegation',
  ) {
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
      kind,
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: kind === 'delegation' ? 'Peer Station' : 'Plain Device',
      source: 'tailnet',
      requester: { provider: 'tailscale-serve', login: 'owner@github' },
    });
    pairing.confirmRequest(request.requestId, operatorApproval);
    const paired = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
    return paired;
  }

  function environmentSecurityServiceFor(pairing: DevicePairingService) {
    return deepStub({
      verifyCredential: (credential: string) =>
        credential === OPERATOR_CREDENTIAL ||
        pairing.verifyCredential(credential),
      authorizeCredential: (credential: string) =>
        credential === OPERATOR_CREDENTIAL ||
        pairing.verifyCredential(credential),
      verifyOperatorCredential: (credential: string) =>
        credential === OPERATOR_CREDENTIAL,
      resolveGrantedScope: (credential: string) =>
        credential === OPERATOR_CREDENTIAL
          ? pairingScopePresetString('standard')
          : pairing.identifyDevice(credential)?.scope,
      identifyDevice: (credential: string) =>
        pairing.identifyDevice(credential),
      // The operator's own client holds a credential minted with proof of
      // home possession (the local-grant path the Station UI uses).
      credentialLocality: (credential: string) =>
        credential === OPERATOR_CREDENTIAL
          ? 'home-possession'
          : pairing.credentialLocality(credential),
      credentialMintKind: (credential: string) =>
        credential === OPERATOR_CREDENTIAL
          ? 'local-grant'
          : pairing.credentialMintKind(credential),
      devicePairing: pairing,
    });
  }

  async function setup() {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-contribution-auth-'));
    directories.push(homeDir);
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '33333333-3333-4333-8333-333333333333',
    });
    const storage = new FileStorageAdapter(homeDir);
    const projectService = new ProjectService(
      storage,
      new ProjectManifestStore(homeDir, storage),
    );
    const repoDir = join(homeDir, 'checkout');
    makeGitCheckout(repoDir);
    const project = await projectService.createProject({
      name: 'Shared Offer',
      slug: 'shared-offer',
      workingDirectory: repoDir,
    });
    const manifests = new ProjectManifestStore(homeDir, storage, {
      bindings: new ProjectBindingsStore(homeDir),
      readRemotes: readCheckoutRemotes,
    });
    const ensured = await manifests.ensureProjectManifest(project);
    expect(['existing', 'created']).toContain(ensured.outcome);
    const manifest = manifests.readProjectManifest(project.slug)!;

    let appConfig: Record<string, unknown> = {};
    const configLoader = {
      getProjectHomeDir: () => homeDir,
      loadAppConfig: async () => ({ ...appConfig }),
      mutateAppConfig: async (mutate: (current: any) => any) => {
        appConfig = { ...appConfig, ...mutate({ ...appConfig }) };
        return { ...appConfig };
      },
    };
    const membership = createProjectMembershipRuntime(
      homeDir,
      'environment-local',
      storage,
    );
    const localAccounts = await loadLocalAccounts(
      { publicOrigin: 'http://localhost:4321' },
      { stationId: 'environment-local', homeDirectory: homeDir },
      membership.service,
    );
    const applicationSessions = createApplicationSessionRuntime(
      homeDir,
      'environment-local',
      localAccounts,
      (value: string) => pairing.identifyDevice(value),
    );
    const app = new Hono();
    const context = deepStub({
      projectMembership: membership.service,
      deploymentAuthentication: localAccounts,
      localAccounts,
      applicationSessions,
      storageAdapter: storage,
      projectService,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentService: { listAgents: () => [] },
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: new Proxy(
        {
          sessionTurnBoundaryAuthority: () => ({
            reconcile: () => ({ kind: 'available', interrupted: [] }),
          }),
        },
        {
          get(target, property) {
            if (property in target) return Reflect.get(target, property);
            return deepCallable();
          },
        },
      ),
      environmentSecurityService: environmentSecurityServiceFor(pairing),
      taskGraphService: { listTasks: () => [] },
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutesProduction(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    await result.kitLifecycleReady;
    return {
      app,
      pairing,
      homeDir,
      project,
      manifest,
      config: () => appConfig,
      delegation: pairDelegationDevice(pairing, 'delegation'),
      plainDevice: pairDelegationDevice(pairing, 'device'),
    };
  }

  const query = (app: Hono, credential: string, env: unknown) =>
    app.request(
      '/api/project-contributions/query',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({
          portableProjectId: 'prj_does_not_matter_for_admission',
          resourceId: REPO_REMOTE,
        }),
      },
      env as never,
    );

  test('a current approved delegation credential queries; an ordinary Device and a revoked credential do not', async () => {
    const h = await setup();
    const admitted = await query(
      h.app,
      h.delegation.credential,
      REMOTE_TAILNET_ENV,
    );
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    const body = (await admitted.json()) as any;
    expect(body.success).toBe(true);

    const device = await query(
      h.app,
      h.plainDevice.credential,
      REMOTE_TAILNET_ENV,
    );
    expect(device.status).toBe(403);

    h.pairing.revokeDevice(
      h.pairing.identifyDevice(h.delegation.credential)!.id,
      'operator-credential',
    );
    const revoked = await query(
      h.app,
      h.delegation.credential,
      REMOTE_TAILNET_ENV,
    );
    expect(revoked.status).toBe(401);
  });

  test('the loopback operator authorizes the offer mutation; the delegation credential cannot', async () => {
    const h = await setup();
    const offerBody = {
      portableProjectId: h.manifest.id,
      localProjectId: h.project.id,
      resourceId: h.manifest.repos[0]!.id,
      expected: null,
      enabled: true,
    };
    const forbidden = await h.app.request(
      '/api/project-contributions/offer',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${h.delegation.credential}`,
        },
        body: JSON.stringify(offerBody),
      },
      REMOTE_TAILNET_ENV,
    );
    expect(forbidden.status).toBe(403);
    expect(h.config().contribution).toBeUndefined();

    // #2377 slice A: the per-boot internal token is not the operator. It is
    // what Station's station-control tools present (the CLI's UI proxy marks
    // every browser hop `remote`), and no tool reaches this route, so the
    // station-control authority guard refuses it before the route runs.
    const internalToken = await h.app.request(
      '/api/project-contributions/offer',
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        },
        body: JSON.stringify(offerBody),
      },
      LOOPBACK_ENV,
    );
    expect(internalToken.status).toBe(403);
    expect(await internalToken.json()).toMatchObject({
      code: 'station_control_route_unmapped',
    });
    expect(h.config().contribution).toBeUndefined();
    // The real local operator: a home-possession operator credential — the
    // path that binds `isBoundRuntimeLocalOperator`.
    const operatorHeaders = {
      'content-type': 'application/json',
      Authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
    };
    const offered = await h.app.request(
      '/api/project-contributions/offer',
      {
        method: 'PUT',
        headers: operatorHeaders,
        body: JSON.stringify(offerBody),
      },
      LOOPBACK_ENV,
    );
    expect(offered.status, await offered.clone().text()).toBe(200);
    const stored = h.config().contribution as Record<string, unknown>;
    expect(stored[`project:${h.manifest.id}`]).toEqual({
      enabled: true,
      execution: { repoIds: [h.manifest.repos[0]!.id] },
    });

    // The peer now reads the exact offered resource — presence without paths.
    const offered2 = await h.app.request(
      '/api/project-contributions/query',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${h.plainDevice.credential}`,
        },
        body: JSON.stringify({
          portableProjectId: h.manifest.id,
          resourceId: h.manifest.repos[0]!.id,
        }),
      },
      REMOTE_TAILNET_ENV,
    );
    expect(offered2.status).toBe(403);
    const peer = await h.app.request(
      '/api/project-contributions/query',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${h.delegation.credential}`,
        },
        body: JSON.stringify({
          portableProjectId: h.manifest.id,
          resourceId: h.manifest.repos[0]!.id,
        }),
      },
      REMOTE_TAILNET_ENV,
    );
    expect(peer.status, await peer.clone().text()).toBe(200);
    const projection = (await peer.json()) as any;
    // The resolver finds the live checkout bound, but the binding store has
    // NO stored observation: verifiedAt stays null — presence without a
    // fabricated observation, and never a local path.
    expect(projection.data.participation).toBe('contributing');
    expect(projection.data.execution).toEqual([
      {
        repoId: h.manifest.repos[0]!.id,
        bound: true,
        verifiedAt: null,
      },
    ]);
    expect(projection.data.sourceObservedAt).toBeNull();
    expect(JSON.stringify(projection)).not.toContain('checkout');
  });

  test('an account-bound guest device credential cannot query', async () => {
    const h = await setup();
    // The account binding itself is exercised end-to-end by the pairing and
    // account-session suites; what THIS route must prove is that a device
    // whose grant is bound to a person's account — the "account-bound guest"
    // shape the invitation flow mints — is NOT a delegation receiver, no
    // matter how current its credential is. Pair through the real
    // DevicePairingService with an account candidate, exactly as the
    // access-request route's own handler does once a session presents one.
    const issuer = 'https://accounts.example.test';
    const guestOffer = h.pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const guestRequest = h.pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: guestOffer.offerId,
      proof: guestOffer.challenge,
      deviceName: 'Bound guest',
      source: 'tailnet',
      requester: { provider: 'tailscale-serve', login: 'guest@github' },
      requireAccountBinding: true,
      accountCandidate: {
        issuer,
        subject: 'guest-user',
        displayName: 'Guest User',
      },
      accountCandidateSessionId: 'fixture-session-1',
    });
    h.pairing.confirmRequest(guestRequest.requestId, operatorApproval, {
      principalId: `human:deployment:${issuer}:guest-user`,
      kind: 'account',
    });
    const guest = h.pairing.exchange({
      offerId: guestOffer.offerId,
      proof: guestOffer.challenge,
      requestId: guestRequest.requestId,
    });
    expect(guest.device.principalBinding).toMatchObject({ kind: 'account' });
    // The credential itself verifies, but an account-bound device is
    // admitted ONLY together with its account session (the deployment
    // authentication tier) — the bare bearer is refused outright, and no
    // path through this route turns an account-bound guest into a
    // delegation receiver.
    const refused = await query(h.app, guest.credential, REMOTE_TAILNET_ENV);
    expect(refused.status, await refused.clone().text()).toBe(401);
  });
});
