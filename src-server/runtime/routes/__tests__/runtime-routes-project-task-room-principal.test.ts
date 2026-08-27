/**
 * station#4075 stage 3 slice 1: the Task-room `requestAuthority.resolve`
 * closure at `runtime-routes.ts` (the ProjectTaskRoomRuntime deps literal)
 * used to stamp every caller with `getCachedUser().alias` regardless of who
 * — or which paired device — actually made the request. This exercises the
 * REAL production wiring (`configureRuntimeRoutes`, the real `/api/tasks/*`
 * middleware, and the real `resolve` closure it feeds) end to end through a
 * real Hono app and a real (temp-file) `EventStore`, never a hand-built
 * `requestAuthority` stub that only encodes the intended behavior.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getCachedUser } from '../../../routes/system/auth.js';
import {
  type RuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { configureRuntimeRoutes as configureRuntimeRoutesProduction } from '../runtime-routes.js';

// This composition test exercises the room's own `/api/tasks/*` middleware
// and `requestAuthority.resolve` closure directly; the shared runtime-http
// credential pipeline (device pairing, cookies, proxy attestation) is a
// separately-covered boundary and only adds unrelated setup here — same
// rationale as `runtime-routes-hosted-mcp-composition.test.ts`.
vi.mock('../../bootstrap/runtime-http.js', () => ({
  configureRuntimeHttp: () => undefined,
  configureRuntimeRouteClassificationGate: () => undefined,
  LOOPBACK_DEVICE_SESSION_COOKIE: 'station-device',
  SECURE_DEVICE_SESSION_COOKIE: '__Host-station-device',
}));

const runtimeSupportStub = new Proxy({}, { get: () => () => undefined });
// `configureRuntimeRoutes` reads `context.buildRuntimeContext().orchestrationEventStore`
// (a nativeInvocation/voiceTurn run-reader) eagerly at registration, and
// `configureRuntimeSupportServices` composes real scheduler/notification/
// approval-inbox/web-push services this test never exercises. Both are
// unrelated to the room's own requestAuthority wiring under test — same
// stubbing rationale as `runtime-routes-hosted-mcp-composition.test.ts`.
vi.mock('../runtime-route-support.js', () => ({
  configureRuntimeSupportServices: () => ({
    schedulerService: runtimeSupportStub,
    notificationService: runtimeSupportStub,
    attentionProjection: runtimeSupportStub,
    webPushService: runtimeSupportStub,
    webPushEnabled: false,
  }),
  createRuntimeSystemRouteDeps: () => runtimeSupportStub,
}));

async function configureRuntimeRoutes(
  context: Parameters<typeof configureRuntimeRoutesProduction>[0],
) {
  const result = configureRuntimeRoutesProduction(context);
  await result.kitLifecycleReady;
  return result;
}

function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      // Self-similar: a one-level proxy answers `.a.b()` but throws on
      // `.a.b.c()`, so a deeper production chain must not red a fixture
      // that never exercises it.
      const proxy: unknown = new Proxy(() => undefined, {
        // `then` must stay absent. A proxy that answers EVERY property is
        // THENABLE, so `await`ing an unstubbed member calls then(resolve,
        // reject), receives another proxy instead of a settled value, and hangs
        // forever — which is exactly how this shape failed CI at 4m57s against
        // the 5-minute lane budget while passing locally.
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

function loopbackEnv() {
  return { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;
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

describe('Task-room requestAuthority principal (station#4075 stage 3 slice 1)', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  /**
   * Builds the real `configureRuntimeRoutes` composition plus a caller-
   * controlled priming middleware standing in for the real runtime-http
   * credential pipeline (mocked out above). `setCaller` lets each test
   * choose the exact `RuntimeAuthenticatedRequestPrincipal` fields the room
   * route sees for every subsequent request, including omitting
   * `locality` entirely to model a caller with no verified home-possession
   * authority fact — the case that must fail closed.
   */
  async function setup(deviceCredential: string) {
    const directory = mkdtempSync(join(tmpdir(), 'station-room-principal-'));
    directories.push(directory);
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    const app = new Hono();
    let caller: RuntimeAuthenticatedRequestPrincipal = {
      credential: 'unset',
      authority: 'device-credential',
      source: 'bearer',
    };
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, caller);
      await next();
    });
    const environmentSecurityService = deepStub({
      identifyDevice: (credential: string) =>
        credential === deviceCredential
          ? { id: 'device-x', name: 'Device X', scope: 'pairing-v7' }
          : undefined,
      verifyOperatorCredential: (credential: string) =>
        credential === 'operator-secret',
      // A LISTED member is opted out of the fallback below, so every member
      // production reads off it must be named here. Recursing the fallback
      // into listed objects would close this automatically but would also
      // make `appConfig: {}` answer every flag with a truthy function, so
      // the member is named instead (station#4283 added `environmentId`).
      devicePairing: {
        listDevices: () => [],
        environmentId: () => 'environment-local',
      },
    });
    const context = deepStub({
      app,
      port: 4321,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => directory,
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
      taskGraphService: {
        readTaskView: (id: string) => (id === task.id ? task : null),
        listTasks: () => [],
      },
      projectService: {
        listProjects: () => [{ id: task.projectId, slug: 'project' }],
      },
      environmentSecurityService,
    });
    // `configureRuntimeRoutes` reads `context.buildRuntimeContext()
    // .orchestrationEventStore` eagerly at registration
    // (`runtime-routes-hosted-mcp-composition.test.ts` documents the same
    // seam) — self-reference the same stub context so that resolves back to
    // the real `store` above.
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    // The stub is deliberately partial (deepStub proxies every unlisted
    // member); cast at the boundary like
    // `runtime-system-route-deps-live-config.test.ts` does — upstream growth
    // of ConfigureRuntimeRoutesContext must not force this test to stub
    // members the room wiring never reads.
    const result = await configureRuntimeRoutes(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    return {
      app,
      store,
      roomRuntime: result.projectTaskRoomRuntime!,
      setCaller: (next: RuntimeAuthenticatedRequestPrincipal) => {
        caller = next;
      },
    };
  }

  test('device-identified branch resolves operatorId from the stage-2 principal, never getCachedUser().alias', async () => {
    const { app, store, roomRuntime, setCaller } = await setup('device-cred-a');
    setCaller({
      credential: 'device-cred-a',
      authority: 'device-credential',
      source: 'bearer',
      locality: 'home-possession',
    });
    const request = new Request('http://station/api/tasks/task-1/room', {
      headers: {},
    });
    const discovered = await app.fetch(request, loopbackEnv());
    expect(discovered.status).toBe(200);

    await roomRuntime.message({
      taskId: task.id,
      request,
      proposalId: 'proposal-device',
      text: 'hello from a paired device',
    });
    const history = await roomRuntime.history({ taskId: task.id, request });
    expect(history).toMatchObject({
      kind: 'available',
      records: [
        {
          principal: {
            kind: 'operator',
            operatorId: LOCAL_OPERATOR_PRINCIPAL_ID,
            deviceId: 'device-x',
          },
          body: { kind: 'human-message', text: 'hello from a paired device' },
        },
      ],
    });
    // Belt-and-suspenders: the removed fallback would have stamped this
    // process's own OS-account alias, never the contract-defined principal.
    expect(LOCAL_OPERATOR_PRINCIPAL_ID).not.toBe(getCachedUser().alias);
    await roomRuntime.close();
    store.close();
  });

  test('operator-credential branch resolves operatorId from the stage-2 principal, never getCachedUser().alias', async () => {
    const { app, store, roomRuntime, setCaller } = await setup(
      'no-such-device-credential',
    );
    setCaller({
      credential: 'operator-secret',
      authority: 'operator-credential',
      source: 'bearer',
      locality: 'home-possession',
    });
    const request = new Request('http://station/api/tasks/task-1/room', {
      headers: {},
    });
    const discovered = await app.fetch(request, loopbackEnv());
    expect(discovered.status).toBe(200);

    await roomRuntime.message({
      taskId: task.id,
      request,
      proposalId: 'proposal-operator',
      text: 'hello from the operator credential',
    });
    const history = await roomRuntime.history({ taskId: task.id, request });
    expect(history).toMatchObject({
      kind: 'available',
      records: [
        {
          principal: {
            kind: 'operator',
            operatorId: LOCAL_OPERATOR_PRINCIPAL_ID,
            deviceId: `operator:${LOCAL_OPERATOR_PRINCIPAL_ID}`,
          },
          body: {
            kind: 'human-message',
            text: 'hello from the operator credential',
          },
        },
      ],
    });
    await roomRuntime.close();
    store.close();
  });

  // station#4518: a recognized device with no home-possession fact is now
  // resolvable ON ITS OWN — the whole point of the fix. This is the positive
  // counterpart to the "unresolvable" test below: the SAME `setup('device-
  // cred-a')` fixture, the SAME recognized credential, but with `locality`
  // omitted (never stamped for a device credential — see `CredentialLocality`'s
  // docs) — reaching full task-room participation (message/history here;
  // `/api/live-activity` is covered separately below) through the REAL
  // `resolveOrchestrationRequestPrincipal` → `requestAuthority.resolve` seam,
  // never a hand-built stub. Before this fix, this EXACT scenario 404'd (see
  // the "unresolvable" test immediately below, which used to cover this
  // shape and now covers a genuinely different one).
  test('a recognized device with no home-possession fact resolves its own human:device:<id> principal and reaches full room participation', async () => {
    const { app, store, roomRuntime, setCaller } = await setup('device-cred-a');
    setCaller({
      credential: 'device-cred-a',
      authority: 'device-credential',
      source: 'bearer',
      // No locality: a device credential never carries home-possession —
      // this is the ordinary shape for a remote paired phone.
    });
    const request = new Request('http://station/api/tasks/task-1/room', {
      headers: {},
    });
    const discovered = await app.fetch(request, loopbackEnv());
    expect(discovered.status).toBe(200);

    await roomRuntime.message({
      taskId: task.id,
      request,
      proposalId: 'proposal-remote-device',
      text: 'hello from a remote paired device',
    });
    const history = await roomRuntime.history({ taskId: task.id, request });
    expect(history).toMatchObject({
      kind: 'available',
      records: [
        {
          principal: {
            kind: 'operator',
            operatorId: 'human:device:device-x',
            deviceId: 'device-x',
          },
          body: {
            kind: 'human-message',
            text: 'hello from a remote paired device',
          },
        },
      ],
    });
    // Never the shared local-operator principal — that stays gated on the
    // home-possession fact this caller never carries.
    expect(history).not.toMatchObject({
      records: [{ principal: { operatorId: LOCAL_OPERATOR_PRINCIPAL_ID } }],
    });
    // `policyRevision` on the grant is the device's own scope
    // (`ProjectTaskRoomRequestAuthority.resolve`, runtime-routes.ts) — assert
    // it through a fresh capability check rather than only the history
    // projection, since `policyRevision` is not itself in the history shape.
    await expect(
      roomRuntime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toMatchObject({ result: { outcome: 'joined' } });
    await roomRuntime.close();
    store.close();
  });

  // station#4518 fix round (HIGH-3), EVOLVED by station#4529: this test used
  // to pin "the operator's own secret, presented over a remote peer with no
  // home-possession proof" as the one remaining production-reachable
  // unresolvable shape in personal mode (an UNRECOGNIZED credential, the
  // ORIGINAL fixture here, can never actually reach this seam at all —
  // `resolveCredentialAuthority` stamps `'device-credential'` only when
  // `devicePairing.identifyDevice` recognizes it, so an unrecognized
  // credential is `authority: undefined`, rejected at the auth middleware
  // before `setCaller` is ever consulted). Station#4529 closed that
  // disclosed gap (see `OperatorAuthorityFact` in `principal-resolver.ts`):
  // a verified operator credential now resolves in personal mode
  // regardless of locality, exactly like the operator-credential + explicit
  // home-possession test above. Verified, not assumed: `verifyCredential`
  // only ever accepts an operator credential or a recognized device
  // (`environment-security-service.ts`), and both now resolve — there is no
  // longer a reachable "authenticated, personal mode, unresolvable" shape
  // to pin in THIS file's fixture space. Repointed to pin the new
  // resolution table: this is now a POSITIVE test, structurally identical
  // to the operator-credential + home-possession test above except
  // `locality` stays omitted, proving the two facts are independently
  // sufficient.
  test('an operator credential with no home-possession fact now reaches full room participation — station#4529', async () => {
    const { app, store, roomRuntime, setCaller } = await setup('device-cred-a');
    setCaller({
      credential: 'operator-secret',
      authority: 'operator-credential',
      source: 'bearer',
      // locality intentionally omitted — the operator secret was never
      // minted through a local-grant/UI-bootstrap flow for this request.
      // Station#4529: no longer disqualifying on its own.
    });
    const request = new Request('http://station/api/tasks/task-1/room', {
      headers: {},
    });
    const discovered = await app.fetch(request, loopbackEnv());
    expect(discovered.status).toBe(200);

    await roomRuntime.message({
      taskId: task.id,
      request,
      proposalId: 'proposal-operator-remote',
      text: 'hello from the remote operator credential',
    });
    const history = await roomRuntime.history({ taskId: task.id, request });
    expect(history).toMatchObject({
      kind: 'available',
      records: [
        {
          principal: {
            kind: 'operator',
            operatorId: LOCAL_OPERATOR_PRINCIPAL_ID,
            deviceId: `operator:${LOCAL_OPERATOR_PRINCIPAL_ID}`,
          },
          body: {
            kind: 'human-message',
            text: 'hello from the remote operator credential',
          },
        },
      ],
    });
    await roomRuntime.close();
    store.close();
  });

  // Fix round (review HIGH-2): the repointing above correctly turned the
  // OLD "unresolvable" fixtures into positive tests — station#4529 really
  // did make both of them resolvable — but doing so left the room's own
  // fail-closed `requestAuthority.resolve` closure (`runtime-routes.ts`,
  // `if (!authenticated) return { kind: 'revoked' }` /
  // `if (!principal) return { kind: 'revoked' }`) pinned nowhere: a
  // reviewer fault injection (throw at either branch; a default-identity
  // fallback in their place) reached them ZERO times across the full suite
  // and both injections passed every test green.
  //
  // A HOSTED-mode negative was tried first and abandoned: it does not apply
  // to THIS closure. `runtime-routes.ts`'s
  // `if (!isHostedTenantExecutionRequired() && context.orchestrationEventStore)`
  // gate wraps the room runtime's entire construction AND its `/api/tasks/*`
  // + `/api/live-activity` mounts — Task rooms are a PERSONAL-mode-only
  // feature, never mounted at all when a hosted tenant registry is
  // configured. Setting `HOSTED_TENANT_REGISTRY_FILE_ENV` for this
  // composition does not exercise a hosted variant of this closure; it
  // un-mounts the routes under test and every request 404s at Hono's own
  // router before reaching any of this file's code (confirmed by running
  // exactly that against this fixture — a generic Hono 404, not the room's
  // own JSON `{success:false}` 404 the tests above assert).
  //
  // The reviewer's own framing otherwise stands: `authority: undefined` is
  // genuinely unreachable for an ADMITTED caller now (`resolveCredentialAuthority`
  // only ever stamps `'device-credential'` or `'operator-credential'` for a
  // verified credential, and both resolve in personal mode after #4529). The
  // remaining, still-reachable negative is the OTHER guard on this same
  // closure: `!authenticated` — no `RuntimeAuthenticatedRequestPrincipal`
  // cached for the request AT ALL, never a device/operator credential shape.
  // `roomRequestPrincipals`'s own docs (above `resolveOrchestrationRequestPrincipal`)
  // name this exact case as indistinguishable, by design, from a thrown
  // `PrincipalUnresolvedError`: "a missing entry and a failed resolution are
  // indistinguishable to the reader below, and both fail closed." Driven via
  // the injectable seam this file already uses for Request identity — a
  // freshly constructed `Request` that is handed straight to the room
  // runtime's public methods WITHOUT first passing it through `app.fetch`
  // (so neither this test's own priming middleware nor the real credential
  // pipeline it stands in for ever touches it) is the direct, honest way to
  // model a caller `requestAuthority.resolve` never saw a credential for —
  // no `setCaller` call needed, because that is exactly the point: nothing
  // authenticated this request.
  //
  // Fault-injection verification (both attempted, one discriminates): a
  // default-identity fallback in place of `if (!authenticated) return
  // { kind: 'revoked' }` reds this test — `.live()`'s "join" outcome flips
  // from `{ kind: 'not-found' }` to a real `{ kind: 'available', result:
  // { outcome: 'joined' } }` with a fabricated participant actually seated in
  // the room. A THROW in the same spot does NOT red this test, and cannot:
  // `project-task-room-runtime.ts`'s `#principal()` — the sole consumer of
  // this closure — already does `catch { return undefined; }` immediately
  // beside `result.kind === 'granted' ? result : undefined`, so a thrown
  // resolution and a returned `{ kind: 'revoked' }` are NORMALIZED to the
  // identical `undefined` outcome before any caller (this test included) can
  // observe which one happened — exactly the "indistinguishable... both fail
  // closed" contract `roomRequestPrincipals`' own docs claim. No test
  // reachable through the room runtime's public surface can discriminate a
  // throw from a revoke here; the default-identity-fallback injection above
  // is the one that actually matters, and it reds.
  test('a request with no authenticated caller at all revokes the room grant rather than any default identity — fix round HIGH-2', async () => {
    const { store, roomRuntime } = await setup('device-cred-a');
    // Deliberately never `app.fetch`ed — `getRuntimeAuthenticatedRequestPrincipal`
    // and `roomRequestPrincipals` are both keyed on Request OBJECT IDENTITY,
    // so a fresh Request neither this test's priming middleware nor
    // `primeRoomRequestPrincipal` has ever seen has no entry in either.
    const request = new Request('http://station/api/tasks/task-1/room');

    const history = await roomRuntime.history({ taskId: task.id, request });
    expect(history).toEqual({ kind: 'not-found' });

    const messageResult = await roomRuntime.message({
      taskId: task.id,
      request,
      proposalId: 'proposal-unauthenticated',
      text: 'should never be attributed to any default identity',
    });
    expect(messageResult).toEqual({ kind: 'not-found' });

    await expect(
      roomRuntime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toEqual({ kind: 'not-found' });
    await roomRuntime.close();
    store.close();
  });

  // Fix round (review finding): `liveActivity()` (project-task-room-
  // runtime.ts:1536-1622) reaches the exact same `#principal` →
  // `requestAuthority.resolve` seam, but through a SECOND, separate mount —
  // `createLiveActivityRoutes` at `/api/live-activity`
  // (`routes/orchestration/live-activity.ts:23-25`) — not
  // `/api/tasks/*`. The first cut of this slice only primed `/api/tasks/*`,
  // so every `/api/live-activity` request had no cached principal,
  // `#authorizedDocument` always returned undefined, and `liveActivity()`
  // silently returned an empty `participants` projection for every caller,
  // forever — a real regression versus main (the removed alias mint had no
  // WeakMap dependency at all). These two tests exercise `/api/live-activity`
  // through the real composition, never a hand-built `roomRuntime` stub.
  test('a resolvable caller sees a populated /api/live-activity projection, not a silently empty one', async () => {
    const { app, store, roomRuntime, setCaller } = await setup('device-cred-a');
    setCaller({
      credential: 'device-cred-a',
      authority: 'device-credential',
      source: 'bearer',
      locality: 'home-possession',
    });
    const request = new Request('http://station/api/tasks/task-1/room', {
      headers: {},
    });
    const discovered = await app.fetch(request, loopbackEnv());
    expect(discovered.status).toBe(200);
    // Reuses the same primed `request` directly against the runtime, exactly
    // like the device-identified/operator-credential tests above, to put a
    // live participant in the room before checking the aggregate.
    await expect(
      roomRuntime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toMatchObject({ result: { outcome: 'joined' } });
    await expect(
      roomRuntime.live({ taskId: task.id, request, command: 'announce' }),
    ).resolves.toMatchObject({ result: { outcome: 'updated' } });

    const liveActivityResponse = await app.fetch(
      new Request('http://station/api/live-activity'),
      loopbackEnv(),
    );
    expect(liveActivityResponse.status).toBe(200);
    const body = (await liveActivityResponse.json()) as {
      success: boolean;
      data: { participants: unknown[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.participants.length).toBeGreaterThan(0);
    await roomRuntime.close();
    store.close();
  });

  // station#4518 fix round, EVOLVED by station#4529: this test used to prove
  // that an unresolvable caller (the operator secret presented remotely with
  // no home-possession proof — the same shape the revoked-grant test above
  // used to pin) still gets an empty, never-errored `/api/live-activity`
  // projection rather than a thrown `PrincipalUnresolvedError` surfacing as
  // a 500. Station#4529 closed that unresolvable shape (see
  // `OperatorAuthorityFact` in `principal-resolver.ts`): this exact caller
  // now resolves to the shared `human:local:operator` principal, same as an
  // explicitly home-possessed one, and reads the room like any other
  // resolvable caller — the REAL participant a DIFFERENT device-credential
  // caller already joined and announced. Repointed to pin that: the
  // projection is now POPULATED, not empty, mirroring the "a resolvable
  // caller sees a populated projection" test immediately above (which used
  // `device-credential` + explicit home-possession; this is the same claim
  // for an operator credential with no locality fact).
  test('an operator credential with no home-possession fact also sees a populated /api/live-activity projection — station#4529', async () => {
    const { app, store, roomRuntime, setCaller } = await setup('device-cred-a');
    // First, a DIFFERENT resolvable caller joins and announces so a live
    // participant genuinely exists in the room.
    setCaller({
      credential: 'device-cred-a',
      authority: 'device-credential',
      source: 'bearer',
      locality: 'home-possession',
    });
    const joinRequest = new Request('http://station/api/tasks/task-1/room', {
      headers: {},
    });
    expect((await app.fetch(joinRequest, loopbackEnv())).status).toBe(200);
    await roomRuntime.live({
      taskId: task.id,
      request: joinRequest,
      command: 'join',
    });
    await roomRuntime.live({
      taskId: task.id,
      request: joinRequest,
      command: 'announce',
    });

    // Now switch to the operator's own secret, presented remotely with no
    // home-possession proof and no device-credential fallback available to
    // it — station#4529's newly-resolvable shape.
    setCaller({
      credential: 'operator-secret',
      authority: 'operator-credential',
      source: 'bearer',
    });
    const liveActivityResponse = await app.fetch(
      new Request('http://station/api/live-activity'),
      loopbackEnv(),
    );
    expect(liveActivityResponse.status).toBe(200);
    const body = (await liveActivityResponse.json()) as {
      success: boolean;
      data: { participants: unknown[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.participants.length).toBeGreaterThan(0);
    await roomRuntime.close();
    store.close();
  });
});
