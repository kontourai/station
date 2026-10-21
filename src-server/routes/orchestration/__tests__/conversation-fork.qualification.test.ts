import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  continuityBinding,
  continuityRegistry,
  TerminalHandoffAdapter,
} from '../../../__test-utils__/scripted-continuity-adapter.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import {
  createConversationHandoffIntent,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import type { Logger } from '../../../utils/logger.js';
import {
  createConversationRoutes,
  createGlobalConversationRoutes,
} from '../../chat/conversations.js';

const OWNER = 'fork-qualification-owner';
const ENVIRONMENT = 'fork-qualification-station';
const PARENT = 'owned-file-parent';
const PARENT_AGENT = agentId('source-agent');
const PARENT_ONLY = 'FORK-PARENT-ONLY-9384';
const FIRST_MESSAGE = 'Continue this independent fork.';
const authority = sessionReadAuthorityFromRequest(OWNER, undefined, undefined);
const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
  setLevel: vi.fn(),
  getLevel: () => 'error',
};

describe('scripted fork delivery and canonical history qualification', () => {
  const makeTempDir = trackTempDirs();
  const runtimes: { service: OrchestrationService; store: EventStore }[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.service.shutdown();
      runtime.store.close();
    }
  });

  async function fixture(provider: 'codex' | 'claude') {
    const root = makeTempDir('station-fork-qualification-');
    const parentFiles = new FileMemoryAdapter({ projectHomeDir: root });
    const targetFiles = new FileMemoryAdapter({ projectHomeDir: root });
    await parentFiles.createConversation({
      id: PARENT,
      resourceId: PARENT_AGENT,
      userId: OWNER,
      title: 'Parent before branching',
      metadata: {},
    });
    await parentFiles.addMessages(
      [
        {
          id: 'parent-user',
          role: 'user',
          parts: [
            {
              type: 'text',
              text: `Remember HANDOFF-CARRY-731 and ${PARENT_ONLY}.`,
            },
          ],
        },
        {
          id: 'parent-answer',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Stored parent answer.' }],
          metadata: { turnId: 'parent-turn', answerEligible: true },
        },
      ],
      OWNER,
      PARENT,
    );
    const store = new EventStore(join(root, 'events.sqlite'));
    const ownership = {
      assertMutable: (id: string) => store.assertNativeSessionMutable(id),
      claim: (key: string, id: string, rebind?: boolean) =>
        store.claimNativeSessionIdentity(key, id, rebind),
      retired: (id: string) => store.recordNativeSessionRetired(id),
    };
    const codex = new TerminalHandoffAdapter('codex', true, ownership);
    const claude = new TerminalHandoffAdapter('claude', true, ownership);
    const service = new OrchestrationService({
      eventStore: store,
      eventBus: new EventBus(),
      adapterRegistry: continuityRegistry([codex, claude]),
      logger,
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) => ({
          name: slug,
          prompt: `Instructions for ${slug}`,
          skills: [],
          tools: { mcpServers: [] },
        }),
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
    });
    runtimes.push({ service, store });
    const memoryAdapters = new Map([
      [PARENT_AGENT, parentFiles],
      [agentId(provider), targetFiles],
    ]);
    const globalRoutes = createGlobalConversationRoutes(
      memoryAdapters,
      { getConversation: () => null },
      logger,
      undefined,
      service,
      () => OWNER,
      undefined,
      () => authority,
      service,
    );
    const routes = createConversationRoutes(
      memoryAdapters,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
      () => OWNER,
      undefined,
      () => authority,
      service,
      () => true,
    );
    const fork = await routes.request(
      `/${PARENT_AGENT}/conversations/${PARENT}/fork`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetAgent: provider,
          branchPointTurnId: 'parent-turn',
          idempotencyKey: 'one-owned-fork',
        }),
      },
    );
    expect(fork.status, await fork.clone().text()).toBe(200);
    const body: unknown = await fork.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('data' in body) ||
      !body.data ||
      typeof body.data !== 'object' ||
      !('conversationId' in body.data) ||
      typeof body.data.conversationId !== 'string'
    )
      throw new Error('Fork did not return a Conversation identity.');
    const conversationId = body.data.conversationId;
    expect(conversationId).not.toBe(PARENT);
    expect(store.readSessionByThread(conversationId)).toBeUndefined();
    expect(store.readSessionByThread(PARENT)).toBeUndefined();
    await parentFiles.addMessages(
      [
        {
          id: 'later-parent-user',
          role: 'user',
          parts: [{ type: 'text', text: 'AFTER-FORK-DIVERGENCE' }],
        },
        {
          id: 'later-parent-answer',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Later parent answer.' }],
          metadata: { turnId: 'later-parent-turn', answerEligible: true },
        },
      ],
      OWNER,
      PARENT,
    );

    const deps: ExecutionTargetExecutionDependencies = {
      resolveEnvironmentAccess: async () => ({
        kind: 'current',
        apiBase: 'http://fork-qualification.station',
        environmentId: ENVIRONMENT,
        environmentName: 'Fork qualification',
      }),
      getAgent: async (_access, id) => {
        if (id !== 'codex' && id !== 'claude')
          throw new Error('Unexpected execution Agent.');
        return {
          slug: id,
          available: true,
          executionDefault: true,
          execution: { agentConnectionId: engineConnectionId(id) },
        };
      },
      getConnection: async (_access, id) => {
        if (id !== 'codex' && id !== 'claude')
          throw new Error('Unexpected connection.');
        return {
          id: engineConnectionId(id),
          name: id,
          type: `${id}-runtime`,
          kind: 'agent',
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          prerequisites: [],
          config: { provider: id },
        };
      },
      getProject: async () => {
        throw new Error('This fixture has no Project.');
      },
      getProviderAdapter: (id) => service.getProviderAdapter(id),
      readSessionBinding: async (_access, id) => continuityBinding(store, id),
      readInitialConversationContext: async (_access, input) =>
        service.prepareInitialConversationForkContext(input, authority),
      resolveConversationSession: async (_access, id, requested) =>
        service.resolveConversationContinuation(id, authority, requested),
      prepareConversationHandoff: async (_access, input) =>
        service.prepareConversationHandoff(input.conversationId, authority, {
          agentId: input.agentId,
          environmentId: ENVIRONMENT,
          provider: input.provider,
          connectionId: input.connectionId,
          idempotencyKey: input.idempotencyKey,
          messageDigest: input.messageDigest,
        }),
      readConversationHandoffEffect: async (_access, input) =>
        service.readConversationHandoffStatus(
          input.conversationId,
          input.idempotencyKey,
          authority,
          input.inputDigest,
        ),
      retireHandoffPredecessor: async (_access, id) =>
        service.retireHandoffPredecessor(id, authority),
      retireNativeReturnSource: async (_access, id) =>
        service.retireNativeReturnSource(id, authority),
      claimConversationContextBoundaryColdStart: (_access, id, commandId) =>
        service.claimConversationContextBoundaryColdStart(id, commandId),
      consumeConversationContextBoundary: (_access, id, commandId) =>
        service.consumeConversationContextBoundary(id, commandId),
      releaseConversationContextBoundaryFailedClaim: (
        _access,
        id,
        indeterminate,
      ) =>
        service.releaseConversationContextBoundaryFailedClaim(
          id,
          indeterminate,
        ),
      startSession: async (_access, input) => {
        const conversation = input.metadata?.conversationId;
        const environment = input.metadata?.environmentId;
        if (typeof conversation !== 'string' || typeof environment !== 'string')
          throw new Error('Foreground start omitted its identity.');
        const boundary = input.metadata?.contextBoundary;
        const commandId =
          boundary &&
          typeof boundary === 'object' &&
          'startCommandId' in boundary &&
          typeof boundary.startCommandId === 'string'
            ? boundary.startCommandId
            : undefined;
        const started = await service.startSessionInternal(
          { type: 'start-session', input },
          { userId: OWNER },
          {
            ...(commandId ? { commandId } : {}),
            conversationIdentity: {
              conversationId: conversation,
              environmentId: environment,
            },
          },
        );
        if (started.status !== 'accepted') throw new Error(started.message);
        await vi.waitFor(() =>
          expect(continuityBinding(store, conversation)).not.toBeNull(),
        );
        return {
          commandId: started.receipt.commandId,
          sessionId: started.session.threadId,
        };
      },
      sendTurn: async (_access, input, context) => {
        const receipt = await service.dispatchWithReceipt(
          { type: 'sendTurn', input },
          { userId: OWNER },
          { submissionDigest: context?.submissionDigest },
        );
        if (!receipt.result || !('turnId' in receipt.result))
          throw new Error('No provider turn identity.');
        return { turnId: receipt.result.turnId };
      },
    };
    const execute = (
      selected: 'codex' | 'claude',
      message: string,
      handoffKey?: string,
      ephemeral = false,
    ) =>
      executeForegroundMessage(
        {
          target: {
            environment: { kind: 'current' },
            agent: agentId(selected),
          },
          conversationId,
          message,
          userId: OWNER,
          ...(ephemeral ? { ephemeral: true } : {}),
          ...(handoffKey
            ? { handoffIntent: createConversationHandoffIntent(handoffKey) }
            : {}),
        },
        deps,
      );
    return {
      service,
      store,
      routes,
      globalRoutes,
      conversationId,
      receiver: provider === 'codex' ? codex : claude,
      other: provider === 'codex' ? claude : codex,
      execute,
    };
  }

  async function stoppedNonpersistentFork() {
    const f = await fixture('codex');
    await f.execute('codex', FIRST_MESSAGE, undefined, true);
    await vi.waitFor(async () =>
      expect(
        (
          await f.service.readCurrentConversationSession(
            f.conversationId,
            authority,
          )
        )?.session.hasActiveTurn,
      ).toBe(false),
    );
    await f.service.dispatch(
      { type: 'stopSession', threadId: f.conversationId },
      { userId: OWNER },
    );
    await vi.waitFor(() =>
      expect(f.store.readSessionByThread(f.conversationId)?.status).toBe(
        'closed',
      ),
    );
    return f;
  }

  test.each(['codex', 'claude'] as const)(
    '%s receives the selected fork context and carries it into a later handoff',
    async (provider) => {
      const f = await fixture(provider);
      await f.execute(provider, FIRST_MESSAGE);
      await vi.waitFor(() => expect(f.receiver.turns).toHaveLength(1));
      expect(f.receiver.turns[0]?.ambientContext).toContain(PARENT_ONLY);
      expect(f.receiver.turns[0]?.ambientContext).not.toContain(
        'AFTER-FORK-DIVERGENCE',
      );
      await vi.waitFor(async () =>
        expect(
          (
            await f.service.readCurrentConversationSession(
              f.conversationId,
              authority,
            )
          )?.session.hasActiveTurn,
        ).toBe(false),
      );
      await f.execute(
        provider === 'codex' ? 'claude' : 'codex',
        'Continue on the other engine.',
        'fork-engine-switch',
      );
      await vi.waitFor(() => expect(f.other.turns).toHaveLength(1));
      expect(f.other.turns[0]?.ambientContext).toContain(PARENT_ONLY);
      expect(f.other.turns[0]?.ambientContext).not.toContain(
        'AFTER-FORK-DIVERGENCE',
      );
      expect(f.store.conversationSessions(f.conversationId)).toHaveLength(2);
      expect(
        f.store.readConversationForkProvenance(f.conversationId).forkedFrom
          ?.sourceConversationId,
      ).toBe(PARENT);
    },
  );

  test('a failed first fork seed cannot be silently skipped by an ordinary follow-up', async () => {
    const f = await fixture('codex');
    f.receiver.failNextTranscriptSeed = true;
    await f.execute('codex', FIRST_MESSAGE);
    await vi.waitFor(() => expect(f.receiver.turns).toHaveLength(1));
    await vi.waitFor(async () =>
      expect(
        (
          await f.service.readCurrentConversationSession(
            f.conversationId,
            authority,
          )
        )?.session.hasActiveTurn,
      ).toBe(false),
    );
    await expect(
      f.execute('codex', 'Continue after the failed first turn.'),
    ).rejects.toThrow('Fork context delivery has not completed.');
    expect(f.receiver.turns).toHaveLength(1);
  });

  test.each([
    { mode: 'continuation', outcome: 'completed' },
    { mode: 'continuation', outcome: 'failed' },
    { mode: 'continue-from-history', outcome: 'completed' },
    { mode: 'continue-from-history', outcome: 'failed' },
    { mode: 'empty-next-cold-start', outcome: 'completed' },
  ] as const)(
    '$mode cold context gates ordinary reuse by observed delivery ($outcome)',
    async ({ mode, outcome }) => {
      const f = await stoppedNonpersistentFork();
      const boundary =
        mode !== 'continuation'
          ? await f.service.reserveConversationContextBoundary(
              f.conversationId,
              authority,
              {
                policy: mode,
                idempotencyKey: 'cold-context-boundary',
                expectedCurrentSessionId: f.conversationId,
                actorId: OWNER,
              },
            )
          : undefined;
      f.receiver.failNextTranscriptSeed = outcome === 'failed';
      await f.execute('codex', 'Continue in a replacement process.');
      await vi.waitFor(() => expect(f.receiver.turns).toHaveLength(2));
      if (mode === 'empty-next-cold-start') {
        expect(f.receiver.turns[1]?.ambientContext).not.toContain(PARENT_ONLY);
        expect(f.receiver.turns[1]?.ambientContext).toContain(
          'Instructions for codex',
        );
      } else expect(f.receiver.turns[1]?.ambientContext).toContain(PARENT_ONLY);
      if (boundary)
        expect(
          await f.service.readConversationContextBoundaryStatus(
            f.conversationId,
            'cold-context-boundary',
            authority,
          ),
        ).toMatchObject({ status: 'consumed' });
      await vi.waitFor(async () =>
        expect(
          (
            await f.service.readCurrentConversationSession(
              f.conversationId,
              authority,
            )
          )?.session.hasActiveTurn,
        ).toBe(false),
      );
      if (outcome === 'failed') {
        await expect(
          f.execute('codex', 'Ordinary follow-up after that failure.'),
        ).rejects.toThrow('Continuation context delivery has not completed.');
        expect(f.receiver.turns).toHaveLength(2);
      } else {
        await f.execute(
          'codex',
          'Ordinary follow-up after completed delivery.',
        );
        await vi.waitFor(() => expect(f.receiver.turns).toHaveLength(3));
        expect(f.receiver.turns[2]?.ambientContext).toBeUndefined();
      }
    },
  );

  test('an intervening source append refuses the continuation pin before a replacement starts', async () => {
    const f = await stoppedNonpersistentFork();
    const reserve = f.store.reserveConversationStartContext.bind(f.store);
    const raced = vi
      .spyOn(f.store, 'reserveConversationStartContext')
      .mockImplementationOnce((id, pin) => {
        f.store.appendEvent({
          eventId: 'continuation-source-raced',
          provider: 'codex',
          threadId: f.conversationId,
          sessionId: f.conversationId,
          method: 'session.configured',
          createdAt: new Date().toISOString(),
          metadata: {},
        });
        return reserve(id, pin);
      });
    try {
      await expect(
        f.execute('codex', 'Continue with a source racing reservation.'),
      ).rejects.toThrow('context changed before its continuation reservation');
    } finally {
      raced.mockRestore();
    }
    expect(f.receiver.starts).toHaveLength(1);
    expect(f.receiver.turns).toHaveLength(1);
    const pending = f.store.conversationSessions(f.conversationId).at(-1);
    expect(pending?.predecessorSessionId).toBe(f.conversationId);
    expect(f.store.readSessionByThread(pending!.sessionId)).toBeUndefined();
    expect(
      f.store.conversationStartContext(pending!.sessionId),
    ).toBeUndefined();
  });

  test('an owned unstarted fork opens with copied context and no invented provider Session', async () => {
    const f = await fixture('codex');
    const response = await f.globalRoutes.request(
      `/${encodeURIComponent(f.conversationId)}/open`,
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('data' in body))
      throw new Error('Fork open omitted its result.');
    const opened = body.data;
    expect(opened).toMatchObject({
      status: 'fork-ready',
      conversation: { id: f.conversationId, agentSlug: 'codex' },
      transcript: { available: true, owner: 'fork-context', messageCount: 2 },
      canContinue: true,
    });
    expect(opened).not.toHaveProperty('currentSessionId');
    expect(
      await f.service.resolveConversationOpen(
        f.conversationId,
        sessionReadAuthorityFromRequest(
          'unrelated-owner',
          undefined,
          undefined,
        ),
      ),
    ).toBeNull();
    expect(f.receiver.starts).toHaveLength(0);
  });

  test('deleting an unstarted fork prevents its saved seed from activating later', async () => {
    const f = await fixture('codex');
    const deleted = await f.routes.request(
      `/codex/conversations/${encodeURIComponent(f.conversationId)}`,
      { method: 'DELETE' },
    );
    expect(deleted.status).toBe(200);
    const lookup = await f.globalRoutes.request(
      `/${encodeURIComponent(f.conversationId)}`,
    );
    expect(lookup.status).toBe(404);
    const reopened = await f.globalRoutes.request(
      `/${encodeURIComponent(f.conversationId)}/open`,
    );
    expect(reopened.status).toBe(404);
    await expect(f.execute('codex', FIRST_MESSAGE)).rejects.toThrow();
    expect(f.receiver.starts).toHaveLength(0);
    expect(f.receiver.turns).toHaveLength(0);
  });

  test('native fork refresh includes copied context and the new user turn', async () => {
    const f = await fixture('codex');
    await f.execute('codex', FIRST_MESSAGE);
    await vi.waitFor(() =>
      expect(
        f.service
          .readSessionMessages(f.conversationId, authority)
          .some((message) => message.role === 'user'),
      ).toBe(true),
    );
    const refreshed = await f.routes.request(
      `/codex/conversations/${encodeURIComponent(f.conversationId)}/messages`,
    );
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([
            expect.objectContaining({ text: FIRST_MESSAGE }),
          ]),
        }),
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining(PARENT_ONLY),
            }),
          ]),
        }),
      ]),
    });
  });
});
