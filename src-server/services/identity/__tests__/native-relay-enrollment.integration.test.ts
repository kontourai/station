import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from '@hpke/core';
import {
  type ApplicationChannel,
  createApplicationChannelFetch,
  serveApplicationChannel,
} from '@kontourai/station-connect/application-channel';
import {
  NATIVE_RELAY_ENROLLMENT_BASE_PATH as BASE,
  NATIVE_RELAY_ENROLLMENT_PATHS,
  type NativeRelayEnrollmentChallenge,
  type NativeRelayEnrollmentDelivery,
  NATIVE_RELAY_ENROLLMENT_VERSION as VERSION,
} from '@kontourai/station-contracts/native-relay-enrollment';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import {
  CompactSign,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import {
  createNativeRelayEnrollmentOperatorRoutes,
  createNativeRelayEnrollmentRoutes,
} from '../../../routes/system/native-relay-enrollment-routes.js';
import { createNativeRelaySurfaceRoutes } from '../../../routes/system/native-relay-surface-routes.js';
import { createRelayManagementRoutes } from '../../../routes/system/relay-management-routes.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { captureRelayManagementActor } from '../../../security/relay-management-actor.js';
import {
  captureRelayManagementApproval,
  hasRelayManagementAuthority,
} from '../../../security/relay-management-authority.js';
import { NativeSurfaceRegistry } from '../../connections/native-surface-registry.js';
import {
  createResolvedNativeV2PionApplicationAdapter,
  readVerifiedNativePionApplicationRequest,
} from '../../connections/native-v2-pion-application-adapter.js';
import type { startPionApplicationAdapter } from '../../connections/pion-application-adapter.js';
import { VirtualApplicationIngress } from '../../connections/virtual-application.js';
import { ProjectManifestStore } from '../../projects/project-manifest-store.js';
import { ProjectMembershipService } from '../../projects/project-membership-service.js';
import { ProjectMembershipStore } from '../../projects/project-membership-store.js';
import { ProjectService } from '../../projects/project-service.js';
import { NativeRelayEnrollmentJournal } from '../../relay/native-relay-enrollment-journal.js';
import { ConnectionSigningKeyStore } from '../../ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { NativeDeviceProofBindingService } from '../../ssh/native-device-proof-binding-service.js';
import { loadLocalAccounts } from '../local-account-runtime.js';
import {
  nativeEnrollmentCanonical,
  nativeEnrollmentPayloadDigest,
} from '../native-relay-enrollment-schema.js';
import { NativeRelayEnrollmentService } from '../native-relay-enrollment-service.js';

const makeTempDir = trackTempDirs();
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});
const ORIGIN = 'https://native-station.example';
const OFFER = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}\r\n`;
const ANSWER = OFFER.replaceAll('AA', 'BB');
const opaque = () => randomBytes(32).toString('base64url');
class Channel implements ApplicationChannel {
  other!: Channel;
  listeners = new Set<(value: unknown) => void>();
  closedListeners = new Set<() => void>();
  closed = false;
  send(value: string) {
    if (this.closed) throw new Error('closed');
    queueMicrotask(() => {
      for (const listener of this.other.listeners) listener(value);
    });
  }
  subscribe(message: (value: unknown) => void, closed: () => void) {
    this.listeners.add(message);
    this.closedListeners.add(closed);
    return () => {
      this.listeners.delete(message);
      this.closedListeners.delete(closed);
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.other.closed = true;
    for (const closed of this.closedListeners) closed();
    for (const closed of this.other.closedListeners) closed();
  }
}
function pair() {
  const client = new Channel(),
    server = new Channel();
  client.other = server;
  server.other = client;
  return { client, server };
}
async function fixture(initialGeneration = 1, actorRefresh = () => true) {
  const home = makeTempDir('native-enrollment-integration-');
  const security = new EnvironmentSecurityService({ homeDir: home });
  const { environmentId: stationId, credential: operator } =
    await security.initialize();
  const signing = new ConnectionSigningKeyStore(home);
  const trust = await signing.initialize();
  const registry = new NativeSurfaceRegistry(home, stationId);
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  const projects = new ProjectService(storage, manifests);
  const project = await projects.createProject({
    name: 'Shared Example',
    slug: 'shared-example',
  });
  const db = new DatabaseSync(join(home, 'membership.sqlite'));
  const members = new ProjectMembershipStore(db, stationId);
  const membership = new ProjectMembershipService(
    stationId,
    storage,
    manifests,
    members,
  );
  const owner = humanPrincipal('fixture', 'casey', 'Casey');
  const ownerAuthority = {
    current: async () => ({ principal: owner, verifiedEmails: [] }),
    operator: async () => {
      if (!security.verifyOperatorCredential(operator))
        throw new Error('operator retired');
    },
  };
  const access = await membership.enable(
    project.slug,
    project.id,
    ownerAuthority,
  );
  const invite = await membership.invite(
    access.scope,
    {
      email: null,
      role: 'viewer',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    ownerAuthority,
  );
  const accounts = await loadLocalAccounts(
    { publicOrigin: ORIGIN },
    { stationId, homeDirectory: home },
    membership,
  );
  const pairing = security.devicePairing;
  const bindings = new NativeDeviceProofBindingService({
    homeDir: home,
    pairing,
  });
  const journal = new NativeRelayEnrollmentJournal(
    join(home, 'authentication', 'native-enrollment.sqlite'),
    stationId,
  );
  const service = new NativeRelayEnrollmentService({
    stationId,
    origin: ORIGIN,
    registry,
    journal,
    pairing,
    bindings,
    authentication: accounts.service,
    signing,
    operatorSecurity: security,
    now: () => Date.now(),
  });
  const actorCurrency = (
    request: Request,
    actor: import('@kontourai/station-contracts/principal').PrincipalRef,
  ) => {
    const base = captureRelayManagementActor(
      request,
      actor,
      pairing,
      accounts.service,
    );
    return {
      current: base.current,
      refresh: async () => actorRefresh() && (await base.refresh()),
    };
  };
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    } as never,
    eventBus: { emit: vi.fn() } as never,
    security: {
      nativeEnrollment: service,
      deploymentAuthentication: accounts.service,
      verifyCredential: (c) => security.verifyCredential(c),
      recognizeCredential: (c) => security.verifyCredential(c),
      resolveGrantedScope: (c) => security.resolveGrantedScope(c),
      resolveCredentialAuthority: (c) =>
        security.verifyOperatorCredential(c)
          ? 'operator-credential'
          : pairing.identifyDevice(c)
            ? 'device-credential'
            : undefined,
      allowedOrigins: [ORIGIN],
    },
  });
  const routes = createNativeRelayEnrollmentRoutes(service);
  for (const path of NATIVE_RELAY_ENROLLMENT_PATHS)
    app.post(path, (c) => routes.fetch(c.req.raw));
  app.route(
    '/api/relay-management',
    createRelayManagementRoutes({
      registry,
      enrollment: service,
      resolveActor: createOrchestrationRequestPrincipalResolver({
        environmentSecurityService: security,
        deploymentAuthentication: accounts.service,
      }),
      actorCurrency,
      captureDecision: (request, subjectId, actor) =>
        captureRelayManagementApproval(
          request,
          subjectId,
          security,
          pairing,
          actor,
          actorCurrency(request, actor),
        ),
      owner: {
        describe: async () => {
          throw new Error('Unused broker boundary');
        },
        prepare: async () => {
          throw new Error('Unused broker boundary');
        },
        issueNativeInvitation: async () => {
          throw new Error('Unused broker boundary');
        },
      },
      isManager: (request) =>
        hasRelayManagementAuthority(request, security, pairing),
    }),
  );
  app.route(
    '/api/pairing/native-relay-surfaces',
    createNativeRelaySurfaceRoutes({ registry, security }),
  );
  app.route(
    '/api/pairing/native-relay-enrollments',
    createNativeRelayEnrollmentOperatorRoutes(service),
  );
  const surface = {
    kind: 'station-native' as const,
    appIdentifier: 'io.kontourai.station.nightly',
    channel: 'nightly' as const,
    clientInstanceId: randomUUID(),
    keyThumbprint: opaque(),
  };
  const scope = {
    stationId,
    enrollmentId: trust.enrollmentId,
    routingGeneration: initialGeneration,
  };
  const operatorPost = (path: string, body: unknown, bearer = operator) =>
    app.request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
  const approved = await operatorPost('/api/pairing/native-relay-surfaces', {
    operation: 'approve',
    tuple: { scope, surface },
  });
  expect(approved.status, await approved.clone().text()).toBe(200);
  const ingress = new VirtualApplicationIngress(
    ORIGIN,
    undefined,
    readVerifiedNativePionApplicationRequest,
  );
  ingress.bind(app);
  const application = ingress.activate();
  let accept: ((channel: ApplicationChannel) => void) | undefined;
  const start: typeof startPionApplicationAdapter = async (input) => {
    accept = input.accept;
    let resolve!: () => void;
    const cleanupComplete = new Promise<void>((done) => (resolve = done));
    input.signal.addEventListener('abort', resolve, { once: true });
    return {
      answer: { type: 'answer', sdp: ANSWER },
      provenance: {
        pionWebrtc: 'v4.0.13',
        goVersion: 'go1.24.5',
        executableSha256: '0'.repeat(64),
      },
      peer: {
        close: async () => resolve(),
        getSelectedCandidatePair: () => null,
      },
      diagnostics: () => null,
      readMessages: () => [],
      cleanupComplete,
      close: async () => resolve(),
    };
  };
  const resolved = createResolvedNativeV2PionApplicationAdapter(
    {
      registry,
      applicationOrigin: ORIGIN,
      application,
      executable: '/test-pion',
      certificatePem: 'synthetic certificate',
      privateKeyPem: 'synthetic key',
      turn: { url: 'turn:localhost:3478', username: 'test', password: 'test' },
      trust: {
        current: () => signing.readDescriptor(),
        isCurrent: (value) =>
          nativeEnrollmentCanonical(signing.readDescriptor()) ===
          nativeEnrollmentCanonical(value),
      },
      issuer: signing.createIssuer(() => true),
    },
    { startAdapter: start, serve: serveApplicationChannel },
  );
  let transportScope = scope;
  let transportSurface = surface;
  async function replaceTransport(generation: number, installation = surface) {
    const next = { ...scope, routingGeneration: generation };
    if (
      !registry
        .approvedSurfaces()
        .some(
          (approval) =>
            nativeEnrollmentCanonical(approval.scope) ===
              nativeEnrollmentCanonical(next) &&
            nativeEnrollmentCanonical(approval.surface) ===
              nativeEnrollmentCanonical(installation),
        )
    ) {
      const approved = await operatorPost(
        '/api/pairing/native-relay-surfaces',
        {
          operation: 'approve',
          tuple: { scope: next, surface: installation },
        },
      );
      expect(approved.status, await approved.clone().text()).toBe(200);
    }
    transportScope = next;
    transportSurface = installation;
  }
  async function exchange(path: string, body: unknown, nonce = opaque()) {
    const captured = registry
      .approvedSurfaces()
      .find(
        (approval) =>
          nativeEnrollmentCanonical(approval.scope) ===
            nativeEnrollmentCanonical(transportScope) &&
          nativeEnrollmentCanonical(approval.surface) ===
            nativeEnrollmentCanonical(transportSurface),
      );
    if (!captured) throw new Error('transport approval missing');
    const descriptor = signing.readDescriptor()!;
    const { stationConnectionSigningKeyId } = await import(
      '@kontourai/station-shared/connection-proof'
    );
    await resolved.adapter.answer(
      {
        version: 'station-broker-native-connection-offer/v2',
        scope: transportScope,
        surface: transportSurface,
        stationSigningKeyId: await stationConnectionSigningKeyId(descriptor),
        stationSigningGeneration: descriptor.generation,
        clientId: transportSurface.clientInstanceId,
        nonce,
        offerSdp: OFFER,
        expiresAt: Date.now() + 60000,
      },
      descriptor,
      new AbortController().signal,
      captured,
    );
    const channel = pair();
    if (!accept) throw new Error('no accepted channel');
    accept(channel.server);
    const fetch = createApplicationChannelFetch({
      origin: ORIGIN,
      signal: new AbortController().signal,
      open: async () => channel.client,
      assertCurrent: () => {
        if (!captured.isCurrent()) throw new Error('surface retired');
      },
    });
    const response = await fetch(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: nativeEnrollmentCanonical(body),
    });
    const raw = await response.text();
    return { response, raw, data: JSON.parse(raw), nonce };
  }
  cleanup.push(async () => {
    await resolved.close();
    ingress.stop();
    await service.close();
    await accounts.service.close();
    registry.close();
    db.close();
  });
  const device = await generateKeyPair('ES256', { extractable: true });
  const publicDevice = await exportJWK(device.publicKey);
  const publicJwk = {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: publicDevice.x!,
    y: publicDevice.y!,
  };
  const recipient = await generateKeyPair('ES256', { extractable: true });
  const recipientJwk = await exportJWK(recipient.publicKey);
  const recipientPoint = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(recipientJwk.x!, 'base64url'),
    Buffer.from(recipientJwk.y!, 'base64url'),
  ]);
  const genesis = opaque();
  const begun = await exchange(`${BASE}/begin`, {
    version: VERSION,
    clientAttemptId: opaque(),
    peerNonce: genesis,
    expiresAt: Date.now() + 300000,
    recipient: {
      suite: { kem: 16, kdf: 1, aead: 1 },
      publicKey: recipientPoint.toString('base64url'),
    },
  });
  expect(begun.response.status, begun.raw).toBe(200);
  const challenge = begun.data as NativeRelayEnrollmentChallenge;
  expect(challenge.peerNonce).toBe(genesis);
  expect(challenge.responsePeerNonce).toBe(begun.nonce);
  const candidate = {
    version: 'station-native-device-binding-candidate/v1' as const,
    stationId,
    deviceId: challenge.reservedDeviceId,
    bindingId: randomUUID(),
    surface,
    deviceProofJwk: publicJwk,
    deviceProofKeyThumbprint: await calculateJwkThumbprint(publicJwk, 'sha256'),
  };
  async function proved(
    purpose: string,
    payload: Record<string, unknown>,
    nonce = opaque(),
    activationNonce = challenge.nonce,
    jti = opaque(),
  ) {
    const {
      stationProof: _,
      version: __,
      nonce: ___,
      expiresAt: ____,
      clientAttemptId: _____,
      responsePeerNonce: ______,
      requestedScope: _______,
      registrationAvailable: ________,
      stationSigningGeneration: _________,
      ...binding
    } = challenge;
    const iat = Math.floor(Date.now() / 1000);
    const proof = await new CompactSign(
      new TextEncoder().encode(
        nativeEnrollmentCanonical({
          ...binding,
          peerNonce: nonce,
          version: VERSION,
          requestedScope: 'orchestration:read',
          purpose,
          candidate,
          nonce: activationNonce,
          htm: 'POST',
          htu: `${BASE}/${purpose}`,
          payloadSha256: nativeEnrollmentPayloadDigest(payload),
          jti,
          iat,
          exp: iat + 30,
        }),
      ),
    )
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'station-native-relay-enrollment+jwt',
      })
      .sign(device.privateKey);
    return exchange(`${BASE}/${purpose}`, { ...payload, proof }, nonce);
  }
  async function registered() {
    const pending = await proved('register', {
      enrollmentId: challenge.enrollmentId,
      candidate,
      credentials: {
        username: 'zach',
        password: 'Native invitation fixture password',
      },
      invitation: invite.token,
      name: 'Zach',
    });
    expect(pending.response.status, pending.raw).toBe(200);
    const record = journal.get(challenge.enrollmentId)!;
    const retried = await proved('register', {
      enrollmentId: challenge.enrollmentId,
      candidate,
      credentials: {
        username: 'zach',
        password: 'Native invitation fixture password',
      },
      invitation: invite.token,
      name: 'Zach',
    });
    expect(retried.response.status, retried.raw).toBe(200);
    expect(journal.get(challenge.enrollmentId)?.providerSessionId).toBe(
      record.providerSessionId,
    );
    expect(
      (
        await accounts.service.verifySessionReference(
          record.providerSessionId!,
          new AbortController().signal,
        )
      ).kind,
    ).toBe('invalid');
    expect(
      pairing.resolveActiveRelayEnrollmentDevice(
        candidate.deviceId,
        challenge.enrollmentId,
      ),
    ).toBeNull();
    expect(
      (
        await operatorPost(
          `/api/pairing/native-relay-enrollments/${challenge.enrollmentId}/approve`,
          { candidate },
          'not-operator',
        )
      ).status,
    ).toBe(401);
    const approved = await operatorPost(
      `/api/pairing/native-relay-enrollments/${challenge.enrollmentId}/approve`,
      { candidate },
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
    const delivered = await proved('finalize', {
      enrollmentId: challenge.enrollmentId,
    });
    expect(delivered.response.status, delivered.raw).toBe(200);
    return delivered.data as NativeRelayEnrollmentDelivery;
  }
  const activate = (delivery: NativeRelayEnrollmentDelivery) =>
    proved(
      'activate',
      {
        enrollmentId: challenge.enrollmentId,
        deviceId: candidate.deviceId,
        bindingId: candidate.bindingId,
        activationNonce: delivery.activationNonce,
        bundleDigest: delivery.bundleDigest,
      },
      opaque(),
      delivery.activationNonce,
    );
  return {
    app,
    operatorPost,
    service,
    security,
    signing,
    registry,
    pairing,
    bindings,
    journal,
    accounts,
    membership,
    project,
    invite,
    challenge,
    candidate,
    recipient,
    proved,
    registered,
    activate,
    exchange,
    replaceTransport,
  };
}

test('fresh native registration uses actual Project invitation/provider/operator/Device owners, seals credential and recovers ACK on a new peer', async () => {
  const h = await fixture();
  const direct = await h.app.request(`${ORIGIN}${BASE}/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pion-Verified': 'true' },
    body: '{}',
  });
  expect(direct.status).toBe(403);
  const invalid = await h.proved('register', {
    enrollmentId: h.challenge.enrollmentId,
    candidate: h.candidate,
    credentials: {
      username: 'zach',
      password: 'Native invitation fixture password',
    },
    invitation: opaque(),
  });
  expect(invalid.response.status).toBe(400);
  // The failed provider attempt is terminal. Use a distinct real allocation for the successful invitation journey.
  const successful = await fixture();
  const delivery = await successful.registered();
  const jti = opaque();
  const once = await successful.proved(
    'status',
    { enrollmentId: successful.challenge.enrollmentId },
    opaque(),
    successful.challenge.nonce,
    jti,
  );
  expect(once.response.status, once.raw).toBe(200);
  const replay = await successful.proved(
    'status',
    { enrollmentId: successful.challenge.enrollmentId },
    opaque(),
    successful.challenge.nonce,
    jti,
  );
  expect(replay.response.status, replay.raw).toBe(400);
  expect(replay.data.error.code).toBe('native_enrollment_replayed');
  expect(delivery).not.toHaveProperty('deviceCredential');
  expect(delivery.responsePeerNonce).not.toBe(delivery.binding.peerNonce);
  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm(),
  });
  const privateJwk = await exportJWK(successful.recipient.privateKey);
  const recipient = await suite.kem.importKey('jwk', privateJwk, false);
  const aad = Buffer.from(delivery.stationProof.split('.')[1]!, 'base64url');
  const bytes = await suite.open(
    {
      recipientKey: recipient,
      enc: Buffer.from(delivery.enc, 'base64url'),
      info: new TextEncoder().encode(VERSION),
    },
    Buffer.from(delivery.ciphertext, 'base64url'),
    aad,
  );
  const bundle = JSON.parse(new TextDecoder().decode(bytes));
  expect(bundle.deviceId).toBe(successful.candidate.deviceId);
  expect(typeof bundle.deviceCredential).toBe('string');
  expect(successful.pairing.identifyDevice(bundle.deviceCredential)).toBeNull();
  const active = await successful.activate(delivery);
  expect(active.response.status, active.raw).toBe(200);
  expect(active.data.deviceReceipt.currentDeviceBinding).toBe(true);
  expect(successful.pairing.identifyDevice(bundle.deviceCredential)?.id).toBe(
    successful.candidate.deviceId,
  );
  const status = await successful.proved('status', {
    enrollmentId: successful.challenge.enrollmentId,
  });
  expect(status.response.status, status.raw).toBe(200);
  expect(status.data.state).toBe('active');
  expect(status.data.responsePeerNonce).toBe(status.nonce);
  const record = successful.journal.get(successful.challenge.enrollmentId)!;
  const account = await successful.accounts.service.verifySessionReference(
    record.providerSessionId!,
    new AbortController().signal,
  );
  expect(account.kind).toBe('authenticated');
  if (account.kind !== 'authenticated')
    throw new Error('No current real provider person');
  expect(
    await successful.membership.readableProjectScopes({
      current: async () => ({
        principal: account.principal,
        verifiedEmails: [],
      }),
      operator: async () => {
        throw new Error('not operator');
      },
    }),
  ).toEqual([]);
  await successful.membership.accept(successful.invite.token, {
    current: async () => ({ principal: account.principal, verifiedEmails: [] }),
    operator: async () => {
      throw new Error('not operator');
    },
  });
  expect(
    (
      await successful.membership.readableProjectScopes({
        current: async () => ({
          principal: account.principal,
          verifiedEmails: [],
        }),
        operator: async () => {
          throw new Error('not operator');
        },
      })
    )[0]?.localProjectSlug,
  ).toBe(successful.project.slug);
  const canceled = await successful.proved('cancel', {
    enrollmentId: successful.challenge.enrollmentId,
  });
  expect(canceled.response.status, canceled.raw).toBe(200);
  expect(canceled.data.state).toBe('cancelled');
  expect(successful.pairing.identifyDevice(bundle.deviceCredential)).toBeNull();
});

