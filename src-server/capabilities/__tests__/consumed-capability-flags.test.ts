import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHostedTenantRegistry } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { readStreamUntil } from '../../__test-utils__/sse-helpers.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { RecipientStore } from '../../analytics/recipient-store.js';
import type { EnrollmentActor } from '../../analytics/source-enrollment-store.js';
import { SourceEnrollmentStore } from '../../analytics/source-enrollment-store.js';
import { createPushRoutes } from '../../routes/operations/push-routes.js';
import { createRecipientCandidateRoutes } from '../../routes/operations/recipient-candidates.js';
import { createOrchestrationRoutes } from '../../routes/orchestration/orchestration.js';
import { createSessionPersonActivityRoutes } from '../../routes/orchestration/session-project-activity.js';
import { createSystemStatusRoutes } from '../../routes/system/system-status-routes.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../runtime/bootstrap/hosted-tenant-mode.js';
import {
  resolveRuntimeConnectionRoutesEnabled,
  resolveRuntimeWebPushEnabled,
} from '../../runtime/routes/runtime-route-support.js';
import { configureRuntimePublicRoutes } from '../../runtime/routes/runtime-routes.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import {
  resolveStationCapabilityFlags,
  STATION_CAPABILITY_FLAGS,
} from '../station-capability-flags.js';
import { TABLED_CAPABILITY_FLAGS } from './consumed-capability-flag-names.js';

const makeTempDir = trackTempDirs();

const REGISTRY = {
  schemaVersion: 1,
  tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
};

type Deployment = { hosted: boolean };

/** The real orchestration routes for one deployment mode, over a stub owner. */
function orchestrationRoutes(
  { hosted }: Deployment,
  service: Record<string, unknown>,
) {
  return createOrchestrationRoutes(
    service as never,
    {
      eventBus: { subscribe: () => () => {} },
      logger: { debug: vi.fn() },
      getUserId: () => 'owner',
      isRequestPrincipalCurrent: () => true,
      ...(hosted
        ? { hostedTenantRegistry: parseHostedTenantRegistry(REGISTRY) }
        : {}),
    } as never,
  );
}

/**
 * Every handshake flag a client gates on (packages/sdk or src-ui), plus every
 * flag a deployment mode withdraws, with a probe that asks the real route whether it serves that
 * feature in a deployment mode, given an owner that would grant the request.
 * client-capability-gates.scan.test.ts fails when a client gates on a flag
 * missing here; TABLED_CAPABILITY_FLAGS names these rows for it.
 */
const CONSUMED_FLAGS: Record<
  string,
  (deployment: Deployment) => Promise<boolean>
