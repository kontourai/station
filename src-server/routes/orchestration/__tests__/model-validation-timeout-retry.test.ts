import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import type { ProviderAdapterMetadata } from '../../../providers/adapter-shape.js';
import {
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';

const OWNER = 'validation-timeout-owner';

/**
 * #2424, through the real foreground seam (`executeForegroundMessage`) and the
 * real `OrchestrationService`/`EventStore`: on a loaded host the Claude model
 * catalog read (a whole CLI spawn) missed its deadline, which failed the send,
 * and the failed continuation start then made the conversation's open read
 * report "not found", which the client renders as a read-only chat.
 */
class SlowCatalogClaudeAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'claude adapter whose catalog probe stalls',
    capabilities: ['agent-runtime'],
    defaultModel: 'claude-default',
    knownModels: [{ id: 'claude-default', name: 'Default' }],
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  };
  /** Catalog reads that never answer until Station's deadline aborts them. */
  stallCatalog = 0;
  turns = 0;

  listModels(options?: { signal?: AbortSignal }) {
    if (this.stallCatalog > 0) {
      this.stallCatalog -= 1;
      return new Promise<never>((_, reject) =>
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        ),
      );
    }
    return Promise.resolve([
      { id: 'claude-default', name: 'Default', originalId: 'claude-default' },
    ]);
  }

  override async startSession(input: ProviderSessionStartInput) {
    const now = new Date().toISOString();
    this.events.push({
      eventId: `${input.threadId}:configured`,
      method: 'session.configured',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      metadata: input.metadata,
    } as CanonicalRuntimeEvent);
    return {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      createdAt: now,
      updatedAt: now,
    };
  }

  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns += 1;
    const turnId = `turn-${this.turns}`;
    const base = {
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      createdAt: new Date().toISOString(),
    } as const;
    this.events.push({
      ...base,
      eventId: `${turnId}:started`,
      method: 'turn.started',
      prompt: input.input,
    });
    this.events.push({
      ...base,
      eventId: `${turnId}:completed`,
      method: 'turn.completed',
      outputText: 'ok',
    });
    return { threadId: input.threadId, turnId };
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-validation-timeout-'));
  roots.push(root);
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const adapter = new SlowCatalogClaudeAdapter();
  // A transient failure BEFORE the engine launches, independent of the
  // catalog: the class of start failure a validation deadline used to be.
  let failAgentResolution = 0;
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    resolveSessionAgent: async (input) => {
      if (failAgentResolution > 0) {
        failAgentResolution -= 1;
        throw new Error('agent resolution unavailable');
      }
      return { ...input, agent: { slug: 'claude' } };
    },
    logger: { debug: vi.fn(), warn: vi.fn() },
    ownerlessSessionAccess: 'single-user-compat',
  });
  const deps: ExecutionTargetExecutionDependencies = {
    resolveEnvironmentAccess: async () => ({
      apiBase: 'http://validation.station',
      environmentId: 'validation-station',
      environmentName: 'Validation Station',
      kind: 'current',
    }),
    getAgent: async () => ({
      slug: 'claude',
      available: true,
      execution: { agentConnectionId: engineConnectionId('claude') },
    }),
    getConnection: async () => ({
      id: engineConnectionId('claude'),
      name: 'Claude Code',
      type: 'claude',
      kind: 'agent',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { provider: 'claude' },
    }),
    getProject: async () => undefined,
    getProviderAdapter: (provider) => service.getProviderAdapter(provider),
    readSessionBinding: async (_access, id) => {
      const detail = await service.readSession(id, INTERNAL_SESSION_READ_SCOPE);
      if (!detail) return null;
      return {
        environmentId: 'validation-station',
        agentId: 'claude',
        userId: OWNER,
      };
    },
    resolveConversationSession: async (_access, id, requested) =>
      service.resolveConversationContinuation(
        id,
        INTERNAL_SESSION_READ_SCOPE,
        requested,
      ),
    startSession: async (_access, input) => {
      const started = await service.startSessionInternal(
        { type: 'start-session', input },
        { userId: OWNER },
        {
          conversationIdentity: {
            conversationId: String(input.metadata?.conversationId),
            environmentId: String(input.metadata?.environmentId),
          },
        },
      );
      if (started.status !== 'accepted') throw new Error(started.message);
      return undefined;
    },
    sendTurn: async (_access, input) => {
      const dispatched = await service.dispatchWithReceipt(
        { type: 'sendTurn', input },
        { userId: OWNER },
      );
      if (!dispatched.result || !('turnId' in dispatched.result))
        throw new Error('dispatch returned no turn id');
      return { turnId: dispatched.result.turnId };
    },
  };
  const send = (conversationId: string, override?: string) =>
    executeForegroundMessage(
      {
        message: 'hello',
        conversationId,
        clientTurnId: 'client-turn-1',
        target: {
          environment: { kind: 'current' },
          agent: agentId('claude'),
          ...(override ? { model: { override } } : {}),
        },
        userId: OWNER,
      },
      deps,
    );
  const failNextStartBeforeLaunch = () => {
    failAgentResolution = 1;
  };
  return { store, adapter, service, send, failNextStartBeforeLaunch };
}

