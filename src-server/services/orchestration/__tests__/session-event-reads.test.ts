import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STEERING_ENGINE_DURABILITY } from '@kontourai/station-contracts/engine-capability-matrix';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GateTestAdapter } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { SessionEventReads } from '../session-event-reads.js';
import {
  captureReportTerminalWitness,
  verifyReportTerminalWitness,
} from '../station-report-terminal-witness.js';

const directories: string[] = [];

function createStore(): EventStore {
  const directory = mkdtempSync(join(tmpdir(), 'session-event-reads-'));
  directories.push(directory);
  return new EventStore(join(directory, 'orchestration.sqlite'));
}

function readsFor(
  store: EventStore,
  rootId: string,
  readSession?: (threadId: string) => Promise<any>,
  overrides: Partial<ConstructorParameters<typeof SessionEventReads>[0]> = {},
): SessionEventReads {
  return new SessionEventReads({
    eventStore: store,
    logger: { warn() {} },
    listSessions: async () => [],
    hydratePersistedTenantContexts() {},
    loadedSessionForThread: () => undefined,
    canReadSession: () => true,
    canUserReadSession: () => true,
    readTurnProgress: () => undefined,
    observeAnswerability: () => ({ state: 'unobserved' }) as never,
    readSession:
      readSession ??
      (async (threadId) =>
        threadId === rootId
          ? ({ session: { threadId: rootId }, events: [] } as never)
          : null),
    ...overrides,
  });
}

function seedRoot(store: EventStore, rootId: string): void {
  store.upsertSession({
    provider: 'claude',
    threadId: rootId,
    status: 'closed',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  });
}

const historicalHomes = trackTempDirs();
const historicalTurn = {
  conversationId: 'report-thread',
  sessionId: 'report-thread',
  clientTurnId: 'report-client-turn',
  turnId: 'report-provider-turn',
};
const historicalAuthority = sessionReadAuthorityFromRequest(
  'report-owner',
  undefined,
  undefined,
);
function seedHistoricalTurn(store: EventStore): void {
  seedRoot(store, historicalTurn.sessionId);
  const fields = {
    provider: 'claude' as const,
    threadId: historicalTurn.sessionId,
    createdAt: '2026-10-26T00:00:00.000Z',
  };
  store.appendEvent({
    ...fields,
    eventId: 'report-session-start',
    method: 'session.started',
    sessionId: historicalTurn.sessionId,
    metadata: { userId: 'report-owner' },
  });
  const claim = store.createTurnDeduplicator().claim({
    threadId: historicalTurn.sessionId,
    clientTurnId: historicalTurn.clientTurnId,
  });
  if (claim.kind !== 'owner') throw new Error('Fixture must own its real turn');
  claim.claim.beginInvocation();
  claim.claim.resolve(historicalTurn.turnId);
  store.appendEvent({
    ...fields,
    eventId: 'report-terminal',
    method: 'turn.completed',
    turnId: historicalTurn.turnId,
    finishReason: 'stop',
  });
}

