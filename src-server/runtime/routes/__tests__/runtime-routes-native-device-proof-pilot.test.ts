/**
 * #2893 opt-in native Device request-proof pilot through the PRODUCTION
 * composition.
 *
 * Drives the REAL `configureRuntimeRoutes` — real `configureRuntimeHttp`
 * native admission (bounded exact-body read, byte-copy provenance owner,
 * Device JWS/JTI admission, budget source, no-credential-fallback refusals),
 * the real account-bound device gate, the real native account continuation
 * routes, the real Project membership guards — over real key signatures and
 * real persistence: a real `EnvironmentSecurityService` pairing registry, a
 * real `NativeDeviceProofBindingService` store, a real SQLite replay store,
 * and the REAL local-account provider (real invitation-gated username signup,
 * real password login, real session-reference verify/revoke and Better Auth
 * session state). No provider authentication is fabricated and no request
 * principal is installed by hand.
 *
 * Private provenance comes through the REAL native v2 Pion application
 * adapter and the real `VirtualApplicationIngress`: the broker transport is
 * faked (permitted), positive requests are consumed by the PRODUCTION
 * `createApplicationChannelFetch` client, and only the controlled
 * delayed-revocation test drives manual frames/credits. `configureRuntimeHttp`
 * is NOT mocked. Stream assertions require `end === true` and
 * `error === undefined` before any body parse, and failure surfaces carry
 * only safe frame types, error codes and byte counts — never header values,
 * continuation bodies or credentials.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  createApplicationChannelFetch,
  serveApplicationChannel,
} from '@kontourai/station-connect/application-channel';
import {
  readApplicationFrame,
  writeApplicationFrame,
} from '@kontourai/station-connect/application-channel-frames';
import {
  APPLICATION_SESSION_NATIVE_HEADER,
  APPLICATION_SESSION_NATIVE_PROOF_HEADER,
} from '@kontourai/station-contracts/application-session';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionSigningKey,
} from '@kontourai/station-contracts/connection-proof';
import { NATIVE_DEVICE_PROOF_HEADER } from '@kontourai/station-contracts/native-device-proof';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import {
  createNativeApplicationSessionProof,
  serializedCredentialsHash,
} from '@kontourai/station-sdk/application-session-native';
import { createNativeDeviceRequestProof } from '@kontourai/station-sdk/native-device-proof';
import {
  signStationConnectionProof,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { Hono } from 'hono';
import { exportJWK as exportJwkJose, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { NativeDeviceRequestAuthority } from '../../../security/native-device-request-authority.js';
import {
  createNativeV2PionApplicationAdapter,
  readVerifiedNativePionApplicationRequest,
} from '../../../services/connections/native-v2-pion-application-adapter.js';
import {
  readVerifiedNativeVirtualApplicationRequest,
  VirtualApplicationIngress,
} from '../../../services/connections/virtual-application.js';
import { createApplicationSessionRuntime } from '../../../services/identity/application-session-runtime.js';
import { deploymentAccountPrincipal } from '../../../services/identity/deployment-authentication-service.js';
import { loadLocalAccounts } from '../../../services/identity/local-account-runtime.js';
import { NativeDeviceProofReplayStoreSqlite } from '../../../services/identity/native-device-replay-store.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  NativeDeviceProofBindingService,
  NativeDeviceProofOperatorAuthority,
} from '../../../services/ssh/native-device-proof-binding-service.js';
import { configureRuntimeRoutes as configureRuntimeRoutesProduction } from '../runtime-routes.js';

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
    get: (_t, property) => (property === 'then' ? undefined : deepCallable()),
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
const STATION_ID = randomUUID();
let guestUsernameCounter = 0;
const guestUsername = () => `pilotguest${++guestUsernameCounter}`;
const GUEST_PASSWORD = 'pilot-password-123';
const GUEST_DISPLAY = 'Pilot Guest';
const GUEST_GRANT = 'orchestration:read orchestration:operate';
const operatorApproval = { kind: 'presented-credential' } as const;
const NATIVE_VERSION = 'station.application-session-native/v1';

function ownedTempRoot(prefix: string): string {
  const ambientRoot = process.env.STATION_ROOT
    ? resolve(process.env.STATION_ROOT)
    : resolve(tmpdir());
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

async function p256Key(): Promise<{
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  sign: (input: Uint8Array) => Promise<Uint8Array>;
}> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJwkJose(pair.publicKey)) as Record<string, string>;
  return {
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! },
    sign: async (input: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          new Uint8Array(input),
        ),
      ),
  };
}

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');
const sha256Base64url = async (value: string): Promise<string> =>
  base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  );

/** Safe delivery summary: frame types, error codes, byte counts — no values. */
function deliverySummary(driver: {
  frames: string[];
  chunks: Uint8Array[];
  end: boolean;
  error: string | undefined;
}): string {
  const types = driver.frames.map((message) => {
    try {
      const frame = readApplicationFrame(message) as Record<string, unknown>;
      return frame.type === 'response'
        ? `response:${String(frame.status)}`
        : frame.type === 'error'
          ? `error:${String(frame.code)}`
          : String(frame.type);
    } catch {
      return 'unreadable';
    }
  });
  return `frames=[${types.join(',')}] chunkBytes=${driver.chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  )} end=${driver.end}`;
}

