import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import { AUTHORITY_OBSERVATION_SCHEMA_VERSION } from '@kontourai/station-contracts/authority-observation';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { readStreamUntil } from '../../__test-utils__/sse-helpers.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { RecipientStore } from '../../analytics/recipient-store.js';
import type { EnrollmentActor } from '../../analytics/source-enrollment-store.js';
import { SourceEnrollmentStore } from '../../analytics/source-enrollment-store.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import { MemoryReviewService } from '../../knowledge-store/memory-review.js';
import { MemoryRootManager } from '../../knowledge-store/memory-root.js';
import { createPeerChatRoutes } from '../../routes/environments/peer-chat-routes.js';
import { createMemoryRoutes } from '../../routes/knowledge/memory-routes.js';
import { createPushRoutes } from '../../routes/operations/push-routes.js';
import { createRecipientCandidateRoutes } from '../../routes/operations/recipient-candidates.js';
import { createSchedulerRoutes } from '../../routes/operations/scheduler.js';
import { createInboxHarness } from '../../routes/orchestration/__tests__/helpers/thread-inbox-harness.js';
import { createCoordinatorRoutes } from '../../routes/orchestration/coordinator.js';
import { createOrchestrationRoutes } from '../../routes/orchestration/orchestration.js';
import { createSessionPersonActivityRoutes } from '../../routes/orchestration/session-project-activity.js';
import { createReadMarkerRoutes } from '../../routes/read-markers/read-marker-routes.js';
import { createDiagnosticsRoutes } from '../../routes/system/diagnostics.js';
import { createSystemStatusRoutes } from '../../routes/system/system-status-routes.js';
import { isDelegatedToolAllowed } from '../../runtime/agents/delegation.js';
import { createRequestDelegationResolver } from '../../runtime/agents/request-delegation.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../runtime/bootstrap/hosted-tenant-mode.js';
import {
  resolveRuntimeConnectionRoutesEnabled,
  resolveRuntimeWebPushEnabled,
} from '../../runtime/routes/runtime-route-support.js';
import { configureRuntimePublicRoutes } from '../../runtime/routes/runtime-routes.js';
import { isStationInternalRequest } from '../../services/browser/browser-request-origin.js';
import { TroubleshootService } from '../../services/infra/troubleshoot-service.js';
import {
  conversationAcknowledgementKey,
  FileConversationAcknowledgementStore,
} from '../../services/orchestration/conversation-acknowledgement-store.js';
import { FileDelegationAttemptClaimStore } from '../../services/orchestration/delegation-attempt-claim-store.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { ReadMarkerService } from '../../services/read-markers/read-marker-service.js';
import { FileReadMarkerStore } from '../../services/read-markers/read-marker-store.js';
import { createRemoteStationForwarder } from '../../services/remote-stations/remote-station-forwarder.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import {
  resolveStationCapabilityFlags,
  STATION_CAPABILITY_FLAGS,
  servesCoordinatorSession,
  servesFollowUpAttachments,
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
  deps: Record<string, unknown> = {},
) {
  return createOrchestrationRoutes(
    service as never,
    {
      eventBus: { subscribe: () => () => {} },
      logger: { debug: vi.fn() },
      getUserId: () => 'owner',
      isRequestPrincipalCurrent: () => true,
      ...deps,
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
/** The conversation inbox world a busy follow-up is held in. */
const inboxStation = createInboxHarness();

const CONSUMED_FLAGS: Record<
  string,
  (deployment: Deployment) => Promise<boolean>
> = {
  delegationToolConstraintsV1: async (deployment) => {
    const execute = vi.fn(
      async (input: {
        conversationId?: string;
        delegation?: AgentDelegationContext;
      }) => ({
        conversationId: input.conversationId,
        sessionId: input.conversationId,
        providerTurnId: 'probe-turn',
        environment: { id: 'probe-host', name: 'Probe host', kind: 'current' },
        target: { kind: 'agent', id: 'station' },
        resolution: {
          schemaVersion: 'station.execution-resolution/v1',
          resolvedAt: new Date().toISOString(),
          environmentId: 'probe-host',
          agentId: 'station',
          engine: { kind: 'station' },
          provider: 'station-agent',
          modelLaunchPlan: {
            kind: 'engine-selected',
            evidence: 'adapter-declared',
          },
        },
      }),
    );
    const routes = orchestrationRoutes(
      deployment,
      { hasSessionStartRecord: async () => false },
      {
        delegationAttemptClaimStore: new FileDelegationAttemptClaimStore(
          makeTempDir('tool-constraints-capability-'),
        ),
        executeForegroundMessage: execute,
        resolveRequestDelegation: createRequestDelegationResolver({
          isInternalRequest: isStationInternalRequest,
          resolveCaller: () => null,
          startedMetadata: () => undefined,
          sessionEngine: () => undefined,
          loadAgentSpec: async () => {
            throw new Error('No verified caller');
          },
          isRegistryDefaultAgent: async () => false,
        }),
      },
    );
    const body = {
      clientTurnId: 'tool-constraints-probe',
      message: 'Read within scope',
      target: { environment: { kind: 'current' }, agent: 'station' },
      delegation: {
        mode: 'isolated-child',
        depth: 1,
        maxDepth: 2,
        parentAgentSlug: 'parent',
        rootAgentSlug: 'root',
        toolAllowlistConstraints: [['repo_read']],
      },
    };
    const post = () =>
      routes.request('/chat/delegated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const response = await post();
    expect(response.status, await response.clone().text()).toBe(200);
    const replay = await post();
    expect(replay.status, await replay.text()).toBe(200);
    body.delegation.toolAllowlistConstraints = [['repo_write']];
    const changed = await post();
    expect(changed.status, await changed.text()).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
    const delegation = execute.mock.calls[0]?.[0].delegation;
    return (
      response.status === 200 &&
      JSON.stringify(delegation?.toolAllowlistConstraints) ===
        JSON.stringify([['repo_read']]) &&
      isDelegatedToolAllowed({
        toolName: 'repo_read',
        delegation,
        toolNameMapping: new Map(),
      }) &&
      !isDelegatedToolAllowed({
        toolName: 'repo_write',
        delegation,
        toolNameMapping: new Map(),
      })
    );
  },
  peerChatTunnelV1: async ({ hosted }) => {
    const peer = {
      environmentId: 'receiver',
      apiBase: 'https://receiver.test',
      credential: 'peer-credential-for-test',
      scope: 'orchestration:read orchestration:operate',
      label: 'Receiver',
      createdAt: 1,
      updatedAt: 1,
    };
    const peers = { get: () => peer };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        Response.json(
          String(input).endsWith('/api/auth/authority')
            ? {
                schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
                environmentId: 'receiver',
                principal: {
                  kind: 'human',
                  id: humanPrincipal('fixture', 'peer', 'Peer').id,
                },
                grant: {
                  kind: 'device',
                  deviceId: 'peer',
                  grantedScopes: [
                    'orchestration:read',
                    'orchestration:operate',
                  ],
                },
              }
            : {
                environmentId: 'receiver',
                capabilities: { delegationLocalConversationV1: true },
              },
        ),
      );
    try {
      const app = createPeerChatRoutes({
        peers,
        remote: createRemoteStationForwarder({
          peers,
          ssh: { list: () => [], connect: vi.fn() },
        }),
        current: () => true,
        owner: () => true,
        preview: hosted
          ? undefined
          : { select: (branches) => branches.enabled() },
      });
      return (await app.request('/receiver/chat-connection')).status === 200;
    } finally {
      fetch.mockRestore();
    }
  },
  delegationLocalConversationV1: async (deployment) => {
    let submitted = false;
    const app = orchestrationRoutes(
      deployment,
      {
        hasReadableSession: async () => true,
        canUserReadSession: () => true,
        conversationInputAdmissionRefusal: () => undefined,
        readCurrentConversationSession: async () => ({
          events: [
            {
              method: 'session.started',
              metadata: { environmentId: 'receiver' },
            },
          ],
        }),
      },
      {
        resolveInboundDeviceKind: () => 'delegation',
        receiverEnvironmentId: () => 'receiver',
        threadInbox: {
          submit: () => {
            submitted = true;
            return { outcome: 'queued', entry: {} };
          },
        },
      },
    );
    const response = await app.request('/conversations/one/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'follow-up', key: 'one', message: 'Hello' }),
    });
    if (!deployment.hosted)
      expect(response.status, await response.text()).toBe(202);
    return submitted;
  },
  // GET /api/knowledge/memory/queue answers only where the Private memory
  // preview is bound, which is personal hosts; hosted deployments never bind it.
  privateMemoryReview: async ({ hosted }) => {
    const home = makeTempDir('memory-flag-');
    vi.stubEnv('STATION_HOME', home);
    try {
      const persistence = new FileStorageAdapter(home);
      const store = new KnowledgeStoreProvider(persistence);
      const enabled = () => !hosted;
      const manager = new MemoryRootManager(store, persistence, home, enabled);
      const owner = sessionReadAuthorityFromRequest(
        'owner',
        undefined,
        undefined,
      );
      if (enabled()) await manager.ensureRoot(owner, () => {});
      const routes = createMemoryRoutes({
        manager,
        enabled,
        authority: () => ({ scope: owner, assertCurrent: () => {} }),
        mayReadRoot: async () => true,
        review: new MemoryReviewService({ manager, home }),
        reviewerKind: () => 'human',
        guardReadResponse: async (_request, _roots, response) => response,
      });
      return (await routes.request('/memory/queue')).status === 200;
    } finally {
      vi.unstubAllEnvs();
    }
  },
  childWorkSteering: async (deployment) => {
    const routes = orchestrationRoutes(deployment, {
      childWorkTranscripts: { ownsChild: () => true },
      readChildSteerInstructions: () => ({ entries: [] }),
    });
    return (
      (
        await routes.request(
          '/sessions/session-a/child-work/child-a/instructions',
        )
      ).status === 200
    );
  },
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
  // POST /api/read-markers/summary answers the caller's read state, keyed by
  // the same per-person (hosted: tenant) key as the inventory.
  readMarkers: async ({ hosted }) => {
    const home = makeTempDir('read-markers-flag-');
    const authority = hosted
      ? sessionReadAuthorityFromRequest(
          'alpha-user',
          { tenantId: tenantId('alpha') },
          parseHostedTenantRegistry(REGISTRY),
        )
      : sessionReadAuthorityFromRequest('operator', undefined, undefined);
    const service = new ReadMarkerService({
      personKeyFor: () => conversationAcknowledgementKey(authority),
      conversations: new FileConversationAcknowledgementStore(home),
      store: new FileReadMarkerStore(home),
      agentConversations: {
        latestVersions: async () =>
          new Map([
            ['c1', { version: 10, space: 'content', acknowledgeableUntil: 10 }],
          ]),
        versionsOf: () => new Map(),
      },
    });
    const routes = new Hono().route(
      '/api/read-markers',
      createReadMarkerRoutes({ service }),
    );
    const response = await routes.request('/api/read-markers/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets: [{ kind: 'agent-conversation', conversationId: 'c1' }],
      }),
    });
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
  // GET /api/orchestration/coordinator answers only where the runtime mounts
  // the routes with a store, from the same predicate as the flag.
  coordinatorSession: async (deployment) => {
    const eventStore = new EventStore(
      join(makeTempDir('coordinator-flag-'), 'orchestration.sqlite'),
    );
    try {
      const routes = new Hono().route(
        '/api/orchestration',
        createCoordinatorRoutes({
          store: servesCoordinatorSession(deployment)
            ? eventStore.coordinatorStore()
            : undefined,
          person: () => ({
            userId: 'owner',
            mayRead: () => true,
            mayMutate: () => true,
          }),
          dispatchActor: () => ({ userId: 'owner' }),
          preview: { select: (branches) => branches.enabled() },
        }),
      );
      const response = await routes.request('/api/orchestration/coordinator');
      return response.status === 200;
    } finally {
      eventStore.close();
    }
  },
  // POST /api/orchestration/chat holds a busy follow-up with a file (202)
  // only where the runtime builds the conversation inbox, from the same
  // predicate as the flag; without it the send is refused, never held.
  followUpAttachments: async (deployment) => {
    const world = inboxStation({
      queuedFiles: true,
      ...(servesFollowUpAttachments(deployment) ? {} : { inbox: false }),
    });
    await world.busy();
    const response = await world.send('probe-file', 'with a file', {
      whenBusy: 'queue',
      attachments: [
        {
          kind: 'file',
          name: 'probe.txt',
          mimeType: 'text/plain',
          size: 2,
          dataUrl: 'data:text/plain;base64,aGk=',
        },
      ],
    });
    return response.status === 202;
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
  // POST /scheduler/jobs accepts a job `target` (an automation that runs in
  // a conversation). The scheduler routes answer 404 to every hosted request,
  // whatever the body, because scheduler storage has no tenant binding.
  scheduledConversationTarget: async ({ hosted }) => {
    const addJob = vi.fn(async () => "Job 'digest' created");
    const routes = createSchedulerRoutes(
      { addJob } as never,
      { error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
      {
        readAuthorityForRequest: () =>
          ({ mode: hosted ? 'hosted' : 'personal' }) as never,
        admitAutomationTarget: () => ({
          ok: true,
          createdBy: { userId: 'owner' },
        }),
      },
    );
    const response = await routes.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'digest',
        schedule: { kind: 'every', everyMs: 3_600_000 },
        prompt: 'Summarize',
        target: { kind: 'conversation', conversationId: 'conversation-a' },
      }),
    });
    return (
      response.status === 200 &&
      addJob.mock.calls.length === 1 &&
      (addJob.mock.calls[0] as unknown[])[0] !== undefined &&
      ((addJob.mock.calls[0] as unknown[])[0] as { target?: unknown })
        .target !== undefined
    );
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
      personViewsEveryProject: () => true,
      preview: { select: (branches) => branches.enabled() },
    });
    return (await routes.request('/activity')).status === 200;
  },
  // POST /api/diagnostics/troubleshoot/prepare writes a run and answers the
  // seed wherever the runtime mounts it with a troubleshoot service.
  troubleshootPrepare: async () => {
    const stationRoot = makeTempDir('troubleshoot-flag-');
    const logFailure = vi.fn();
    const routes = createDiagnosticsRoutes(
      {} as never,
      { error: logFailure } as never,
      {} as never,
      {
        troubleshoot: new TroubleshootService(stationRoot, {
          stationRoot,
          collectDoctor: async () =>
            ({
              checks: [],
              recommendation: '',
              chatReady: true,
              runtimeReady: true,
            }) as never,
        }),
      },
    );
    const response = await routes.request('/troubleshoot/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok)
      throw new Error(
        `Troubleshoot capability probe failed: ${response.status}: ${logFailure.mock.calls.flatMap((call) => call.flatMap((value) => (value && typeof value === 'object' && 'error' in value && value.error instanceof Error ? [value.error.message] : []))).join('; ')}`,
        { cause: logFailure.mock.calls },
      );
    return response.status === 200;
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
  configureRuntimePublicRoutes(app as never, security, () => true);
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
    delegationToolConstraintsV1: { personal: true, hosted: true },
    peerChatTunnelV1: { personal: true, hosted: false },
    delegationLocalConversationV1: { personal: true, hosted: false },
    childWorkSteering: { personal: true, hosted: true },
    privateMemoryReview: { personal: true, hosted: false },
    privateOperationalOutcomes: { personal: true, hosted: true },
    readMarkers: { personal: true, hosted: true },
    scheduledConversationTarget: { personal: true, hosted: false },
    sessionEventWindow: { personal: true, hosted: true },
    sessionInventoryInputRead: { personal: true, hosted: false },
    eventStreamResume: { personal: true, hosted: true },
    sessionPersonReads: { personal: true, hosted: true },
    webPushNotifications: { personal: true, hosted: false },
    connectionRoutes: { personal: true, hosted: false },
    coordinatorSession: { personal: true, hosted: false },
    followUpAttachments: { personal: true, hosted: false },
    troubleshootPrepare: { personal: true, hosted: true },
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