describe('recorded sealed source Session policy', () => {
  test('uses saved Session mode across point, list and event-page reads without changing ordinary provider defaults', async () => {
    const store = createStore();
    const eventBus = new EventBus();
    const logger = { debug() {}, warn() {} };
    const fetchModel = vi.fn<typeof fetch>(async () => {
      throw new Error('A recorded-mode read must not invoke a model');
    });
    const adapter = new StationAgentAdapter({
      apiBase: 'http://recorded-mode.test',
      hasAgent: () => true,
      eventBus,
      approvalRegistry: new ApprovalRegistry(logger, { eventBus }),
      fetch: fetchModel,
    });
    const external = new GateTestAdapter();
    external.metadata.durability = STEERING_ENGINE_DURABILITY;
    const service = new OrchestrationService({
      eventStore: store,
      eventBus,
      adapterRegistry: {
        register() {},
        get: (provider) =>
          provider === adapter.provider
            ? adapter
            : provider === external.provider
              ? external
              : undefined,
        list: () => [adapter, external],
      },
      logger,
    });
    const identity = `sha256:${'a'.repeat(64)}`;
    const record = (
      threadId: string,
      mode: unknown,
      cursor = false,
      provider: 'station-agent' | 'claude' = 'station-agent',
    ) => {
      store.upsertSession({
        provider,
        threadId,
        status: 'ready',
        createdAt: '2026-10-26T00:00:00.000Z',
        updatedAt: '2026-10-26T00:00:00.000Z',
        ...(cursor
          ? { resumeCursor: { reservedSourceIdentity: identity } }
          : {}),
      });
      store.appendEvent({
        provider,
        threadId,
        sessionId: threadId,
        eventId: `${threadId}:start`,
        method: 'session.started',
        createdAt: '2026-10-26T00:00:00.000Z',
        metadata: {
          userId: 'mode-owner',
          ...(mode !== undefined ? { reservedSourceExecution: mode } : {}),
        },
      });
    };
    record('sealed-no-tools', { mode: 'sealed-source-no-tools', identity });
    record('sealed-input', { mode: 'sealed-source-input', identity });
    record('malformed-sealed', {
      mode: 'sealed-source-input',
      identity: 'not-a-digest',
    });
    record('ordinary', undefined);
    record('cursor-only', undefined, true);
    record('external-ordinary', undefined, false, 'claude');
    record(
      'external-shaped',
      { mode: 'sealed-source-input', identity },
      false,
      'claude',
    );
    record('external-historical-station', {
      mode: 'sealed-source-input',
      identity,
    });
    store.upsertSession({
      provider: 'claude',
      threadId: 'external-historical-station',
      status: 'ready',
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:01.000Z',
    });
    store.appendEvent({
      provider: 'claude',
      threadId: 'external-historical-station',
      sessionId: 'external-historical-station',
      eventId: 'external-historical-station:reattach',
      method: 'session.started',
      createdAt: '2026-10-26T00:00:01.000Z',
      metadata: { userId: 'mode-owner' },
    });
    // A later unmarked reattach does not erase the first canonical declaration.
    store.appendEvent({
      provider: 'station-agent',
      threadId: 'sealed-input',
      sessionId: 'sealed-input',
      eventId: 'sealed-input:reattach',
      method: 'session.started',
      createdAt: '2026-10-26T00:00:01.000Z',
      metadata: { userId: 'mode-owner' },
    });
    try {
      const ordinary = service.durabilityProfileForProvider('station-agent');
      expect(ordinary).toBeDefined();
      const listed = await service.listSessionReadModel(
        INTERNAL_SESSION_READ_SCOPE,
      );
      for (const threadId of [
        'sealed-no-tools',
        'sealed-input',
        'malformed-sealed',
      ]) {
        const queueReason =
          threadId === 'malformed-sealed'
            ? 'The recorded sealed source declaration is unavailable.'
            : "This session can't take Steer or Queue messages. To ask for another turn, use the report or group controls.";
        const point = await service.readSession(
          threadId,
          INTERNAL_SESSION_READ_SCOPE,
        );
        const page = await service.readSessionEventPage(threadId, {
          afterSequence: 0,
          limit: 20,
          authority: INTERNAL_SESSION_READ_SCOPE,
        });
        for (const summary of [
          point?.session,
          page?.session,
          listed.find((row) => row.threadId === threadId),
        ]) {
          expect(summary?.durability).toMatchObject({
            queuedFollowUp: { state: 'none', detail: queueReason },
            steerPlacement: { state: 'none', detail: queueReason },
            crashContinuation: { state: 'none' },
            toolReplay: { state: 'none' },
            pendingApprovals: { state: 'none' },
            fork: { state: 'none' },
          });
          expect(summary?.durability?.contextCarriage.history).not.toBe(
            'station-memory',
          );
          expect(summary?.durability?.steerPlacement.boundary).toBeUndefined();
        }
        expect(await service.steerFidelityForThread(threadId)).toBe('none');
        expect(
          service.canSteerAtPostToolBoundary(threadId, 'not-injected'),
        ).toBe(false);
        const count = store.countEventsByThread(threadId);
        expect(() =>
          service.recordPostToolSteer({
            threadId,
            turnId: 'not-injected',
            clientInputId: 'not-injected',
            payload: { message: 'must not inject' },
          }),
        ).toThrow('do not support post-tool steering');
        expect(store.countEventsByThread(threadId)).toBe(count);
        expect(service.conversationInputAdmissionRefusal(threadId)).toEqual({
          reasonCode: 'sealed_source_admission_required',
          reason: queueReason,
        });
      }
      for (const threadId of ['ordinary', 'cursor-only']) {
        const point = await service.readSession(
          threadId,
          INTERNAL_SESSION_READ_SCOPE,
        );
        expect(point?.session.durability).toEqual(ordinary);
        expect(
          service.conversationInputAdmissionRefusal(threadId),
        ).toBeUndefined();
      }
      for (const threadId of [
        'external-ordinary',
        'external-shaped',
        'external-historical-station',
      ]) {
        const point = await service.readSession(
          threadId,
          INTERNAL_SESSION_READ_SCOPE,
        );
        const page = await service.readSessionEventPage(threadId, {
          afterSequence: 0,
          limit: 20,
          authority: INTERNAL_SESSION_READ_SCOPE,
        });
        for (const summary of [
          point?.session,
          page?.session,
          listed.find((row) => row.threadId === threadId),
        ]) {
          expect(summary?.provider).toBe('claude');
          expect(summary?.durability).toEqual(STEERING_ENGINE_DURABILITY);
        }
      }
      const latest = vi.spyOn(store, 'latestEventByMethod');
      const first = vi.spyOn(store, 'firstEventByMethod');
      try {
        expect(
          service.durabilityProfileForSession('station-agent', 'sealed-input')
            ?.steerPlacement.state,
        ).toBe('none');
        expect(latest).toHaveBeenCalledWith('sealed-input', 'session.started');
        expect(first).toHaveBeenCalledWith('sealed-input', 'session.started');
        for (const threadId of [
          'external-ordinary',
          'external-shaped',
          'external-historical-station',
        ]) {
          latest.mockClear();
          first.mockClear();
          const current = store.readSessionByThread(threadId);
          expect(current?.provider).toBe('claude');
          expect(
            service.durabilityProfileForSession(current?.provider, threadId),
          ).toEqual(STEERING_ENGINE_DURABILITY);
          expect(
            latest,
            'external-engine durability lookup must not query the Station metadata namespace',
          ).not.toHaveBeenCalled();
          expect(
            first,
            'external-engine durability lookup must not query the Station metadata namespace',
          ).not.toHaveBeenCalled();
        }
      } finally {
        latest.mockRestore();
        first.mockRestore();
      }
      expect(service.durabilityProfileForProvider('station-agent')).toEqual(
        ordinary,
      );
      expect(fetchModel).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      store.close();
    }
  });
});