test('Device revocation during actual Station receipt crypto blocks a stale ACTIVE response', async () => {
  const h = await fixture();
  const delivery = await h.registered();
  let release!: () => void, started!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve)),
    entered = new Promise<void>((resolve) => (started = resolve));
  const original = h.signing.signNativeEnrollmentReceipt.bind(h.signing);
  vi.spyOn(h.signing, 'signNativeEnrollmentReceipt').mockImplementation(
    async (value) => {
      const signed = await original(value);
      started();
      await barrier;
      return signed;
    },
  );
  const pending = h.activate(delivery);
  await entered;
  h.pairing.revokeDevice(h.candidate.deviceId, 'operator-credential');
  release();
  const refused = await pending;
  expect(refused.response.status, refused.raw).toBe(503);
  expect(refused.data).not.toHaveProperty('stationProof');
  const status = await h.proved('status', {
    enrollmentId: h.challenge.enrollmentId,
  });
  expect(status.response.status, status.raw).toBe(200);
  expect(status.data.state).toBe('revoked');
});

test('expired before registration can confirm owned cancellation without account or Device authority', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const h = await fixture();
  now = h.challenge.expiresAt + 1;
  const rejected = await h.proved('register', {
    enrollmentId: h.challenge.enrollmentId,
    candidate: h.candidate,
    credentials: { username: 'zach', password: 'never submitted registration' },
    invitation: h.invite.token,
  });
  expect(rejected.response.status, rejected.raw).toBe(410);
  expect(
    h.journal.get(h.challenge.enrollmentId)?.providerSessionId,
  ).toBeUndefined();
  expect(h.journal.get(h.challenge.enrollmentId)?.candidate).toBeUndefined();
  const mismatched = await h.proved('cancel', {
    enrollmentId: h.challenge.enrollmentId,
    candidate: { ...h.candidate, deviceId: randomUUID() },
  });
  expect(mismatched.response.status).toBe(400);
  const cancelled = await h.proved('cancel', {
    enrollmentId: h.challenge.enrollmentId,
    candidate: h.candidate,
  });
  expect(cancelled.response.status, cancelled.raw).toBe(200);
  expect(cancelled.data.state).toBe('cancelled');
  expect(cancelled.data.candidate).toEqual(h.candidate);
  expect(cancelled.data.responsePeerNonce).toBe(cancelled.nonce);
  expect(h.journal.get(h.challenge.enrollmentId)?.state).toBe('cancelled');
  expect(await h.membership.previewInvitation(h.invite.token)).toMatchObject({
    projectName: 'Shared Example',
  });
  expect(
    h.journal.get(h.challenge.enrollmentId)?.providerSessionId,
  ).toBeUndefined();
  expect(
    h.pairing.resolveActiveRelayEnrollmentDevice(
      h.candidate.deviceId,
      h.challenge.enrollmentId,
    ),
  ).toBeNull();
});

