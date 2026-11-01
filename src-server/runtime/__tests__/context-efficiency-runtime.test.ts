import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { ProjectManifestStore } from '../../services/projects/project-manifest-store.js';
import { ProjectMembershipService } from '../../services/projects/project-membership-service.js';
import { ProjectMembershipStore } from '../../services/projects/project-membership-store.js';
import { ProjectService } from '../../services/projects/project-service.js';
import { ProjectSharedTaskStore } from '../../services/projects/project-shared-task-store.js';
import { createLogger } from '../../utils/logger.js';
import {
  composeContextEfficiencyRuntime,
  recordManagedModelContext,
} from '../context-efficiency-runtime.js';
import { modelConnectionConfigurationDigest } from '../frameworks/model-generation-identity.js';
import type { ConfigureRuntimeRoutesContext } from '../routes/runtime-routes.js';
import type { ModelGenerationObservation } from '../types.js';

const temp = trackTempDirs();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

test('the actual compaction route confirms only fresh launchable capacity for the exact provider model, connection and current configuration', async () => {
  const home = temp('context-runtime-'),
    store = new EventStore(join(home, 'events.sqlite'));
  cleanups.push(() => {
    store.close();
  });
  const owner = 'human:local:owner',
    session = 'conversation',
    now = new Date().toISOString();
  store.upsertSession({
    threadId: session,
    provider: 'station-agent',
    status: 'ready',
    createdAt: now,
    updatedAt: now,
  });
  for (const event of [
    {
      method: 'session.started',
      sessionId: session,
      metadata: { userId: owner },
    },
    { method: 'turn.started', turnId: 'turn-1', prompt: 'Measured turn' },
    { method: 'turn.completed', turnId: 'turn-1' },
  ] as const)
    store.appendEvent({
      eventId: event.method,
      threadId: session,
      provider: 'station-agent',
      createdAt: now,
      ...event,
    });
  const bus = new EventBus(),
    logger = createLogger({ name: 'context-runtime-test' });
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventStore: store,
    eventBus: bus,
    logger,
  });
  const app = new Hono(),
    previews = new FeaturePreviewRegistry(home, logger);
  const connection = {
    id: 'direct',
    type: 'openai',
    apiKey: 'fixture-nonsecret',
  };
  let inventoryEntry = {
    connectionKind: 'model',
    connectionId: 'direct',
    providerModel: 'actual-model',
    availability: 'available',
    freshness: 'live',
    observedAt: now,
    effectiveContextTokens: 2000,
  };
  const listLaunchableModelInventory = vi.fn(async () => ({
    models: [inventoryEntry],
  }));
  const context = {
    app,
    orchestrationEventStore: store,
    orchestrationService: service,
    eventBus: bus,
    featurePreviews: previews,
    logger,
    providerService: { listProviderConnections: () => [connection] },
    connectionService: { listLaunchableModelInventory },
    getLiveAppConfig: () => ({ structureModel: 'summary-model' }),
    taskGraphService: { readTaskView: () => null },
  } as unknown as ConfigureRuntimeRoutesContext;
  cleanups.push(() => service.shutdown());
  const runtime = composeContextEfficiencyRuntime(context, {
    hosted: false,
    inbox: {} as never,
    person: () =>
      ({ userId: owner, mayRead: () => true, mayMutate: () => true }) as never,
    authority: () =>
      sessionReadAuthorityFromRequest(owner, undefined, undefined),
    currentRequest: () => true,
    questionWake: () => undefined,
    taskRequestMayRead: () => true,
    taskBrief: async () => ({ kind: 'unbound' }),
    sessionTaskAccess: async () => ({ kind: 'no-task' }),
  })!;
  cleanups.push(() => runtime.close());
  await previews.setEnabled('context-compaction', true);
  const measured: ModelGenerationObservation = {
    source: 'voltagent-step',
    invocation: {
      agentSlug: 'default',
      sessionId: session,
      turnId: 'turn-1',
      principalId: owner,
    },
    modelId: 'actual-model',
    modelIdentitySource: 'provider-response',
    inputTokenAccounting: 'total',
    inputTokens: 800,
    outputTokens: 100,
    connectionId: 'direct',
    connectionConfigurationDigest:
      modelConnectionConfigurationDigest(connection),
  };
  const read = async () => {
    const response = await app.request(
      `/api/orchestration/conversations/${session}/compaction`,
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  };
  expect(await read()).not.toHaveProperty('data.confirmedContext');
  recordManagedModelContext(store, measured);
  expect(await read()).toMatchObject({
    data: {
      confirmedContext: {
        contextTokens: 900,
        contextWindowTokens: 2000,
        modelId: 'actual-model',
      },
    },
  });
  const valid = { ...inventoryEntry };
  for (const invalid of [
    { freshness: 'configured' },
    { freshness: 'stale' },
    { observedAt: new Date(Date.now() - 16 * 60_000).toISOString() },
    { observedAt: new Date(Date.now() + 60_000).toISOString() },
    { connectionId: 'another' },
    { providerModel: 'another' },
    { connectionKind: 'engine' },
    { availability: 'unavailable' },
    { effectiveContextTokens: 0 },
  ]) {
    inventoryEntry = { ...valid, ...invalid };
    expect(await read()).not.toHaveProperty('data.confirmedContext');
  }
  inventoryEntry = valid;
  connection.apiKey = 'changed-configuration';
  expect(await read()).not.toHaveProperty('data.confirmedContext');
  expect(listLaunchableModelInventory).toHaveBeenCalled();
});