> = {
  privateOperationalOutcomes: async ({ hosted }) => {
    const actor: EnrollmentActor = {
      sourceStationId: 'receiver',
      userId: 'alice',
      mode: hosted ? 'hosted' : 'personal',
      tenantId: hosted ? 'alpha' : null,
      ownerIds: ['alice'],
      assertCurrent: async () => {},
    };
    const store = new RecipientStore(makeTempDir('outcomes-capability-'));
    const source = new SourceEnrollmentStore(
      makeTempDir('outcomes-capability-source-'),
    );
    const intent = await source.prepare(
      { ...actor, sourceStationId: 'source' },
      {
        operationId: randomUUID(),
        proposedDestination: {
          stationId: 'receiver',
          origin: 'https://receiver.example.test',
        },
        scope: 'individual',
        operationalConsent: 'terminal-outcomes/v1',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        retention: { mode: 'live-mirror' },
      },
    );
    const id = randomUUID();
    await store.prepare(actor, {
      operationId: id,
      proposedSourceOrigin: 'https://source.example.test',
      sourceIntent: intent,
    });
    const read = vi.spyOn(store, 'queryOperationalOutcomes').mockResolvedValue({
      data: {
        protocol: 'station-private-operational-outcomes/v1',
        operationalConsent: 'terminal-outcomes/v1',
        groupBy: 'engine',
        highWater: 1,
        observedTurns: 1,
        rows: [{ key: 'codex', completed: 1, aborted: 0, failed: 0 }],
        sourceAuthority: 'not-verified-by-storage',
        coverage: {
          state: 'unknown',
          reason: 'retained-terminal-observations-only',
          retentionDays: 7,
        },
        recipientId: id,
        asOf: {
          stationId: 'source',
          streamEpoch: 'epoch',
          highWater: 1,
          sourceRevision: 1,
        },
      },
      assertCurrent: actor.assertCurrent,
    });
    // Target capture is an owner dependency; the probe never invokes its storage methods.
    const routes = createRecipientCandidateRoutes({
      store,
      capture: async () => actor,
      captureSyncTarget: async () => ({
        installationId: 'receiver',
        custody: 'custody',
        assertCurrent: actor.assertCurrent,
        provision: async () => {
          throw new Error('unused');
        },
        checkpoint: async () => null,
        receipt: async () => null,
        invalidationReceipt: async () => null,
        applyInvalidations: async () => {
          throw new Error('unused');
        },
        queryReceipts: async () => {
          throw new Error('unused');
        },
        commit: async () => {
          throw new Error('unused');
        },
        queryOperationalOutcomes: async () => {
          throw new Error('unused');
        },
      }),
    });
    const response = await routes.request(`/${id}/outcomes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '2026-10-01',
        to: '2026-10-02',
        groupBy: 'engine',
      }),
    });
    read.mockRestore();
    return response.status === 200;
  },
  // GET /sessions/:threadId/event-window answers a bounded window.
  sessionEventWindow: async (deployment) => {
    const routes = orchestrationRoutes(deployment, {
      readSessionEventWindow: vi.fn(async () => ({ events: [], turns: [] })),
    });
    const response = await routes.request(
      '/sessions/session-a/event-window?turnLimit=1',
    );
    return response.status === 200;
  },
  // GET /sessions/:threadId/inputs/:eventId answers the exact authored input.
  sessionInventoryInputRead: async (deployment) => {
    const routes = orchestrationRoutes(deployment, {
      canUserReadSession: () => true,
      sessionQueries: {
        readUserInput: vi.fn(async () => ({
          status: 'found',
          sessionId: 'session-a',
          eventId: 'input-a',
          turnId: 'turn-a',
          input: { prompt: 'Protected input', attachments: [] },
        })),
      },
    });
    const response = await routes.request(
      '/sessions/session-a/inputs/input-a?turnId=turn-a',
    );
    return response.status === 200;
  },
  // GET /api/system/routes answers the Station routes only where runtime
  // route support composes a resolver, from the same predicate as the flag.
  connectionRoutes: async ({ hosted }) => {
    const enabled = resolveRuntimeConnectionRoutesEnabled(
      hosted
        ? { [HOSTED_TENANT_REGISTRY_FILE_ENV]: '/hosted/tenants.json' }
        : {},
    );
    const routes = createSystemStatusRoutes({
      ...(enabled
        ? {
            resolveStationRoutes: async () => ({
              environmentId: 'env-a',
              routes: [],
            }),
          }
        : {}),
    } as never);
    return (await routes.request('/routes')).status === 200;
  },
  // Not gated by a client today, but withdrawn in hosted mode, so pinned too.
  // GET /vapid-public-key answers under resolveRuntimeWebPushEnabled. That
  // configureRuntimeSupportServices composes webPushEnabled from it is pinned
  // in runtime-route-support-notification-providers.test.ts.
  webPushNotifications: async ({ hosted }) => {
    const routes = createPushRoutes({
      enabled: resolveRuntimeWebPushEnabled(
        hosted
          ? { [HOSTED_TENANT_REGISTRY_FILE_ENV]: '/hosted/tenants.json' }
          : {},
      ),
      getVapidPublicKey: () => 'vapid-public-key',
      identifyDevice: () => null,
      credentialAliasId: () => undefined,
      setPushSubscription: vi.fn(),
      clearPushSubscription: vi.fn(),
    });
    return (await routes.request('/vapid-public-key')).status === 200;
  },
  // GET /api/orchestration/session-reads/activity answers a person's list.
  sessionPersonReads: async ({ hosted }) => {
    const routes = createSessionPersonActivityRoutes({
      orchestrationService: {
        canUserReadSession: () => true,
        currentConversationSessionId: (id: string) => id,
        firstStartedMetadataOfThread: () => undefined,
        listSessionReadModel: vi.fn(async () => []),
      },
      eventStore: {} as never,
      resolvePrincipal: () =>
        ({ id: 'owner', kind: 'human', display: 'Owner' }) as never,
      ...(hosted
        ? { hostedTenantRegistry: parseHostedTenantRegistry(REGISTRY) }
        : {}),
      projectIdForSlug: () => undefined,
      personMayView: () => true,
      preview: { select: (branches) => branches.enabled() },
    });
    return (await routes.request('/activity')).status === 200;
  },
  // GET /events honours Last-Event-ID: a cursor inside the gap replays the
  // missed event instead of sending a fresh snapshot.
  eventStreamResume: async (deployment) => {
    const missed = {
      globalSequence: 2,
      payload: {
        eventId: 'evt-2',
        provider: 'claude',
        threadId: 'thread-1',
        createdAt: '2026-03-28T00:00:02.000Z',
        method: 'content.text-delta',
        itemId: 'item-1',
        delta: 'missed',
      },
    };
    const routes = orchestrationRoutes(deployment, {
      canUserReadSession: () => true,
      listSessionReadModel: vi.fn(async () => []),
      readEventStreamHead: () => 2,
      readEventStreamReplayPlan: () => ({ count: 1, fitsBudget: true }),
      readEventStreamReplay: () => [missed],
      replayTurnProvenanceSidecar: () => ({}),
      retainSessionDeletionReader: () => () => {},
      conversationStreamBinding: () => undefined,
    });
    const response = await routes.request('/events', {
      headers: { 'Last-Event-ID': '1' },
    });
    if (response.status !== 200 || !response.body) return false;
    const payload = await readStreamUntil(response.body, (text) =>
      text.includes('orchestration:caughtUp'),
    );
    const caughtUp = payload.indexOf('orchestration:caughtUp');
    const history = payload.slice(0, caughtUp);
    return (
      caughtUp >= 0 &&
      history.includes('"eventId":"evt-2"') &&
      !history.includes('orchestration:snapshot')
    );
  },
};

async function advertisedFlags({ hosted }: Deployment) {
  const homeDir = makeTempDir('station-consumed-capability-');
  const registryPath = join(homeDir, 'tenants.json');
  writeFileSync(registryPath, JSON.stringify(REGISTRY));
  const security = new EnvironmentSecurityService({
    homeDir,
    environment: hosted
      ? { [HOSTED_TENANT_REGISTRY_FILE_ENV]: registryPath }
      : {},
  });
  const app = new Hono();
  configureRuntimePublicRoutes(app as never, security);
  const handshake = (await (
    await app.request('/.well-known/station/v1')
  ).json()) as { capabilities?: Record<string, boolean> };
  return handshake.capabilities ?? {};
}

/**
 * #4177: an advertised flag must say whether this deployment's route serves
 * the feature. Each row compares the real handshake (EnvironmentSecurityService
 * behind the public route) with the real route, built from the same mode.
 */
describe('consumed capability flags match what their routes serve', () => {
  // Pinned beside the derived comparison so a change flipping both sides
  // together (withdrawing a flag everywhere, or serving hosted reads without
  // a tenant reader) still reds.
  const EXPECTED: Record<string, Record<'personal' | 'hosted', boolean>> = {
    privateOperationalOutcomes: { personal: true, hosted: true },
    sessionEventWindow: { personal: true, hosted: true },
    sessionInventoryInputRead: { personal: true, hosted: false },
    eventStreamResume: { personal: true, hosted: true },
    sessionPersonReads: { personal: true, hosted: true },
    webPushNotifications: { personal: true, hosted: false },
    connectionRoutes: { personal: true, hosted: false },
  };

  test('every flag a deployment withdraws has a row', () => {
    const hostedFlags = resolveStationCapabilityFlags({ hosted: true });
    const withdrawn = Object.keys(STATION_CAPABILITY_FLAGS).filter(
      (flag) => !Object.hasOwn(hostedFlags, flag),
    );
    expect(withdrawn).toEqual(
      expect.arrayContaining([
        'sessionInventoryInputRead',
        'webPushNotifications',
      ]),
    );
    expect(
      withdrawn.filter((flag) => !Object.hasOwn(CONSUMED_FLAGS, flag)),
      'A flag withdrawn in hosted mode needs a row in CONSUMED_FLAGS probing its route.',
    ).toEqual([]);
  });

  test('the rows are exactly the tabled flag list the client scan checks', () => {
    expect(Object.keys(CONSUMED_FLAGS).sort()).toEqual(
      [...TABLED_CAPABILITY_FLAGS].sort(),
    );
  });

  test('every table row has a pinned expectation', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(
      Object.keys(CONSUMED_FLAGS).sort(),
    );
  });

  for (const [flag, probe] of Object.entries(CONSUMED_FLAGS)) {
    test.each([
      { mode: 'personal' as const, hosted: false },
      { mode: 'hosted' as const, hosted: true },
    ])(`${flag}: $mode deployment`, async ({ mode, hosted }) => {
      const flags = await advertisedFlags({ hosted });
      const advertised = flags[flag] === true;
      const served = await probe({ hosted });

      expect({ flag, mode, served }).toEqual({
        flag,
        mode,
        served: EXPECTED[flag]![mode],
      });
      expect({ flag, mode, advertised }).toEqual({
        flag,
        mode,
        advertised: served,
      });
      // A withdrawn flag is an absent key, the contract's "unsupported".
      expect(Object.hasOwn(flags, flag)).toBe(advertised);
    });
  }
});