test('newer routing generation closes only the expired original Device ceremony', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const h = await fixture();
  await h.replaceTransport(2);
  const payload = {
    enrollmentId: h.challenge.enrollmentId,
    candidate: h.candidate,
  };
  const live = await h.proved('cancel', payload);
  expect(live.response.status, live.raw).toBe(400);
  const login = await h.proved('register', {
    ...payload,
    credentials: { username: 'zach', password: 'not-authorized-by-new-route' },
    invitation: h.invite.token,
  });
  expect(login.response.status, login.raw).toBe(400);
  now += 60_000;
  const newer = await h.exchange(`${BASE}/begin`, {
    version: VERSION,
    clientAttemptId: opaque(),
    peerNonce: opaque(),
    expiresAt: now + 300_000,
    recipient: h.challenge.recipient,
  });
  expect(newer.response.status, newer.raw).toBe(200);
  now = h.challenge.expiresAt + 1;
  const closed = await h.proved('cancel', payload);
  expect(closed.response.status, closed.raw).toBe(200);
  expect(h.journal.get(newer.data.enrollmentId)?.state).toBe('challenge');
  expect(h.journal.get(newer.data.enrollmentId)?.expiresAt).toBeGreaterThan(
    now,
  );
  expect(closed.data.state).toBe('cancelled');
  expect(closed.data.binding.scope).toEqual(h.challenge.scope);
  expect(closed.data.responsePeerNonce).toBe(closed.nonce);
  expect(
    h.journal.get(h.challenge.enrollmentId)?.providerSessionId,
  ).toBeUndefined();
  expect(
    h.pairing.resolveActiveRelayEnrollmentDevice(
      h.candidate.deviceId,
      h.challenge.enrollmentId,
    ),
  ).toBeNull();
  expect(await h.membership.previewInvitation(h.invite.token)).toMatchObject({
    projectName: 'Shared Example',
  });
});

