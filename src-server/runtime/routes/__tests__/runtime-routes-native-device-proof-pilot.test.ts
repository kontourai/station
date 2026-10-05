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
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import {
  NATIVE_DEVICE_PROOF_HEADER,
  NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH,
  NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
  type NativeDeviceProofSelfReceiptV1,
} from '@kontourai/station-contracts/native-device-proof';
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
import { z } from 'zod/v3';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
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
let guestUsernameCounter = 0;
const guestUsername = () => `pilotguest${++guestUsernameCounter}`;
const GUEST_PASSWORD = 'pilot-password-123';
const GUEST_DISPLAY = 'Pilot Guest';
const GUEST_GRANT = 'orchestration:read orchestration:operate';
const operatorApproval = { kind: 'presented-credential' } as const;
const NATIVE_VERSION = 'station.application-session-native/v1';

const makeTempDir = trackTempDirs();

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
  const parent = insideSharedRoot ? dirname(ambientRoot) : base;
  return makeTempDir(join(relative(base, parent), prefix));
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    directories.splice(0);
  });

  async function setup() {
    const owned = directories[directories.length - 1];
    const homeDir = join(owned, 'data');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700, recursive: true });
    const security = new EnvironmentSecurityService({ homeDir });
    const { credential: operatorCredential, environmentId: STATION_ID } =
      await security.initialize();

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

    let lastNativeRequest: Request | undefined;
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
        lastNativeRequest = request;
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
      nativeDeviceProofPilot: { ...pilot, authority: nativeAuthority },
      nativeDeviceProofBindings: bindingService,
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
      login:
        | Extract<
            Awaited<
              ReturnType<typeof localAccounts.service.loginVirtualSession>
            >,
            { kind: 'authenticated' }
          >
        | undefined,
      scope = GUEST_GRANT,
    ) => {
      const pairing = security.devicePairing;
      const offer = pairing.createOffer({
        endpoint: ORIGIN,
        scope,
      });
      const pending = pairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: name,
        requesterPosition: 'unproven',
        source: 'same-origin',
        ...(login
          ? {
              accountCandidate: {
                issuer: login.issuer,
                subject: login.session.subject,
                displayName: GUEST_DISPLAY,
              },
              accountCandidateSessionId: login.session.sessionId,
              requireAccountBinding: true as const,
            }
          : {}),
      });
      pairing.confirmRequest(
        pending.requestId,
        { ...operatorApproval },
        login
          ? {
              principalId: deploymentAccountPrincipal(
                login.issuer,
                login.session.subject,
                GUEST_DISPLAY,
              ).id,
              kind: 'account',
            }
          : undefined,
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
      const bindingId = randomUUID();
      const binding = bindingService.createBinding({
        bindingId,
        deviceId: device.id,
        surface,
        jwk: deviceKey.publicJwk,
        approval: operatorAuthority.approve({
          operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
          tuple: {
            operation: 'create',
            stationId: STATION_ID,
            deviceId: device.id,
            bindingId,
            surface,
            jwk: deviceKey.publicJwk,
          },
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
            queueMicrotask(() => {
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
            });
          },
          close: () => {
            clientClosedByServer = true;
            try {
              queueMicrotask(() => clientClosedCb?.());
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
            queueMicrotask(() => serverHandler?.(message));
          },
          close: () => {
            serverClosedByClient = true;
            try {
              queueMicrotask(() => serverClosedCb?.());
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
          write: (frame) => clientEnd.send(writeApplicationFrame(frame)),
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
            `native exchange: ${exchangeResponse.status} bytes=${exchangeText.length}`,
          ).toBe(200);
          const data = JSON.parse(exchangeText) as {
            data: { credential: string; nonce: string; deviceId: string };
          };
          continuation = data.data;
          return data.data;
        },
        /** Headers for a bearer-free protected request on the continuation. */
        headers: async (
          method: string,
          path: string,
          body: Uint8Array = new Uint8Array(0),
        ) => {
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
            [NATIVE_DEVICE_PROOF_HEADER]: await deviceProof(method, path, body),
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
        retire: async () => {
          peerController.abort();
          await created.close();
        },
        openManualChannel,
        session,
        deviceProof,
        replaySize: () => replayStore.size(),
      };
    };

    return {
      app,
      homeDir,
      request,
      security,
      localAccounts,
      applicationSessions,
      membership,
      ownerHeaders,
      shareAndCreateGuest,
      pairNativeDevice,
      startNativePeer,
      bindingService,
      operatorAuthority,
      nativeAuthority,
      lastNativeRequest: () => lastNativeRequest,
    };
  }

  test('mounted binding management requires operator authority and preserves Origin admission', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest(
      'binding-management',
      'Binding management',
    );
    const paired = await h.pairNativeDevice(
      'binding-management-device',
      guest.login,
    );
    const path = `/api/pairing/native-device-bindings/${paired.binding.bindingId}`;
    const owner = await h.request(path, h.ownerHeaders());
    expect(owner.status).toBe(200);
    expect(owner.headers.get('Cache-Control')).toBe('no-store');
    const readback = await owner.json();
    expect(readback).toMatchObject({
      data: {
        binding: { bindingId: paired.binding.bindingId },
        currentDeviceBinding: true,
      },
    });
    const deviceOnly = await h.request(path, {
      headers: { Authorization: `Bearer ${paired.credential}` },
    });
    expect(deviceOnly.status).toBeGreaterThanOrEqual(400);
    const body = JSON.stringify({
      operation: 'create',
      candidate: {
        version: 'station-native-device-binding-candidate/v1',
        stationId: paired.binding.stationId,
        deviceId: paired.device.id,
        bindingId: paired.binding.bindingId,
        surface: paired.surface,
        deviceProofJwk: paired.deviceKey.publicJwk,
        deviceProofKeyThumbprint: paired.binding.deviceProof.thumbprint,
      },
    });
    const refusedOrigin = await h.request(
      `${path}/approve`,
      h.ownerHeaders({
        method: 'POST',
        headers: {
          Origin: 'https://untrusted.example',
          'Content-Type': 'application/json',
        },
        body,
      }),
    );
    expect(refusedOrigin.status).toBe(403);
    const approved = await h.request(
      `${path}/approve`,
      h.ownerHeaders({
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body,
      }),
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      data: { binding: { bindingId: paired.binding.bindingId } },
    });
  });

  test('mounted self-receipt admits only its owning Device bearer before account sign-in', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('self-receipt', 'Self receipt');
    const paired = await h.pairNativeDevice('self-receipt-device', guest.login);
    const other = await h.pairNativeDevice('other-receipt-device', guest.login);
    const path = `${NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH}/${paired.binding.bindingId}/receipt`;
    const bearer = { Authorization: `Bearer ${paired.credential}` };
    const response = await h.request(path, { headers: bearer });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(
      await readJson<{ data: NativeDeviceProofSelfReceiptV1 }>(response),
    ).toEqual({
      data: {
        version: 'station-native-device-proof-self-receipt/v1',
        binding: {
          stationId: paired.binding.stationId,
          deviceId: paired.device.id,
          bindingId: paired.binding.bindingId,
          surface: paired.surface,
          deviceProofJwk: paired.deviceKey.publicJwk,
          deviceProofKeyThumbprint: paired.binding.deviceProof.thumbprint,
          state: 'active',
          createdAt: paired.binding.createdAt,
          approvedAt: paired.binding.approvedAt,
        },
        currentDeviceBinding: true,
      },
    });
    const head = await h.request(path, { method: 'HEAD', headers: bearer });
    expect(head.status).toBe(200);
    expect(head.headers.get('Cache-Control')).toBe('no-store');
    expect(await head.text()).toBe('');
    const foreign = await h.request(path, {
      headers: { Authorization: `Bearer ${other.credential}` },
    });
    const absent = await h.request(
      `${NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH}/${randomUUID()}/receipt`,
      { headers: bearer },
    );
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await foreign.json()).toEqual({
      error: {
        version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
        code: 'not_found',
      },
    });
    expect(await absent.json()).toEqual({
      error: {
        version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
        code: 'not_found',
      },
    });

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const refused = await h.request(path, { method, headers: bearer });
      expect(refused.status).toBe(401);
      await refused.body?.cancel();
    }
    for (const suffix of ['', '/extra', '/approve']) {
      const refused = await h.request(
        suffix === '' ? path.replace('/receipt', '') : `${path}${suffix}`,
        { headers: bearer },
      );
      expect(refused.status).toBe(401);
      await refused.body?.cancel();
    }
    const operator = await h.request(path, h.ownerHeaders());
    expect(operator.status).toBe(403);
    expect(await operator.json()).toEqual({
      error: {
        version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
        code: 'device_required',
      },
    });
    const cookie = await h.request(path, {
      headers: { Cookie: `__Host-station-device=${paired.credential}` },
    });
    expect(cookie.status).toBe(401);
    await cookie.body?.cancel();
    const login = await h.request('/api/account-auth/sign-in/username', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: guest.username,
        password: GUEST_PASSWORD,
      }),
    });
    expect(login.status).toBe(200);
    const accountCookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(accountCookie).not.toBe('');
    await login.body?.cancel();
    const accountOnly = await h.request(path, {
      headers: { Cookie: accountCookie },
    });
    expect(accountOnly.status).toBe(401);
    await accountOnly.body?.cancel();
    const proof = await h.request(path, {
      headers: { ...bearer, [NATIVE_DEVICE_PROOF_HEADER]: 'forged' },
    });
    expect(proof.status).toBe(403);
    await proof.body?.cancel();
    const plain = await h.pairNativeDevice('plain-self-receipt', undefined);
    const plainPath = `${NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH}/${plain.binding.bindingId}/receipt`;
    const plainBearer = await h.request(plainPath, {
      headers: { Authorization: `Bearer ${plain.credential}` },
    });
    expect(plainBearer.status).toBe(200);
    await plainBearer.body?.cancel();
    const plainCookie = await h.request(plainPath, {
      headers: { Cookie: `__Host-station-device=${plain.credential}` },
    });
    expect(plainCookie.status).toBe(403);
    expect(await plainCookie.json()).toEqual({
      error: {
        version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
        code: 'device_required',
      },
    });
    const offer = h.security.devicePairing.createOffer({
      endpoint: ORIGIN,
      kind: 'delegation',
    });
    const pending = h.security.devicePairing.requestPairing({
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'delegation-receipt',
      requesterPosition: 'unproven',
    });
    h.security.devicePairing.confirmRequest(
      pending.requestId,
      operatorApproval,
    );
    const delegated = h.security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    });
    const delegation = await h.request(path, {
      headers: { Authorization: `Bearer ${delegated.credential}` },
    });
    expect(delegation.status).toBe(403);
    expect(await delegation.json()).toEqual({
      error: {
        version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
        code: 'device_required',
      },
    });
    const approval = await h.request(
      `/api/pairing/native-device-bindings/${paired.binding.bindingId}/approve`,
      { method: 'POST', headers: bearer, body: '{}' },
    );
    expect(approval.status).toBe(403);
    await approval.body?.cancel();
  });

  test('self-receipt preserves exact historical revocation and derives currentness from current scope', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('self-history', 'Self history');
    const paired = await h.pairNativeDevice('self-history-device', guest.login);
    const read = (bindingId = paired.binding.bindingId) =>
      h.request(
        `${NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH}/${bindingId}/receipt`,
        { headers: { Authorization: `Bearer ${paired.credential}` } },
      );
    h.security.devicePairing.setDeviceScope(
      paired.device.id,
      ['orchestration:read'],
      operatorApproval,
    );
    const reduced = await read();
    expect(reduced.status).toBe(200);
    expect(await reduced.json()).toMatchObject({
      data: {
        binding: { bindingId: paired.binding.bindingId, state: 'active' },
        currentDeviceBinding: false,
      },
    });
    h.security.devicePairing.setDeviceScope(
      paired.device.id,
      ['orchestration:read', 'orchestration:operate'],
      operatorApproval,
    );
    const bindingId = randomUUID();
    const key = await p256Key();
    h.bindingService.createBinding({
      bindingId,
      deviceId: paired.device.id,
      surface: paired.surface,
      jwk: key.publicJwk,
      approval: h.operatorAuthority.approve({
        operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
        tuple: {
          operation: 'create',
          stationId: paired.binding.stationId,
          deviceId: paired.device.id,
          bindingId,
          surface: paired.surface,
          jwk: key.publicJwk,
        },
      }),
    });
    const replaced = await read();
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({
      data: {
        binding: {
          bindingId: paired.binding.bindingId,
          state: 'revoked',
          revocationReason: 'replaced',
        },
        currentDeviceBinding: false,
      },
    });
    const replacement = await read(bindingId);
    expect(replacement.status).toBe(200);
    expect(await replacement.json()).toMatchObject({
      data: {
        binding: { bindingId, state: 'active', deviceProofJwk: key.publicJwk },
        currentDeviceBinding: true,
      },
    });
    h.bindingService.revokeBinding({
      bindingId,
      deviceId: paired.device.id,
      surface: paired.surface,
      jwk: key.publicJwk,
      approval: h.operatorAuthority.approve({
        operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
        tuple: {
          operation: 'revoke',
          stationId: paired.binding.stationId,
          deviceId: paired.device.id,
          bindingId,
          surface: paired.surface,
          jwk: key.publicJwk,
        },
      }),
    });
    const revoked = await read(bindingId);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      data: {
        binding: {
          bindingId,
          state: 'revoked',
          revocationReason: 'operator-revoked',
        },
        currentDeviceBinding: false,
      },
    });
    h.security.devicePairing.revokeDevice(
      paired.device.id,
      'operator-credential',
    );
    const deviceRevoked = await read(bindingId);
    expect(deviceRevoked.status).toBe(401);
    await deviceRevoked.body?.cancel();
  });

  test.each(['revoke', 'scope', 'binding-scope', 'identity'] as const)(
    'self-receipt rechecks Device %s before publication',
    async (change) => {
      const h = await setup();
      const guest = await h.shareAndCreateGuest('self-race', 'Self race');
      const paired = await h.pairNativeDevice('self-race-device', guest.login);
      const other =
        change === 'identity'
          ? await h.pairNativeDevice('self-race-other', guest.login)
          : undefined;
      const original = h.bindingService.bindingReceiptForDevice.bind(
        h.bindingService,
      );
      vi.spyOn(h.bindingService, 'bindingReceiptForDevice').mockImplementation(
        (input) => {
          const result = original(input);
          if (change === 'revoke')
            h.security.devicePairing.revokeDevice(
              paired.device.id,
              'operator-credential',
            );
          else if (other)
            vi.spyOn(h.security, 'identifyDevice').mockReturnValue(
              other.device,
            );
          else if (change === 'binding-scope')
            h.security.devicePairing.setDeviceScope(
              paired.device.id,
              ['orchestration:read'],
              operatorApproval,
            );
          else
            h.security.devicePairing.setDeviceScope(
              paired.device.id,
              ['orchestration:operate'],
              operatorApproval,
            );
          return result;
        },
      );
      const response = await h.request(
        `${NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH}/${paired.binding.bindingId}/receipt`,
        { headers: { Authorization: `Bearer ${paired.credential}` } },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
          code: 'device_required',
        },
      });
    },
  );

  test('self-receipt refuses corrupt binding state as unavailable', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('self-corrupt', 'Self corrupt');
    const paired = await h.pairNativeDevice('self-corrupt-device', guest.login);
    writeFileSync(
      join(h.homeDir, 'security', 'native-device-proof-bindings.json'),
      '{',
      { mode: 0o600 },
    );
    const response = await h.request(
      `${NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH}/${paired.binding.bindingId}/receipt`,
      { headers: { Authorization: `Bearer ${paired.credential}` } },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
        code: 'unavailable',
      },
    });
  });

  test('current native Device may observe neutral Station identity and status before account login but cannot read Projects', async () => {
    vi.stubEnv('STATION_E2E_SYSTEM_STATUS_READY', '1');
    vi.stubEnv('STATION_BUILD_SHA', '081bfd979d9f3e180586bafb6b46130556ce5d60');
    vi.stubEnv('STATION_INSTANCE_ID', 'native-pilot-fixture');
    vi.stubEnv('STATION_BOOT_ID', 'native-pilot-fixture-boot');
    const h = await setup();
    const guest = await h.shareAndCreateGuest(
      'neutral-native',
      'Neutral native',
      'viewer',
    );
    const paired = await h.pairNativeDevice(
      'neutral-device',
      guest.login,
      'orchestration:read',
    );
    const peer = await h.startNativePeer(paired);
    try {
      const path = '/api/system/identity';
      const identity = await peer.nativeFetch(
        new Request(`${ORIGIN}${path}`, {
          headers: {
            [NATIVE_DEVICE_PROOF_HEADER]: await peer.deviceProof('GET', path),
          },
        }),
      );
      expect(identity.status).toBe(200);
      expect(await identity.json()).toMatchObject({
        instanceId: 'native-pilot-fixture',
        bootId: 'native-pilot-fixture-boot',
        sha: '081bfd979d9f3e180586bafb6b46130556ce5d60',
      });
      const statusPath = '/api/system/status';
      const status = await peer.nativeFetch(
        new Request(`${ORIGIN}${statusPath}`, {
          headers: {
            [NATIVE_DEVICE_PROOF_HEADER]: await peer.deviceProof(
              'GET',
              statusPath,
            ),
          },
        }),
      );
      expect(status.status).toBe(200);
      await status.body?.cancel();
      const project = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: {
            [NATIVE_DEVICE_PROOF_HEADER]: await peer.deviceProof(
              'GET',
              '/api/projects',
            ),
          },
        }),
      );
      expect(project.status).toBe(401);
      await project.text();
      expect(
        h.security.devicePairing.identifyDevice(paired.credential)?.id,
      ).toBe(paired.device.id);
    } finally {
      peer.dispose();
    }
  });

  test('mounted native HTTP invitation acceptance composes actual account and Device proof, then preserves Device across account401 and same-person reauthentication', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest(
      'native-http-invite',
      'Native HTTP invite',
      'viewer',
    );
    const paired = await h.pairNativeDevice(
      'native-http-device',
      guest.login,
      'orchestration:read',
    );
    const peer = await h.startNativePeer(paired);
    const path = '/api/account-auth/accept-invitation';
    const body = new TextEncoder().encode(
      JSON.stringify({ token: guest.invitationToken }),
    );
    try {
      const established = await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      const before = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: await peer.session.headers('GET', '/api/projects'),
        }),
      );
      expect(before.status).toBe(200);
      expect(
        z
          .object({ data: z.array(z.unknown()) })
          .passthrough()
          .parse(await before.json()).data,
      ).toEqual([]);
      const direct = await h.request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await peer.session.headers('POST', path, body)),
        },
        body,
      });
      expect(direct.status).toBe(403);
      for (const conflict of [
        { Origin: ORIGIN },
        { Cookie: 'untrusted=value' },
      ]) {
        const response = await peer.nativeFetch(
          new Request(`${ORIGIN}${path}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(await peer.session.headers('POST', path, body)),
              ...conflict,
            },
            body,
          }),
        );
        const errorText = await response.text();
        if ('Cookie' in conflict) {
          expect(response.status).toBe(400);
          expect(JSON.parse(errorText)).toEqual({
            error: { code: 'virtual_header_forbidden' },
          });
        } else expect(response.status, errorText).toBe(403);
      }
      const changed = new TextEncoder().encode(
        JSON.stringify({ token: 'X'.repeat(43) }),
      );
      const tampered = await peer.nativeFetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(await peer.session.headers('POST', path, body)),
          },
          body: changed,
        }),
      );
      expect(tampered.status).toBe(403);
      await tampered.text();
      const beforeOversize = h.lastNativeRequest();
      await expect(
        peer.nativeFetch(
          new Request(`${ORIGIN}${path}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(await peer.session.headers('POST', path, body)),
            },
            body: 'x'.repeat(16 * 1024 + 1),
          }),
        ),
      ).rejects.toThrow('Application request body exceeds 16 KiB pilot limit');
      expect(h.lastNativeRequest()).toBe(beforeOversize);
      const headers = {
        'Content-Type': 'application/json',
        ...(await peer.session.headers('POST', path, body)),
      };
      const accepted = await peer.nativeFetch(
        new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body }),
      );
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        data: {
          scope: { localProjectSlug: guest.project.slug },
          grantsDeviceAccess: false,
        },
      });
      const replay = await peer.nativeFetch(
        new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body }),
      );
      expect(replay.status).toBe(403);
      await replay.text();
      const read = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects/${guest.project.slug}`, {
          headers: await peer.session.headers(
            'GET',
            `/api/projects/${guest.project.slug}`,
          ),
        }),
      );
      expect(read.status).toBe(200);
      await read.text();
      const sessionStore = new DatabaseSync(
        join(h.homeDir, 'authentication', 'application-sessions.sqlite'),
        { readOnly: true },
      );
      let sessionId: string;
      try {
        const record = sessionStore
          .prepare(
            'SELECT record FROM application_session_native_sessions WHERE token_hash=?',
          )
          .get(await sha256Base64url(established.credential));
        if (typeof record?.record !== 'string')
          throw new Error('No actual native continuation record');
        const parsed = JSON.parse(record.record);
        if (typeof parsed.providerSessionId !== 'string')
          throw new Error('No actual provider session reference');
        sessionId = parsed.providerSessionId;
      } finally {
        sessionStore.close();
      }
      const account = await h.localAccounts.service.verifySessionReference(
        sessionId,
        new AbortController().signal,
      );
      if (account.kind !== 'authenticated')
        throw new Error('No real current account');
      await h.localAccounts.service.revokeSessionReference(
        sessionId,
        new AbortController().signal,
      );
      const revoked = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: await peer.session.headers('GET', '/api/projects'),
        }),
      );
      expect(revoked.status).toBe(401);
      expect(revoked.headers.get('X-Station-Authentication-Failure')).toBe(
        'account',
      );
      await revoked.text();
      expect(
        h.security.devicePairing.identifyDevice(paired.credential)?.id,
      ).toBe(paired.device.id);
      await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      const reauthenticated = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: await peer.session.headers('GET', '/api/projects'),
        }),
      );
      expect(reauthenticated.status).toBe(200);
      expect(
        z
          .object({ data: z.array(z.unknown()) })
          .passthrough()
          .parse(await reauthenticated.json()).data,
      ).toHaveLength(1);
      const revokePath = '/api/account-auth/continuations/native/revoke';
      const revokeBody = new TextEncoder().encode('{}');
      const revokeHeaders = {
        'Content-Type': 'application/json',
        ...(await peer.session.headers('POST', revokePath, revokeBody)),
      };
      const directRevoke = await h.request(revokePath, {
        method: 'POST',
        headers: revokeHeaders,
        body: revokeBody,
      });
      expect(directRevoke.status).toBe(403);
      await directRevoke.text();
      const logout = await peer.nativeFetch(
        new Request(`${ORIGIN}${revokePath}`, {
          method: 'POST',
          headers: revokeHeaders,
          body: revokeBody,
        }),
      );
      expect(logout.status).toBe(200);
      expect(await logout.json()).toEqual({ data: { revoked: true } });
      const replayLogout = await peer.nativeFetch(
        new Request(`${ORIGIN}${revokePath}`, {
          method: 'POST',
          headers: revokeHeaders,
          body: revokeBody,
        }),
      );
      expect(replayLogout.status).toBe(403);
      await replayLogout.text();
      const afterLogout = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: await peer.session.headers('GET', '/api/projects'),
        }),
      );
      expect(afterLogout.status).toBe(401);
      expect(afterLogout.headers.get('X-Station-Authentication-Failure')).toBe(
        'account',
      );
      await afterLogout.text();
      expect(
        h.security.devicePairing.identifyDevice(paired.credential)?.id,
      ).toBe(paired.device.id);
      await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      const afterReauth = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: await peer.session.headers('GET', '/api/projects'),
        }),
      );
      expect(afterReauth.status).toBe(200);
      await afterReauth.text();
      const providerFailure = vi
        .spyOn(h.localAccounts.service, 'revokeSessionReference')
        .mockRejectedValueOnce(new Error('unconfirmed provider outcome'));
      const uncertain = await peer.nativeFetch(
        new Request(`${ORIGIN}${revokePath}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(await peer.session.headers('POST', revokePath, revokeBody)),
          },
          body: revokeBody,
        }),
      );
      expect(uncertain.status).toBe(503);
      expect(await uncertain.json()).toEqual({
        error: { code: 'application_session_unavailable' },
      });
      providerFailure.mockRestore();
      const afterUncertain = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: await peer.session.headers('GET', '/api/projects'),
        }),
      );
      expect(afterUncertain.status).toBe(401);
      await afterUncertain.text();
      expect(
        h.security.devicePairing.identifyDevice(paired.credential)?.id,
      ).toBe(paired.device.id);
    } finally {
      peer.dispose();
    }
  });

  test('native remote logout withholds acknowledgment when the real Device binding retires during actual provider revocation', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest(
      'logout-retirement',
      'Logout retirement',
      'viewer',
    );
    const paired = await h.pairNativeDevice(
      'logout-device',
      guest.login,
      'orchestration:read',
    );
    const peer = await h.startNativePeer(paired);
    let resolveReached!: () => void;
    let resolveRelease!: () => void;
    const reached = new Promise<void>((resolve) => {
      resolveReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const original = h.localAccounts.service.revokeSessionReference.bind(
      h.localAccounts.service,
    );
    const barrier = vi
      .spyOn(h.localAccounts.service, 'revokeSessionReference')
      .mockImplementationOnce(async (id, signal) => {
        await original(id, signal);
        resolveReached();
        await release;
      });
    try {
      await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      const path = '/api/account-auth/continuations/native/revoke';
      const body = new TextEncoder().encode('{}');
      const pending = peer.nativeFetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(await peer.session.headers('POST', path, body)),
          },
          body,
        }),
      );
      await Promise.race([
        reached,
        pending.then(() => {
          throw new Error('provider barrier not reached');
        }),
      ]);
      h.bindingService.revokeBinding({
        bindingId: paired.binding.bindingId,
        deviceId: paired.device.id,
        surface: paired.surface,
        jwk: paired.deviceKey.publicJwk,
        approval: h.operatorAuthority.approve({
          operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
          tuple: {
            operation: 'revoke',
            stationId: paired.binding.stationId,
            deviceId: paired.device.id,
            bindingId: paired.binding.bindingId,
            surface: paired.surface,
            jwk: paired.deviceKey.publicJwk,
          },
        }),
      });
      resolveRelease();
      const response = await pending;
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: 'application_session_invalid' },
      });
      expect(
        h.security.devicePairing.identifyDevice(paired.credential)?.id,
      ).toBe(paired.device.id);
    } finally {
      resolveRelease();
      barrier.mockRestore();
      peer.dispose();
    }
  });

  test('mounted native invitation cannot combine one real person continuation with another account-bound Device', async () => {
    const h = await setup();
    const alice = await h.shareAndCreateGuest(
      'native-alice',
      'Alice Project',
      'viewer',
    );
    const bob = await h.shareAndCreateGuest(
      'native-bob',
      'Bob Project',
      'viewer',
    );
    const aliceDevice = await h.pairNativeDevice(
      'alice-device',
      alice.login,
      'orchestration:read',
    );
    const bobDevice = await h.pairNativeDevice(
      'bob-device',
      bob.login,
      'orchestration:read',
    );
    const a = await h.startNativePeer(aliceDevice),
      b = await h.startNativePeer(bobDevice);
    const path = '/api/account-auth/accept-invitation';
    const body = new TextEncoder().encode(
      JSON.stringify({ token: alice.invitationToken }),
    );
    try {
      await a.session.establish({
        username: alice.username,
        password: GUEST_PASSWORD,
      });
      await b.session.establish({
        username: bob.username,
        password: GUEST_PASSWORD,
      });
      const foreign = await b.session.headers('POST', path, body);
      const own = await a.session.headers('POST', path, body);
      const response = await a.nativeFetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...foreign,
            [NATIVE_DEVICE_PROOF_HEADER]: own[NATIVE_DEVICE_PROOF_HEADER],
          },
          body,
        }),
      );
      expect(response.status).toBe(401);
      await response.text();
      const unread = await a.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: await a.session.headers('GET', '/api/projects'),
        }),
      );
      expect(unread.status).toBe(200);
      expect(
        z
          .object({ data: z.array(z.unknown()) })
          .passthrough()
          .parse(await unread.json()).data,
      ).toEqual([]);
      expect(
        h.security.devicePairing.identifyDevice(aliceDevice.credential)?.id,
      ).toBe(aliceDevice.device.id);
      expect(
        h.security.devicePairing.identifyDevice(bobDevice.credential)?.id,
      ).toBe(bobDevice.device.id);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

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

  test('retiring the admitted peer makes the exact Request principal and shared resolver stale', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('peer-current', 'Peer current');
    const paired = await h.pairNativeDevice('peer-current-device', guest.login);
    const peer = await h.startNativePeer(paired);
    try {
      await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      const held = peer.openManualChannel();
      held.write({
        type: 'request',
        method: 'GET',
        path: '/api/projects',
        headers: Object.entries(
          await peer.session.headers('GET', '/api/projects'),
        ).map(([name, value]) => [name.toLowerCase(), value]),
        body: null,
      });
      await held.awaitFrame();
      expect(held.driver.status, deliverySummary(held.driver)).toBe(200);
      const request = h.lastNativeRequest();
      if (!request)
        throw new Error('native service never received the admitted Request');
      expect(h.nativeAuthority.resolveCurrent(request)?.deviceId).toBe(
        paired.device.id,
      );
      await peer.retire();
      expect(
        readVerifiedNativeVirtualApplicationRequest(request),
      ).toBeUndefined();
      expect(h.nativeAuthority.resolveCurrent(request)).toBeUndefined();
    } finally {
      peer.dispose();
    }
  });

  test('invalid proofs from one verified installation cannot rate-limit a different peer installation', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest(
      'rate-isolation',
      'Rate isolation',
    );
    const first = await h.pairNativeDevice('rate-first', guest.login);
    const second = await h.pairNativeDevice('rate-second', guest.login);
    const a = await h.startNativePeer(first);
    const b = await h.startNativePeer(second);
    try {
      const invalid = async (peer: typeof a) => {
        const parts = (await peer.deviceProof('GET', '/api/projects')).split(
          '.',
        );
        const claims = JSON.parse(
          Buffer.from(parts[1]!, 'base64url').toString(),
        );
        claims.deviceId = second.device.id; // Unverified selectors cannot poison this Device's budget.
        parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
        const signature = Buffer.from(parts[2]!, 'base64url');
        signature[0] ^= 1;
        parts[2] = signature.toString('base64url');
        return peer.nativeFetch(
          new Request(`${ORIGIN}/api/projects`, {
            headers: { [NATIVE_DEVICE_PROOF_HEADER]: parts.join('.') },
          }),
        );
      };
      let limited = false;
      for (let attempt = 0; attempt < 32; attempt++) {
        const response = await invalid(a);
        await response.text();
        if (response.status === 429) {
          limited = true;
          break;
        }
        expect(response.status).toBe(403);
      }
      expect(limited).toBe(true);
      const independent = await invalid(b);
      expect(independent.status, await independent.text()).toBe(403);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  test('verified Device failures are limited without charging another Device', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest(
      'verified-budget',
      'Verified budget',
    );
    const a = await h.startNativePeer(
      await h.pairNativeDevice('verified-budget-a', guest.login),
    );
    const b = await h.startNativePeer(
      await h.pairNativeDevice('verified-budget-b', guest.login),
    );
    try {
      const noAccount = async (peer: typeof a) =>
        peer.nativeFetch(
          new Request(`${ORIGIN}/api/projects`, {
            headers: {
              [NATIVE_DEVICE_PROOF_HEADER]: await peer.deviceProof(
                'GET',
                '/api/projects',
              ),
            },
          }),
        );
      let limited = false;
      for (let attempt = 0; attempt < 32; attempt++) {
        const response = await noAccount(a);
        await response.text();
        if (response.status === 429) {
          limited = true;
          break;
        }
        expect(response.status).toBe(401);
      }
      expect(limited).toBe(true);
      const independent = await noAccount(b);
      expect(independent.status, await independent.text()).toBe(401);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  test('scope withdrawn during real provider verification refuses the admitted Project read', async () => {
    const h = await setup();
    const guest = await h.shareAndCreateGuest('scope-await', 'Scope await');
    const paired = await h.pairNativeDevice(
      'scope-await-device',
      guest.login,
      'orchestration:operate',
    );
    const changeScope = async (scope: string[]) => {
      const response = await h.request(
        `/api/pairing/devices/${paired.device.id}/scope`,
        h.ownerHeaders({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope }),
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
    };
    await changeScope(['orchestration:read', 'orchestration:operate']);
    const peer = await h.startNativePeer(paired);
    try {
      await peer.session.establish({
        username: guest.username,
        password: GUEST_PASSWORD,
      });
      const verify = h.localAccounts.service.verifySessionReference.bind(
        h.localAccounts.service,
      );
      let withdrew = false;
      vi.spyOn(
        h.localAccounts.service,
        'verifySessionReference',
      ).mockImplementation(async (...args) => {
        const result = await verify(...args);
        if (!withdrew) {
          withdrew = true;
          await changeScope(['orchestration:operate']);
        }
        return result;
      });
      const response = await peer.nativeFetch(
        new Request(`${ORIGIN}/api/projects`, {
          headers: await peer.session.headers('GET', '/api/projects'),
        }),
      );
      expect(response.status).toBe(401);
      expect(await response.text()).toContain(
        'account_authentication_required',
      );
      expect(withdrew).toBe(true);
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

  test.each(['binding', 'device', 'provider', 'member', 'peer'] as const)(
    '%s revoked before byte release delivers zero protected bytes',
    async (retired) => {
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
        const logins = vi.spyOn(h.localAccounts.service, 'loginVirtualSession');
        await peer.session.establish({
          username: guest.username,
          password: GUEST_PASSWORD,
        });
        const login = await logins.mock.results.at(-1)?.value;
        if (login?.kind !== 'authenticated')
          throw new Error(
            'native exchange did not establish a real provider session',
          );
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
        if (retired === 'binding') {
          // Revoke the approved native binding before pulling any byte.
          h.bindingService.revokeBinding({
            bindingId: paired.binding.bindingId,
            deviceId: paired.device.id,
            surface: paired.surface,
            jwk: paired.deviceKey.publicJwk,
            approval: h.operatorAuthority.approve({
              operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
              tuple: {
                operation: 'revoke',
                stationId: paired.binding.stationId,
                deviceId: paired.device.id,
                bindingId: paired.binding.bindingId,
                surface: paired.surface,
                jwk: paired.deviceKey.publicJwk,
              },
            }),
          });
        } else if (retired === 'device') {
          const response = await h.request(
            `/api/pairing/devices/${paired.device.id}`,
            h.ownerHeaders({ method: 'DELETE' }),
          );
          expect(response.status).toBe(200);
          await response.text();
        } else if (retired === 'provider') {
          await h.localAccounts.service.revokeSessionReference(
            login.session.sessionId,
            new AbortController().signal,
          );
        } else if (retired === 'member') {
          const administration = await h.request(
            `/api/projects/${guest.project.slug}/access`,
            h.ownerHeaders(),
          );
          expect(administration.status).toBe(200);
          const { data } = await readJson<{
            data: import('@kontourai/station-contracts/project-membership').ProjectAccessAdministrationView;
          }>(administration);
          const member = data.members.find(
            (entry) => entry.principal.id === login.principal.id,
          );
          if (!member) throw new Error('real invited member not found');
          const revoked = await h.request(
            `/api/projects/${guest.project.slug}/access/members`,
            h.ownerHeaders({
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                scope: data.scope,
                principalId: member.principal.id,
                revision: member.revision,
                role: member.role,
                status: 'revoked',
              }),
            }),
          );
          expect(revoked.status).toBe(200);
          await revoked.text();
        } else {
          await peer.retire();
          expect(manual.closedByServer()).toBe(true);
          expect(
            manual.driver.chunks,
            deliverySummary(manual.driver),
          ).toHaveLength(0);
          return;
        }
        manual.write({ type: 'credit' });
        await manual.awaitFrame();
        // A late authorization guard denies the bytes: the frame record shows
        // the canonical application_failed error and zero protected bytes.
        expect(manual.driver.error, deliverySummary(manual.driver)).toBe(
          'application_failed',
        );
        expect(
          manual.driver.chunks,
          deliverySummary(manual.driver),
        ).toHaveLength(0);
      } finally {
        peer.dispose();
      }
    },
  );
});
