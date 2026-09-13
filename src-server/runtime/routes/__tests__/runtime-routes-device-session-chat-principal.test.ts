/**
 * station#4518: a freshly APPROVED paired-device session (the Android app
 * over tailscale-served HTTPS, exactly the owner-reproduced repro) sent a
 * chat turn and got `Unable to resolve a principal: personal-mode request
 * carries no verified identity and no home-possession authority fact` —
 * device sessions authenticate every other surface but chat's principal
 * resolution treated them as identityless. Root cause: station#4075 stage 2
 * (`bedffd16f`) made `resolveOrchestrationRequestPrincipal`
 * (`runtime-routes.ts`) fail closed instead of silently defaulting to
 * `getCachedUser().alias`, which is correct, but nothing filled the gap for
 * a device-credential caller — `identifyIngress` only recognizes Tailscale
 * Serve's WhoIs header, never a paired-device bearer/cookie, and a device
 * credential deliberately never carries the `home-possession` authority
 * fact (that fact means "this machine", not "this owner's paired phone").
 *
 * The issue's required "missing test class": a route-level test that sends
 * a request through the REAL auth path (real bearer parsing, real
 * `DevicePairingService`-backed credential verification and scope
 * enforcement — never a hand-set `RuntimeAuthenticatedRequestPrincipal`)
 * AS A PAIRED DEVICE SESSION, asserting principal resolution succeeds and
 * the request is ADMITTED. This exercises the exact production composition
 * (`configureRuntimeRoutes`, `configureRuntimeHttp`) — unlike
 * `runtime-routes-project-task-room-principal.test.ts`, which deliberately
 * mocks out `runtime-http.js` and hand-sets the authenticated principal
 * (documented there as testing the room's OWN wiring, not the credential
 * pipeline). Every existing chat/orchestration-route test either injects a
 * bespoke `resolvePrincipal` function directly or hand-sets the
 * authenticated principal — never exercising REAL bearer-credential parsing
 * together with the REAL `resolveOrchestrationRequestPrincipal` closure —
 * which is exactly how this regression shipped invisibly.
 *
 * `/api/orchestration/attachment-staging/prepare` is the observation point,
 * not `/api/orchestration/chat`: both are mounted by the SAME production
 * `configureRuntimeRoutes` call and both reach the identical
 * `resolveOrchestrationRequestPrincipal` closure (`runtime-routes.ts`,
 * `currentOwner`/`resolvePrincipal` deps at the two adjacent
 * `context.app.route(...)` calls), but `/chat` requires a full, heavy
 * `OrchestrationService` to reach "turn admitted" while attachment staging
 * only needs the lightweight, real `AttachmentStagingService` this file
 * already constructs — same principal-resolution seam, far less unrelated
 * setup. `AttachmentStagingService.prototype.prepare` is spied (never
 * mocked-away) to assert the exact resolved `principalId` reached the
 * service, which is the same shape `/chat` stamps onto its dispatched turn.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationProvider,
} from '@kontourai/station-contracts/deployment-authentication';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import type { LocalAccountView } from '@kontourai/station-contracts/local-accounts';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type {
  ProjectAccessAdministrationView,
  ProjectInvitationView,
} from '@kontourai/station-contracts/project-membership';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { getCachedUser } from '../../../routes/system/auth.js';
import type { LoadedDeploymentAuthentication } from '../../../services/identity/deployment-authentication-loader.js';
import { DeploymentAuthenticationService } from '../../../services/identity/deployment-authentication-service.js';
import { loadLocalAccounts } from '../../../services/identity/local-account-runtime.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { AttachmentStagingService } from '../../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { createRuntimeSearch } from '../../../services/search/runtime-search.js';
import {
  DevicePairingService,
  type PairingApproval,
} from '../../../services/ssh/device-pairing-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
} from '../../../utils/internal-api-token.js';
import { configureRuntimeRoutes as configureRuntimeRoutesProduction } from '../runtime-routes.js';

// Deliberately NOT mocked (unlike the room-principal composition test): this
// suite's entire point is exercising the REAL credential pipeline
// (`configureRuntimeHttp`'s bearer parsing, `verifyCredential`,
// `resolveGrantedScope`, `resolveCredentialLocality`) end to end.
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

async function configureRuntimeRoutes(
  context: Parameters<typeof configureRuntimeRoutesProduction>[0],
) {
  const result = configureRuntimeRoutesProduction(context);
  await result.kitLifecycleReady;
  return result;
}

// Same self-similar stub as the room-principal composition test: answers
// every unlisted member with an inert proxy so upstream context growth
// never forces this file to stub fields the attachment-staging/auth wiring
// under test never reads.
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

const task: TaskRecord = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Room task',
  description: '',
  priority: 'normal',
  status: 'ready',
  createdBy: 'operator',
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
} as unknown as TaskRecord;

const operatorApproval: PairingApproval = { kind: 'presented-credential' };
/** A tailnet-shaped remote peer address — never loopback — matching the
 * owner's real repro (a phone reaching this host over tailscale-served
 * HTTPS), same address shape `pairing-scope-enforcement.test.ts` uses. */
const REMOTE_TAILNET_ENV = {
  incoming: { socket: { remoteAddress: '100.96.12.7' } },
} as never;
/**
 * station#4518 fix round (HIGH-1): the serve→proxy topology
 * (`packages/cli/src/commands/lifecycle.ts`'s `proxyToBackend`) re-dials
 * THIS backend from ITS OWN loopback socket after verifying a Tailscale
 * Serve WhoIs identity — so a request carrying both a device-session
 * credential AND a WhoIs identity arrives here looking exactly like a
 * loopback connection, matching `readVerifiedIngressIdentity`'s own
 * `isLoopbackEnvironment` requirement.
 */
const LOOPBACK_SERVE_PROXY_ENV = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;

