/**
 * The phone's card holds exactly what that phone's own session list shows.
 *
 * Real pieces only: a real pairing registry, a real EventStore and
 * OrchestrationService with the runtime's personal conversation-access
 * policy, the real orchestration session-list route authenticated as the
 * paired device through the runtime's own request-principal resolver, and
 * the real publisher reading through the production session reader. The
 * sessions are owned by the operator (a CLI chat), by the phone's device, and
 * by a principal this device may not read.
 */
import { createDecipheriv } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_PUSH_SEALED_AAD_PREFIX } from '@kontourai/station-contracts/native-push';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import { getCachedUser } from '../../../routes/system/auth.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import {
  resolvePushGatewayConfig,
  wireAgentActivityPublisher,
} from '../../../services/notifications/agent-activity-publisher.js';
import type { NativePushRegistration } from '../../../services/notifications/native-push-registration-store.js';
import { PushSigningKeyStore } from '../../../services/notifications/push-signing-key-store.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import { createOrchestrationRequestPrincipalResolver } from '../../bootstrap/orchestration-request-principal.js';
import { createAgentActivitySessionReader } from '../agent-activity-session-reader.js';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const STRANGER = 'human:github:someone-else';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function openCard(sealed: string, registration: NativePushRegistration) {
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(registration.payloadKey, 'base64url'),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(
    Buffer.from(
      `${NATIVE_PUSH_SEALED_AAD_PREFIX}${registration.registrationId}`,
      'utf8',
    ),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString('utf8'),
  ) as Record<string, string>;
}

function pair(
  pairing: DevicePairingService,
  name: string,
  tailnetLogin?: string,
) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
  });
  const base = {
    requesterPosition: 'off-box' as const,
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
  };
  const request = tailnetLogin
    ? pairing.requestPairing({
        ...base,
        source: 'tailnet',
        requester: { provider: 'tailscale-serve', login: tailnetLogin },
      })
    : pairing.requestPairing(base);
  pairing.confirmRequest(
    request.requestId,
    { kind: 'presented-credential' },
    tailnetLogin
      ? { principalId: LOCAL_OPERATOR_PRINCIPAL_ID, kind: 'verified-ingress' }
      : undefined,
  );
  return pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
}