const OWNER_AUTHORITY = sessionReadAuthorityFromRequest(
  OWNER,
  undefined,
  undefined,
);

/**
 * #2540: the engine reports its session ended (an explicit stop, a restart),
 * through the same event path a real adapter uses — so the next turn needs a
 * successor, the start these tests fail.
 */
async function closeBinding(
  service: OrchestrationService,
  adapter: SlowCatalogClaudeAdapter,
  threadId: string,
) {
  adapter.events.push({
    eventId: `${threadId}:exited`,
    method: 'session.exited',
    provider: adapter.provider,
    threadId,
    sessionId: threadId,
    reason: 'stopped',
    createdAt: new Date().toISOString(),
  } as CanonicalRuntimeEvent);
  await eventually(async () => {
    const detail = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(detail?.session.status).toBe('closed');
    // The exit records no new outcome for the finished turn.
    expect(detail?.session.lifecycleState).toBe('idle');
  });
}

test('a first send succeeds when the model catalog misses its deadline', async () => {
  const { adapter, service, send, store } = fixture();
  service.initialize();
  adapter.stallCatalog = 1;

  const handle = await send('conv-first-send');

  expect(adapter.stallCatalog).toBe(0);
  expect(handle).toMatchObject({
    conversationId: 'conv-first-send',
    sessionId: 'conv-first-send',
    providerTurnId: 'turn-1',
  });
  await service.shutdown();
  store.close();
}, 30_000);

test('a continuation whose start failed before launch stays openable and writable, and the next send reuses its reservation', async () => {
  const { adapter, service, send, store, failNextStartBeforeLaunch } =
    fixture();
  service.initialize();
  await send('conv-continued');
  await eventually(async () => {
    expect(
      (await service.readSession('conv-continued', INTERNAL_SESSION_READ_SCOPE))
        ?.session.lifecycleState,
    ).toBe('idle');
  });

  // #2540: a finished turn leaves the root idle and reusable; only an engine
  // binding that ended (a stop, a restart) sends the next turn to a
  // successor — the start this test fails.
  await closeBinding(service, adapter, 'conv-continued');
  failNextStartBeforeLaunch();
  await expect(send('conv-continued')).rejects.toThrow(
    'agent resolution unavailable',
  );
  const lineage = store.conversationSessions('conv-continued');
  expect(lineage).toHaveLength(2);
  const reserved = lineage[1]!.sessionId;
  expect(
    await service.readSession(reserved, INTERNAL_SESSION_READ_SCOPE),
  ).toBeNull();

  // Before the fix this was `null` — the route's 404 "Conversation not
  // found" — which the client turned into "is read-only".
  const readCurrent = vi.spyOn(service, 'readCurrentConversationSession');
  const open = await service.resolveConversationOpen(
    'conv-continued',
    OWNER_AUTHORITY,
  );
  // The predecessor is followed under the REQUEST's authority, never an
  // internal scope that would read it for anyone.
  expect(readCurrent).toHaveBeenCalledWith('conv-continued', OWNER_AUTHORITY);
  for (const [, authority] of readCurrent.mock.calls)
    expect(authority).toBe(OWNER_AUTHORITY);
  readCurrent.mockRestore();
  expect(open).toMatchObject({
    status: 'resolved',
    currentSessionId: 'conv-continued',
    canContinue: true,
    execution: { sessionId: 'conv-continued' },
  });

  const retried = await send('conv-continued');
  expect(retried.sessionId).toBe(reserved);
  expect(store.conversationSessions('conv-continued')).toHaveLength(2);
  await eventually(async () => {
    expect(
      await service.resolveConversationOpen('conv-continued', OWNER_AUTHORITY),
    ).toMatchObject({
      status: 'resolved',
      currentSessionId: reserved,
      canContinue: true,
    });
  });
  await service.shutdown();
  store.close();
}, 30_000);