const ATTACHMENT_DESCRIPTOR = {
  clientAttachmentId: 'attach-device-1',
  kind: 'file' as const,
  name: 'note.txt',
  mimeType: 'text/plain' as const,
  size: 10,
};

/**
 * station#4518 fix round (HIGH-2/HIGH-3): a fixture operator secret, checked
 * by string equality in `environmentSecurityServiceFor` below — the same
 * shape `verifyOperatorCredential` checks in production (a digest compare
 * against the ONE stored secret), just without the real
 * `EnvironmentSecurityService`'s file-backed record. This is what lets this
 * file model "the operator's own secret, presented over a remote peer with
 * no home-possession proof" (HIGH-3's disclosed, still-open gap) and, via
 * `/api/orchestration/chat`, prove the wire-level `code` (HIGH-2).
 */
const OPERATOR_SECRET = 'operator-secret-remote-fixture';

describe('device-session chat principal resolution over the REAL auth path (station#4518)', () => {
  const directories: string[] = [];
  const searchCleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of searchCleanup.splice(0)) await close();
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  /**
   * Pairs a real device through the REAL `DevicePairingService` — the exact
   * offer/request/confirm/exchange sequence the pairing flow's own tests use
   * (`runtime-request-principal-current.test.ts`) — so the resulting bearer
   * credential is byte-for-byte what a real paired app (e.g. the Android
   * app) receives and sends as `Authorization: Bearer <credential>`. Never
   * `requesterPosition: 'off-box'`'s home-possession stamp: that mint path
   * is reserved for local-grant/UI-bootstrap exchanges
   * (`DevicePairingService.exchange`'s own doc comment), never a remote
   * pairing-code/tailnet device — which is exactly the fact this regression
   * turns on.
   */
  function pairRealDevice(homePossession = false) {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-device-chat-'));
    directories.push(homeDir);
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '22222222-2222-4222-8222-222222222222',
    });
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    // LOW-2 (station#4518 fix round): the docblock above claims byte-for-
    // byte fidelity with a real paired app's request — that claim was false
    // for `source`/`requester` (left at the default `undefined`) while the
    // owner's actual repro is a phone reaching over tailscale-served HTTPS,
    // which `requestPairing` records as `source: 'tailnet'` with a real
    // `TailscaleServeRequester`. Passing it here means the resulting
    // `PairedDevice.source` on `paired.device` is the true shape too.
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: "Owner's Pixel",
      source: 'tailnet',
      requester: { provider: 'tailscale-serve', login: 'owner@github' },
    });
    pairing.confirmRequest(
      request.requestId,
      homePossession ? { kind: 'local-grant' } : operatorApproval,
    );
    const paired = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
      ...(homePossession
        ? {
            locality: 'home-possession' as const,
            mintKind: 'local-grant' as const,
          }
        : {}),
    });
    return { pairing, paired };
  }

  /** The same real-credential-pipeline shape `runtimeSecurity` in
   * `runtime-routes.ts` builds from `context.environmentSecurityService`,
   * backed by the REAL `DevicePairingService` paired above — every method
   * delegates to the real pairing store, none of it hand-fakes "this
   * credential belongs to this device". */
  function environmentSecurityServiceFor(pairing: DevicePairingService) {
    return deepStub({
      verifyCredential: (credential: string) =>
        credential === OPERATOR_SECRET || pairing.verifyCredential(credential),
      authorizeCredential: (credential: string) =>
        credential === OPERATOR_SECRET || pairing.verifyCredential(credential),
      // HIGH-3 fix round: recognizes the fixture operator secret — never a
      // device — matching `verifyOperatorCredential`'s real contract
      // (checked independently of transport/locality; only the mint path
      // decides `locality`, never this predicate).
      verifyOperatorCredential: (credential: string) =>
        credential === OPERATOR_SECRET,
      resolveGrantedScope: (credential: string) =>
        credential === OPERATOR_SECRET
          ? DEFAULT_GRANT_PAIRING_SCOPE
          : pairing.identifyDevice(credential)?.scope,
      identifyDevice: (credential: string) =>
        pairing.identifyDevice(credential),
      credentialLocality: (credential: string) =>
        pairing.credentialLocality(credential),
      credentialMintKind: (credential: string) =>
        pairing.credentialMintKind(credential),
      devicePairing: pairing,
    });
  }

  async function setup(
    searchMode?: 'device' | 'whois' | 'home' | 'operator',
    taskReferences = false,
    deploymentAuthentication?: LoadedDeploymentAuthentication,
    withMembership = false,
    withLocalAccounts = false,
  ) {
    const { pairing, paired } = pairRealDevice(searchMode === 'home');
    const roomHomeDir = mkdtempSync(
      join(tmpdir(), 'station-device-chat-room-'),
    );
    directories.push(roomHomeDir);
    const store = new EventStore(join(roomHomeDir, 'orchestration.sqlite'));
    let runtimeSearch: ReturnType<typeof createRuntimeSearch> | undefined;
    let orchestration: OrchestrationService | undefined;
    if (searchMode) {
      for (const [threadId, userId] of [
        ['device-owned', `human:device:${paired.device.id}`],
        ['whois-owned', 'human:tailscale-serve:owner@github'],
        ['legacy-owned', getCachedUser().alias],
      ]) {
        if (taskReferences)
          store.upsertSession({
            threadId,
            provider: 'claude',
            status: 'closed',
            createdAt: '2026-09-04T00:00:00Z',
            updatedAt: '2026-09-04T00:00:00Z',
          });
        store.appendEvent({
          eventId: `${threadId}:start`,
          threadId,
          sessionId: threadId,
          provider: 'claude',
          method: 'session.started',
          createdAt: '2026-09-04T00:00:00Z',
          metadata: {
            userId,
            ...(taskReferences ? { projectSlug: task.projectId } : {}),
          },
        });
        store.appendEvent({
          eventId: `${threadId}:exact`,
          threadId,
          turnId: `${threadId}:turn`,
          provider: 'claude',
          method: 'turn.started',
          createdAt: '2026-09-04T00:00:01Z',
          prompt: 'cobalt receipt',
        });
        if (taskReferences)
          store.appendEvent({
            eventId: `${threadId}:done`,
            threadId,
            turnId: `${threadId}:turn`,
            provider: 'claude',
            method: 'turn.completed',
            createdAt: '2026-09-04T00:00:02Z',
            finishReason: 'stop',
            outputText: 'An exact public answer.',
          });
      }
      orchestration = new OrchestrationService({
        eventStore: store,
        adoptionLedger: store.createAdoptionLedger(),
        eventBus: new EventBus(),
        adapterRegistry: {
          register() {},
          get: () => undefined,
          list: () => [],
        },
        logger: { debug() {}, warn() {} },
        legacyPersonalOwner: getCachedUser().alias,
      });
      orchestration.initialize();
      // Registered BEFORE the barrier is awaited. The barrier resolves only
      // from the `finally` in `initialize()`; if that never runs, an `await`
      // placed ahead of this push leaves `afterEach` with nothing to close,
      // so the runtime and its SQLite handle leak into every later test in
      // the file. `runtimeSearch` is deliberately optional here — it does not
      // exist yet, and a barrier that never resolved means it never will.
      searchCleanup.push(async () => {
        await runtimeSearch?.close();
        await orchestration!.shutdown();
        await expect.poll(() => store.close().kind).toBe('closed');
      });
      await awaitSessionAttachmentSettled(orchestration);
      runtimeSearch = createRuntimeSearch({
        stationId: '22222222-2222-4222-8222-222222222222',
        tasks: new TaskGraphService(roomHomeDir, {
          resolveProjectWorkspace: async () => '',
        }),
        transcripts: orchestration,
      });
    }
    const project = {
      id: task.projectId,
      slug: task.projectId,
      name: 'Project',
      workingDirectory: roomHomeDir,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    const taskGraph = taskReferences
      ? new TaskGraphService(roomHomeDir, {
          projectService: { getProject: () => project },
        })
      : undefined;
    const referenceTask = await taskGraph?.createTask({
      projectId: task.projectId,
      title: 'Kept answer',
    });
    const membershipStorage = withMembership
      ? new FileStorageAdapter(roomHomeDir)
      : undefined;
    const membershipProjects = membershipStorage
      ? new ProjectService(
          membershipStorage,
          new ProjectManifestStore(roomHomeDir, membershipStorage),
        )
      : undefined;
    const sharedProject = await membershipProjects?.createProject({
      name: 'Example shared Project',
      slug: 'example',
    });
    const membership = membershipStorage
      ? createProjectMembershipRuntime(
          roomHomeDir,
          'environment-local',
          membershipStorage,
        )
      : undefined;
    const localAccounts =
      withLocalAccounts && membership
        ? await loadLocalAccounts(
            { publicOrigin: 'http://localhost:4321' },
            { stationId: 'environment-local', homeDirectory: roomHomeDir },
            membership.service,
          )
        : undefined;
    const app = new Hono();
    const context = deepStub({
      projectMembership: membership?.service,
      ...(membershipStorage ? { storageAdapter: membershipStorage } : {}),
      deploymentAuthentication: localAccounts ?? deploymentAuthentication,
      localAccounts,
      app,
      port: 4321,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => roomHomeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: store,
      ...(runtimeSearch ? { runtimeSearch } : {}),
      ...(taskReferences
        ? {
            orchestrationService: deepStub({
              sessionQueries: orchestration!.sessionQueries,
              canUserReadSession:
                orchestration!.canUserReadSession.bind(orchestration),
            }),
          }
        : {}),
      taskGraphService: taskGraph ?? {
        readTaskView: (id: string) => (id === task.id ? task : null),
        listTasks: () => [],
      },
      projectService: membershipProjects ?? {
        listProjects: () => [{ id: task.projectId, slug: 'project' }],
        ...(taskReferences ? { getProject: () => project } : {}),
      },
      environmentSecurityService: environmentSecurityServiceFor(pairing),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = await configureRuntimeRoutes(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    return {
      app,
      store,
      membership,
      localAccounts,
      sharedProject,
      roomRuntime: result.projectTaskRoomRuntime!,
      pairing,
      paired,
      referenceTask,
    };
  }

  test('Task answer pins use the same verified device owner as exact answer reads', async () => {
    const { app, roomRuntime, paired, referenceTask } = await setup(
      'device',
      true,
    );
    searchCleanup.unshift(async () => {
      await roomRuntime.close();
    });
    const headers = {
      Authorization: `Bearer ${paired.credential}`,
      'Content-Type': 'application/json',
    };
    for (const [sessionId, expected] of [
      ['device-owned', 201],
      ['legacy-owned', 404],
      ['whois-owned', 404],
    ] as const) {
      const answer = await app.request(
        `/api/orchestration/sessions/${sessionId}/turns/${sessionId}:turn`,
        { headers },
        REMOTE_TAILNET_ENV,
      );
      expect(answer.status, JSON.stringify(await answer.json())).toBe(
        expected === 201 ? 200 : 404,
      );
      const response = await app.request(
        `/api/tasks/${referenceTask!.id}/references`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            kind: 'turn',
            sessionId,
            turnId: `${sessionId}:turn`,
          }),
        },
        REMOTE_TAILNET_ENV,
      );
      expect(response.status, JSON.stringify(await response.json())).toBe(
        expected,
      );
    }
  });

  test.each(['device', 'whois', 'home', 'operator'] as const)(
    'search and exact open use actual %s ingress ownership, not the OS alias',
    async (mode) => {
      const { app, roomRuntime, paired } = await setup(mode);
      searchCleanup.unshift(async () => {
        await roomRuntime.close();
      });
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mode === 'operator' ? OPERATOR_SECRET : paired.credential}`,
        ...(mode === 'whois'
          ? {
              [INTERNAL_INGRESS_IDENTITY_HEADER]: Buffer.from(
                JSON.stringify({
                  provider: 'tailscale-serve',
                  login: 'owner@github',
                }),
              ).toString('base64url'),
              [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            }
          : {}),
      };
      const environment =
        mode === 'whois' ? LOOPBACK_SERVE_PROXY_ENV : REMOTE_TAILNET_ENV;
      const response = await app.request(
        '/api/search',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ version: UNIFIED_SEARCH_V1, query: 'cobalt' }),
        },
        environment,
      );
      const body = (await response.json()) as any;
      expect(response.status, JSON.stringify(body)).toBe(200);
      const expected =
        mode === 'home' || mode === 'operator'
          ? 'legacy-owned'
          : `${mode}-owned`;
      // The source states ride in the failure message: a provider that timed
      // out or a read the attachment gate refused answers 200 with an empty
      // list, which reads exactly like a wrong owner filter (station#1707).
      expect(
        body.data.results.map((row: any) => row.scope.sessionId),
        JSON.stringify(body.data.sources),
      ).toEqual(mode === 'operator' ? [] : [expected]);
      const opened = await app.request(
        '/api/search/resolve-open',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            kind: 'session-message',
            sessionId: expected,
            matchedEventId: `${expected}:exact`,
          }),
        },
        environment,
      );
      expect(await opened.json()).toMatchObject(
        mode === 'operator'
          ? { data: { state: 'not-found' } }
          : {
              data: {
                state: 'resolved',
                target: {
                  sessionId: expected,
                  matchedEventId: `${expected}:exact`,
                },
              },
            },
      );
    },
  );

  test('bounded chunked search and open preserve the authenticated Request and cancel over-limit input', async () => {
    const { app, roomRuntime, paired } = await setup('device');
    searchCleanup.unshift(async () => {
      await roomRuntime.close();
    });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${paired.credential}`,
    };
    for (const [path, body] of [
      ['/api/search', { version: UNIFIED_SEARCH_V1, query: 'cobalt' }],
      [
        '/api/search/resolve-open',
        {
          kind: 'session-message',
          sessionId: 'device-owned',
          matchedEventId: 'device-owned:exact',
        },
      ],
    ] as const) {
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 8));
          controller.enqueue(bytes.slice(8));
          controller.close();
        },
      });
      const response = await app.request(
        path,
        {
          method: 'POST',
          headers,
          body: stream,
          duplex: 'half',
        } as RequestInit,
        REMOTE_TAILNET_ENV,
      );
      expect(response.status).toBe(200);
      const wire = (await response.json()) as any;
      expect(
        path.endsWith('resolve-open')
          ? wire.data.state
          : wire.data.results[0].scope.sessionId,
      ).toBe(path.endsWith('resolve-open') ? 'resolved' : 'device-owned');
      const cancel = vi.fn();
      const oversized = new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(13 * 1024));
        },
        cancel,
      });
      const refused = await app.request(
        path,
        {
          method: 'POST',
          headers,
          body: oversized,
          duplex: 'half',
        } as RequestInit,
        REMOTE_TAILNET_ENV,
      );
      expect(refused.status).toBe(413);
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  test('explicit operator pairing binds two devices to one person through real HTTP authorization and refuses conflicting identity', async () => {
    const { app, store, roomRuntime, pairing } = await setup();
    const prepareSpy = vi.spyOn(AttachmentStagingService.prototype, 'prepare');
    const credentials: string[] = [];
    try {
      for (const name of ['Laptop', 'Phone']) {
        const offer = pairing.createOffer({
          endpoint: 'https://station.example.test',
          scope: pairingScopePresetString('standard'),
        });
        const pending = pairing.requestPairing({
          offerId: offer.offerId,
          proof: offer.challenge,
          deviceName: name,
          requesterPosition: 'off-box',
          source: 'tailnet',
          requester: {
            provider: 'tailscale-serve',
            login: 'collaborator@example.test',
          },
        });
        const approval = await app.request(
          `/api/pairing/requests/${pending.requestId}/confirm`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${OPERATOR_SECRET}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ bindVerifiedIdentity: true }),
          },
          REMOTE_TAILNET_ENV,
        );
        expect(approval.status, await approval.text()).toBe(200);
        const paired = pairing.exchange({
          offerId: offer.offerId,
          proof: offer.challenge,
          requestId: pending.requestId,
        });
        credentials.push(paired.credential);
        const response = await app.request(
          '/api/orchestration/attachment-staging/prepare',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${paired.credential}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ...ATTACHMENT_DESCRIPTOR,
              clientAttachmentId: `attachment-${name}`,
            }),
          },
          REMOTE_TAILNET_ENV,
        );
        expect(response.status, await response.text()).toBe(200);
      }
      expect(prepareSpy.mock.calls.map(([owner]) => owner.principalId)).toEqual(
        [
          'human:tailscale-serve:collaborator@example.test',
          'human:tailscale-serve:collaborator@example.test',
        ],
      );
      prepareSpy.mockClear();
      const conflict = await app.request(
        '/api/orchestration/attachment-staging/prepare',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials[0]}`,
            'Content-Type': 'application/json',
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_INGRESS_IDENTITY_HEADER]: Buffer.from(
              JSON.stringify({
                provider: 'tailscale-serve',
                login: 'different@example.test',
              }),
            ).toString('base64url'),
          },
          body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
        },
        LOOPBACK_SERVE_PROXY_ENV,
      );
      expect(conflict.status).toBe(400);
      expect(prepareSpy).not.toHaveBeenCalled();
      const device = pairing.identifyDevice(credentials[0]!)!;
      pairing.revokeDevice(device.id, 'operator-credential');
      const revoked = await app.request(
        '/api/orchestration/attachment-staging/prepare',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials[0]}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
        },
        REMOTE_TAILNET_ENV,
      );
      expect(revoked.status).toBe(401);
      expect(
        pairing.identifyDevice(credentials[1]!)?.principalBinding?.subject,
      ).toBe('collaborator@example.test');
    } finally {
      await roomRuntime.close();
      store.close();
    }
  });

  async function responseData<T>(response: Response): Promise<T> {
    return ((await response.json()) as { data: T }).data;
  }

  test('shareable invitation supports local username registration and explicit acceptance without email or a new device grant', async () => {
    const h = await setup(undefined, false, undefined, true, true);
    const invoke = (
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      h.app.request(
        path,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Origin: 'http://localhost:4321',
            'Content-Type': 'application/json',
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        REMOTE_TAILNET_ENV,
      );
    try {
      const operator = { Authorization: `Bearer ${OPERATOR_SECRET}` };
      const enabled = await invoke(
        '/api/projects/example/access/enable',
        { localProjectId: h.sharedProject!.id },
        operator,
      );
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const view = await responseData<ProjectAccessAdministrationView>(enabled);
      const offered = await invoke(
        '/api/projects/example/access/invitations',
        {
          scope: view.scope,
          email: null,
          role: 'viewer',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
        operator,
      );
      expect(offered.status, await offered.clone().text()).toBe(200);
      const { token, invitation } = await responseData<{
        token: string;
        invitation: ProjectInvitationView;
      }>(offered);
      expect(invitation.recipientEmail).toBeNull();
      const devicesBefore = h.pairing.listDevices();
      const user = {
        username: 'collaborator',
        password: 'A local test password 12345',
        name: 'Collaborator',
      };
      expect(
        (await invoke('/api/account-auth/sign-up/username', user)).status,
      ).toBe(403);
      const registration = await invoke(
        '/api/account-auth/sign-up/username',
        user,
        { 'x-station-invitation': token },
      );
      expect(registration.status, await registration.clone().text()).toBe(200);
      expect(registration.headers.get('set-cookie') ?? '').not.toContain(
        'session_token',
      );
      const login = await invoke('/api/account-auth/sign-in/username', {
        username: user.username,
        password: user.password,
      });
      expect(login.status, await login.clone().text()).toBe(200);
      expect(await login.clone().json()).toEqual({ success: true });
      const Cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      expect(Cookie).toContain('session_token=');
      const identity = await invoke('/api/account-auth/session', undefined, {
        Cookie,
      });
      expect(identity.status, await identity.clone().text()).toBe(200);
      const account = await responseData<{
        principal: PrincipalRef;
        contacts: unknown[];
      }>(identity);
      expect(account.contacts).toEqual([]);
      expect(account.principal.id).not.toBe(LOCAL_OPERATOR_PRINCIPAL_ID);
      const before = await responseData<ProjectAccessAdministrationView>(
        await invoke('/api/projects/example/access', undefined, operator),
      );
      expect(before.members).toHaveLength(1);
      const accepted = await invoke(
        '/api/account-auth/accept-invitation',
        { token },
        { Cookie },
      );
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      expect(await responseData<unknown>(accepted)).toEqual({
        scope: view.scope,
        grantsDeviceAccess: false,
      });
      const after = await responseData<ProjectAccessAdministrationView>(
        await invoke('/api/projects/example/access', undefined, operator),
      );
      expect(after.members).toContainEqual(
        expect.objectContaining({
          principal: account.principal,
          role: 'viewer',
          status: 'active',
        }),
      );
      expect(h.pairing.listDevices()).toEqual(devicesBefore);
      expect(
        (await invoke('/api/projects', undefined, { Cookie })).status,
      ).toBe(401);
      expect(
        (
          await invoke(
            '/api/account-auth/accept-invitation',
            { token },
            { Cookie },
          )
        ).status,
      ).toBe(409);
      // A link does not let the user silently satisfy an email-restricted invitation.
      const restricted = await invoke(
        '/api/projects/example/access/invitations',
        {
          scope: view.scope,
          email: 'someone@example.test',
          role: 'viewer',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
        operator,
      );
      const restrictedToken = (
        await responseData<{ token: string }>(restricted)
      ).token;
      expect(
        (
          await invoke(
            '/api/account-auth/accept-invitation',
            { token: restrictedToken },
            { Cookie },
          )
        ).status,
      ).toBe(409);
      const administration = await invoke(
        '/api/operator/accounts',
        undefined,
        operator,
      );
      expect(administration.status, await administration.clone().text()).toBe(
        200,
      );
      const accounts = (
        await responseData<{ accounts: LocalAccountView[] }>(administration)
      ).accounts;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        username: 'collaborator',
        disabled: false,
        emailVerified: false,
      });
      expect(accounts[0]).not.toHaveProperty('email');
      const accountId = accounts[0]!.accountId;
      const actions = `/api/operator/accounts/${accountId}/actions`;
      expect(
        (await invoke(actions, { action: 'create-recovery' }, { Cookie }))
          .status,
      ).toBe(401);
      expect(
        (
          await invoke(
            actions,
            { action: 'create-recovery' },
            { Authorization: `Bearer ${h.paired.credential}` },
          )
        ).status,
      ).toBe(403);
      const recovery = await invoke(
        actions,
        { action: 'create-recovery' },
        operator,
      );
      expect(recovery.status, await recovery.clone().text()).toBe(200);
      const recoveryUrl = new URL(
        (await responseData<{ recoveryUrl: string }>(recovery)).recoveryUrl,
      );
      const resetToken = new URLSearchParams(recoveryUrl.hash.slice(1)).get(
        'token',
      );
      expect(resetToken).toBeTruthy();
      const newPassword = 'A changed local password 45678';
      const reset = await invoke('/api/account-auth/reset-password', {
        token: resetToken,
        newPassword,
      });
      expect(reset.status, await reset.clone().text()).toBe(200);
      expect(
        (await invoke('/api/account-auth/session', undefined, { Cookie }))
          .status,
      ).toBe(401);
      expect(
        (
          await invoke('/api/account-auth/reset-password', {
            token: resetToken,
            newPassword,
          })
        ).status,
      ).toBe(400);
      const relogin = await invoke('/api/account-auth/sign-in/username', {
        username: user.username,
        password: newPassword,
      });
      expect(relogin.status, await relogin.clone().text()).toBe(200);
      const nextCookie = relogin.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const recovered = await invoke('/api/account-auth/session', undefined, {
        Cookie: nextCookie,
      });
      expect(
        (await responseData<{ principal: PrincipalRef }>(recovered)).principal,
      ).toEqual(account.principal);
      expect(
        (await invoke(actions, { action: 'disable' }, operator)).status,
      ).toBe(200);
      expect(
        (
          await invoke('/api/account-auth/session', undefined, {
            Cookie: nextCookie,
          })
        ).status,
      ).toBe(401);
      expect(
        h.pairing
          .listDevices()
          .map(({ lastUsedAt: _lastUsedAt, ...grant }) => grant),
      ).toEqual(
        devicesBefore.map(({ lastUsedAt: _lastUsedAt, ...grant }) => grant),
      );
    } finally {
      await h.localAccounts?.service.close();
      h.membership?.close();
      await h.roomRuntime.close();
      h.store.close();
    }
  });

  test('operator Project administration uses real credentials and membership rather than admitting every paired device', async () => {
    const { app, store, roomRuntime, paired, membership, sharedProject } =
      await setup(undefined, false, undefined, true);
    try {
      const base = '/api/projects/example/access';
      const invoke = (credential: string, path: string, body?: unknown) =>
        app.request(
          path,
          {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              Authorization: `Bearer ${credential}`,
              'Content-Type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          REMOTE_TAILNET_ENV,
        );
      const enabled = await invoke(OPERATOR_SECRET, `${base}/enable`, {
        localProjectId: sharedProject!.id,
      });
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const view = (await enabled.json()) as {
        data: {
          scope: { localProjectId: string };
          members: { principal: { id: string }; role: string }[];
        };
      };
      expect(view.data.scope.localProjectId).toBe(sharedProject!.id);
      expect(view.data.members).toMatchObject([
        { principal: { id: LOCAL_OPERATOR_PRINCIPAL_ID }, role: 'owner' },
      ]);
      expect((await invoke(paired.credential, base)).status).toBe(403);
      expect(
        (
          await invoke(paired.credential, `${base}/enable`, {
            localProjectId: sharedProject!.id,
          })
        ).status,
      ).toBe(403);
      const offered = await invoke(OPERATOR_SECRET, `${base}/invitations`, {
        scope: view.data.scope,
        email: 'invitee@example.test',
        role: 'viewer',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      expect(offered.status, await offered.clone().text()).toBe(200);
      const invalid = await invoke('invalid-credential', base);
      expect(invalid.status).toBe(401);
    } finally {
      membership?.close();
      await roomRuntime.close();
      store.close();
    }
  });

  test('an account principal reaches the real staging owner while device admission remains independent', async () => {
    const provider: DeploymentAuthenticationProvider = {
      version: DEPLOYMENT_AUTHENTICATION_VERSION,
      issuer: 'urn:station:account-test',
      displayName: 'Test accounts',
      sessionCookies: ['test_account'],
      endpoints: [{ path: '/logout', methods: ['POST'], operation: 'logout' }],
      authenticate: async () => ({
        kind: 'authenticated',
        session: {
          subject: 'opaque-member',
          displayName: 'Member',
          sessionId: 'session-one',
          authenticatedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          contacts: [],
        },
      }),
      handle: async () => new Response(null, { status: 204 }),
    };
    const service = new DeploymentAuthenticationService(provider);
    const { app, store, roomRuntime, paired } = await setup(undefined, false, {
      service,
      publicOrigin: 'https://station.example.test',
    });
    const prepareSpy = vi.spyOn(AttachmentStagingService.prototype, 'prepare');
    try {
      const headers = {
        'Content-Type': 'application/json',
        Cookie: 'test_account=present',
      };
      const denied = await app.request(
        '/api/orchestration/attachment-staging/prepare',
        {
          method: 'POST',
          headers,
          body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
        },
        REMOTE_TAILNET_ENV,
      );
      expect(denied.status).toBe(401);
      expect(prepareSpy).not.toHaveBeenCalled();
      const admitted = await app.request(
        '/api/orchestration/attachment-staging/prepare',
        {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${paired.credential}` },
          body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
        },
        REMOTE_TAILNET_ENV,
      );
      expect(admitted.status, await admitted.text()).toBe(200);
      expect(prepareSpy).toHaveBeenCalledOnce();
      const expected = await service.authenticate(
        new Request('https://station.example.test', { headers }),
      );
      if (expected.kind !== 'authenticated')
        throw new Error('Account fixture did not authenticate');
      expect(prepareSpy.mock.calls[0]![0].principalId).toBe(
        expected.principal.id,
      );
      expect(expected.principal.id).not.toBe(
        `human:device:${paired.device.id}`,
      );
      prepareSpy.mockClear();
      const conflict = await app.request(
        '/api/orchestration/attachment-staging/prepare',
        {
          method: 'POST',
          headers: {
            ...headers,
            Authorization: `Bearer ${paired.credential}`,
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_INGRESS_IDENTITY_HEADER]: Buffer.from(
              JSON.stringify({
                provider: 'tailscale-serve',
                login: 'different@github',
              }),
            ).toString('base64url'),
          },
          body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
        },
        LOOPBACK_SERVE_PROXY_ENV,
      );
      expect(conflict.status).toBe(401);
      expect(prepareSpy).not.toHaveBeenCalled();
    } finally {
      await roomRuntime.close();
      store.close();
    }
  });

  test('an approved device session’s credential resolves a principal and its request is ADMITTED — never PrincipalUnresolvedError', async () => {
    const { app, store, roomRuntime, paired } = await setup();
    const prepareSpy = vi.spyOn(AttachmentStagingService.prototype, 'prepare');

    const response = await app.request(
      '/api/orchestration/attachment-staging/prepare',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${paired.credential}`,
        },
        body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
      },
      REMOTE_TAILNET_ENV,
    );

    // Before the fix this credential — real, valid, and freshly approved —
    // hit `PrincipalUnresolvedError` and the route's generic catch turned it
    // into a 400 with no `code`. A 200 here is proof principal resolution
    // succeeded through the REAL auth pipeline and the request was ADMITTED
    // by the resolvePrincipal-gated route, not that any turn produced model
    // output.
    const body = (await response.json()) as unknown;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(prepareSpy).toHaveBeenCalledOnce();
    const [owner] = prepareSpy.mock.calls[0]!;
    // station#4518 fix: the device's OWN identity, derived from the
    // already-verified `RuntimeAuthenticatedRequestPrincipal` — never the
    // shared `human:local:operator` literal (that stays gated on the
    // home-possession fact this device credential never carries) and never
    // this process's own OS-account alias (the pre-station#4075 defect the
    // room-principal test guards separately).
    expect(owner).toMatchObject({
      principalId: `human:device:${paired.device.id}`,
    });

    await roomRuntime.close();
    store.close();
  });

  // station#4529, found building #4537's paired-device journey coverage: the
  // STANDARD E2E fixture authenticates as a verified operator credential
  // with no home-possession fact — the exact "production-reachable
  // unresolvable shape" `runtime-routes-project-task-room-principal.test.ts`
  // used to pin (HIGH-3's disclosed, then-open gap). This is the route-level
  // positive proof that the same seam journey 1
  // (`tests/paired-device-chat.spec.ts`) exercises now resolves this shape
  // too: possession of the operator secret IS operator identity (see
  // `OperatorAuthorityFact`'s doc in `principal-resolver.ts` for the full
  // rationale), so it collapses to the SAME `human:local:operator` principal
  // a home-possessed caller already resolved to — never a distinct
  // per-caller identity the way a paired device gets one.
  test('a verified operator credential with no home-possession fact resolves to the shared local-operator principal — station#4529', async () => {
    const { app, store, roomRuntime } = await setup();
    const prepareSpy = vi.spyOn(AttachmentStagingService.prototype, 'prepare');

    const response = await app.request(
      '/api/orchestration/attachment-staging/prepare',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPERATOR_SECRET}`,
        },
        body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
      },
      REMOTE_TAILNET_ENV,
    );

    const body = (await response.json()) as unknown;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(prepareSpy).toHaveBeenCalledOnce();
    const [owner] = prepareSpy.mock.calls[0]!;
    expect(owner).toMatchObject({ principalId: LOCAL_OPERATOR_PRINCIPAL_ID });

    await roomRuntime.close();
    store.close();
  });

  test('an unauthenticated remote request still fails closed, never admitted', async () => {
    const { app, store, roomRuntime } = await setup();
    const prepareSpy = vi.spyOn(AttachmentStagingService.prototype, 'prepare');

    const response = await app.request(
      '/api/orchestration/attachment-staging/prepare',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
      },
      REMOTE_TAILNET_ENV,
    );

    // The REAL auth middleware refuses a credential-less remote request
    // before principal resolution ever runs — fails closed with the
    // ordinary, honest `authentication_required`, never a default identity
    // and never a 200.
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'authentication_required' },
    });
    expect(prepareSpy).not.toHaveBeenCalled();

    await roomRuntime.close();
    store.close();
  });

  test('a credential unknown to this environment’s pairing store still fails closed, never admitted', async () => {
    const { app, store, roomRuntime, paired } = await setup();
    const prepareSpy = vi.spyOn(AttachmentStagingService.prototype, 'prepare');

    const response = await app.request(
      '/api/orchestration/attachment-staging/prepare',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // A credential shaped like a real bearer but never issued by this
          // environment's pairing store — the same class of failure as a
          // revoked device (verifyCredential returns false either way).
          Authorization: `Bearer ${paired.credential}-tampered`,
        },
        body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
      },
      REMOTE_TAILNET_ENV,
    );

    expect(response.status).toBe(401);
    expect(prepareSpy).not.toHaveBeenCalled();

    await roomRuntime.close();
    store.close();
  });

  // station#4518 fix round (HIGH-2), EVOLVED by station#4529: this test used
  // to pin the operator-secret-over-a-remote-peer shape as PERSONAL mode's
  // one remaining production-reachable `principal_unresolved` trigger, to
  // prove `/api/orchestration/chat`'s catch (`orchestration.ts:1148-1152`)
  // forwards `PrincipalUnresolvedError.code` onto the wire — the seam the
  // client's error translator (`chatErrorTranslation.ts`) actually consumes,
  // unlike `/attachment-staging/prepare`'s catch, which swallows the code
  // entirely. Station#4529 closed that exact gap (see `OperatorAuthorityFact`
  // in `principal-resolver.ts`): a verified operator credential now ALWAYS
  // resolves in personal mode, same as a home-possessed one or a paired
  // device — so this test's OWN scenario no longer reproduces an
  // unresolvable caller at all. Verified (not assumed): every verified
  // credential `verifyCredential` accepts is either an operator credential
  // or a recognized device (`resolveCredentialAuthority`'s only two
  // branches — see the room-principal test file's HIGH-3 note for why an
  // unrecognized credential never reaches this seam either), and both now
  // resolve in personal mode. There is no longer a reachable
  // "authenticated, personal mode, principal_unresolved" shape to pin here;
  // the wire-forwarding MECHANISM itself (not this specific trigger) stays
  // proven by `orchestration.routes.test.ts`'s "missing principal fails
  // closed" suite, which throws `PrincipalUnresolvedError` directly from an
  // injected resolver rather than depending on a specific credential shape.
  // This test is repointed to pin the new resolution table instead: the
  // SAME request now resolves and is admitted, exactly like the
  // attachment-staging positive test above.
  test('an operator credential with no home-possession fact on /api/orchestration/chat no longer gets principal_unresolved — station#4529', async () => {
    const { app, store, roomRuntime } = await setup();

    const response = await app.request(
      '/api/orchestration/chat',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPERATOR_SECRET}`,
        },
        body: JSON.stringify({
          message: 'hello',
          target: { environment: { kind: 'current' }, agent: 'codex' },
        }),
      },
      REMOTE_TAILNET_ENV,
    );

    const body = (await response.json()) as {
      success: boolean;
      error?: string;
      code?: string;
    };
    // This harness wires no real OrchestrationService/engine, so a genuine
    // turn dispatch is out of scope here (see the file-header docblock on
    // why `/attachment-staging/prepare` is the positive-proof route
    // elsewhere in this file) — the only claim this test makes is that
    // principal resolution is no longer what refuses the request.
    //
    // Fix round (review LOW-2): still 400, restored here rather than left
    // unasserted — but for a DIFFERENT, unrelated reason now
    // ("Current Station environment is unavailable", this stripped-down
    // harness's own missing environment wiring), never `principal_unresolved`.
    // Pinning the status alongside the body keeps that distinction explicit
    // instead of only proving the negative.
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(body.code).not.toBe('principal_unresolved');
    expect(body.error).not.toMatch(/Unable to resolve a principal/);

    await roomRuntime.close();
    store.close();
  });

  // station#4518 fix round (HIGH-1): pins the DECIDED precedence — a device
  // session and a Tailscale Serve WhoIs identity are NOT mutually exclusive
  // (the serve→proxy topology can present both on the SAME request; see the
  // rewritten comment at `resolveOrchestrationRequestPrincipal`'s
  // `identifyIngress(c) ?? …` line in runtime-routes.ts) — WhoIs wins by
  // construction. A future edit that silently flips this precedence (or
  // drops the WhoIs read) reds here, even though neither existing scenario
  // test (device-only, WhoIs-absent) would catch it.
  test('a Tailscale Serve WhoIs identity wins over a device session when both are present on the same request', async () => {
    const { app, store, roomRuntime, paired } = await setup();
    const prepareSpy = vi.spyOn(AttachmentStagingService.prototype, 'prepare');
    const identityHeader = Buffer.from(
      JSON.stringify({ provider: 'tailscale-serve', login: 'owner@github' }),
    ).toString('base64url');

    const response = await app.request(
      '/api/orchestration/attachment-staging/prepare',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The device session's OWN credential — proven resolvable on its
          // own by the earlier positive test in this file.
          Authorization: `Bearer ${paired.credential}`,
          [INTERNAL_INGRESS_IDENTITY_HEADER]: identityHeader,
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        },
        body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
      },
      LOOPBACK_SERVE_PROXY_ENV,
    );

    const body = (await response.json()) as unknown;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(prepareSpy).toHaveBeenCalledOnce();
    const [owner] = prepareSpy.mock.calls[0]!;
    // WhoIs wins: the finer-grained individually-attributable identity, NOT
    // the coarser per-device `human:device:<id>` the credential alone would
    // have resolved to (see the positive device-session test above).
    expect(owner).toMatchObject({
      principalId: 'human:tailscale-serve:owner@github',
    });

    await roomRuntime.close();
    store.close();
  });

  // station#4529: mirrors the HIGH-1 pin immediately above for the NEW
  // operator-credential branch — a verified operator credential and a
  // Tailscale Serve WhoIs identity are equally NOT mutually exclusive (the
  // same serve→proxy topology re-dial applies regardless of which
  // credential kind rides along), and `identifyIngress(c) ?? …` already
  // gives WhoIs unconditional priority (unchanged by this fix — see
  // `resolveOrchestrationRequestPrincipal`'s comment in runtime-routes.ts).
  // Pinned explicitly rather than left to fall out of the `??` chain's
  // general shape: a future edit that special-cased `operatorAuthority`
  // ahead of `identifyIngress` would red here even though neither the
  // operator-only nor the WhoIs-only scenario tests would catch it.
  test('a Tailscale Serve WhoIs identity wins over an operator credential when both are present on the same request', async () => {
    const { app, store, roomRuntime } = await setup();
    const prepareSpy = vi.spyOn(AttachmentStagingService.prototype, 'prepare');
    const identityHeader = Buffer.from(
      JSON.stringify({ provider: 'tailscale-serve', login: 'owner@github' }),
    ).toString('base64url');

    const response = await app.request(
      '/api/orchestration/attachment-staging/prepare',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The operator's OWN secret — proven resolvable on its own by the
          // operator-credential positive test above.
          Authorization: `Bearer ${OPERATOR_SECRET}`,
          [INTERNAL_INGRESS_IDENTITY_HEADER]: identityHeader,
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        },
        body: JSON.stringify(ATTACHMENT_DESCRIPTOR),
      },
      LOOPBACK_SERVE_PROXY_ENV,
    );

    const body = (await response.json()) as unknown;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(prepareSpy).toHaveBeenCalledOnce();
    const [owner] = prepareSpy.mock.calls[0]!;
    // WhoIs wins: the finer-grained individually-attributable identity, NOT
    // the shared `human:local:operator` literal the credential alone would
    // have resolved to (see the operator-credential positive test above).
    expect(owner).toMatchObject({
      principalId: 'human:tailscale-serve:owner@github',
    });

    await roomRuntime.close();
    store.close();
  });
});