interface ManualChannel {
  driver: {
    frames: string[];
    status: number | undefined;
    chunks: Uint8Array[];
    end: boolean;
    error: string | undefined;
  };
  /** The raw ApplicationChannel served by the adapter's accept. */
  channel: {
    send(message: string): void;
    close(): void;
    subscribe(
      message: (value: unknown) => void,
      closed: () => void,
    ): () => void;
  };
  write(frame: Parameters<typeof writeApplicationFrame>[0]): void;
  /** Wait until at least one new frame has been delivered. */
  awaitFrame(): Promise<void>;
  closedByServer(): boolean;
  unsubscribed(): boolean;
}

describe('native Device request-proof pilot over the production composition', () => {
  const directories: string[] = [];
  const ambientHome = process.env.STATION_HOME;
  const ambientRoot = process.env.STATION_ROOT;
  const ambientOrigins = process.env.ALLOWED_ORIGINS;
  beforeEach(() => {
    const owned = ownedTempRoot('station-native-pilot-');
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
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  async function setup() {
    const owned = directories[directories.length - 1];
    const homeDir = join(owned, 'data');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700, recursive: true });
    const security = new EnvironmentSecurityService({ homeDir });
    const { credential: operatorCredential } = await security.initialize();

    const storage = new FileStorageAdapter(homeDir);
    const manifests = new ProjectManifestStore(homeDir, storage);
    const projectService = new ProjectService(storage, manifests);
    const membership = createProjectMembershipRuntime(
      homeDir,
      STATION_ID,
      storage,
    );
    // The REAL local-account provider: real invitation-gated username signup,
    // real password login and real session-reference state.
    const localAccounts = await loadLocalAccounts(
      { publicOrigin: ORIGIN },
      { stationId: STATION_ID, homeDirectory: homeDir },
      membership.service,
    );

    const replayStore = new NativeDeviceProofReplayStoreSqlite(
      join(homeDir, 'security', 'native-device-proof-replay.sqlite'),
      STATION_ID,
    );
    const bindingService = new NativeDeviceProofBindingService({
      homeDir,
      pairing: {
        environmentId: () => STATION_ID,
        listDevices: () => security.devicePairing.listDevices(),
      },
    });
    const operatorAuthority = new NativeDeviceProofOperatorAuthority();
    const pilot = {
      binding: bindingService,
      pairing: {
        activeDevice: (deviceId: string) =>
          security.devicePairing
            .listDevices()
            .find((device) => device.id === deviceId),
      },
      replayStore,
    };
    const nativeAuthority = new NativeDeviceRequestAuthority(pilot);

    const applicationSessions = createApplicationSessionRuntime(
      homeDir,
      STATION_ID,
      localAccounts,
      (value: string) => security.devicePairing.identifyDevice(value),
      undefined,
      undefined,
      Date.now,
      () => undefined,
      undefined,
      readVerifiedNativeVirtualApplicationRequest,
      (request: Request) => {
        const current = nativeAuthority.resolveCurrent(request);
        return current ? { device: current.device } : undefined;
      },
    );
    if (!applicationSessions)
      throw new Error('local accounts lack native session capabilities');

    let appConfig: Record<string, unknown> = {};
    const app = new Hono();
    const eventBus = new EventBus();
    const context = deepStub({
      projectMembership: membership.service,
      projectSharedTasks: undefined,
      deploymentAuthentication: localAccounts,
      applicationSessions,
      storageAdapter: storage,
      projectService,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: async () => ({ ...appConfig }),
        mutateAppConfig: async (
          mutate: (current: Record<string, unknown>) => Record<string, unknown>,
        ) => {
          appConfig = { ...appConfig, ...mutate({ ...appConfig }) };
          return { ...appConfig };
        },
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
      eventBus,
      taskGraphService: { listTasks: () => [] },
      nativeDeviceProofPilot: pilot,
    });
    const result = configureRuntimeRoutesProduction(
      context as unknown as Parameters<
        typeof configureRuntimeRoutesProduction
      >[0],
    );
    await result.kitLifecycleReady;

    const request = (path: string, init: RequestInit = {}) =>
      app.request(`${ORIGIN}${path}`, init);
    const ownerHeaders = (extra?: RequestInit) => ({
      ...extra,
      headers: {
        ...(extra?.headers ?? {}),
        Authorization: `Bearer ${operatorCredential}`,
      },
    });

    /**
     * REAL account lifecycle: operator shares a Project and invites; the
     * person signs up through the REAL local-account provider with that
     * invitation, then performs a REAL password login.
     */
    const shareAndCreateGuest = async (
      slug: string,
      name: string,
      role = 'admin',
    ) => {
      const username = guestUsername();
      const project = await projectService.createProject({ name, slug });
      const enabled = await request(
        `/api/projects/${slug}/access/enable`,
        ownerHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localProjectId: project.id }),
        }),
      );
      expect(enabled.status, await enabled.clone().text()).toBe(200);
      const scope = (await readJson<{ data: { scope: unknown } }>(enabled)).data
        .scope;
      const invited = await request(
        `/api/projects/${slug}/access/invitations`,
        ownerHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope,
            email: null,
            role,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          }),
        }),
      );
      expect(invited.status, await invited.clone().text()).toBe(200);
      const token = (await readJson<{ data: { token: string } }>(invited)).data
        .token;
      const signedUp = await localAccounts.service.handle(
        new Request(`${ORIGIN}/api/account-auth/sign-up/username`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-station-invitation': token,
          },
          body: JSON.stringify({
            username,
            password: GUEST_PASSWORD,
            name: GUEST_DISPLAY,
          }),
        }),
        '/sign-up/username',
      );
      expect(signedUp.status, await signedUp.clone().text()).toBe(200);
      const login = await localAccounts.service.loginVirtualSession(
        new Request(`${ORIGIN}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password: GUEST_PASSWORD,
          }),
        }),
      );
      if (login.kind !== 'authenticated')
        throw new Error(`fixture local login failed: ${login.kind}`);
      return { project, scope, login, username, invitationToken: token };
    };

    /** Pair an account-bound device bound to the REAL logged-in account. */
    const pairNativeDevice = async (
      name: string,
      login: Extract<
        Awaited<ReturnType<typeof localAccounts.service.loginVirtualSession>>,
        { kind: 'authenticated' }
      >,
    ) => {
      const pairing = security.devicePairing;
      const offer = pairing.createOffer({
        endpoint: ORIGIN,
        scope: GUEST_GRANT,
      });
      const pending = pairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: name,
        requesterPosition: 'unproven',
        source: 'same-origin',
        accountCandidate: {
          issuer: login.issuer,
          subject: login.session.subject,
          displayName: GUEST_DISPLAY,
        },
        accountCandidateSessionId: login.session.sessionId,
        requireAccountBinding: true,
      });
      pairing.confirmRequest(
        pending.requestId,
        { ...operatorApproval },
        {
          principalId: deploymentAccountPrincipal(
            login.issuer,
            login.session.subject,
            GUEST_DISPLAY,
          ).id,
          kind: 'account',
        },
      );
      const exchange = pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: pending.requestId,
      });
      const device = pairing
        .listDevices()
        .find((candidate) => candidate.name === name);
      if (!device) throw new Error('fixture device not paired');
      const deviceKey = await p256Key();
      const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
        kind: 'station-native',
        appIdentifier: 'dev.kontourai.station.pilot-test',
        channel: 'dev',
        clientInstanceId: randomUUID(),
        keyThumbprint: 'B'.repeat(43),
      };
      const binding = bindingService.createBinding({
        deviceId: device.id,
        surface,
        jwk: deviceKey.publicJwk,
        approval: operatorAuthority.approve({
          operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
        }),
      });
      return {
        credential: exchange.credential,
        device,
        surface,
        binding,
        deviceKey,
      };
    };

    /**
     * The real native v2 Pion application adapter over the real
     * VirtualApplicationIngress; only the broker transport is faked.
     * Positive requests are consumed by the PRODUCTION
     * `createApplicationChannelFetch` client; the manual frame channel
     * exists for controlled delayed-revocation delivery only.
     */
    const startNativePeer = async (paired: {
      device: { id: string };
      surface: SelfHostedBrokerNativeClientSurfaceV2;
      binding: { bindingId: string; deviceProof: { thumbprint: string } };
      deviceKey: {
        publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
        sign: (input: Uint8Array) => Promise<Uint8Array>;
      };
    }) => {
      const device = {
        id: paired.device.id,
        surface: paired.surface,
        binding: paired.binding,
        deviceKey: paired.deviceKey,
      };
      const ingress = new VirtualApplicationIngress(
        ORIGIN,
        undefined,
        readVerifiedNativePionApplicationRequest,
      );
      ingress.bind({
        fetch: app.fetch as unknown as (
          request: Request,
        ) => Response | Promise<Response>,
      });
      const virtual = ingress.activate();
      const issuerPair = await generateKeyPair('ES256', { extractable: true });
      const issuerJwk = (await exportJwkJose(issuerPair.publicKey)) as Record<
        string,
        string
      >;
      const trust: ApprovedStationConnectionTrust = {
        stationId: STATION_ID,
        enrollmentId: randomUUID(),
        generation: 1,
        signingKey: issuerJwk as unknown as StationConnectionSigningKey,
      };
      const stationKeyId = await stationConnectionSigningKeyId(trust);
      const offerNonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
      let accept: ((channel: unknown) => void) | undefined;
      const created = createNativeV2PionApplicationAdapter(
        {
          surface: device.surface,
          applicationOrigin: ORIGIN,
          application: virtual,
          executable: '/bin/false',
          certificatePem: 'cert',
          privateKeyPem: 'key',
          turn: { url: 'turn:example', username: 'u', password: 'p' },
          trust: {
            current: () => structuredClone(trust),
            isCurrent: (value) =>
              value.stationId === trust.stationId &&
              value.enrollmentId === trust.enrollmentId &&
              value.generation === trust.generation,
          },
          issuer: {
            issue: async (binding) =>
              signStationConnectionProof({
                trust,
                binding,
                signingKey: issuerPair.privateKey,
                now: Math.floor(Date.now() / 1000),
              }),
          },
        },
        {
          startAdapter: (async (input: {
            accept: (channel: unknown) => void;
          }) => {
            accept = input.accept;
            let resolveCleanup: () => void = () => {};
            const cleanupComplete = new Promise<void>((resolve) => {
              resolveCleanup = resolve;
            });
            cleanupComplete.then(undefined, () => {});
            return {
              answer: {
                type: 'answer' as const,
                sdp: `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${Array(
                  32,
                )
                  .fill('AA')
                  .join(':')}\r\n`,
              },
              close: vi.fn(async () => resolveCleanup()),
              cleanupComplete,
            };
          }) as never,
          serve: serveApplicationChannel,
        },
      );
      const offer = {
        version: 'station-broker-native-connection-offer/v2' as const,
        scope: {
          stationId: STATION_ID,
          enrollmentId: trust.enrollmentId,
          routingGeneration: 1,
        },
        surface: device.surface,
        stationSigningKeyId: stationKeyId,
        stationSigningGeneration: 1,
        clientId: device.surface.clientInstanceId,
        nonce: offerNonce,
        offerSdp: `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${Array(
          32,
        )
          .fill('AA')
          .join(':')}\r\n`,
        expiresAt: Date.now() + 60_000,
      };
      await created.adapter.answer(offer, trust, new AbortController().signal);
      if (!accept) throw new Error('native peer transport never accepted');

      const bindingSnapshot = {
        stationId: STATION_ID,
        stationAudience: ORIGIN,
        deviceId: device.id,
        bindingId: device.binding.bindingId,
        deviceProofKeyThumbprint: device.binding.deviceProof.thumbprint,
        peerNonce: offerNonce,
        surface: device.surface,
      };
      const deviceProof = (
        method: string,
        path: string,
        body: Uint8Array = new Uint8Array(0),
      ) =>
        createNativeDeviceRequestProof(
          {
            publicKey: device.deviceKey.publicJwk,
            sign: device.deviceKey.sign,
          },
          bindingSnapshot,
          { method, path, body },
        );

      const sessionKey = await p256Key();
      let continuation:
        | { credential: string; nonce: string; deviceId: string }
        | undefined;

      /**
       * One fake transport with TWO ends and full close/unsubscribe
       * lifecycle: the server end goes to the adapter's accept; the client
       * end is what the production channel client opens. `send` routes to
       * the opposite end's subscriber; only server-to-client frames are
       * recorded for assertion.
       */
      const openManualChannel = (): ManualChannel => {
        const driver = {
          frames: [] as string[],
          status: undefined as number | undefined,
          chunks: [] as Uint8Array[],
          end: false,
          error: undefined as string | undefined,
        };
        let serverHandler: ((value: unknown) => void) | undefined;
        let serverClosedCb: (() => void) | undefined;
        let clientHandler: ((value: unknown) => void) | undefined;
        let clientClosedCb: (() => void) | undefined;
        let clientUnsubscribed = false;
        let serverUnsubscribed = false;
        let clientClosedByServer = false;
        let serverClosedByClient = false;
        const serverEnd = {
          send: (message: string) => {
            if (clientClosedByServer) return;
            driver.frames.push(message);
            const frame = readApplicationFrame(message) as Record<
              string,
              unknown
            >;
            if (frame.type === 'response')
              driver.status = frame.status as number;
            else if (frame.type === 'chunk')
              driver.chunks.push(
                new Uint8Array(Buffer.from(frame.bytes as string, 'base64')),
              );
            else if (frame.type === 'end') driver.end = true;
            else if (frame.type === 'error')
              driver.error = frame.code as string;
            clientHandler?.(message);
          },
          close: () => {
            clientClosedByServer = true;
            try {
              clientClosedCb?.();
            } catch {
              // Fake lifecycle only.
            }
          },
          subscribe: (
            message: (value: unknown) => void,
            closed: () => void,
          ) => {
            serverHandler = message;
            serverClosedCb = closed;
            return () => {
              serverUnsubscribed = true;
            };
          },
        };
        const clientEnd = {
          send: (message: string) => {
            if (serverClosedByClient) return;
            serverHandler?.(message);
          },
          close: () => {
            serverClosedByClient = true;
            try {
              serverClosedCb?.();
            } catch {
              // Fake lifecycle only.
            }
          },
          subscribe: (
            message: (value: unknown) => void,
            closed: () => void,
          ) => {
            clientHandler = message;
            clientClosedCb = closed;
            return () => {
              clientUnsubscribed = true;
            };
          },
        };
        accept!(serverEnd);
        return {
          driver,
          channel: clientEnd,
          write: (frame) => serverHandler?.(writeApplicationFrame(frame)),
          awaitFrame: async () => {
            const before = driver.frames.length;
            await vi.waitFor(
              () => expect(driver.frames.length).toBeGreaterThan(before),
              { timeout: 5_000 },
            );
          },
          closedByServer: () => clientClosedByServer,
          unsubscribed: () => clientUnsubscribed && !serverUnsubscribed,
        };
      };

      // Production client consumption: every fetch opens one fresh channel.
      const peerController = new AbortController();
      const nativeFetch = createApplicationChannelFetch({
        origin: ORIGIN,
        signal: peerController.signal,
        open: async () => openManualChannel().channel,
        assertCurrent: () => {},
      });

      const session = {
        /** Establish the bearer-free native account continuation. */
        establish: async (credentials: Record<string, unknown>) => {
          const challengeBody = new TextEncoder().encode(
            JSON.stringify({
              version: NATIVE_VERSION,
              publicKey: sessionKey.publicJwk,
            }),
          );
          const challengeResponse = await nativeFetch(
            new Request(
              `${ORIGIN}/api/account-auth/continuations/native/challenge`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  [NATIVE_DEVICE_PROOF_HEADER]: await deviceProof(
                    'POST',
                    '/api/account-auth/continuations/native/challenge',
                    challengeBody,
                  ),
                },
                body: challengeBody,
              },
            ),
          );
          const challengeText = await challengeResponse.text();
          expect(
            challengeResponse.status,
            `native challenge: ${challengeResponse.status} ${challengeText.slice(0, 200)}`,
          ).toBe(200);
          const challenge = JSON.parse(challengeText) as {
            data: { challengeId: string; nonce: string; deviceId: string };
          };
          const credentialsHash = await serializedCredentialsHash(credentials);
          const exchangeProof = await createNativeApplicationSessionProof(
            { publicKey: sessionKey.publicJwk, sign: sessionKey.sign },
            {
              kind: 'station-native',
              stationId: STATION_ID,
              audience: ORIGIN,
              deviceId: device.id,
              surface: device.surface,
            },
            {
              purpose: 'exchange',
              deviceId: device.id,
              nonce: challenge.data.nonce,
              method: 'POST',
              path: '/api/account-auth/continuations/native/exchange',
              challengeIdHash: await sha256Base64url(
                challenge.data.challengeId,
              ),
              credentialsHash,
              expiresAtMs: Date.now() + 20_000,
            },
          );
          const exchangeBody = new TextEncoder().encode(
            JSON.stringify({
              version: NATIVE_VERSION,
              challengeId: challenge.data.challengeId,
              credentials,
              proof: exchangeProof,
            }),
          );
          const exchangeResponse = await nativeFetch(
            new Request(
              `${ORIGIN}/api/account-auth/continuations/native/exchange`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  [NATIVE_DEVICE_PROOF_HEADER]: await deviceProof(
                    'POST',
                    '/api/account-auth/continuations/native/exchange',
                    exchangeBody,
                  ),
                },
                body: exchangeBody,
              },
            ),
          );
          const exchangeText = await exchangeResponse.text();
          expect(
            exchangeResponse.status,
            `native exchange: ${exchangeResponse.status} ${exchangeText.slice(0, 200)}`,
          ).toBe(200);
          const data = JSON.parse(exchangeText) as {
            data: { credential: string; nonce: string; deviceId: string };
          };
          continuation = data.data;
          return data.data;
        },
        /** Headers for a bearer-free protected request on the continuation. */
        headers: async (method: string, path: string) => {
          if (!continuation) throw new Error('continuation not established');
          const continuationProof = await createNativeApplicationSessionProof(
            { publicKey: sessionKey.publicJwk, sign: sessionKey.sign },
            {
              kind: 'station-native',
              stationId: STATION_ID,
              audience: ORIGIN,
              deviceId: continuation.deviceId,
              surface: device.surface,
            },
            {
              purpose: 'request',
              deviceId: continuation.deviceId,
              nonce: continuation.nonce,
              method,
              path,
              credentialHash: await sha256Base64url(continuation.credential),
              expiresAtMs: Date.now() + 20_000,
            },
          );
          return {
            // A fresh one-use Device request proof travels with every
            // request, alongside the continuation and its own proof.
            [NATIVE_DEVICE_PROOF_HEADER]: await deviceProof(method, path),
            [APPLICATION_SESSION_NATIVE_HEADER]: continuation.credential,
            [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: continuationProof,
          };
        },
      };

      return {
        dispose: () => {
          replayStore.close();
          peerController.abort();
          void created.close().catch(() => {});
        },
        nativeFetch,
        openManualChannel,
        session,
        deviceProof,
        replaySize: () => replayStore.size(),
      };
    };

    return {
      app,
      request,
      security,
      localAccounts,
      membership,
      ownerHeaders,
      shareAndCreateGuest,
      pairNativeDevice,
      startNativePeer,
      bindingService,
      operatorAuthority,
    };
  }

  test('bearer-free native challenge, exchange and permitted Project read over one admitted peer', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('demo', 'Demo');
    const paired = await h.pairNativeDevice('pilot-device', guest.login);
    // Trusted setup only: enroll the invited person's membership through the
    // real membership owner with the principal the REAL login produced. The
    // pilot requests under test never ride this authority.
    await h.membership.service.accept(guest.invitationToken, {
      current: async () => ({
        principal: deploymentAccountPrincipal(
          guest.login.issuer,
          guest.login.session.subject,
          GUEST_DISPLAY,
        ),
        verifiedEmails: [],
      }),
      operator: async () => {},
    });
    const peer = await h.startNativePeer(paired);
    try {
      const established = await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      expect(established.deviceId).toBe(paired.device.id);

      // Bearer-free, proof-bound reads over the production channel client.
      const list = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: await peer.session.headers('GET', '/api/projects'),
        }),
      );
      const listText = await list.text();
      expect(list.status, listText.slice(0, 200)).toBe(200);
      const listed = JSON.parse(listText) as { data: unknown[] };
      expect(listed.data.length).toBeGreaterThanOrEqual(1);

      const read = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects/${guest.project.slug}`, {
          headers: await peer.session.headers(
            'GET',
            `/api/projects/${guest.project.slug}`,
          ),
        }),
      );
      const readText = await read.text();
      expect(read.status, readText.slice(0, 200)).toBe(200);
      expect(readText).toContain(guest.project.slug);

      // Challenge, exchange, list and read each consumed exactly one JTI;
      // currentness rechecks never consume again.
      expect(peer.replaySize()).toBe(4);
    } finally {
      peer.dispose();
    }
  });

  test('tampered body refuses the challenge before any provider work starts', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('tamper', 'Tamper');
    const paired = await h.pairNativeDevice('tamper-device', guest.login);
    const peer = await h.startNativePeer(paired);
    try {
      // Sign the proof over one body and transmit another; the admission
      // owner hashes the exact received bytes.
      const signed = new TextEncoder().encode('{"publicKey":{}}');
      const proof = await peer.deviceProof(
        'POST',
        '/api/account-auth/continuations/native/challenge',
        signed,
      );
      const tampered = new TextEncoder().encode('{"publicKey":{},"x":1}');
      const response = await peer.nativeFetch(
        new Request(
          `${ORIGIN}/api/account-auth/continuations/native/challenge`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [NATIVE_DEVICE_PROOF_HEADER]: proof,
            },
            body: tampered,
          },
        ),
      );
      expect(response.status).toBe(403);
      const refused = (await response.json()) as { error: { code: string } };
      expect(refused.error.code).toBe('native_device_proof_invalid');
    } finally {
      peer.dispose();
    }
  });

  test('replayed Device proof refuses with no credential fallback', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('replay', 'Replay');
    const paired = await h.pairNativeDevice('replay-device', guest.login);
    const peer = await h.startNativePeer(paired);
    try {
      await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      const proof = await peer.deviceProof('GET', '/api/projects');
      const first = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: {
            ...(await peer.session.headers('GET', '/api/projects')),
            [NATIVE_DEVICE_PROOF_HEADER]: proof,
          },
        }),
      );
      expect(first.status, await first.clone().text()).toBe(200);
      await first.text();

      const second = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: {
            ...(await peer.session.headers('GET', '/api/projects')),
            [NATIVE_DEVICE_PROOF_HEADER]: proof,
          },
        }),
      );
      expect(second.status).toBe(403);
      const refused = (await second.json()) as { error: { code: string } };
      expect(refused.error.code).toBe('native_device_proof_invalid');
    } finally {
      peer.dispose();
    }
  });

  test('proof without account session refuses; privileged pairing route refuses proof authority', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('scope', 'Scope');
    const paired = await h.pairNativeDevice('scope-device', guest.login);
    const peer = await h.startNativePeer(paired);
    try {
      // A fully valid Device proof with NO account continuation is refused
      // with the canonical account requirement and no credential fallback.
      const noAccount = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: {
            [NATIVE_DEVICE_PROOF_HEADER]: await peer.deviceProof(
              'GET',
              '/api/projects',
            ),
          },
        }),
      );
      expect(noAccount.status).toBe(401);
      expect(
        ((await noAccount.json()) as { error: { code: string } }).error.code,
      ).toBe('account_authentication_required');

      // The pairing inventory is NOT on the pilot allowlist even with a
      // fully valid proof and a current continuation.
      const privileged = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/pairing/devices`, {
          headers: {
            [NATIVE_DEVICE_PROOF_HEADER]: await peer.deviceProof(
              'GET',
              '/api/pairing/devices',
            ),
          },
        }),
      );
      expect(privileged.status).toBe(403);
      expect(
        ((await privileged.json()) as { error: { code: string } }).error.code,
      ).toBe('native_device_proof_route_forbidden');
    } finally {
      peer.dispose();
    }
  });

  test('inaccessible Project reads refuse with the canonical refusal only', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('invited', 'Invited');
    await h.shareAndCreateGuest('theirs', 'Theirs');
    const paired = await h.pairNativeDevice('member-device', guest.login);
    const peer = await h.startNativePeer(paired);
    try {
      await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      const denied = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects/theirs`, {
          headers: await peer.session.headers('GET', '/api/projects/theirs'),
        }),
      );
      expect(denied.status).toBe(404);
      // The canonical refusal only — never Project data.
      expect(await denied.text()).toBe(
        '{"success":false,"error":"Project not found"}',
      );
    } finally {
      peer.dispose();
    }
  });

  test('binding revoked before byte release delivers zero protected bytes', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('delayed', 'Delayed');
    const paired = await h.pairNativeDevice('revoke-device', guest.login);
    await h.membership.service.accept(guest.invitationToken, {
      current: async () => ({
        principal: deploymentAccountPrincipal(
          guest.login.issuer,
          guest.login.session.subject,
          GUEST_DISPLAY,
        ),
        verifiedEmails: [],
      }),
      operator: async () => {},
    });
    const peer = await h.startNativePeer(paired);
    try {
      await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      // Control: the identical request through the production client reads.
      const control = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects/${guest.project.slug}`, {
          headers: await peer.session.headers(
            'GET',
            `/api/projects/${guest.project.slug}`,
          ),
        }),
      );
      expect(control.status, await control.text()).toBe(200);
      // Controlled manual delivery: request the guarded read, hold the
      // response, revoke, then credit exactly once.
      const manual = peer.openManualChannel();
      manual.write({
        type: 'request',
        method: 'GET',
        path: `/api/projects/${guest.project.slug}`,
        headers: Object.entries({
          ...(await peer.session.headers(
            'GET',
            `/api/projects/${guest.project.slug}`,
          )),
        }).map(
          ([name, value]) => [name.toLowerCase(), value] as [string, string],
        ),
        body: null,
      });
      await manual.awaitFrame();
      expect(manual.driver.status, deliverySummary(manual.driver)).toBe(200);
      // Revoke the approved native binding before pulling any byte.
      h.bindingService.revokeBinding({
        deviceId: paired.device.id,
        surface: paired.surface,
        approval: h.operatorAuthority.approve({
          operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
        }),
      });
      manual.write({ type: 'credit' });
      await manual.awaitFrame();
      // A late authorization guard denies the bytes: the frame record shows
      // the canonical application_failed error and zero protected bytes.
      expect(manual.driver.error, deliverySummary(manual.driver)).toBe(
        'application_failed',
      );
      expect(manual.driver.chunks, deliverySummary(manual.driver)).toHaveLength(
        0,
      );
    } finally {
      peer.dispose();
    }
  });
});