function seedFinishedSession(
  store: EventStore,
  threadId: string,
  owner: string,
  title: string,
) {
  const at = Date.now() - 60_000;
  const iso = (offset: number) => new Date(at + offset).toISOString();
  store.upsertSession({
    provider: 'claude',
    threadId,
    status: 'ready',
    createdAt: iso(0),
    updatedAt: iso(2000),
  });
  store.appendEvent({
    eventId: `${threadId}:start`,
    provider: 'claude',
    threadId,
    createdAt: iso(0),
    method: 'session.started',
    sessionId: threadId,
    metadata: { userId: owner, agentSlug: 'claude' },
  } as never);
  store.appendEvent({
    eventId: `${threadId}:turn`,
    provider: 'claude',
    threadId,
    turnId: `${threadId}:t1`,
    createdAt: iso(1000),
    method: 'turn.started',
    prompt: title,
  } as never);
  store.appendEvent({
    eventId: `${threadId}:done`,
    provider: 'claude',
    threadId,
    turnId: `${threadId}:t1`,
    createdAt: iso(2000),
    method: 'turn.completed',
  } as never);
}

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-activity-authority-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir: home,
    environmentId: ENVIRONMENT_ID,
  });
  const phone = pair(pairing, 'Pixel');
  const alicePhone = pair(pairing, 'Alice phone', 'alice@example.com');
  const store = new EventStore(join(home, 'orchestration.sqlite'));
  cleanups.push(() => store.close());
  const eventBus = new EventBus();
  const service = new OrchestrationService({
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    eventBus,
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {} },
    // The runtime's personal-mode policy (runtime-initialize.ts).
    personalConversationAccess: {
      canRead: (requester: string, owner: string) =>
        pairing.canSharePersonalConversation(requester, owner),
      ownerIds: (requester: string) =>
        pairing.personalConversationOwnerIds(requester),
    },
  } as never);
  service.initialize();
  // Owners written as literal principal ids — not derived from the code
  // under test.
  seedFinishedSession(
    store,
    'cli',
    LOCAL_OPERATOR_PRINCIPAL_ID,
    'Operator CLI task',
  );
  seedFinishedSession(
    store,
    'phone',
    `human:device:${phone.device.id}`,
    'Task started on the phone',
  );
  seedFinishedSession(
    store,
    'alice',
    'human:tailscale-serve:alice@example.com',
    'Task Alice started',
  );
  seedFinishedSession(store, 'foreign', STRANGER, 'Someone else’s task');

  // The phones' own view, through the real route and the runtime's
  // request-principal resolver, authenticated as each paired device.
  const resolvePrincipal = createOrchestrationRequestPrincipalResolver({
    environmentSecurityService: pairing,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer /, '');
    const device = bearer ? pairing.identifyDevice(bearer) : null;
    if (bearer && device)
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'credential',
        credential: bearer,
        authority: 'device-credential',
        source: 'bearer',
        deviceId: device.id,
        deviceKind: 'device',
      });
    await next();
  });
  app.get('/whoami', (c) => c.json({ id: resolvePrincipal(c).id }));
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug() {} },
      resolvePrincipal,
    }),
  );
  const ownList = async (credential: string) => {
    const response = await app.request(
      '/api/orchestration/sessions/read-model',
      { headers: { authorization: `Bearer ${credential}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ displayTitle?: string }>;
    };
    return body.data.map((session) => session.displayTitle).sort();
  };
  const whoami = async (credential: string) =>
    (
      (await (
        await app.request('/whoami', {
          headers: { authorization: `Bearer ${credential}` },
        })
      ).json()) as { id: string }
    ).id;

  const keys = new PushSigningKeyStore(home, () => pairing.environmentId());
  const key = await keys.loadOrCreate();
  const registrations = new Map<string, NativePushRegistration>();
  for (const [device, token] of [
    [phone.device.id, `fcm-token-${'a'.repeat(60)}`],
    [alicePhone.device.id, `fcm-token-${'b'.repeat(60)}`],
  ] as const) {
    const registration = pairing.setNativePush(
      device,
      { token, packageName: 'io.kontourai.station', platform: 'android' },
      key.thumbprint,
    );
    registrations.set(registration.registrationId, registration);
  }
  const reader = createAgentActivitySessionReader({
    listDevices: () => pairing.listDevices(),
    listSessionReadModel: (authority) =>
      service.listSessionReadModel(authority),
    listProjectionEvents: (threadIds) =>
      new Map(
        [...store.listSessionProjectionEventsForThreads(threadIds)].map(
          ([threadId, events]) => [
            threadId,
            events.map((event) => event.payload),
          ],
        ),
      ),
    projectNames: () => new Map(),
  });
  /** Cards delivered, by device id. */
  const cards = new Map<string, Array<Record<string, string>>>();
  let clock = Date.now();
  const publisher = wireAgentActivityPublisher({
    eventBus,
    devicePairing: pairing,
    signingKey: keys,
    gateway: resolvePushGatewayConfig({})!,
    logger: { warn: vi.fn() },
    windowMs: 1,
    now: () => clock,
    setTimer: () => () => {},
    sessionReaderFor: reader,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(Buffer.from(init.body as Buffer)));
      const registration = registrations.get(body.data.device_id);
      if (!registration) throw new Error('unknown registration');
      const deviceId = [phone, alicePhone].find(
        (paired) =>
          pairing
            .listNativePushRegistrations()
            .find((entry) => entry.deviceId === paired.device.id)?.registration
            .registrationId === registration.registrationId,
      )?.device.id;
      const list = cards.get(deviceId ?? '?') ?? [];
      list.push(openCard(body.data.sealed, registration));
      cards.set(deviceId ?? '?', list);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  cleanups.push(() => void publisher.stop());
  const flush = async () => {
    publisher.requestFlush();
    await publisher.drain();
  };
  return {
    service,
    pairing,
    phone,
    alicePhone,
    ownList,
    whoami,
    reader,
    flush,
    cards,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const cardTitles = (card: Record<string, string> | undefined) =>
  Object.entries(card ?? {})
    .filter(([key]) => key.startsWith('activity_line_'))
    .map(([, row]) => row.split('\t')[1])
    .sort();

test('each phone reads as the principal its own requests resolve to', async () => {
  const f = await fixture();
  // Literal expectations, then parity with the runtime's resolver.
  expect(await f.whoami(f.phone.credential)).toBe(
    `human:device:${f.phone.device.id}`,
  );
  expect(await f.whoami(f.alicePhone.credential)).toBe(
    'human:tailscale-serve:alice@example.com',
  );
  expect(f.reader(f.phone.device.id)?.principalId).toBe(
    await f.whoami(f.phone.credential),
  );
  expect(f.reader(f.alicePhone.device.id)?.principalId).toBe(
    await f.whoami(f.alicePhone.credential),
  );
});

test("each phone's card lists exactly the sessions that phone's own session list returns", async () => {
  const f = await fixture();
  await f.flush();
  for (const paired of [f.phone, f.alicePhone]) {
    const listed = await f.ownList(paired.credential);
    expect(listed).toEqual([
      'Operator CLI task',
      'Task Alice started',
      'Task started on the phone',
    ]);
    const delivered = f.cards.get(paired.device.id) ?? [];
    expect(delivered).toHaveLength(1);
    expect(cardTitles(delivered[0])).toEqual(listed);
    expect(JSON.stringify(delivered[0])).not.toContain('Someone else');
  }
});

test('a phone narrowed below orchestration:read gets one final empty card, then nothing', async () => {
  const f = await fixture();
  await f.flush();
  expect(f.cards.get(f.phone.device.id)).toHaveLength(1);
  f.pairing.setDeviceScope(f.phone.device.id, ['inference:invoke'], {
    kind: 'presented-credential',
  });
  expect(f.reader(f.phone.device.id)).toBeNull();
  f.advance(5000);
  await f.flush();
  const delivered = f.cards.get(f.phone.device.id) ?? [];
  expect(delivered).toHaveLength(2);
  expect(cardTitles(delivered[1])).toEqual([]);
  expect(delivered[1]).toMatchObject({
    active: 'false',
    activity_active_count: '0',
  });
  expect(delivered[1]?.alert_id).toBeUndefined();
  f.advance(5000);
  await f.flush();
  expect(f.cards.get(f.phone.device.id)).toHaveLength(2);
  // The other phone is unaffected.
  expect(f.cards.get(f.alicePhone.device.id)).toHaveLength(1);
});

test('the OS alias is not a reading principal: it sees none of these sessions', async () => {
  const { service } = await fixture();
  // The live-run defect: this authority built every card empty.
  expect(
    await service.listSessionReadModel(
      sessionReadAuthorityFromRequest(
        getCachedUser().alias,
        undefined,
        undefined,
      ),
    ),
  ).toEqual([]);
});