describe('historical report terminal snapshots', () => {
  test('retains an authenticated original-turn witness after Session deletion and refuses altered identities', async () => {
    const home = historicalHomes('report-terminal-witness-');
    const environment = new EnvironmentSecurityService({ homeDir: home });
    await environment.initialize();
    const persistence = new StationDelegationPersistence(home);
    const store = createStore();
    const orchestration = new OrchestrationService({
      eventStore: store,
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
    });
    const current = (): undefined => undefined;
    const input = {
      groupId: 'report-group',
      seatId: 'reviewer',
      invocationId: 'report-invocation',
      root: {
        id: 'report-root',
        authority_epoch: 0,
        digest: `sha256:${'1'.repeat(64)}`,
      },
      envelope: {
        id: 'report-envelope',
        generation: 0,
        digest: `sha256:${'2'.repeat(64)}`,
      },
      evidence: {
        id: 'physical-evidence',
        domain: 'station.provider-evidence' as const,
        digest: `sha256:${'3'.repeat(64)}`,
      },
      turn: historicalTurn,
      ownerId: 'report-owner',
    };
    try {
      seedHistoricalTurn(store);
      expect(
        captureReportTerminalWitness(
          { environment, orchestration, current },
          { ...input, ownerId: 'foreign-owner' },
        ),
      ).toBeNull();
      const witness = captureReportTerminalWitness(
        { environment, orchestration, current },
        input,
      );
      expect(witness).not.toBeNull();
      if (!witness) throw new Error('Expected actual terminal witness');
      const observation = {
        groupId: input.groupId,
        seatId: input.seatId,
        invocationId: input.invocationId,
        observation: {
          kind: 'terminal' as const,
          evidence: input.evidence,
          taskId: historicalTurn.conversationId,
          sessionId: historicalTurn.sessionId,
          turnId: historicalTurn.turnId,
          eventId: 'report-terminal',
          witness,
        },
      };
      const reference = await persistence.retainReportObservation(
        observation,
        current,
      );
      await expect(
        persistence.retainReportObservation(
          { ...observation, invocationId: 'foreign-invocation' },
          current,
        ),
      ).rejects.toThrow('Report terminal witness identity mismatch');
      store.deleteThread(historicalTurn.sessionId);
      expect(
        orchestration.readHistoricalReportTurn(
          historicalTurn,
          historicalAuthority,
        ),
      ).toBeNull();
      const retained = await new StationDelegationPersistence(
        home,
      ).readReportObservation(
        input.groupId,
        input.invocationId,
        reference,
        current,
      );
      if (
        retained.observation.kind !== 'terminal' ||
        !retained.observation.witness
      )
        throw new Error('Expected retained witness');
      expect(
        verifyReportTerminalWitness(retained.observation.witness, environment),
      ).toBe(true);
      const changed = structuredClone(retained.observation.witness);
      changed.data.terminal.turnId = 'foreign-turn';
      expect(verifyReportTerminalWitness(changed, environment)).toBe(false);
      const other = new EnvironmentSecurityService({
        homeDir: historicalHomes('foreign-terminal-witness-'),
      });
      await other.initialize();
      expect(verifyReportTerminalWitness(witness, other)).toBe(false);
    } finally {
      await orchestration.shutdown();
      store.close();
    }
  });

  test('refuses corrupt tenant storage instead of interpreting parsed absence as personal', () => {
    const file = join(
      historicalHomes('report-tenant-storage-'),
      'events.sqlite',
    );
    const store = new EventStore(file);
    const database = new DatabaseSync(file);
    try {
      seedHistoricalTurn(store);
      const reads = readsFor(store, historicalTurn.sessionId);
      expect(
        reads.readHistoricalReportTurn(historicalTurn, historicalAuthority),
      ).not.toBeNull();
      for (const corrupted of ['malformed', '{}', 'null', ' '.repeat(65_537)]) {
        database
          .prepare(
            'UPDATE provider_session_state SET tenant_execution_context = ? WHERE thread_id = ?',
          )
          .run(corrupted, historicalTurn.sessionId);
        expect(
          reads.readHistoricalReportTurn(historicalTurn, historicalAuthority),
        ).toBeNull();
      }
    } finally {
      database.close();
      store.close();
    }
  });

  test('refuses a personal report authority on a hosted runtime', async () => {
    const store = createStore();
    const service = new OrchestrationService({
      eventStore: store,
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
      requireTenantExecutionContext: () => true,
    });
    try {
      seedHistoricalTurn(store);
      expect(
        service.readHistoricalReportTurn(historicalTurn, historicalAuthority),
      ).toBeNull();
    } finally {
      await service.shutdown();
      store.close();
    }
  });

  test('refuses foreign owners, mismatched tuples and ambiguous completion without trusting cached authorization', () => {
    const store = createStore();
    try {
      seedHistoricalTurn(store);
      const reads = readsFor(store, historicalTurn.sessionId, undefined, {
        canReadSession: () => true,
      });
      expect(
        reads.readHistoricalReportTurn(
          historicalTurn,
          sessionReadAuthorityFromRequest(
            'foreign-owner',
            undefined,
            undefined,
          ),
        ),
      ).toBeNull();
      for (const patch of [
        { conversationId: 'foreign-conversation' },
        { clientTurnId: 'unreceived-turn' },
        { turnId: 'another-provider-turn' },
      ])
        expect(
          reads.readHistoricalReportTurn(
            { ...historicalTurn, ...patch },
            historicalAuthority,
          ),
        ).toBeNull();
      expect(
        reads.readHistoricalReportTurn(historicalTurn, historicalAuthority),
      ).not.toBeNull();
      store.appendEvent({
        eventId: 'second-report-terminal',
        provider: 'claude',
        threadId: historicalTurn.sessionId,
        turnId: historicalTurn.turnId,
        method: 'turn.completed',
        createdAt: '2026-10-26T00:00:01.000Z',
        finishReason: 'stop',
      });
      expect(
        reads.readHistoricalReportTurn(historicalTurn, historicalAuthority),
      ).toBeNull();
    } finally {
      store.close();
    }
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SessionEventReads conversation boundary hydration', () => {
  test('abort stops lineage authorization between awaited Session reads', async () => {
    const store = createStore();
    const rootId = 'event-reads-abort';
    const childId = `${rootId}:child`;
    const controller = new AbortController();
    const readSession = vi.fn(async (threadId: string) => {
      controller.abort();
      return { session: { threadId }, events: [] };
    });
    try {
      seedRoot(store, rootId);
      store.reserveConversationHandoff({
        conversationId: rootId,
        predecessorSessionId: rootId,
        sessionId: childId,
        idempotencyKey: 'abort-key',
        targetAgentId: 'claude' as never,
        targetEnvironmentId: '11111111-1111-4111-8111-111111111111' as never,
        messageDigest: 'abort-digest',
        createdAt: '2026-08-25T00:01:00.000Z',
      });
      await expect(
        readsFor(store, rootId, readSession).readConversationEventWindow(
          rootId,
          {
            authority: INTERNAL_SESSION_READ_SCOPE,
            turnLimit: 10,
            signal: controller.signal,
          },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(readSession).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });
  test.each([
    ['reserved', undefined],
    ['failed', 'failed'],
    ['indeterminate', 'indeterminate'],
  ] as const)(
    'folds an exact %s unmaterialized boundary child through its predecessor',
    async (_label, transition) => {
      const store = createStore();
      const rootId = `event-reads-${_label}`;
      const childId = `${rootId}:child`;
      try {
        seedRoot(store, rootId);
        store.reserveConversationContextBoundary({
          boundaryId: `boundary-${_label}`,
          conversationId: rootId,
          predecessorSessionId: rootId,
          successorSessionId: childId,
          idempotencyKey: `key-${_label}`,
          policy: 'empty-next-cold-start',
          status: 'reserved',
          actorId: 'owner-user',
          createdAt: '2026-08-25T00:01:00.000Z',
        });
        if (transition) {
          store.claimConversationContextBoundaryColdStart(
            `boundary-${_label}`,
            `start-${_label}`,
            '2026-08-25T00:02:00.000Z',
          );
          if (transition === 'failed') {
            store.releaseConversationContextBoundaryFailedClaim(
              `boundary-${_label}`,
              '2026-08-25T00:03:00.000Z',
            );
          } else {
            store.markConversationContextBoundaryIndeterminate(
              `boundary-${_label}`,
              '2026-08-25T00:03:00.000Z',
            );
          }
        }

        await expect(
          readsFor(store, rootId).readConversationEventWindow(rootId, {
            authority: INTERNAL_SESSION_READ_SCOPE,
            turnLimit: 10,
          }),
        ).resolves.toMatchObject({
          conversationId: rootId,
          currentSessionId: childId,
          session: { threadId: rootId },
        });
      } finally {
        store.close();
      }
    },
  );

  test('folds an exact unmaterialized handoff child through its predecessor', async () => {
    const store = createStore();
    const rootId = 'event-reads-handoff';
    const childId = `${rootId}:child`;
    try {
      seedRoot(store, rootId);
      store.reserveConversationHandoff({
        conversationId: rootId,
        predecessorSessionId: rootId,
        sessionId: childId,
        idempotencyKey: 'handoff-key',
        targetAgentId: 'codex',
        targetExecutionAgentId: 'claude',
        targetEnvironmentId: 'environment-a',
        messageDigest: 'message-a',
        createdAt: '2026-08-25T00:01:00.000Z',
      });

      const snapshot = await readsFor(
        store,
        rootId,
      ).readConversationEventWindow(rootId, {
        authority: INTERNAL_SESSION_READ_SCOPE,
        turnLimit: 10,
      });
      expect(snapshot).toMatchObject({
        currentSessionId: childId,
        session: { threadId: rootId },
        handoffs: [
          expect.objectContaining({ targetExecutionAgentId: 'claude' }),
        ],
      });
      expect(snapshot?.handoffs[0]).not.toHaveProperty('targetProvider');
      expect(snapshot?.handoffs[0]).not.toHaveProperty(
        'expectedDefinitionFingerprint',
      );
    } finally {
      store.close();
    }
  });

  test.each(['boundary', 'handoff'] as const)(
    'fails closed for a %s child that is materialized but denied by readSession',
    async (kind) => {
      const store = createStore();
      const rootId = `event-reads-denied-${kind}`;
      const childId = `${rootId}:child`;
      try {
        seedRoot(store, rootId);
        if (kind === 'boundary') {
          store.reserveConversationContextBoundary({
            boundaryId: `${kind}-denied`,
            conversationId: rootId,
            predecessorSessionId: rootId,
            successorSessionId: childId,
            idempotencyKey: `${kind}-denied`,
            policy: 'empty-next-cold-start',
            status: 'reserved',
            actorId: 'owner-user',
            createdAt: '2026-08-25T00:01:00.000Z',
          });
        } else {
          store.reserveConversationHandoff({
            conversationId: rootId,
            predecessorSessionId: rootId,
            sessionId: childId,
            idempotencyKey: `${kind}-denied`,
            targetAgentId: 'codex',
            targetEnvironmentId: 'environment-a',
            messageDigest: 'message-a',
            createdAt: '2026-08-25T00:01:00.000Z',
          });
        }
        // The read dependency represents a foreign owner/tenant and returns
        // null. The durable materialization must prevent predecessor folding.
        store.upsertSession({
          provider: 'claude',
          threadId: childId,
          status: 'closed',
          createdAt: '2026-08-25T00:02:00.000Z',
          updatedAt: '2026-08-25T00:02:00.000Z',
        });

        await expect(
          readsFor(store, rootId).readConversationEventWindow(rootId, {
            authority: INTERNAL_SESSION_READ_SCOPE,
            turnLimit: 10,
          }),
        ).resolves.toBeNull();
      } finally {
        store.close();
      }
    },
  );

  test('fails closed for a latest unmaterialized child without exact active lineage evidence', async () => {
    const store = createStore();
    const rootId = 'event-reads-unrelated';
    try {
      seedRoot(store, rootId);
      store.reserveNextConversationSession({
        conversationId: rootId,
        predecessorSessionId: rootId,
        proposedSessionId: `${rootId}:missing`,
        createdAt: '2026-08-25T00:01:00.000Z',
      });

      await expect(
        readsFor(store, rootId).readConversationEventWindow(rootId, {
          authority: INTERNAL_SESSION_READ_SCOPE,
          turnLimit: 10,
        }),
      ).resolves.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('SessionEventReads bounded archive caller', () => {
  test.each([false, true])(
    'discovers only an unknown target (unknown=%s)',
    async (unknown) => {
      const store = createStore();
      const id = 'archive-target';
      const inventory = vi.fn(async () => {
        seedRoot(store, id);
        return [];
      });
      const hydrate = vi.fn();
      try {
        if (!unknown) seedRoot(store, id);
        const reads = readsFor(store, id, undefined, {
          listSessions: inventory,
          hydratePersistedTenantContexts: hydrate,
        });
        const options = {
          afterSequence: 0,
          limit: 100,
          authority: INTERNAL_SESSION_READ_SCOPE,
        };
        expect(await reads.readSessionEventPage(id, options)).toMatchObject({
          session: { threadId: id },
          events: [],
        });
        expect(await reads.readSessionEventPage(id, options)).not.toBeNull();
        expect(inventory).toHaveBeenCalledTimes(unknown ? 1 : 0);
        expect(
          hydrate.mock.calls.every(
            ([sessions]) =>
              sessions.length === 1 && sessions[0].threadId === id,
          ),
        ).toBe(true);
      } finally {
        store.close();
      }
    },
  );
  test('denied archive never reads its event projection or payload', async () => {
    const store = createStore();
    try {
      seedRoot(store, 'private');
      const projection = vi.spyOn(store, 'listSessionProjectionEvents');
      const page = vi.spyOn(store, 'listEventPage');
      const result = await readsFor(store, 'private', undefined, {
        canReadSession: () => false,
      }).readSessionEventPage('private', {
        afterSequence: 0,
        limit: 100,
        authority: INTERNAL_SESSION_READ_SCOPE,
      });
      expect(result).toBeNull();
      expect(projection).not.toHaveBeenCalled();
      expect(page).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});

describe('SessionEventReads session window sequence space', () => {
  // Two threads interleaved, so a thread's own ordinal (1, 2, 3, …) and the
  // global stream sequence (1, 3, 5, …) diverge. The window's `watermark` is
  // the thread-filtered GLOBAL head; its events must be numbered in that same
  // space, or a reader stitching live SSE frames (global ids) past the
  // watermark orders the page wrongly.
  function seedInterleaved(store: EventStore, a: string, b: string) {
    seedRoot(store, a);
    seedRoot(store, b);
    const globals: number[] = [];
    for (let index = 0; index < 6; index++) {
      for (const threadId of [a, b]) {
        const event =
          index === 0
            ? {
                method: 'turn.started' as const,
                turnId: `${threadId}-turn`,
                prompt: 'go',
              }
            : {
                method: 'content.text-delta' as const,
                turnId: `${threadId}-turn`,
                itemId: 'text',
                delta: `${threadId}-${index} `,
              };
        store.appendEvent({
          eventId: `${threadId}-${index}`,
          provider: 'claude',
          threadId,
          createdAt: `2026-09-29T00:00:0${index}.000Z`,
          ...event,
        } as never);
        if (threadId === a) globals.push(store.headGlobalSequence());
      }
    }
    return globals;
  }

  test.each([
    ['newest', { direction: 'newest' as const }],
    ['oldest-first', {}],
  ])(
    'a no-lineage session window (%s) numbers its events in the watermark’s global space',
    async (_label, direction) => {
      const store = createStore();
      const a = `window-space-a-${_label}`;
      const b = `window-space-b-${_label}`;
      try {
        const globals = seedInterleaved(store, a, b);
        const reads = readsFor(store, a);
        const session = await reads.readSessionEventWindow(a, {
          authority: INTERNAL_SESSION_READ_SCOPE,
          turnLimit: 10,
          ...direction,
        });
        expect(session).not.toBeNull();
        const sequences = session!.events.map((item) => item.sequence);
        // Per-thread ordinals would be [1..6]; these are the global ones.
        expect(sequences).toEqual(globals);
        expect(Math.max(...sequences)).toBe(session!.watermark);

        // The conversation reader's legacy (no-lineage) branch serves the
        // same page, so it is in the same space too.
        const conversation = await reads.readConversationEventWindow(a, {
          authority: INTERNAL_SESSION_READ_SCOPE,
          turnLimit: 10,
          ...direction,
        });
        expect(conversation?.events.map((item) => item.sequence)).toEqual(
          globals,
        );
        expect(conversation?.watermark).toBe(session!.watermark);
      } finally {
        store.close();
      }
    },
  );

  test('a capped newest window tells both readers its turn start is detached', async () => {
    const store = createStore();
    const threadId = 'detached-window';
    try {
      seedRoot(store, threadId);
      const fields = {
        provider: 'claude' as const,
        threadId,
        turnId: 'turn',
        createdAt: '2026-09-29T00:00:00.000Z',
      };
      store.appendEvent({
        ...fields,
        eventId: 'detached-start',
        method: 'turn.started',
        prompt: 'Question',
      } as never);
      for (let index = 0; index < 180; index++)
        store.appendEvent({
          ...fields,
          eventId: `detached-${index}`,
          method: 'content.text-delta',
          itemId: 'answer',
          delta: 'x',
        } as never);
      const reads = readsFor(store, threadId);
      const options = {
        authority: INTERNAL_SESSION_READ_SCOPE,
        turnLimit: 10,
        direction: 'newest' as const,
      };
      const session = await reads.readSessionEventWindow(threadId, options);
      const conversation = await reads.readConversationEventWindow(
        threadId,
        options,
      );
      expect(session).not.toBeNull();
      expect(conversation).not.toBeNull();
      expect(session?.turnStartDetached).toBe(true);
      expect(conversation?.turnStartDetached).toBe(true);
      expect(session?.nextCursor).toBeDefined();
    } finally {
      store.close();
    }
  });
});

describe('SessionEventReads current-turn tool activity', () => {
  test('fresh capped windows retain the own latest tool start and reset at the next turn', async () => {
    const store = createStore();
    const threadId = 'activity-child';
    const base = {
      provider: 'claude' as const,
      threadId,
      createdAt: '2026-10-20T00:00:00.000Z',
    };
    const options = {
      authority: INTERNAL_SESSION_READ_SCOPE,
      direction: 'newest' as const,
      turnLimit: 1,
    };
    try {
      seedRoot(store, threadId);
      store.appendEvent({
        ...base,
        eventId: 'old-start',
        turnId: 'old',
        method: 'turn.started',
        prompt: 'Previous task',
      });
      store.appendEvent({
        ...base,
        eventId: 'old-tool',
        turnId: 'old',
        method: 'tool.started',
        itemId: 'old',
        toolCallId: 'old',
        toolName: 'OldTool',
      });
      store.appendEvent({
        ...base,
        eventId: 'start',
        turnId: 'current',
        method: 'turn.started',
        prompt: 'Inspect',
      });
      store.appendEvent({
        ...base,
        eventId: 'read',
        turnId: 'current',
        method: 'tool.started',
        itemId: 'read',
        toolCallId: 'read',
        toolName: 'Read',
      });
      store.appendEvent({
        ...base,
        eventId: 'edit',
        turnId: 'current',
        method: 'tool.started',
        itemId: 'edit',
        toolCallId: 'edit',
        toolName: 'Edit',
        arguments: { private: 'must not enter the activity fact' },
      });
      store.appendEvent({
        ...base,
        eventId: 'read-done',
        turnId: 'current',
        method: 'tool.completed',
        itemId: 'read',
        toolCallId: 'read',
        toolName: 'Read',
        status: 'success',
        output: 'done',
      });
      for (let index = 0; index < 160; index++) {
        store.appendEvent({
          ...base,
          eventId: `progress-${index}`,
          turnId: 'current',
          method: 'tool.progress',
          itemId: 'edit',
          toolCallId: 'edit',
          message: `step ${index}`,
        });
      }
      for (const other of ['parent', 'sibling']) {
        seedRoot(store, other);
        store.appendEvent({
          ...base,
          threadId: other,
          eventId: `${other}-start`,
          turnId: 'current',
          method: 'turn.started',
          prompt: 'Unrelated',
        });
        store.appendEvent({
          ...base,
          threadId: other,
          eventId: `${other}-tool`,
          turnId: 'current',
          method: 'tool.started',
          itemId: other,
          toolCallId: other,
          toolName: `${other}-tool`,
        });
      }
      const result = await readsFor(store, threadId).readSessionEventWindow(
        threadId,
        options,
      );
      expect(result).not.toBeNull();
      expect(result!.hasMore).toBe(true);
      expect(result!.events.length).toBeLessThanOrEqual(150);
      expect(
        result!.events.some(({ event }) => event.method === 'tool.started'),
      ).toBe(false);
      expect(result!.latestTool).toEqual({ turnId: 'current', name: 'Edit' });
      store.appendEvent({
        ...base,
        eventId: 'steer-current',
        turnId: 'current',
        method: 'turn.started',
        inputKind: 'steer',
        prompt: 'Keep inspecting',
      });
      expect(
        (await readsFor(store, threadId).readSessionEventWindow(
          threadId,
          options,
        ))!.latestTool,
      ).toEqual({ turnId: 'current', name: 'Edit' });

      store.appendEvent({
        ...base,
        eventId: 'next-start',
        turnId: 'next',
        method: 'turn.started',
        prompt: 'Next task',
      });
      store.appendEvent({
        ...base,
        eventId: 'late-old-tool',
        turnId: 'current',
        method: 'tool.started',
        itemId: 'late',
        toolCallId: 'late',
        toolName: 'LateOldTool',
      });
      const next = await readsFor(store, threadId).readSessionEventWindow(
        threadId,
        options,
      );
      expect(next!.latestTool).toBeNull();
      store.appendEvent({
        ...base,
        eventId: 'next-tool',
        turnId: 'next',
        method: 'tool.started',
        itemId: 'next',
        toolCallId: 'next',
        toolName: 'NextTool',
      });
      expect(
        (await readsFor(store, threadId).readSessionEventWindow(
          threadId,
          options,
        ))!.latestTool,
      ).toEqual({ turnId: 'next', name: 'NextTool' });
      store.appendEvent({
        ...base,
        eventId: 'same-id-start',
        turnId: 'next',
        method: 'turn.started',
        prompt: 'New input on the same id',
      });
      expect(
        (await readsFor(store, threadId).readSessionEventWindow(
          threadId,
          options,
        ))!.latestTool,
      ).toEqual({ turnId: 'next', name: 'NextTool' });
    } finally {
      store.close();
    }
  });

  test('activity respects the transcript watermark when a newer turn arrives between reads', async () => {
    const store = createStore();
    const threadId = 'activity-watermark';
    const base = {
      provider: 'claude' as const,
      threadId,
      createdAt: '2026-10-20T00:00:00.000Z',
    };
    try {
      seedRoot(store, threadId);
      store.appendEvent({
        ...base,
        eventId: 'start',
        turnId: 'first',
        method: 'turn.started',
        prompt: 'First',
      });
      store.appendEvent({
        ...base,
        eventId: 'tool',
        turnId: 'first',
        method: 'tool.started',
        itemId: 'read',
        toolCallId: 'read',
        toolName: 'Read',
      });
      const window = store.listEventWindowByTurn.bind(store);
      vi.spyOn(store, 'listEventWindowByTurn').mockImplementationOnce(
        (id, options) => {
          const result = window(id, options);
          store.appendEvent({
            ...base,
            eventId: 'next',
            turnId: 'second',
            method: 'turn.started',
            prompt: 'Second',
          });
          return result;
        },
      );
      const result = await readsFor(store, threadId).readSessionEventWindow(
        threadId,
        {
          authority: INTERNAL_SESSION_READ_SCOPE,
          direction: 'newest',
          turnLimit: 1,
        },
      );
      expect(result!.watermark).toBeLessThan(store.headGlobalSequence());
      expect(result!.latestTool).toEqual({ turnId: 'first', name: 'Read' });
    } finally {
      store.close();
    }
  });

  test.each(['é'.repeat(128), 'é'.repeat(129), ''])(
    'bounds the latest tool name without substituting an earlier tool (%s)',
    async (name) => {
      const store = createStore();
      const threadId = 'activity-bound';
      const base = {
        provider: 'claude' as const,
        threadId,
        turnId: 'current',
        createdAt: '2026-10-20T00:00:00.000Z',
      };
      try {
        seedRoot(store, threadId);
        store.appendEvent({
          ...base,
          eventId: 'start',
          method: 'turn.started',
          prompt: 'Inspect',
        });
        store.appendEvent({
          ...base,
          eventId: 'earlier',
          method: 'tool.started',
          itemId: 'earlier',
          toolCallId: 'earlier',
          toolName: 'EarlierTool',
        });
        store.appendEvent({
          ...base,
          eventId: 'latest',
          method: 'tool.started',
          itemId: 'latest',
          toolCallId: 'latest',
          toolName: name,
        });
        const result = await readsFor(store, threadId).readSessionEventWindow(
          threadId,
          {
            authority: INTERNAL_SESSION_READ_SCOPE,
            direction: 'newest',
            turnLimit: 1,
          },
        );
        expect(result!.latestTool).toEqual(
          name && Buffer.byteLength(name) <= 256
            ? { turnId: 'current', name }
            : null,
        );
      } finally {
        store.close();
      }
    },
  );
});