test('successor route cannot finalize, activate or cancel a committed Device ceremony', async () => {
  const h = await fixture();
  const delivery = await h.registered();
  await h.replaceTransport(2);
  const finalize = await h.proved('finalize', {
    enrollmentId: h.challenge.enrollmentId,
  });
  expect(finalize.response.status, finalize.raw).toBe(400);
  const activation = await h.activate(delivery);
  expect(activation.response.status, activation.raw).toBe(400);
  await h.replaceTransport(1);
  const active = await h.activate(delivery);
  expect(active.response.status, active.raw).toBe(200);
  await h.replaceTransport(2);
  vi.spyOn(Date, 'now').mockReturnValue(h.challenge.expiresAt + 1);
  for (const purpose of ['status', 'cancel']) {
    const refused = await h.proved(purpose, {
      enrollmentId: h.challenge.enrollmentId,
      candidate: h.candidate,
    });
    expect(refused.response.status, refused.raw).toBe(400);
  }
  expect(h.journal.get(h.challenge.enrollmentId)?.state).toBe('committed');
  expect(
    h.pairing.resolveActiveRelayEnrollmentDevice(
      h.candidate.deviceId,
      h.challenge.enrollmentId,
    ),
  ).not.toBeNull();
});

test('expired staged delivery refuses newer-generation status and cancellation', async () => {
  const h = await fixture();
  const delivery = await h.registered();
  await h.replaceTransport(2);
  vi.spyOn(Date, 'now').mockReturnValue(h.challenge.expiresAt + 1);
  const before = h.journal.get(h.challenge.enrollmentId)!;
  expect(before.state).toBe('awaiting-ack');
  expect(before.bundleDigest).toBe(delivery.bundleDigest);
  expect(before.ackDigest).toBeUndefined();
  for (const purpose of ['status', 'cancel']) {
    const refused = await h.proved(purpose, {
      enrollmentId: h.challenge.enrollmentId,
      candidate: h.candidate,
    });
    expect(refused.response.status, refused.raw).toBe(400);
  }
  expect(h.journal.get(h.challenge.enrollmentId)).toEqual(before);
});