test.each([false, true])(
  'a zero-turn Task refresh with revoked response share=%s keeps context private and needs no summary model',
  async (revokeAtRelease) => {
    const home = temp('zero-turn-task-context-'),
      store = new EventStore(join(home, 'events.sqlite'));
    cleanups.push(() => {
      store.close();
    });
    const session = 'fresh-task',
      principal = humanPrincipal('deployment', 'owner', 'Owner'),
      owner = principal.id,
      now = new Date().toISOString();
    const storage = new FileStorageAdapter(home),
      manifests = new ProjectManifestStore(home, storage),
      projects = new ProjectService(storage, manifests);
    const project = await projects.createProject({
      name: 'Context Task',
      slug: 'project',
    });
    const accessDb = new DatabaseSync(join(home, 'access.sqlite'));
    cleanups.push(() => accessDb.close());
    const members = new ProjectMembershipStore(accessDb, 'context-station'),
      membership = new ProjectMembershipService(
        'context-station',
        storage,
        manifests,
        members,
      );
    const admission = await membership.enable('project', project.id, {
      current: async () => ({ principal, verifiedEmails: [] }),
      operator: async () => {},
    });
    const shares = new ProjectSharedTaskStore(accessDb);

    const task = {
      id: 'task',
      projectId: project.id,
      createdAt: now,
      title: 'Current Task',
      description: 'Use the repaired mandatory guidance.',
      status: 'in_progress',
      sessionId: session,
    };
    const share = shares.share({
      scope: admission.scope,
      taskId: task.id,
      taskCreatedAt: task.createdAt,
      sharedBy: owner,
    });
    store.upsertSession({
      threadId: session,
      provider: 'station-agent',
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    });
    store.appendEvent({
      eventId: 'task-start',
      sessionId: session,
      threadId: session,
      provider: 'station-agent',
      createdAt: now,
      method: 'session.started',
      initialState: 'created',
      metadata: {
        userId: owner,
        stationTaskBrief: {
          version: 'station.task-brief/v1',
          text: 'Withdrawn guidance.',
          digest: 'c'.repeat(64),
          mandatoryContextDigest: 'd'.repeat(64),
          learningContributions: [],
        },
      },
    });
    store.appendEvent({
      eventId: 'task-configured',
      threadId: session,
      provider: 'station-agent',
      createdAt: now,
      method: 'session.configured',
      sessionId: session,
      metadata: { userId: owner },
    });
    await store.bindProjectTaskRoomExecution({
      sessionId: session,
      projectId: task.projectId,
      taskId: task.id,
    });
    const bus = new EventBus(),
      logger = createLogger({ name: 'zero-turn-context' }),
      app = new Hono(),
      previews = new FeaturePreviewRegistry(home, logger);
    const service = new OrchestrationService({
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      eventStore: store,
      eventBus: bus,
      logger,
    });
    const generation = vi.fn(() => {
      throw new Error('A Task refresh must never call a summary model.');
    });
    const context = {
      app,
      orchestrationEventStore: store,
      orchestrationService: service,
      eventBus: bus,
      featurePreviews: previews,
      logger,
      taskGraphService: {
        readTaskView: (id: string) => (id === task.id ? task : null),
      },
      projectService: projects,
      projectMembership: membership,
      projectSharedTasks: shares,
      storageAdapter: storage,
      configLoader: { getProjectHomeDir: () => home },
      getLiveAppConfig: () => ({}),
      buildRuntimeContext: generation,
    } as unknown as ConfigureRuntimeRoutesContext;
    cleanups.push(() => service.shutdown());
    const runtime = composeContextEfficiencyRuntime(context, {
      hosted: false,
      inbox: {} as never,
      person: () =>
        ({
          userId: owner,
          mayRead: () => true,
          mayMutate: () => true,
        }) as never,
      authority: () =>
        sessionReadAuthorityFromRequest(owner, undefined, undefined),
      currentRequest: () => true,
      questionWake: () => undefined,
      taskRequestMayRead: () => true,
      sessionTaskAccess: async () =>
        ({
          kind: 'granted',
          write: {
            taskId: task.id,
            taskCreatedAt: task.createdAt,
            projectId: task.projectId,
            beforeCommit: () => true,
          },
        }) as never,
      taskBrief: async () =>
        ({
          kind: 'brief',
          brief: {
            text: 'Current bounded Task brief with repaired guidance.',
            digest: 'a'.repeat(64),
            mandatoryContextDigest: 'b'.repeat(64),
            documentRevision: 2,
            summaryRevision: 1,
            learningContributions: [],
          },
        }) as never,
    })!;
    cleanups.push(() => runtime.close());
    await previews.setEnabled('context-compaction', true);
    const placement = store.sessionTurnBoundaryAuthority().claim(session, now);
    expect(placement.kind).toBe('owner');
    const held = await app.request(
      `/api/orchestration/conversations/${session}/compaction`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedSessionId: session,
          operationId: 'b0d6c725-4f89-4ca6-929d-8c1e9c8b615b',
          mode: 'manual',
        }),
      },
    );
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({
      code: 'context_compaction_busy',
    });
    if (placement.kind !== 'owner')
      throw new Error('Expected a real prepared placement claim.');
    expect(placement.claim.notInvoked()).toEqual({ kind: 'applied' });
    const response = await app.request(
      `/api/orchestration/conversations/${session}/compaction`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedSessionId: session,
          operationId: 'b0d6c725-4f89-4ca6-929d-8c1e9c8b615b',
          mode: 'manual',
        }),
      },
    );
    expect(response.status).toBe(200);
    if (revokeAtRelease) {
      shares.unshare(task.id, share.shareId);
      await expect(response.json()).rejects.toThrow(
        'Project authorization ended before response delivery',
      );
    } else {
      const body = await response.json();
      expect(body).toMatchObject({
        data: {
          kind: 'record',
          operation: {
            state: 'reserved',
            contextKind: 'task-state',
            seed: {
              kind: 'task-state',
              length: 'Current bounded Task brief with repaired guidance.'
                .length,
            },
          },
        },
      });
      expect(JSON.stringify(body)).not.toContain('Current bounded Task brief');
      expect(JSON.stringify(body)).not.toContain('mandatoryContextDigest');
      expect(JSON.stringify(body)).not.toContain('learningContributions');
    }
    expect(
      runtime.compactions.status('b0d6c725-4f89-4ca6-929d-8c1e9c8b615b', owner),
    ).toMatchObject({
      state: 'reserved',
      seed: { kind: 'task-state', mandatoryContextDigest: 'b'.repeat(64) },
    });
    expect(generation).not.toHaveBeenCalled();
    expect(store.latestEventByMethod(session, 'turn.started')).toBeUndefined();
  },
);
