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
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getCachedUser } from '../../../routes/system/auth.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { waitForReceipt } from '../../../services/infra/receipt-bus.js';
import { AttachmentStagingService } from '../../../services/orchestration/attachment-staging-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
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

  async function setup(searchMode?: 'device' | 'whois' | 'home' | 'operator') {
    const { pairing, paired } = pairRealDevice(searchMode === 'home');
    const roomHomeDir = mkdtempSync(
      join(tmpdir(), 'station-device-chat-room-'),
    );
    directories.push(roomHomeDir);
    const store = new EventStore(join(roomHomeDir, 'orchestration.sqlite'));
    let runtimeSearch: ReturnType<typeof createRuntimeSearch> | undefined;
    if (searchMode) {
      for (const [threadId, userId] of [
        ['device-owned', `human:device:${paired.device.id}`],
        ['whois-owned', 'human:tailscale-serve:owner@github'],
        ['legacy-owned', getCachedUser().alias],
      ]) {
        store.appendEvent({
          eventId: `${threadId}:start`,
          threadId,
          sessionId: threadId,
          provider: 'claude',
          method: 'session.started',
          createdAt: '2026-09-04T00:00:00Z',
          metadata: { userId },
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
      }
      const orchestration = new OrchestrationService({
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
      const settled = waitForReceipt(
        (receipt) => receipt.kind === 'session.attachment.settled',
      );
      orchestration.initialize();
      await settled;
      runtimeSearch = createRuntimeSearch({
        stationId: '22222222-2222-4222-8222-222222222222',
        tasks: new TaskGraphService(roomHomeDir, {
          resolveProjectWorkspace: async () => '',
        }),
        transcripts: orchestration,
      });
      searchCleanup.push(async () => {
        await runtimeSearch!.close();
        await orchestration.shutdown();
        await expect.poll(() => store.close().kind).toBe('closed');
      });
    }
    const app = new Hono();
    const context = deepStub({
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
      taskGraphService: {
        readTaskView: (id: string) => (id === task.id ? task : null),
        listTasks: () => [],
      },
      projectService: {
        listProjects: () => [{ id: task.projectId, slug: 'project' }],
      },
      environmentSecurityService: environmentSecurityServiceFor(pairing),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = await configureRuntimeRoutes(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    return { app, store, roomRuntime: result.projectTaskRoomRuntime!, paired };
  }

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
      expect(body.data.results.map((row: any) => row.scope.sessionId)).toEqual(
        mode === 'operator' ? [] : [expected],
      );
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
