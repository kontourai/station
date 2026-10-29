import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import {
  AgentRegistry,
  TriggerRegistry,
  WorkflowRegistry,
} from '@voltagent/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { continuityRegistry } from '../../../__test-utils__/scripted-continuity-adapter.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createConversationRoutes } from '../../../routes/chat/conversations.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createRuntimeNativeForkReadAdmissionDomain } from '../../../security/native-fork-read-admission.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { createLogger } from '../../../utils/logger.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { ChildWorkProjection } from '../child-work-projection.js';
import {
  createConversationForkContext,
  decodeCommittedNativeForkCreation,
  type NativeForkCommitInput,
  type NativeForkEffectClaim,
  type NativeForkSourceSeal,
  nativeForkHash,
} from '../conversation-fork-context.js';
import { ConversationTurnActivityProjection } from '../conversation-turn-activity.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { runSessionStartWithBoundary } from '../session-turn-boundary.js';

const NOW = '2030-01-01T00:00:00.000Z';
const SOURCE_KEY = 'a'.repeat(64);
const CHILD_KEY = 'b'.repeat(64);
const BINDING_KEY = 'c'.repeat(64);

describe('native fork SQLite effect and publication ownership', () => {
  const temp = trackTempDirs();
  const stores = new Set<EventStore>();
  const peers = new Set<DatabaseSync>();
  const services = new Set<OrchestrationService>();
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const service of services) await service.shutdown();
    services.clear();
    for (const peer of peers) peer.close();
    peers.clear();
    for (const store of stores) store.close();
    stores.clear();
  });
  function fixture(
    options: {
      tenant?: boolean;
      project?: boolean;
      explicitOwned?: boolean;
      contextText?: string;
      initialChildModel?: string;
      idempotencyKey?: string;
    } = {},
  ) {
    const root = temp('station-native-fork-effect-');
    const path = join(root, 'events.sqlite');
    let store = new EventStore(path);
    stores.add(store);
    const sourceSession: ProviderSession = {
      provider: 'codex',
      threadId: 'source',
      status: 'ready',
      ...(options.explicitOwned
        ? { controlMode: 'station-owned' as const }
        : {}),
      ...(options.tenant
        ? {
            tenantExecutionContext: {
              tenantId: tenantId('tenant-one'),
              source: 'session' as const,
            },
          }
        : {}),
      cwd: root,
      resumeCursor: { nativeSessionId: 'source-native' },
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.upsertSession(sourceSession);
    store.claimNativeSessionIdentity(SOURCE_KEY, 'source');
    store.appendEvent({
      eventId: 'source-configured',
      provider: 'codex',
      threadId: 'source',
      sessionId: 'source',
      method: 'session.configured',
      cwd: root,
      createdAt: NOW,
      metadata: {
        userId: 'owner',
        agentSlug: 'codex',
        environmentId: 'local',
        ...(options.project ? { projectSlug: 'project-one' } : {}),
        nativeResumeBindingKey: BINDING_KEY,
      },
    });
    store.appendEvent({
      eventId: 'source-done',
      provider: 'codex',
      threadId: 'source',
      turnId: 'turn-one',
      method: 'turn.completed',
      finishReason: 'stop',
      createdAt: NOW,
    });
    const snapshot = createConversationForkContext({
      forkEventId: 'fork-event',
      sourceConversationId: 'source',
      sourceSessionId: 'source',
      sourceAgent: 'codex',
      targetConversationId: 'child',
      targetAgent: 'codex',
      ownerUserId: 'owner',
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      ...(options.tenant ? { tenantId: 'tenant-one' } : {}),
      ...(options.project ? { projectSlug: 'project-one' } : {}),
      branchPointTurnId: 'turn-one',
      sourceTitle: 'Source',
      createdAt: NOW,
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          parts: [
            { type: 'text', text: options.contextText ?? 'Selected answer' },
          ],
        },
      ],
    });
    store.reserveConversationForkContext(snapshot);
    const source: NativeForkSourceSeal = {
      sourceConversationId: 'source',
      sourceSessionId: 'source',
      selectedEventId: 'source-done',
      selectedTurnId: 'turn-one',
      headEventId: 'source-done',
      nativeIdentityKey: SOURCE_KEY,
      nativeResumeBindingKey: BINDING_KEY,
      provider: 'codex',
      environmentId: 'local',
      agentId: 'codex',
      cwd: root,
    };
    const forkEvent: CanonicalRuntimeEvent = {
      eventId: 'fork-event',
      provider: 'station',
      threadId: 'source',
      method: 'conversation.forked',
      sourceConversationId: 'source',
      targetConversationId: 'child',
      targetAgent: 'codex',
      sourceSessionId: 'source',
      branchPointTurnId: 'turn-one',
      forkedAt: NOW,
      createdAt: NOW,
      contextDigest: snapshot.digest,
      continuation: 'native',
    };
    const replay: CanonicalRuntimeEvent = {
      ...forkEvent,
      continuation: 'replay-seed',
    };
    const commit: NativeForkCommitInput = {
      startedEvent: {
        eventId: 'child-started',
        provider: 'codex',
        threadId: 'child',
        sessionId: 'child',
        method: 'session.started',
        createdAt: NOW,
        metadata: {
          userId: 'owner',
          agentSlug: 'codex',
          environmentId: 'local',
          nativeResumeBindingKey: BINDING_KEY,
          ...(options.project ? { projectSlug: 'project-one' } : {}),
          ...(options.tenant
            ? {
                tenantId: 'tenant-one',
                tenantExecutionContext: {
                  tenantId: 'tenant-one',
                  source: 'session',
                },
              }
            : {}),
        },
      },
      child: {
        ...sourceSession,
        ...(options.initialChildModel
          ? { model: options.initialChildModel }
          : {}),
        threadId: 'child',
        resumeCursor: { nativeSessionId: 'child-native' },
      },
      configuredEvent: {
        eventId: 'child-configured',
        provider: 'codex',
        threadId: 'child',
        sessionId: 'child',
        method: 'session.configured',
        cwd: root,
        createdAt: NOW,
        metadata: {
          userId: 'owner',
          agentSlug: 'codex',
          environmentId: 'local',
          ...(options.project ? { projectSlug: 'project-one' } : {}),
          ...(options.tenant
            ? {
                tenantId: 'tenant-one',
                tenantExecutionContext: {
                  tenantId: 'tenant-one',
                  source: 'session',
                },
              }
            : {}),
          nativeResumeBindingKey: BINDING_KEY,
        },
      },
      forkEvent,
    };
    const peer = new DatabaseSync(path, { readOnly: true });
    peers.add(peer);
    return {
      path,
      peer,
      get store() {
        return store;
      },
      snapshot,
      source,
      commit,
      replay,
      reserve() {
        const result = store.reserveNativeForkEffect({
          targetId: 'child',
          contextDigest: snapshot.digest,
          source,
        });
        if (result.kind !== 'owner')
          throw new Error('Expected an actual native effect owner');
        return result.effect;
      },
      reopen() {
        store.close();
        stores.delete(store);
        store = new EventStore(path);
        stores.add(store);
      },
      observe(effect: NativeForkEffectClaim) {
        effect.observeChild(commit.child.resumeCursor, CHILD_KEY);
        store.claimNativeSessionIdentity(CHILD_KEY, 'child');
      },
    };
  }

  async function storedReadFixture(
    options: {
      accountMember?: boolean;
      foreignOwner?: boolean;
      route?: boolean;
      replay?: boolean;
      hosted?: boolean;
    } = {},
  ) {
    const f = fixture({
      ...(options.route ? { idempotencyKey: 'stored-route-retry' } : {}),
      ...(options.hosted ? { tenant: true } : {}),
    });
    if (options.replay) {
      f.store.publishConversationForkContext(f.replay, f.snapshot.digest);
    } else {
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      effect.commit(f.commit);
    }
    const security = new EnvironmentSecurityService({
      homeDir: temp('station-native-stored-request-'),
    });
    const credential = await security.initialize();
    const request = new Request(
      'http://stored-read.station/agents/codex/conversations/source/fork',
      { method: 'POST' },
    );
    setRuntimeAuthenticatedRequestPrincipal(request, {
      kind: 'credential',
      authority: 'operator-credential',
      source: 'bearer',
      credential: credential.credential,
    });
    const registry = options.hosted
      ? parseHostedTenantRegistry({
          schemaVersion: 1,
          tenants: [
            { id: tenantId('tenant-one'), authority: 'tenant.example.test' },
          ],
        })
      : undefined;
    const authority = sessionReadAuthorityFromRequest(
      options.foreignOwner
        ? 'unrelated-owner'
        : options.accountMember
          ? 'account-reader'
          : 'owner',
      registry ? { tenantId: tenantId('tenant-one') } : undefined,
      registry,
    );
    const domain = createRuntimeNativeForkReadAdmissionDomain(security);
    const mount = domain.bindAtConversationMount(() => authority);
    if (mount.kind !== 'bound') throw new Error('Expected paired mount');
    const captured = mount.capture(request);
    if (captured.kind !== 'captured')
      throw new Error('Expected real credential capture');
    const bus = new EventBus();
    const service = new OrchestrationService({
      eventStore: f.store,
      eventBus: bus,
      adapterRegistry: continuityRegistry([]),
      logger: createLogger({
        name: 'native-stored-read-owner',
        level: 'error',
      }),
      idleSessionParkAfterMs: 0,
      nativeForkStoredReadVerifier: domain.verifyForService,
      ...(registry
        ? {
            requireTenantExecutionContext: () => true,
            validateRecoveredTenantExecutionContext: (
              context:
                | import('@kontourai/station-contracts/tenancy').TenantExecutionContext
                | undefined,
            ) =>
              context &&
              registry.tenants.some((entry) => entry.id === context.tenantId)
                ? context
                : undefined,
          }
        : {}),
      ...(options.accountMember
        ? {
            personalConversationAccess: {
              canRead: (reader: string, owner: string) =>
                reader === 'account-reader' && owner === 'owner',
              ownerIds: () => ['owner'],
            },
          }
        : {}),
    });
    services.add(service);
    // Explicit test runtime setup is outside the read under test. The read
    // entry must not initialize, recover, start providers or warm cold history.
    service.initialize();
    await service.whenSessionAttachmentSettled();
    if (!options.replay) {
      // Genuine fixture report facts, before ordinary warming and outside
      // every measured read. An empty history seed alone is not a report.
      for (const threadId of ['source', 'child'])
        f.store.appendEvent({
          eventId: `reported-${threadId}`,
          provider: 'codex',
          threadId,
          method: 'child-work.updated',
          createdAt: '2030-01-01T00:00:01.000Z',
          delta: {
            kind: 'snapshot',
            producer: 'engine-subagent',
            reporterThreadId: threadId,
            running: [],
          },
        });
    }
    return {
      f,
      service,
      bus,
      security,
      domain,
      mount,
      handle: captured.handle,
      authority,
    };
  }

  test('stored service read refuses cold history before any direct or activity-induced load', async () => {
    const { f, service, bus, handle } = await storedReadFixture();
    const history = vi.spyOn(f.store, 'listChildWorkHistoryForThreads');
    const writes = vi.spyOn(f.store, 'upsertSession');
    const append = vi.spyOn(f.store, 'appendEvent');
    const live = vi.spyOn(bus, 'emit');
    const result = service.readNativeForkStoredCreation(
      'child',
      f.snapshot.digest,
      handle,
    );
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'cold-settled-evidence-budget-missing',
    });
    expect(history).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'warm stored service read preserves current facts using existing owner/account policy: member=%s',
    async (accountMember) => {
      const { f, service, bus, authority, handle, mount } =
        await storedReadFixture({ accountMember });
      // Deliberate ordinary-reader setup reaches the EXISTING seed owner. The
      // stored-only read below must neither repeat it nor refresh activity.
      for (const threadId of ['source', 'child'])
        expect(
          await service.readSession(threadId, authority, {
            eventMethods: ['session.started', 'session.configured'],
          }),
        ).not.toBeNull();
      const current = f.store.readSessionByThread('child');
      if (!current) throw new Error('Missing current stored child');
      const later = {
        ...current,
        status: 'error' as const,
        model: 'later-model',
        resumeCursor: { nativeSessionId: 'later-current' },
        updatedAt: '2030-01-01T00:02:00.000Z',
      };
      f.store.upsertSession(later);
      for (const threadId of ['source', 'child'])
        await service.readSession(threadId, authority, {
          eventMethods: ['session.started', 'session.configured'],
        });
      const history = vi.spyOn(f.store, 'listChildWorkHistoryForThreads');
      const writes = vi.spyOn(f.store, 'upsertSession');
      const append = vi.spyOn(f.store, 'appendEvent');
      const live = vi.spyOn(bus, 'emit');
      const result = service.readNativeForkStoredCreation(
        'child',
        f.snapshot.digest,
        handle,
      );
      expect(result.kind).toBe('stored-creation');
      if (result.kind !== 'stored-creation')
        throw new Error('Expected stored creation');
      expect(result.observation.currentSession).toMatchObject(later);
      expect(result.observation.creation.initialChild.resumeCursor).toEqual(
        f.commit.child.resumeCursor,
      );
      expect(result.observation.canonicalProjection).toBe('not-supplied');
      expect(result.observation.activation).toBe('unwired');
      expect(result.warmCurrent.kind).toBe('warm-current');
      expect(history).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(live).not.toHaveBeenCalled();
      mount.release(handle);
      expect(
        service.readNativeForkStoredCreation(
          'child',
          f.snapshot.digest,
          handle,
        ),
      ).toEqual({ kind: 'unavailable', reason: 'request-not-current' });
    },
  );

  test('warm current activity follows real commits without any cold fallback or stored model reset', async () => {
    const { f, service, authority, handle, bus } = await storedReadFixture();
    for (const id of ['source', 'child'])
      await service.readSession(id, authority, {
        eventMethods: ['session.started', 'session.configured'],
      });
    const stored = f.store.readSessionByThread('child');
    f.store.appendEvent({
      eventId: 'warm-live-start',
      provider: 'codex',
      threadId: 'child',
      method: 'turn.started',
      turnId: 'warm-live',
      createdAt: '2030-01-01T00:00:02.000Z',
    });
    const history = vi.spyOn(f.store, 'listChildWorkHistoryForThreads');
    const lineage = vi.spyOn(f.store, 'conversationSessions');
    const seed = vi.spyOn(f.store, 'listSessionProjectionEvents');
    const turnSeed = vi.spyOn(f.store, 'readTurnActivitySeed');
    const writes = vi.spyOn(f.store, 'upsertSession');
    const live = vi.spyOn(bus, 'emit');
    const running = service.readNativeForkStoredCreation(
      'child',
      f.snapshot.digest,
      handle,
    );
    expect(running.kind).toBe('stored-creation');
    if (running.kind !== 'stored-creation')
      throw new Error('Expected warm read');
    expect(
      running.warmCurrent.conversations.find(
        (row) => row.conversationId === 'child',
      )?.openTurn?.turnId,
    ).toBe('warm-live');
    expect(running.observation.currentSession).toEqual(stored);
    expect(running.observation.canonicalProjection).toBe('not-supplied');
    expect(running.observation.activation).toBe('unwired');
    expect(history).not.toHaveBeenCalled();
    expect(lineage).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
    expect(turnSeed).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
    f.store.appendEvent({
      eventId: 'warm-live-done',
      provider: 'codex',
      threadId: 'child',
      method: 'turn.completed',
      turnId: 'warm-live',
      finishReason: 'stop',
      createdAt: '2030-01-01T00:00:03.000Z',
    });
    const done = service.readNativeForkStoredCreation(
      'child',
      f.snapshot.digest,
      handle,
    );
    expect(done.kind).toBe('stored-creation');
    if (done.kind !== 'stored-creation')
      throw new Error('Expected updated warm read');
    const current = done.warmCurrent.conversations.find(
      (row) => row.conversationId === 'child',
    );
    expect(current?.openTurn).toBeUndefined();
    expect(current!.asOfSequence).toBeGreaterThan(
      running.warmCurrent.conversations.find(
        (row) => row.conversationId === 'child',
      )!.asOfSequence,
    );
  });

  test('warm service reentry stays in the same scope and restores its guard on revoked return', async () => {
    const { f, service, authority, handle, mount } = await storedReadFixture();
    for (const id of ['source', 'child'])
      await service.readSession(id, authority, {
        eventMethods: ['session.started', 'session.configured'],
      });
    const original = ChildWorkProjection.prototype.readWarmReporter;
    let nested:
      | ReturnType<OrchestrationService['readNativeForkStoredCreation']>
      | undefined;
    let entered = false;
    const read = vi
      .spyOn(ChildWorkProjection.prototype, 'readWarmReporter')
      .mockImplementation(function (this: ChildWorkProjection, ...args) {
        if (!entered) {
          entered = true;
          nested = service.readNativeForkStoredCreation(
            'child',
            f.snapshot.digest,
            handle,
          );
        }
        return original.apply(this, args);
      });
    expect(
      service.readNativeForkStoredCreation('child', f.snapshot.digest, handle)
        .kind,
    ).toBe('stored-creation');
    expect(nested?.kind).toBe('stored-creation');
    const observation = vi.spyOn(f.store, 'observeCommittedNativeFork');
    entered = false;
    read.mockImplementation(function (this: ChildWorkProjection, ...args) {
      if (!entered) {
        entered = true;
        nested = service.readNativeForkStoredCreation(
          'outside',
          f.snapshot.digest,
          handle,
        );
      }
      return original.apply(this, args);
    });
    expect(
      service.readNativeForkStoredCreation('child', f.snapshot.digest, handle)
        .kind,
    ).toBe('unavailable');
    expect(nested).toEqual({
      kind: 'unavailable',
      reason: 'warm-scope-widening-or-stale',
    });
    expect(observation.mock.calls.every((args) => args[0] === 'child')).toBe(
      true,
    );
    read.mockImplementation(function (this: ChildWorkProjection, ...args) {
      const result = original.apply(this, args);
      mount.release(handle);
      return result;
    });
    expect(
      service.readNativeForkStoredCreation('child', f.snapshot.digest, handle)
        .kind,
    ).toBe('unavailable');
    read.mockRestore();
    // Ordinary reads must not inherit the now-revoked private warm scope.
    expect(
      await service.readSession('source', authority, {
        eventMethods: ['session.configured'],
      }),
    ).not.toBeNull();
  });

  test('service rejects an unknown handle before bounded creation read', async () => {
    const { f, service } = await storedReadFixture();
    const read = vi.spyOn(f.store, 'observeCommittedNativeFork');
    const forgedCurrent = vi.fn(() => true);
    expect(
      service.readNativeForkStoredCreation('child', f.snapshot.digest, {
        checkCurrent: forgedCurrent,
      }),
    ).toEqual({ kind: 'unavailable', reason: 'request-not-current' });
    expect(read).not.toHaveBeenCalled();
    expect(forgedCurrent).not.toHaveBeenCalled();
  });

  test('current credential cannot read a stored fork owned by an unrelated principal', async () => {
    const { f, service, handle } = await storedReadFixture({
      foreignOwner: true,
    });
    const read = vi.spyOn(f.store, 'observeCommittedNativeFork');
    const history = vi.spyOn(f.store, 'listChildWorkHistoryForThreads');
    expect(
      service.readNativeForkStoredCreation('child', f.snapshot.digest, handle),
    ).toEqual({ kind: 'unavailable', reason: 'affected-owner-unavailable' });
    expect(read).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  test.each([
    'cold',
    'warm',
    'rotated',
    'record-missing',
    'hosted',
    'replay',
  ] as const)(
    'fork retry consumes actual final-Request admission without claiming native activation: %s',
    async (mode) => {
      const { f, service, security, domain, mount, authority } =
        await storedReadFixture({
          route: true,
          replay: mode === 'replay',
          hosted: mode === 'hosted',
        });
      if (mode === 'warm') {
        for (const id of ['source', 'child'])
          expect(
            await service.readSession(id, authority, {
              eventMethods: ['session.started', 'session.configured'],
            }),
          ).not.toBeNull();
      }
      if (mode === 'record-missing') {
        // Corruption control: the canonical native fact must still prevent a
        // replay reply when its native projection row was lost externally.
        const canonicalBefore = f.peer
          .prepare('SELECT payload FROM orchestration_events WHERE id = ?')
          .get(f.snapshot.forkEventId);
        expect(canonicalBefore).toBeDefined();
        const corruption = new DatabaseSync(f.path);
        try {
          expect(
            corruption
              .prepare(
                'DELETE FROM orchestration_conversation_native_fork_effect WHERE target_conversation_id = ?',
              )
              .run('child').changes,
          ).toBe(1);
        } finally {
          corruption.close();
        }
        expect(
          f.peer
            .prepare(
              'SELECT target_conversation_id FROM orchestration_conversation_native_fork_effect WHERE target_conversation_id = ?',
            )
            .get('child'),
        ).toBeUndefined();
        expect(
          f.peer
            .prepare('SELECT payload FROM orchestration_events WHERE id = ?')
            .get(f.snapshot.forkEventId),
        ).toEqual(canonicalBefore);
      }
      const credential = (await security.initialize()).credential;
      const logger = createLogger({
        name: 'native-stored-route-owner',
        level: 'error',
      });
      const { createVoltAgentApp } = await import('@voltagent/server-hono');
      const { app } = await createVoltAgentApp(
        {
          agentRegistry: AgentRegistry.getInstance(),
          workflowRegistry: WorkflowRegistry.getInstance(),
          triggerRegistry: TriggerRegistry.getInstance(),
        },
        { configureFullApp: () => {} },
      );
      configureRuntimeHttp({
        app,
        logger,
        eventBus: new EventBus(),
        security: {
          verifyCredential: (candidate, route) =>
            route
              ? security.authorizeCredential(candidate, route)
              : security.verifyCredential(candidate),
          recognizeCredential: (candidate) =>
            security.verifyCredential(candidate),
          resolveGrantedScope: (candidate) =>
            security.resolveGrantedScope(candidate),
          resolveCredentialAuthority: (candidate) =>
            security.verifyOperatorCredential(candidate)
              ? 'operator-credential'
              : undefined,
        },
      });
      let knownAgentCalls = 0;
      const read = vi.spyOn(service, 'readNativeForkStoredCreation');
      const publish = vi.spyOn(f.store, 'publishConversationForkContext');
      const history = vi.spyOn(f.store, 'listChildWorkHistoryForThreads');
      const writes = vi.spyOn(f.store, 'upsertSession');
      const append = vi.spyOn(f.store, 'appendEvent');
      const route = createConversationRoutes(
        new Map(),
        logger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        service,
        undefined,
        undefined,
        () => authority,
        service,
        async () => {
          knownAgentCalls++;
          // Genuine middleware admission already happened; rotation occurs
          // during an existing awaited route preparation, before capture.
          if (mode === 'rotated' && knownAgentCalls === 2)
            await security.rotateCredential();
          return true;
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { admission: mount, service },
      );
      app.route('/agents', route);
      const response = await app.request(
        'http://stored-read.station/agents/codex/conversations/source/fork',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            targetAgent: 'codex',
            idempotencyKey: 'stored-route-retry',
          }),
        },
      );
      if (mode === 'replay') {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          success: true,
          data: { continuation: 'replay-seed', idempotent: true },
        });
        expect(read).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          success: false,
          code: 'conversation-context-unavailable',
        });
        if (mode === 'rotated') {
          expect(read).not.toHaveBeenCalled();
        } else {
          expect(read).toHaveBeenCalledOnce();
          const handle = read.mock.calls[0]?.[2];
          expect(handle).toBeDefined();
          // Real per-domain lookup, not a fake release/capture return value.
          expect(domain.verifyForService(handle).kind).toBe('unavailable');
          const result = read.mock.results[0];
          expect(result?.type).toBe('return');
          if (mode === 'warm')
            expect(result?.value.kind).toBe('stored-creation');
          if (mode === 'cold')
            expect(result?.value).toEqual({
              kind: 'unavailable',
              reason: 'cold-settled-evidence-budget-missing',
            });
          if (mode === 'record-missing')
            expect(result?.value).toEqual({
              kind: 'unavailable',
              reason: 'creation-not-verified',
            });
          if (mode === 'hosted')
            expect(result?.value).toEqual({
              kind: 'unavailable',
              reason: 'affected-tenant-evidence-unavailable',
            });
        }
      }
      expect(publish).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    },
  );

  test('committed observation preserves later current state/cursor/history and performs zero writes or claim acquisition', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    effect.commit(f.commit);
    const laterCursor = { nativeSessionId: 'current-cursor', revision: 2 };
    f.store.upsertSession({
      ...f.commit.child,
      status: 'closed',
      resumeCursor: laterCursor,
      updatedAt: '2030-01-01T00:01:00.000Z',
    });
    f.store.appendEvent({
      eventId: 'later-answer',
      provider: 'codex',
      threadId: 'child',
      turnId: 'later-turn',
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Later canonical progress',
      createdAt: '2030-01-01T00:01:00.000Z',
    });
    const append = vi.spyOn(f.store, 'appendEvent');
    const upsert = vi.spyOn(f.store, 'upsertSession');
    const reserve = vi.spyOn(f.store, 'reserveNativeForkEffect');
    const before = f.store['db']
      .prepare('SELECT total_changes() AS n')
      .get()?.n;
    const projection = vi
      .spyOn(f.store, 'listSessionProjectionEvents')
      .mockImplementation(() => {
        throw new Error('Projection is intentionally not supplied');
      });
    const observed = f.store.observeCommittedNativeFork(
      'child',
      f.snapshot.digest,
    );
    expect(projection).not.toHaveBeenCalled();
    expect(observed.kind).toBe('verified-creation');
    if (observed.kind !== 'verified-creation')
      throw new Error('Expected verified creation only');
    expect(observed.activation).toBe('unwired');
    expect(observed.creation.initialChild.resumeCursor).toEqual(
      f.commit.child.resumeCursor,
    );
    expect(observed.currentSession.status).toBe('closed');
    expect(observed.currentSession.resumeCursor).toEqual(laterCursor);
    expect(observed.canonicalProjection).toBe('not-supplied');
    expect(observed).not.toHaveProperty('currentProjectionEvents');
    expect(f.store.hasEventId('later-answer')).toBe(true);
    expect(observed.affected.threadIds).toEqual(
      expect.arrayContaining(['source', 'child']),
    );
    expect(f.store['db'].prepare('SELECT total_changes() AS n').get()?.n).toBe(
      before,
    );
    expect(append).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(
      f.peer
        .prepare(
          "SELECT status FROM provider_session_state WHERE thread_id='child'",
        )
        .get()?.status,
    ).toBe('closed');
  });

  test('COMMIT-then-throw can be observed without another fork or historical initialization insertion', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    const exec = f.store['db'].exec.bind(f.store['db']);
    const fault = vi.spyOn(f.store['db'], 'exec').mockImplementation((sql) => {
      const result = exec(sql);
      if (sql === 'COMMIT') throw new Error('uncertain committed creation');
      return result;
    });
    expect(() => effect.commit(f.commit)).toThrow();
    fault.mockRestore();
    const before = f.store['db']
      .prepare('SELECT total_changes() AS n')
      .get()?.n;
    expect(
      f.store.observeCommittedNativeFork('child', f.snapshot.digest).kind,
    ).toBe('verified-creation');
    expect(effect.sessionStart.beginInvocation(NOW).kind).not.toBe('applied');
    expect(f.store['db'].prepare('SELECT total_changes() AS n').get()?.n).toBe(
      before,
    );
  });

  test.each([
    'json',
    'outer-field',
    'method',
    'environment',
    'cursor',
    'order',
    'oversize',
  ] as const)(
    'strict creation observation refuses %s corruption without writing',
    (kind) => {
      const f = fixture();
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      effect.commit(f.commit);
      const record = f.store.readNativeForkEffect('child');
      if (!record?.commitJson) throw new Error('Expected retained receipt');
      if (kind === 'order')
        f.store['db']
          .prepare(
            "UPDATE orchestration_events SET global_sequence = global_sequence + 100000 WHERE id='child-started'",
          )
          .run();
      else {
        let json = record.commitJson;
        if (kind === 'json') json = '{';
        if (kind === 'oversize') json = ' '.repeat(2 * 1024 * 1024 + 1);
        if (kind === 'outer-field')
          json = JSON.stringify({ ...f.commit, unexpected: true });
        if (kind === 'method')
          json = JSON.stringify({
            ...f.commit,
            startedEvent: {
              ...f.commit.startedEvent,
              method: 'session.exited',
            },
          });
        if (kind === 'environment')
          json = JSON.stringify({
            ...f.commit,
            configuredEvent: {
              ...f.commit.configuredEvent,
              metadata: {
                ...f.commit.configuredEvent.metadata,
                environmentId: 'foreign',
              },
            },
          });
        if (kind === 'cursor')
          json = JSON.stringify({
            ...f.commit,
            child: {
              ...f.commit.child,
              resumeCursor: { nativeSessionId: 'forged' },
            },
          });
        f.store['db']
          .prepare(
            'UPDATE orchestration_conversation_native_fork_effect SET record_json = ? WHERE target_conversation_id = ?',
          )
          .run(
            JSON.stringify({
              ...record,
              commitJson: json,
              commitDigest: nativeForkHash(json),
            }),
            'child',
          );
        if (['json', 'outer-field', 'method', 'oversize'].includes(kind))
          expect(() => decodeCommittedNativeForkCreation(json)).toThrow();
      }
      const before = f.store['db']
        .prepare('SELECT total_changes() AS n')
        .get()?.n;
      expect(
        f.store.observeCommittedNativeFork('child', f.snapshot.digest).kind,
      ).toBe('unavailable');
      expect(
        f.store['db'].prepare('SELECT total_changes() AS n').get()?.n,
      ).toBe(before);
    },
  );

  test('canonical lineage beyond the finite observation boundary returns unbounded', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    effect.commit(f.commit);
    let prior = 'source';
    for (let index = 0; index < 256; index++) {
      prior = f.store.reserveNextConversationSession({
        conversationId: 'source',
        predecessorSessionId: prior,
        proposedSessionId: `source-next-${index}`,
        createdAt: NOW,
      }).lineage.sessionId;
    }
    expect(
      f.store.observeCommittedNativeFork('child', f.snapshot.digest),
    ).toEqual({ kind: 'unavailable', reason: 'unbounded' });
  });

  function watchDriver(f: ReturnType<typeof fixture>) {
    const results: { rows: number; largestText: number; totalText: number }[] =
      [];
    const prepare = f.store['db'].prepare.bind(f.store['db']);
    const watcher = vi
      .spyOn(f.store['db'], 'prepare')
      .mockImplementation((sql) => {
        const statement = prepare(sql);
        return new Proxy(statement, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if ((key === 'get' || key === 'all') && typeof value === 'function')
              return (...args: unknown[]) => {
                const returned = Reflect.apply(value, target, args);
                const strings: number[] = [];
                const visit = (item: unknown): void => {
                  if (typeof item === 'string')
                    strings.push(Buffer.byteLength(item));
                  else if (Array.isArray(item)) item.forEach(visit);
                  else if (item && typeof item === 'object')
                    Object.values(item).forEach(visit);
                };
                visit(returned);
                results.push({
                  rows: Array.isArray(returned)
                    ? returned.length
                    : returned === undefined
                      ? 0
                      : 1,
                  largestText: Math.max(0, ...strings),
                  totalText: strings.reduce((a, b) => a + b, 0),
                });
                return returned;
              };
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
    return { results, stop: () => watcher.mockRestore() };
  }

  test.each([
    'record',
    'snapshot',
    'reference',
    'current-model',
    'current-cursor',
    'fact',
    'lineage',
  ] as const)(
    'SQL admission rejects oversized %s before driver text transfer',
    (kind) => {
      const f = fixture();
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      effect.commit(f.commit);
      const large = 'x'.repeat(2 * 1024 * 1024 + 1);
      if (kind === 'record')
        f.store['db']
          .prepare(
            "UPDATE orchestration_conversation_native_fork_effect SET record_json=? WHERE target_conversation_id='child'",
          )
          .run(large);
      if (kind === 'snapshot')
        f.store['db']
          .prepare(
            "UPDATE orchestration_conversation_fork_context SET snapshot_json=? WHERE target_conversation_id='child'",
          )
          .run(large);
      if (kind === 'reference')
        f.store['db']
          .prepare(
            "UPDATE orchestration_conversation_fork_context SET owner_user_id=? WHERE target_conversation_id='child'",
          )
          .run(large);
      if (kind === 'current-model')
        f.store['db']
          .prepare(
            "UPDATE provider_session_state SET model=? WHERE thread_id='child'",
          )
          .run(large);
      if (kind === 'current-cursor')
        f.store['db']
          .prepare(
            "UPDATE provider_session_state SET resume_cursor=? WHERE thread_id='child'",
          )
          .run(JSON.stringify({ cursor: large }));
      if (kind === 'fact')
        f.store['db']
          .prepare(
            "UPDATE orchestration_events SET payload=? WHERE id='child-configured'",
          )
          .run(
            JSON.stringify({
              ...f.commit.configuredEvent,
              instructions: large,
            }),
          );
      if (kind === 'lineage')
        f.store['db']
          .prepare(
            "UPDATE orchestration_conversation_sessions SET created_at=? WHERE session_id='child'",
          )
          .run(large);
      const before = f.store['db']
        .prepare('SELECT total_changes() AS n')
        .get()?.n;
      const driver = watchDriver(f);
      const result = f.store.observeCommittedNativeFork(
        'child',
        f.snapshot.digest,
      );
      driver.stop();
      expect(
        Math.max(0, ...driver.results.map((r) => r.largestText)),
      ).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(
        driver.results.reduce((n, r) => n + r.totalText, 0),
      ).toBeLessThanOrEqual(4 * 1024 * 1024 + 65536);
      expect(
        Math.max(0, ...driver.results.map((r) => r.rows)),
      ).toBeLessThanOrEqual(256);
      expect(result).toEqual({ kind: 'unavailable', reason: 'unbounded' });
      expect(
        f.store['db'].prepare('SELECT total_changes() AS n').get()?.n,
      ).toBe(before);
    },
  );

  test('SQL admission rejects aggregate transfer before the next otherwise valid stored row', () => {
    const f = fixture({
      contextText: 's'.repeat(1500000),
      initialChildModel: 'i'.repeat(1500000),
    });
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    expect(effect.commit(f.commit)).toBe('committed');
    f.store.upsertSession({ ...f.commit.child, model: 'm'.repeat(1500000) });
    const sumBytes = (columns: readonly string[]) =>
      columns
        .map((column) => `coalesce(length(CAST(${column} AS BLOB)),0)`)
        .join(' + ');
    const referenceColumns = [
      'target_conversation_id',
      'fork_event_id',
      'source_conversation_id',
      'source_agent',
      'target_agent',
      'owner_user_id',
      'tenant_key',
      'project_slug',
      'requested_project_slug',
      'requested_branch_point_turn_id',
      'idempotency_key',
      'context_digest',
      'state',
      'created_at',
      'snapshot_json',
    ];
    const currentColumns = [
      'thread_id',
      'provider',
      'status',
      'model',
      'cwd',
      'resume_cursor',
      'control_mode',
      'attached_source',
      'continuation_source_thread_id',
      'adoption_idempotency_key',
      'persist_session',
      'ephemeral',
      'tenant_execution_context',
      'created_at',
      'updated_at',
    ];
    const recordBytes = f.store['db']
      .prepare(
        "SELECT length(CAST(record_json AS BLOB)) AS bytes FROM orchestration_conversation_native_fork_effect WHERE target_conversation_id='child'",
      )
      .get()?.bytes;
    const snapshotBytes = f.store['db']
      .prepare(
        `SELECT ${sumBytes(referenceColumns)} AS bytes FROM orchestration_conversation_fork_context WHERE target_conversation_id='child'`,
      )
      .get()?.bytes;
    const currentBytes = f.store['db']
      .prepare(
        `SELECT ${sumBytes(currentColumns)} AS bytes FROM provider_session_state WHERE thread_id='child'`,
      )
      .get()?.bytes;
    for (const bytes of [recordBytes, snapshotBytes, currentBytes]) {
      expect(typeof bytes).toBe('number');
      expect(Number(bytes)).toBeGreaterThanOrEqual(1500000);
      expect(Number(bytes)).toBeLessThanOrEqual(2 * 1024 * 1024);
    }
    expect(
      Number(recordBytes) + Number(snapshotBytes) + Number(currentBytes),
    ).toBeGreaterThan(4 * 1024 * 1024);
    const canonicalSizes = f.store['db']
      .prepare(
        'SELECT length(CAST(payload AS BLOB)) AS bytes FROM orchestration_events WHERE id IN (?, ?, ?)',
      )
      .all(
        f.commit.startedEvent.eventId,
        f.commit.configuredEvent.eventId,
        f.commit.forkEvent.eventId,
      );
    expect(canonicalSizes).toHaveLength(3);
    for (const row of canonicalSizes)
      expect(Number(row.bytes)).toBeLessThanOrEqual(65536);
    const driver = watchDriver(f);
    const result = f.store.observeCommittedNativeFork(
      'child',
      f.snapshot.digest,
    );
    driver.stop();
    expect(
      Math.max(0, ...driver.results.map((r) => r.largestText)),
    ).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(
      driver.results.reduce((n, r) => n + r.totalText, 0),
    ).toBeLessThanOrEqual(4 * 1024 * 1024 + 65536);
    expect(result).toEqual({ kind: 'unavailable', reason: 'unbounded' });
  });

  test('SQL admission refuses invalid retained SQL types without copying a blob', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    effect.commit(f.commit);
    f.store['db']
      .prepare(
        "UPDATE provider_session_state SET resume_cursor=? WHERE thread_id='child'",
      )
      .run(Buffer.alloc(4096));
    const driver = watchDriver(f);
    const result = f.store.observeCommittedNativeFork(
      'child',
      f.snapshot.digest,
    );
    driver.stop();
    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'corrupt-or-incompatible',
    });
  });

  test('read observation refuses caller uncommitted state and pending intents without granting execution', () => {
    const f = fixture();
    f.reserve();
    expect(
      f.store.observeCommittedNativeFork('child', f.snapshot.digest),
    ).toEqual({ kind: 'pending' });
    f.store['db'].exec('BEGIN');
    expect(
      f.store.observeCommittedNativeFork('child', f.snapshot.digest).kind,
    ).toBe('unavailable');
    f.store['db'].exec('ROLLBACK');
    expect(f.store.observeCommittedNativeFork('', 'invalid').kind).toBe(
      'unavailable',
    );
  });

  function watch(f: ReturnType<typeof fixture>) {
    const notices: {
      kind: string;
      deferred?: boolean;
      inTransaction: boolean;
      sameChild: boolean;
      peerChild: boolean;
      peerReady: unknown;
      peerFact: boolean;
    }[] = [];
    const capture = (kind: string, deferred?: boolean) =>
      notices.push({
        kind,
        deferred,
        inTransaction: f.store['db'].isTransaction,
        sameChild: !!f.store.readSessionByThread('child'),
        peerChild: !!f.peer
          .prepare(
            "SELECT 1 FROM provider_session_state WHERE thread_id='child'",
          )
          .get(),
        peerReady: f.peer
          .prepare(
            "SELECT state FROM orchestration_conversation_fork_context WHERE target_conversation_id='child'",
          )
          .get()?.state,
        peerFact: !!f.peer
          .prepare("SELECT 1 FROM orchestration_events WHERE id='fork-event'")
          .get(),
      });
    const stop = f.store.observeCommits({
      eventCommitted: ({ event, deferred }) => capture(event.eventId, deferred),
      lineageChanged: () => capture('lineage'),
    });
    return { notices, stop };
  }
  function activity(f: ReturnType<typeof fixture>) {
    return new ConversationTurnActivityProjection({
      eventStore: f.store,
      readTurnProgress: () => undefined,
      readRunningChildWork: () => [],
      logger: { warn: vi.fn() },
    });
  }
  test('native observers see only the complete outer commit, in global started-configured-fork order with no repeat', async () => {
    const f = fixture();
    const projection = activity(f);
    try {
      expect(projection.readConversation('child').asOfSequence).toBe(0);
      const effect = f.reserve();
      const observed = watch(f);
      let insideActivity = -1;
      const append = f.store.appendEvent.bind(f.store);
      const barrier = vi
        .spyOn(f.store, 'appendEvent')
        .mockImplementation((event, outputs, participant) =>
          event.method === 'conversation.forked'
            ? append(event, outputs, () => {
                participant?.();
                expect(observed.notices).toEqual([]);
                insideActivity =
                  projection.readConversation('child').asOfSequence;
              })
            : append(event, outputs, participant),
        );
      await runSessionStartWithBoundary(
        f.store.sessionTurnBoundaryAuthority(),
        'child',
        async () => {
          f.observe(effect);
          return effect.commit(f.commit);
        },
        effect.sessionStart,
      );
      barrier.mockRestore();
      expect(insideActivity).toBe(0);
      expect(observed.notices.map((n) => n.kind)).toEqual([
        'lineage',
        'child-started',
        'child-configured',
        'fork-event',
      ]);
      for (const notice of observed.notices) {
        expect(notice.inTransaction).toBe(false);
        expect(notice.sameChild).toBe(true);
        expect(notice.peerChild).toBe(true);
        expect(notice.peerReady).toBe('ready');
        expect(notice.peerFact).toBe(true);
        if (notice.kind !== 'lineage') expect(notice.deferred).toBe(false);
      }
      expect(f.store.readGlobalSequence('child-started')).toBeLessThan(
        f.store.readGlobalSequence('child-configured')!,
      );
      expect(f.store.readGlobalSequence('child-configured')).toBeLessThan(
        f.store.readGlobalSequence('fork-event')!,
      );
      expect(projection.readConversation('child').asOfSequence).toBeGreaterThan(
        0,
      );
      const count = observed.notices.length;
      expect(effect.commit(f.commit)).toBe('already-committed');
      expect(observed.notices).toHaveLength(count);
      observed.stop();
    } finally {
      projection.dispose();
    }
  });

  test.each(['participant', 'before-commit', 'after-commit'] as const)(
    '%s failure releases no event or lineage observer notice',
    (failure) => {
      const f = fixture();
      const projection = activity(f);
      try {
        expect(projection.readConversation('child').asOfSequence).toBe(0);
        const effect = f.reserve();
        effect.sessionStart.beginInvocation(NOW);
        f.observe(effect);
        const observed = watch(f);
        const append = f.store.appendEvent.bind(f.store);
        const participantFault = vi
          .spyOn(f.store, 'appendEvent')
          .mockImplementation((event, outputs, participant) =>
            event.method === 'conversation.forked'
              ? append(event, outputs, () => {
                  participant?.();
                  expect(observed.notices).toEqual([]);
                  expect(
                    projection.readConversation('child').asOfSequence,
                  ).toBe(0);
                  if (failure === 'participant')
                    throw new Error('injected B1 participant failure');
                })
              : append(event, outputs, participant),
          );
        const exec = f.store['db'].exec.bind(f.store['db']);
        const commitFault = vi
          .spyOn(f.store['db'], 'exec')
          .mockImplementation((sql) => {
            if (sql === 'COMMIT' && failure !== 'participant') {
              expect(observed.notices).toEqual([]);
              if (failure === 'after-commit') exec(sql);
              throw new Error('injected B1 commit uncertainty');
            }
            return exec(sql);
          });
        expect(() => effect.commit(f.commit)).toThrow();
        participantFault.mockRestore();
        commitFault.mockRestore();
        expect(observed.notices).toEqual([]);
        expect(effect.sessionStart.beginInvocation(NOW).kind).not.toBe(
          'applied',
        );
        if (failure !== 'after-commit')
          expect(projection.readConversation('child').asOfSequence).toBe(0);
        observed.stop();
        f.reopen();
        expect(f.store.readNativeForkEffect('child')?.state).toBe(
          failure === 'after-commit' ? 'committed' : 'child-observed',
        );
        expect(f.store.hasEventId('child-started')).toBe(
          failure === 'after-commit',
        );
        expect(f.store.hasEventId('fork-event')).toBe(
          failure === 'after-commit',
        );
      } finally {
        projection.dispose();
      }
    },
  );

  test('native observer hold is cleared before reentrant callbacks and observer throws cannot fail a commit', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    const seen: string[] = [];
    const stop = f.store.observeCommits({
      lineageChanged: () => {
        f.store.appendEvent({
          ...f.commit.configuredEvent,
          eventId: 'ordinary-reentrant',
        });
        throw new Error('observer only');
      },
      eventCommitted: ({ event, deferred }) => {
        seen.push(event.eventId);
        expect(deferred).toBe(false);
      },
    });
    expect(effect.commit(f.commit)).toBe('committed');
    expect(seen).toContain('ordinary-reentrant');
    expect(seen).toContain('child-started');
    stop();
  });

  test('ordinary caller-owned transaction retains its existing immediate deferred event notifications', () => {
    const f = fixture();
    const notices: boolean[] = [];
    const stop = f.store.observeCommits({
      eventCommitted: ({ deferred }) => notices.push(deferred),
    });
    f.store['db'].exec('BEGIN IMMEDIATE');
    f.store.appendEvent({
      ...f.commit.configuredEvent,
      eventId: 'ordinary-before-rollback',
    });
    expect(notices).toEqual([true]);
    f.store['db'].exec('ROLLBACK');
    expect(f.store.hasEventId('ordinary-before-rollback')).toBe(false);
    stop();
  });

  test.each(['event', 'lineage'] as const)(
    'unexpected %s notice fails native composition rather than escaping or being swallowed',
    (kind) => {
      const f = fixture();
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      const observed = watch(f);
      const upsert = f.store.upsertSession.bind(f.store);
      const fault = vi
        .spyOn(f.store, 'upsertSession')
        .mockImplementation((session) => {
          upsert(session);
          if (kind === 'event')
            f.store.appendEvent({
              ...f.commit.configuredEvent,
              eventId: 'foreign-event',
            });
          else upsert({ ...f.commit.child, threadId: 'foreign-child' });
        });
      expect(() => effect.commit(f.commit)).toThrow(/Unexpected/);
      fault.mockRestore();
      expect(observed.notices).toEqual([]);
      observed.stop();
      expect(f.store.readSessionByThread('child')).toBeUndefined();
      expect(f.store.hasEventId('foreign-event')).toBe(false);
      expect(f.store.readSessionByThread('foreign-child')).toBeUndefined();
    },
  );

  test.each([
    'thread',
    'provider',
    'owner',
    'environment',
    'Agent',
    'Project',
    'native-binding',
  ] as const)('started %s must match the complete native tuple', (field) => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    const started = {
      ...f.commit.startedEvent,
      metadata: { ...f.commit.startedEvent.metadata },
    };
    if (field === 'thread') started.threadId = 'foreign';
    if (field === 'provider') started.provider = 'claude';
    const key = {
      thread: undefined,
      provider: undefined,
      owner: 'userId',
      environment: 'environmentId',
      Agent: 'agentSlug',
      Project: 'projectSlug',
      'native-binding': 'nativeResumeBindingKey',
    }[field];
    if (key) started.metadata[key] = 'foreign';
    expect(() =>
      effect.commit({ ...f.commit, startedEvent: started }),
    ).toThrow();
    expect(f.store.hasEventId('child-started')).toBe(false);
    expect(f.store.conversationForkContextReference('child')?.state).toBe(
      'prepared',
    );
  });

  test.each([
    'prepared',
    'invoking',
    'child-observed',
    'indeterminate',
    'cleanup-pending',
  ] as const)(
    'old replay publication and deletion refuse %s native intent across reopen',
    (state) => {
      const f = fixture();
      const effect = f.reserve();
      if (state !== 'prepared')
        expect(effect.sessionStart.beginInvocation(NOW).kind).toBe('applied');
      if (state === 'child-observed') f.observe(effect);
      if (state === 'indeterminate') effect.indeterminate();
      if (state === 'cleanup-pending') effect.cleanupPending();
      expect(() =>
        f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
      ).toThrow(/native fork/i);
      expect(() =>
        f.store.deleteUnstartedConversationForkContext('child'),
      ).toThrow(/native fork/i);
      f.reopen();
      expect(f.store.readNativeForkEffect('child')?.state).toBe(state);
      expect(f.store.conversationForkContextReference('child')?.state).toBe(
        'prepared',
      );
      expect(f.store.hasEventId('fork-event')).toBe(false);
      expect(() =>
        f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
      ).toThrow(/native fork/i);
    },
  );

  test('replay-ready cannot acquire native invocation ownership', () => {
    const f = fixture();
    f.store.publishConversationForkContext(f.replay, f.snapshot.digest);
    expect(() => f.reserve()).toThrow(/unpublished prepared/i);
    f.reopen();
    expect(f.store.conversationForkContextReference('child')?.state).toBe(
      'ready',
    );
    expect(f.store.readNativeForkEffect('child')).toBeUndefined();
  });

  test('native commit co-publishes child lineage and exact receipt; conflicting repeats and old publishers refuse', () => {
    const f = fixture();
    const effect = f.reserve();
    expect(effect.sessionStart.beginInvocation(NOW).kind).toBe('applied');
    f.observe(effect);
    expect(effect.commit(f.commit)).toBe('committed');
    expect(effect.commit(f.commit)).toBe('already-committed');
    expect(() =>
      effect.commit({
        ...f.commit,
        child: { ...f.commit.child, status: 'closed' },
      }),
    ).toThrow(/binding conflicts/i);
    expect(() =>
      f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
    ).toThrow(/native fork/i);
    expect(() =>
      f.store.publishConversationForkContext(
        f.commit.forkEvent,
        f.snapshot.digest,
      ),
    ).toThrow(/native fork/i);
    f.reopen();
    expect(f.store.readNativeForkEffect('child')?.state).toBe('committed');
    expect(f.store.readSessionByThread('child')?.resumeCursor).toEqual(
      f.commit.child.resumeCursor,
    );
    expect(f.store.conversationForSession('child')?.conversationId).toBe(
      'child',
    );
    expect(f.store.nativeSessionBindingIdentity('child')).toBe(CHILD_KEY);
    expect(f.store.hasEventId('fork-event')).toBe(true);
  });

  test.each([
    { tenant: true, project: true, explicitOwned: true },
    { tenant: false, project: true, explicitOwned: false },
  ])(
    'native commit preserves matching recorded tenant and Project without minting authority: %j',
    (options) => {
      const f = fixture(options);
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      expect(effect.commit(f.commit)).toBe('committed');
      expect(effect.commit(f.commit)).toBe('already-committed');
      f.reopen();
      expect(
        f.store.readSessionByThread('child')?.tenantExecutionContext?.tenantId,
      ).toBe(options.tenant ? 'tenant-one' : undefined);
      expect(
        f.store.conversationForkContextSnapshot('child')?.projectSlug,
      ).toBe('project-one');
    },
  );

  function configuredPatch(
    input: NativeForkCommitInput,
    patch: Record<string, unknown>,
  ): NativeForkCommitInput {
    if (input.configuredEvent.method !== 'session.configured')
      throw new Error('Expected configured fixture');
    return {
      ...input,
      configuredEvent: {
        ...input.configuredEvent,
        metadata: { ...input.configuredEvent.metadata, ...patch },
      },
    };
  }
  const foreignBindings: {
    name: string;
    change(input: NativeForkCommitInput): NativeForkCommitInput;
  }[] = [
    {
      name: 'fork thread',
      change: (input) => ({
        ...input,
        forkEvent: { ...input.forkEvent, threadId: 'foreign' },
      }),
    },
    {
      name: 'fork provider',
      change: (input) => ({
        ...input,
        forkEvent: { ...input.forkEvent, provider: 'codex' },
      }),
    },
    {
      name: 'configured Session',
      change: (input) => {
        if (input.configuredEvent.method !== 'session.configured')
          throw new Error('Expected configured fixture');
        return {
          ...input,
          configuredEvent: { ...input.configuredEvent, sessionId: 'foreign' },
        };
      },
    },
    {
      name: 'configured cwd',
      change: (input) => {
        if (input.configuredEvent.method !== 'session.configured')
          throw new Error('Expected configured fixture');
        return {
          ...input,
          configuredEvent: { ...input.configuredEvent, cwd: '/foreign' },
        };
      },
    },
    {
      name: 'configured environment',
      change: (input) => configuredPatch(input, { environmentId: 'foreign' }),
    },
    {
      name: 'configured Agent',
      change: (input) => configuredPatch(input, { agentSlug: 'foreign' }),
    },
    {
      name: 'configured Project',
      change: (input) => configuredPatch(input, { projectSlug: 'foreign' }),
    },
    {
      name: 'configured tenant',
      change: (input) => configuredPatch(input, { tenantId: 'foreign' }),
    },
    {
      name: 'configured tenant context',
      change: (input) =>
        configuredPatch(input, {
          tenantExecutionContext: { tenantId: 'foreign', source: 'session' },
        }),
    },
    {
      name: 'configured native binding',
      change: (input) =>
        configuredPatch(input, { nativeResumeBindingKey: 'f'.repeat(64) }),
    },
    {
      name: 'configured native identity mismatch',
      change: (input) =>
        configuredPatch(input, { nativeResumeIdentity: 'mismatch' }),
    },
    {
      name: 'child tenant',
      change: (input) => ({
        ...input,
        child: {
          ...input.child,
          tenantExecutionContext: {
            tenantId: tenantId('foreign'),
            source: 'session',
          },
        },
      }),
    },
    {
      name: 'child attached control mode',
      change: (input) => ({
        ...input,
        child: { ...input.child, controlMode: 'read-only-attached' },
      }),
    },
  ];
  test.each(foreignBindings)(
    'first native commit refuses $name with zero publication and retained cursor',
    ({ change }) => {
      const f = fixture();
      const effect = f.reserve();
      effect.sessionStart.beginInvocation(NOW);
      f.observe(effect);
      expect(() => effect.commit(change(f.commit))).toThrow();
      f.reopen();
      expect(f.store.readNativeForkEffect('child')?.state).toBe(
        'child-observed',
      );
      expect(f.store.readNativeForkEffect('child')?.cursorJson).toBe(
        JSON.stringify(f.commit.child.resumeCursor),
      );
      expect(f.store.readSessionByThread('child')).toBeUndefined();
      expect(f.store.conversationForSession('child')).toBeUndefined();
      expect(f.store.hasEventId('fork-event')).toBe(false);
      expect(f.store.hasEventId('child-configured')).toBe(false);
      expect(f.store.conversationForkContextReference('child')?.state).toBe(
        'prepared',
      );
    },
  );

  test('native commit append failure rolls back child, lineage, ready and receipt while retaining observed cursor', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    const append = f.store.appendEvent.bind(f.store);
    const fault = vi
      .spyOn(f.store, 'appendEvent')
      .mockImplementation((event, outputs, participant) => {
        if (event.method !== 'conversation.forked')
          return append(event, outputs, participant);
        return append(event, outputs, () => {
          participant?.();
          throw new Error('injected native publication failure');
        });
      });
    expect(() => effect.commit(f.commit)).toThrow(
      /injected native publication/i,
    );
    fault.mockRestore();
    f.reopen();
    expect(f.store.readNativeForkEffect('child')?.state).toBe('child-observed');
    expect(f.store.readNativeForkEffect('child')?.cursorJson).toBe(
      JSON.stringify(f.commit.child.resumeCursor),
    );
    expect(f.store.readSessionByThread('child')).toBeUndefined();
    expect(f.store.conversationForSession('child')).toBeUndefined();
    expect(f.store.hasEventId('child-configured')).toBe(false);
    expect(f.store.hasEventId('fork-event')).toBe(false);
    expect(f.store.conversationForkContextReference('child')?.state).toBe(
      'prepared',
    );
  });

  test('rollback after raw boundary transition poisons the same retained wrapper before real helper reuse', async () => {
    const f = fixture();
    const effect = f.reserve();
    const wrapper = effect.sessionStart;
    const prepare = f.store['db'].prepare.bind(f.store['db']);
    const fault = vi
      .spyOn(f.store['db'], 'prepare')
      .mockImplementation((sql) => {
        if (
          sql.startsWith(
            'INSERT INTO orchestration_conversation_native_fork_effect',
          )
        )
          throw new Error('injected projection write failure');
        return prepare(sql);
      });
    expect(wrapper.beginInvocation(NOW).kind).not.toBe('applied');
    fault.mockRestore();
    expect(effect.sessionStart).toBe(wrapper);
    let invoked = 0;
    await expect(
      runSessionStartWithBoundary(
        f.store.sessionTurnBoundaryAuthority(),
        'child',
        async () => {
          invoked++;
        },
        wrapper,
      ),
    ).rejects.toThrow();
    expect(invoked).toBe(0);
    f.reopen();
    expect(f.store.readNativeForkEffect('child')?.state).toBe('prepared');
    expect(f.store.hasEventId('fork-event')).toBe(false);
  });

  test.each(['before-commit', 'after-commit'] as const)(
    '%s failure poisons retained admission even when SQL outcome differs',
    async (timing) => {
      const f = fixture();
      const effect = f.reserve();
      const wrapper = effect.sessionStart;
      const exec = f.store['db'].exec.bind(f.store['db']);
      const fault = vi
        .spyOn(f.store['db'], 'exec')
        .mockImplementation((sql) => {
          if (sql === 'COMMIT') {
            if (timing === 'after-commit') exec(sql);
            throw new Error('injected commit outcome uncertainty');
          }
          return exec(sql);
        });
      expect(wrapper.beginInvocation(NOW).kind).not.toBe('applied');
      fault.mockRestore();
      let invoked = 0;
      await expect(
        runSessionStartWithBoundary(
          f.store.sessionTurnBoundaryAuthority(),
          'child',
          async () => {
            invoked++;
          },
          wrapper,
        ),
      ).rejects.toThrow();
      expect(invoked).toBe(0);
      f.reopen();
      expect(f.store.readNativeForkEffect('child')?.state).toBe(
        timing === 'after-commit' ? 'invoking' : 'prepared',
      );
      expect(f.store.conversationForkContextReference('child')?.state).toBe(
        'prepared',
      );
      expect(f.store.hasEventId('fork-event')).toBe(false);
    },
  );

  test('caller-owned outer transaction and consumed wrapper never admit a second effect', () => {
    const f = fixture();
    const effect = f.reserve();
    f.store['db'].exec('BEGIN IMMEDIATE');
    expect(effect.sessionStart.beginInvocation(NOW).kind).not.toBe('applied');
    f.store['db'].exec('ROLLBACK');
    expect(effect.sessionStart.beginInvocation(NOW).kind).not.toBe('applied');
    const g = fixture();
    const next = g.reserve();
    expect(next.sessionStart.beginInvocation(NOW).kind).toBe('applied');
    expect(next.sessionStart.beginInvocation(NOW).kind).not.toBe('applied');
  });

  test.each([
    { childIdentity: CHILD_KEY },
    { cursorDigest: CHILD_KEY },
    { cursorJson: '{}' },
    { state: 'committed' },
    { version: 2 },
    { extra: 'unrecognized' },
  ])(
    'partial or unknown retained receipt refuses reads and old publication: %j',
    (patch) => {
      const f = fixture();
      f.reserve();
      const record = f.store.readNativeForkEffect('child');
      f.store['db']
        .prepare(
          'UPDATE orchestration_conversation_native_fork_effect SET record_json = ? WHERE target_conversation_id = ?',
        )
        .run(JSON.stringify({ ...record, ...patch }), 'child');
      expect(() => f.store.readNativeForkEffect('child')).toThrow();
      expect(() =>
        f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
      ).toThrow();
      expect(f.store.hasEventId('fork-event')).toBe(false);
    },
  );

  test('cursor is write-once, corruption fails closed, and existing intent cannot acquire another handle', () => {
    const f = fixture();
    const effect = f.reserve();
    effect.sessionStart.beginInvocation(NOW);
    f.observe(effect);
    expect(
      f.store.reserveNativeForkEffect({
        targetId: 'child',
        contextDigest: f.snapshot.digest,
        source: f.source,
      }).kind,
    ).toBe('existing');
    expect(() =>
      effect.observeChild({ nativeSessionId: 'other' }, CHILD_KEY),
    ).toThrow(/receipt conflicts/i);
    f.store['db']
      .prepare(
        'UPDATE orchestration_conversation_native_fork_effect SET record_json = ? WHERE target_conversation_id = ?',
      )
      .run('{"version":99}', 'child');
    expect(() => f.store.readNativeForkEffect('child')).toThrow();
    expect(() =>
      f.store.publishConversationForkContext(f.replay, f.snapshot.digest),
    ).toThrow();
  });
});
