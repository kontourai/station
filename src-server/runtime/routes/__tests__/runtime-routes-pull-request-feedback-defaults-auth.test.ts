/**
 * Project agent feedback defaults over the REAL auth path: `configureRuntimeRoutes`
 * with real bearer parsing, real `DevicePairingService` verification, real
 * pairing-scope enforcement and the production `requestIsPerson` and
 * operator rule (never a hand-set principal). The harness is
 * `runtime-routes-project-contribution-auth.test.ts`'s, with the
 * `pull-request-agent-feedback` Feature Preview on.
 *
 * Only this Station's owner in person sets a Project's defaults: the loopback
 * operator credential writes them. Station's per-boot internal token (what an
 * agent's tool call presents) is refused by the station-control guard, a
 * delegation credential and an account-bound guest without access:manage by
 * pairing scope, and a delegation credential that holds access:manage by
 * the route's own person rule; nothing is written.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { createApplicationSessionRuntime } from '../../../services/identity/application-session-runtime.js';
import { loadLocalAccounts } from '../../../services/identity/local-account-runtime.js';
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
const OPERATOR_CREDENTIAL = 'test-only-operator-credential-pr-defaults-auth';
const REMOTE_TAILNET_ENV = {
  incoming: { socket: { remoteAddress: '100.96.12.7' } },
} as never;
const LOOPBACK_ENV = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;

/**
 * Where this suite's temp trees live: `os.tmpdir()`, unless the ambient
 * TMPDIR nests inside the shared Station root (the home-admission gate
 * refuses a home the shared root contains), then beside that root.
 */
const OWNED_BASE = (() => {
  const ambientRoot = resolveStationRoot();
  const base = resolve(tmpdir());
  const insideSharedRoot =
    ambientRoot === base ||
    base.startsWith(
      ambientRoot.endsWith(sep) ? ambientRoot : ambientRoot + sep,
    );
  return insideSharedRoot ? dirname(ambientRoot) : base;
})();

describe('Project feedback defaults over the REAL auth path', () => {
  // First, so its removal runs after the environment is restored.
  const makeTempDir = trackTempDirs({ base: OWNED_BASE });
  const ambientHome = process.env.STATION_HOME;
  const ambientRoot = process.env.STATION_ROOT;
  // Per-test lifecycle: every test owns ONE temp tree with `home/` and
  // `root/` as SIBLINGS (the admission gate refuses a home that contains the
  // root), the environment binds to it for exactly that test, and afterEach
  // restores the ambient environment BEFORE removing the tree — nothing is
  // shared across tests and nothing leaks.
  beforeEach(() => {
    const owned = makeTempDir('station-pr-defaults-auth-');
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
  });

  function pairDelegationDevice(
    pairing: DevicePairingService,
    kind: 'device' | 'delegation',
    scope = pairingScopePresetString('standard'),
  ) {
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope,
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
        // The operator holds every scope, access:manage included.
        credential === OPERATOR_CREDENTIAL
          ? `${pairingScopePresetString('standard')} access:manage`
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
    const homeDir = makeTempDir('station-pr-defaults-home-');
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
    mkdirSync(repoDir);
    const project = await projectService.createProject({
      name: 'Shared Offer',
      slug: 'shared-offer',
      workingDirectory: repoDir,
    });

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
      featurePreviews: {
        bind: (definition: { id: string }) => ({
          select: <T>(branches: { enabled: () => T; disabled: () => T }) =>
            definition.id === 'pull-request-agent-feedback'
              ? branches.enabled()
              : branches.disabled(),
        }),
      },
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
      config: () => appConfig,
      delegation: pairDelegationDevice(pairing, 'delegation'),
      plainDevice: pairDelegationDevice(pairing, 'device'),
    };
  }

  function pairGuest(pairing: DevicePairingService) {
    const issuer = 'https://accounts.example.test';
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
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
    pairing.confirmRequest(request.requestId, operatorApproval, {
      principalId: `human:deployment:${issuer}:guest-user`,
      kind: 'account',
    });
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
  }

  const defaultsPath = (slug: string) =>
    `/api/pull-request-feedback/projects/${slug}/defaults`;
  const put = (
    app: Hono,
    slug: string,
    headers: Record<string, string>,
    env: unknown,
  ) =>
    app.request(
      defaultsPath(slug),
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          settings: { fixFailingChecks: true, addressReviewComments: false },
        }),
      },
      env as never,
    );
  const bearer = (credential: string) => ({
    Authorization: `Bearer ${credential}`,
  });
  const readDefaults = async (h: Awaited<ReturnType<typeof setup>>) => {
    const response = await h.app.request(
      defaultsPath(h.project.slug),
      { headers: bearer(OPERATOR_CREDENTIAL) },
      LOOPBACK_ENV,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as any).data;
  };

  test('only the operator in person sets them; an agent, a peer Station and a guest cannot', async () => {
    const h = await setup();
    const slug = h.project.slug;
    const refused: Array<[string, Response]> = [
      [
        'internal token',
        await put(
          h.app,
          slug,
          {
            [INTERNAL_PROXY_CALLER_HEADER]: 'local',
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          },
          LOOPBACK_ENV,
        ),
      ],
      [
        'delegation',
        await put(
          h.app,
          slug,
          bearer(h.delegation.credential),
          REMOTE_TAILNET_ENV,
        ),
      ],
      // Past pairing scope (it holds access:manage): the route's own rule
      // refuses another Station acting for an agent.
      [
        'delegation with access:manage',
        await put(
          h.app,
          slug,
          bearer(
            pairDelegationDevice(
              h.pairing,
              'delegation',
              `${pairingScopePresetString('delegation')} access:manage`,
            ).credential,
          ),
          REMOTE_TAILNET_ENV,
        ),
      ],
      [
        'guest',
        await put(
          h.app,
          slug,
          bearer(pairGuest(h.pairing).credential),
          REMOTE_TAILNET_ENV,
        ),
      ],
    ];
    const statuses = Object.fromEntries(
      await Promise.all(
        refused.map(async ([who, response]) => [
          who,
          `${response.status} ${await response.text()}`,
        ]),
      ),
    );
    expect(statuses).toEqual({
      'internal token': expect.stringMatching(
        /^403 .*station_control_route_unmapped/,
      ),
      delegation: expect.stringMatching(/^403 .*insufficient_scope/),
      'delegation with access:manage': expect.stringMatching(
        /^404 .*Project unavailable/,
      ),
      guest: expect.stringMatching(/^403 .*insufficient_scope/),
    });
    expect((await readDefaults(h)).settings.fixFailingChecks).toBe(false);

    const written = await put(
      h.app,
      slug,
      bearer(OPERATOR_CREDENTIAL),
      LOOPBACK_ENV,
    );
    expect(written.status, await written.clone().text()).toBe(200);
    expect(await written.json()).toMatchObject({
      data: {
        projectSlug: slug,
        settings: { fixFailingChecks: true, addressReviewComments: false },
        canChange: true,
      },
    });
    expect((await readDefaults(h)).settings.fixFailingChecks).toBe(true);
  });

  test("a delegation peer that may read them is told it can't change them", async () => {
    const h = await setup();
    const read = await h.app.request(
      defaultsPath(h.project.slug),
      { headers: bearer(h.delegation.credential) },
      REMOTE_TAILNET_ENV,
    );
    // Either refused outright or read-only: never offered the switches.
    if (read.status === 200)
      expect(((await read.json()) as any).data.canChange).toBe(false);
    else expect([401, 403, 404]).toContain(read.status);
  });
});
