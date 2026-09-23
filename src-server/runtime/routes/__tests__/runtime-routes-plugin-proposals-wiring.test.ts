/**
 * #2323 S5, through the PRODUCTION composition.
 *
 * The route-seam tests (`plugin-person-approval.routes.test.ts`) prove the
 * gates with a stand-in principal resolver and a hand-configured auth
 * boundary. They cannot see the three lines in `runtime-routes.ts` that make
 * those gates live in production:
 *
 * - `resolveCredentialDeviceKind` on the runtime security options, which is
 *   what binds `principal.deviceKind`. Without it every paired device reads
 *   as kind-unknown and a delegated Station is admitted as if it were a
 *   person;
 * - `resolvePrincipal` on the proposal routes, which decides operator-only
 *   reads;
 * - `viewerIsOperator` on the attention routes, which decides whether a
 *   viewer sees proposal items.
 *
 * So this drives the REAL `configureRuntimeRoutes` (real
 * `configureRuntimeHttp`, real pairing-scope table, real plugin and proposal
 * routes) with REAL paired-device credentials from a real
 * `EnvironmentSecurityService` on an isolated home, in the harness shape of
 * `runtime-routes-project-guest-admin.test.ts`. The attention projection is
 * the real `AttentionProjectionService` over the same proposal store, with
 * every other source empty; only its construction is local, because
 * `runtime-route-support.ts` builds the whole support runtime.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pairingScopePresetString } from '@kontourai/station-contracts';
import { resolveStationRoot } from '@kontourai/station-shared/runtime-path-resolver';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { PluginLifecycleProposalService } from '../../../services/plugins/plugin-lifecycle-proposals.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { configureRuntimeRoutes as configureRuntimeRoutesProduction } from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', async () => {
  const { AttentionProjectionService } = await import(
    '../../../services/projects/attention-projection.js'
  );
  const { PluginLifecycleProposalService } = await import(
    '../../../services/plugins/plugin-lifecycle-proposals.js'
  );
  const runtimeSupportStub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: (context: {
      configLoader: { getProjectHomeDir(): string };
    }) => ({
      schedulerService: runtimeSupportStub,
      notificationService: runtimeSupportStub,
      // The REAL projection, reading proposals from the same home the
      // composition's routes write, as `runtime-route-support.ts` builds it.
      // Every other source is empty, so what reaches the inbox is decided by
      // the `isOperator` flag the mounted route hands it.
      attentionProjection: new AttentionProjectionService(
        { list: async () => [] },
        {
          listSessionReadModel: async () => [],
          readSessionFlowRun: async () => undefined,
          readSession: async () => undefined,
        } as never,
        { getRunConsole: async () => undefined } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        null,
        undefined,
        new PluginLifecycleProposalService(
          context.configLoader.getProjectHomeDir(),
        ),
      ),
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

const ORIGIN = 'https://station.example.test';
/** Stands for Station's own agent caller in `request` below. */
const INTERNAL_CALLER = '<station-internal-caller>';
const operatorApproval = { kind: 'presented-credential' } as const;

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

