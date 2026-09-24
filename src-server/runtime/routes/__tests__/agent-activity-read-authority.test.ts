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
import {
  createOrchestrationRequestPrincipalResolver,
  pairedDevicePrincipal,
} from '../../bootstrap/orchestration-request-principal.js';
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

function pair(pairing: DevicePairingService, name: string) {
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
  });
  const request = pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
  });
  pairing.confirmRequest(request.requestId, { kind: 'presented-credential' });
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
    ownerlessSessionAccess: 'single-user-compat',
    legacyPersonalOwner: getCachedUser().alias,
    personalConversationAccess: {
      canRead: (requester: string, owner: string) =>
        pairing.canSharePersonalConversation(requester, owner),
      ownerIds: (requester: string) =>
        pairing.personalConversationOwnerIds(requester),
    },
  } as never);
  service.initialize();
  const devicePrincipal = pairedDevicePrincipal(phone.device).id;
  seedFinishedSession(
    store,
    'cli',
    LOCAL_OPERATOR_PRINCIPAL_ID,
    'Operator CLI task',
  );
  seedFinishedSession(
    store,
    'phone',
    devicePrincipal,
    'Task started on the phone',
  );
  seedFinishedSession(store, 'foreign', STRANGER, 'Someone else’s task');

  // The phone's own session list, through the real route and the runtime's
  // request-principal resolver, authenticated as the paired device.
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
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug() {} },
      resolvePrincipal: createOrchestrationRequestPrincipalResolver({
        environmentSecurityService: pairing,
      }),
    }),
  );
  const phoneList = async () => {
    const response = await app.request(
      '/api/orchestration/sessions/read-model',
      {
        headers: { authorization: `Bearer ${phone.credential}` },
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ displayTitle?: string }>;
    };
    return body.data.map((session) => session.displayTitle).sort();
  };

  const keys = new PushSigningKeyStore(home, () => pairing.environmentId());
  const key = await keys.loadOrCreate();
  const registration = pairing.setNativePush(
    phone.device.id,
    {
      token: `fcm-token-${'a'.repeat(60)}`,
      packageName: 'io.kontourai.station',
      platform: 'android',
    },
    key.thumbprint,
  );
  const cards: Array<Record<string, string>> = [];
  const publisher = wireAgentActivityPublisher({
    eventBus,
    devicePairing: pairing,
    signingKey: keys,
    gateway: resolvePushGatewayConfig({})!,
    logger: { warn: vi.fn() },
    windowMs: 1,
    setTimer: () => () => {},
    sessionReaderFor: createAgentActivitySessionReader({
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
    }),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(Buffer.from(init.body as Buffer)));
      cards.push(openCard(body.data.sealed, registration));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  cleanups.push(() => void publisher.stop());
  return { service, phoneList, publisher, cards };
}

const cardTitles = (card: Record<string, string> | undefined) =>
  Object.entries(card ?? {})
    .filter(([key]) => key.startsWith('activity_line_'))
    .map(([, row]) => row.split('\t')[1])
    .sort();

test("the phone's card lists exactly the sessions the phone's own session list returns", async () => {
  const { phoneList, publisher, cards } = await fixture();
  const listed = await phoneList();
  // What the device may read: the operator's and its own, not a stranger's.
  expect(listed).toEqual(['Operator CLI task', 'Task started on the phone']);

  publisher.requestFlush();
  await publisher.drain();
  expect(cards).toHaveLength(1);
  expect(cardTitles(cards[0])).toEqual(listed);
  expect(JSON.stringify(cards[0])).not.toContain('Someone else');
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