test.each(['backward', 'different-installation'] as const)(
  'expired terminal recovery refuses %s transport',
  async (kind) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = await fixture(2);
    await h.replaceTransport(
      kind === 'backward' ? 1 : 3,
      kind === 'different-installation'
        ? { ...h.candidate.surface, clientInstanceId: randomUUID() }
        : h.candidate.surface,
    );
    now = h.challenge.expiresAt + 1;
    const refused = await h.proved('cancel', {
      enrollmentId: h.challenge.enrollmentId,
      candidate: h.candidate,
    });
    expect(refused.response.status, refused.raw).toBe(400);
    expect(h.journal.get(h.challenge.enrollmentId)?.state).toBe('challenge');
  },
);

test('an operator declines an actual pending native registration through the management route and clears provider and Device authority', async () => {
  const h = await fixture();
  const registration = await h.proved('register', {
    enrollmentId: h.challenge.enrollmentId,
    candidate: h.candidate,
    credentials: {
      username: 'declined-user',
      password: 'Native invitation fixture password',
    },
    invitation: h.invite.token,
  });
  expect(registration.response.status, registration.raw).toBe(200);
  const pending = h.journal.get(h.challenge.enrollmentId);
  expect(pending?.state).toBe('requested');
  const denied = await h.operatorPost(
    `/api/relay-management/devices/${h.challenge.enrollmentId}/deny`,
    { candidate: h.candidate },
  );
  expect(denied.status).toBe(200);
  expect(h.journal.get(h.challenge.enrollmentId)?.state).toBe('cancelled');
  expect(
    h.pairing.resolveActiveRelayEnrollmentDevice(
      h.candidate.deviceId,
      h.challenge.enrollmentId,
    ),
  ).toBeNull();
  expect(
    (
      await h.accounts.service.verifySessionReference(
        pending!.providerSessionId!,
        new AbortController().signal,
      )
    ).kind,
  ).toBe('invalid');
});