test('another user still cannot open the reserved-tail conversation', async () => {
  const { adapter, service, send, store, failNextStartBeforeLaunch } =
    fixture();
  service.initialize();
  await send('conv-private');
  await eventually(async () => {
    expect(
      (await service.readSession('conv-private', INTERNAL_SESSION_READ_SCOPE))
        ?.session.lifecycleState,
    ).toBe('idle');
  });
  // #2540: a finished turn leaves the root idle and reusable; only an engine
  // binding that ended (a stop, a restart) sends the next turn to a
  // successor — the start this test fails.
  await closeBinding(service, adapter, 'conv-private');
  failNextStartBeforeLaunch();
  await expect(send('conv-private')).rejects.toThrow();

  await expect(
    service.resolveConversationOpen(
      'conv-private',
      sessionReadAuthorityFromRequest('someone-else', undefined, undefined),
    ),
  ).resolves.toBeNull();
  await service.shutdown();
  store.close();
}, 30_000);

/**
 * #2424 review HIGH: only a PLAIN reservation is described by its
 * predecessor. The send path refuses a handoff tail and an unstartable
 * boundary, and starts a FRESH-context child for a startable boundary, so none
 * of them may open as the predecessor's writable continuation. They keep
 * main's behaviour: the tail has no Session, so the open read finds nothing
 * (the client shows its "couldn't confirm" state, not a writable chat).
 */
describe('non-plain reserved tails are not opened through their predecessor', () => {
  async function completedConversation(conversationId: string) {
    const harness = fixture();
    harness.service.initialize();
    await harness.send(conversationId);
    await eventually(async () => {
      expect(
        (
          await harness.service.readSession(
            conversationId,
            INTERNAL_SESSION_READ_SCOPE,
          )
        )?.session.lifecycleState,
      ).toBe('idle');
    });
    return harness;
  }

  test('a handoff tail awaiting its target', async () => {
    const { service, send, store } =
      await completedConversation('conv-handoff');
    await service.prepareConversationHandoff(
      'conv-handoff',
      INTERNAL_SESSION_READ_SCOPE,
      {
        agentId: 'agent-b',
        environmentId: 'validation-station',
        idempotencyKey: 'handoff-1',
        messageDigest: 'digest-1',
      },
    );
    expect(store.conversationSessions('conv-handoff')).toHaveLength(2);

    await expect(
      service.resolveConversationOpen('conv-handoff', OWNER_AUTHORITY),
    ).resolves.toBeNull();
    // ...and the send path agrees it is not an ordinary continuation.
    await expect(send('conv-handoff')).rejects.toThrow(
      'awaiting its target session start',
    );
    await service.shutdown();
    store.close();
  }, 30_000);

  test('an indeterminate context-boundary tail', async () => {
    const { service, send, store } = await completedConversation('conv-indet');
    const boundary = await service.reserveConversationContextBoundary(
      'conv-indet',
      INTERNAL_SESSION_READ_SCOPE,
      {
        policy: 'continue-from-history',
        idempotencyKey: 'boundary-indet',
        expectedCurrentSessionId: 'conv-indet',
        actorId: OWNER,
      },
    );
    // A claimed cold start whose outcome is unknown.
    store.claimConversationContextBoundaryColdStart(
      boundary.boundaryId,
      'cold-start-1',
      new Date().toISOString(),
    );
    store.markConversationContextBoundaryIndeterminate(
      boundary.boundaryId,
      new Date().toISOString(),
    );

    await expect(
      service.resolveConversationOpen('conv-indet', OWNER_AUTHORITY),
    ).resolves.toBeNull();
    await expect(send('conv-indet')).rejects.toThrow('not startable');
    await service.shutdown();
    store.close();
  }, 30_000);

  // Review MEDIUM: this tail IS startable, but as a fresh-context child, so
  // describing it by the predecessor's transcript and Session would misstate
  // what the next send does. It keeps main's not-found open read.
  test('a reserved empty-next-cold-start boundary tail', async () => {
    const { service, store } = await completedConversation('conv-cold');
    await service.reserveConversationContextBoundary(
      'conv-cold',
      INTERNAL_SESSION_READ_SCOPE,
      {
        policy: 'empty-next-cold-start',
        idempotencyKey: 'boundary-cold',
        expectedCurrentSessionId: 'conv-cold',
        actorId: OWNER,
      },
    );
    expect(store.conversationSessions('conv-cold')).toHaveLength(2);

    await expect(
      service.resolveConversationOpen('conv-cold', OWNER_AUTHORITY),
    ).resolves.toBeNull();
    await service.shutdown();
    store.close();
  }, 30_000);
});

function eventually(assertion: () => void | Promise<void>, timeoutMs = 5_000) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const check = async () => {
      try {
        await assertion();
        resolve();
      } catch (error) {
        if (Date.now() - started >= timeoutMs) reject(error);
        else setTimeout(check, 10);
      }
    };
    void check();
  });
}