describe('#2323 S5 plugin proposal gates over the production composition', () => {
  const directories: string[] = [];
  const stores: EventStore[] = [];
  const ambientHome = process.env.STATION_HOME;
  const ambientRoot = process.env.STATION_ROOT;
  const ambientOrigins = process.env.ALLOWED_ORIGINS;
  beforeEach(() => {
    const owned = ownedTempRoot('station-s5-wiring-');
    directories.push(owned);
    mkdirSync(join(owned, 'home'));
    mkdirSync(join(owned, 'root'));
    mkdirSync(join(owned, 'data'));
    process.env.STATION_HOME = join(owned, 'home');
    process.env.STATION_ROOT = join(owned, 'root');
    process.env.ALLOWED_ORIGINS = ORIGIN;
  });
  afterEach(() => {
    if (ambientHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = ambientHome;
    if (ambientRoot === undefined) delete process.env.STATION_ROOT;
    else process.env.STATION_ROOT = ambientRoot;
    if (ambientOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = ambientOrigins;
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  async function setup() {
    const owned = directories[directories.length - 1]!;
    const homeDir = join(owned, 'data');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700, recursive: true });
    mkdirSync(join(homeDir, 'plugins'), { recursive: true });
    const security = new EnvironmentSecurityService({ homeDir });
    const { credential: operatorCredential } = await security.initialize();
    const storage = new FileStorageAdapter(homeDir);
    const manifests = new ProjectManifestStore(homeDir, storage);
    const projectService = new ProjectService(storage, manifests);
    const eventStore = new EventStore(join(homeDir, 'events.sqlite'));
    stores.push(eventStore);

    const app = new Hono();
    const context = deepStub({
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      storageAdapter: storage,
      projectService,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: async () => ({}),
        mutateAppConfig: async () => ({}),
      },
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
          // #2323 S4: a real installation journal on this home, so the
          // source status route reads real (empty) selections.
          createPackageMcpAdmissionJournal: () =>
            eventStore.createPackageMcpAdmissionJournal(),
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
      environmentSecurityService: security,
      taskGraphService: { listTasks: () => [] },
    });
    const result = configureRuntimeRoutesProduction(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    await result.kitLifecycleReady;

    /** A real paired device, of the given kind, with the given preset. */
    const pair = (
      name: string,
      kind: 'device' | 'delegation',
      preset: 'standard' | 'delegation',
    ) => {
      const pairing = security.devicePairing;
      const offer = pairing.createOffer({
        endpoint: ORIGIN,
        scope: pairingScopePresetString(preset),
        kind,
      });
      const pending = pairing.requestPairing({
        requesterPosition: 'off-box',
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: name,
      });
      pairing.confirmRequest(pending.requestId, { ...operatorApproval });
      return pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      }).credential;
    };
    const request = (
      credential: string,
      path: string,
      init: RequestInit = {},
    ) =>
      credential === INTERNAL_CALLER
        ? // Station's own agent caller: the per-boot internal token, the
          // `local` marker, a direct loopback socket and no credential,
          // exactly what station-control sends.
          app.request(
            `http://127.0.0.1:4321${path}`,
            {
              ...init,
              headers: {
                ...(init.headers ?? {}),
                [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
                [INTERNAL_PROXY_CALLER_HEADER]: 'local',
              },
            },
            { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
          )
        : app.request(`${ORIGIN}${path}`, {
            ...init,
            headers: {
              ...(init.headers ?? {}),
              Authorization: `Bearer ${credential}`,
            },
          });
    return {
      app,
      homeDir,
      operatorCredential,
      pair,
      request,
      proposals: new PluginLifecycleProposalService(homeDir),
    };
  }

  test('a real delegation device is refused on install and remove; a person’s paired device is not refused by that gate', async () => {
    const { pair, request, homeDir } = await setup();
    mkdirSync(join(homeDir, 'plugins', 'installed-plugin'));
    const delegation = pair('Peer: box-b', 'delegation', 'delegation');
    const person = pair('Phone', 'device', 'standard');
    const install = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: '/nonexistent/plugin',
        consent: { permissions: [], contentDigest: `sha256:${'a'.repeat(64)}` },
      }),
    };

    for (const [path, init] of [
      ['/api/plugins/install', install],
      ['/api/plugins/installed-plugin', { method: 'DELETE' }],
    ] as const) {
      const refused = await request(delegation, path, init);
      const refusedBody = await readJson<{ code?: string }>(refused);
      expect({ path, status: refused.status, code: refusedBody.code }).toEqual({
        path,
        status: 403,
        code: 'person-approval-required',
      });
      const reached = await request(person, path, init);
      const reachedBody = await readJson<{ code?: string }>(reached);
      // Not this gate's refusal. What the handler answers after it (a
      // missing source, a plugin that is not a real install) is incidental.
      expect({ path, code: reachedBody.code }).not.toEqual({
        path,
        code: 'person-approval-required',
      });
      expect({ path, status: reached.status }).not.toEqual({
        path,
        status: 403,
      });
    }
  });

  test('proposal reads and proposal attention are the operator’s: a paired person, a delegated Station and Station’s own agents get 404 and no item', async () => {
    const { pair, request, operatorCredential, proposals } = await setup();
    const { proposal } = await proposals.propose({
      kind: 'install',
      source: 'https://github.com/org/pulse',
      rationale: 'Adds the pulse pane.',
      author: { principal: 'agent' },
    });
    const person = pair('Phone', 'device', 'standard');
    const delegation = pair('Peer: box-b', 'delegation', 'delegation');
    // Station's own agent caller resolves as the operator (home possession),
    // and still reads nothing (#2323 S5 delta review).
    const nonOperators = [
      ['person', person],
      ['delegation', delegation],
      ['internal', INTERNAL_CALLER],
    ] as const;

    for (const [caller, credential] of nonOperators) {
      for (const path of [
        '/api/plugin-proposals',
        `/api/plugin-proposals/${proposal.id}`,
      ]) {
        const hidden = await request(credential, path);
        expect({ caller, path, status: hidden.status }).toEqual({
          caller,
          path,
          status: 404,
        });
      }
    }
    const listed = await request(operatorCredential, '/api/plugin-proposals');
    expect(listed.status).toBe(200);
    expect(
      (
        await readJson<{ proposals: Array<{ id: string }> }>(listed)
      ).proposals.map((entry) => entry.id),
    ).toEqual([proposal.id]);
    const read = await request(
      operatorCredential,
      `/api/plugin-proposals/${proposal.id}`,
    );
    expect(read.status).toBe(200);

    const inbox = async (credential: string) => {
      const response = await request(credential, '/api/attention');
      expect(response.status).toBe(200);
      return (
        await readJson<{
          data: { items: Array<{ kind: string; id: string }> };
        }>(response)
      ).data.items.filter((item) => item.kind === 'plugin-lifecycle-proposal');
    };
    for (const [caller, credential] of nonOperators) {
      expect({ caller, items: await inbox(credential) }).toEqual({
        caller,
        items: [],
      });
    }
    expect(await inbox(operatorCredential)).toEqual([
      expect.objectContaining({
        id: `plugin-lifecycle-proposal:${proposal.id}`,
      }),
    ]);
  });
  test('#2323 S4: plugin source status is mounted and scoped: a paired person and Station’s internal caller get 404, the operator gets the list', async () => {
    const { pair, request, operatorCredential, app } = await setup();
    const person = pair('Phone', 'device', 'standard');
    const hidden = await request(person, '/api/plugin-sources');
    // 404 from the handler, not a pairing-scope refusal: an unmapped family
    // would answer 403 before the handler ran.
    expect(hidden.status).toBe(404);

    // Station's own agent caller, as station-control sends it: the per-boot
    // internal token from a direct loopback socket, no credential. The real
    // auth boundary binds it as `internal`, and the handler refuses it.
    const internal = await app.request(
      `${ORIGIN}/api/plugin-sources`,
      {
        headers: {
          [INTERNAL_PROXY_CALLER_HEADER]: 'local',
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        },
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
    );
    expect(internal.status).toBe(404);

    const operator = await request(operatorCredential, '/api/plugin-sources');
    expect(operator.status).toBe(200);
    expect(await readJson<{ sources: unknown[] }>(operator)).toEqual({
      sources: [],
    });
  });
});