test('delegated native approval durably records the authenticated manager rather than the local owner', async () => {
  const h = await fixture();
  const registered = await h.proved('register', {
    enrollmentId: h.challenge.enrollmentId,
    candidate: h.candidate,
    credentials: {
      username: 'managed-recipient',
      password: 'Native invitation fixture password',
    },
    invitation: h.invite.token,
  });
  expect(registered.response.status, registered.raw).toBe(200);
  const offer = h.pairing.createOffer({ endpoint: ORIGIN });
  const pending = h.pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Manager phone',
    source: 'tailnet',
    requester: { provider: 'tailscale-serve', login: 'manager@example.test' },
  });
  h.pairing.confirmRequest(
    pending.requestId,
    { kind: 'presented-credential' },
    { principalId: 'human:local:operator', kind: 'verified-ingress' },
  );
  const manager = h.pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: pending.requestId,
  });
  h.pairing.setDeviceScope(
    manager.device.id,
    ['orchestration:read', 'relay:manage'],
    { kind: 'presented-credential' },
  );
  const approved = await h.operatorPost(
    `/api/relay-management/devices/${h.challenge.enrollmentId}/approve`,
    { candidate: h.candidate },
    manager.credential,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  const actorId = humanPrincipal(
    'tailscale-serve',
    'manager@example.test',
    'Manager',
  ).id;
  expect(h.journal.get(h.challenge.enrollmentId)?.approvedBy).toBe(actorId);
  const finalized = await h.proved('finalize', {
    enrollmentId: h.challenge.enrollmentId,
  });
  expect(finalized.response.status, finalized.raw).toBe(200);
  const activated = await h.activate(finalized.data);
  expect(activated.response.status, activated.raw).toBe(200);
  expect(
    h.pairing.listDevices().find((device) => device.id === h.candidate.deviceId)
      ?.principalBinding?.approvedBy,
  ).toBe(actorId);
  expect(
    h.bindings.bindingById({ bindingId: h.candidate.bindingId })?.approvedBy,
  ).toBe(actorId);
  h.pairing.setDeviceScope(
    h.candidate.deviceId,
    ['orchestration:read', 'relay:manage'],
    { kind: 'presented-credential' },
  );
  const promoted = await h.proved('status', {
    enrollmentId: h.challenge.enrollmentId,
  });
  expect(promoted.response.status, promoted.raw).toBe(200);
  expect(promoted.data.state).toBe('active');
  expect(h.pairing.deviceHoldsScope(h.candidate.deviceId, 'relay:manage')).toBe(
    true,
  );
});

test('account revocation after awaited recipient verification refuses approval even while the management scope remains valid', async () => {
  let actorLive = true;
  const h = await fixture(1, () => actorLive);
  const registration = await h.proved('register', {
    enrollmentId: h.challenge.enrollmentId,
    candidate: h.candidate,
    credentials: {
      username: 'revocation-recipient',
      password: 'Native invitation fixture password',
    },
    invitation: h.invite.token,
  });
  expect(registration.response.status, registration.raw).toBe(200);
  const verify = h.accounts.service.verifyPendingEnrollment.bind(
    h.accounts.service,
  );
  vi.spyOn(
    h.accounts.service,
    'verifyPendingEnrollment',
  ).mockImplementationOnce(async (...args) => {
    const verified = await verify(...args);
    actorLive = false;
    return verified;
  });
  const response = await h.operatorPost(
    `/api/relay-management/devices/${h.challenge.enrollmentId}/approve`,
    { candidate: h.candidate },
  );
  expect(response.status).toBe(401);
  expect(h.journal.get(h.challenge.enrollmentId)?.state).toBe('requested');
  expect(h.journal.get(h.challenge.enrollmentId)?.approvalId).toBeUndefined();
  expect(
    h.bindings.bindingById({ bindingId: h.candidate.bindingId }),
  ).toBeNull();
});
