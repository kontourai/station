import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import {
  type ConversationImportRequestV1,
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES,
} from '@kontourai/station-contracts/peer-chat';
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
import { createConversationRoutes } from '../../chat/conversations.js';

/**
 * The receiver half of continuing a conversation on a paired Station: the
 * real import route saves the carried history as a fork context, the real
 * foreground start of that conversation seeds the engine with it, and a
 * later Agent/engine handoff still carries it.
 */
const OWNER = 'import-qualification-owner';
const ENVIRONMENT = 'import-qualification-station';
const CARRIED_ONLY = 'CARRIED-FROM-SOURCE-5521';
const FIRST_MESSAGE = 'Pick up where the other Station left off.';
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

function importBody(
  overrides: Partial<ConversationImportRequestV1> = {},
): ConversationImportRequestV1 {
  return {
    version: 1,
    idempotencyKey: 'import-key-1',
    source: {
      environmentId: 'source-station',
      stationName: 'Laptop',
      conversationId: 'source-conversation',
      title: 'Move plan',
      agent: 'codex',
    },
    messages: [
      { id: 'u1', role: 'user', text: `Remember ${CARRIED_ONLY}.` },
      { id: 'a1', role: 'assistant', text: 'Remembered on the source.' },
    ],
    omittedMessages: 0,
    nonTextMessages: 0,
    shortenedMessages: 0,
    ...overrides,
  };
}

describe('a conversation imported from a paired Station', () => {
  const makeTempDir = trackTempDirs();
  const runtimes: { service: OrchestrationService; store: EventStore }[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.service.shutdown();
      runtime.store.close();
    }
  });

  async function fixture(
    readAuthority: () => typeof authority = () => authority,
  ) {
    const root = makeTempDir('station-import-qualification-');
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
      [agentId('codex'), new FileMemoryAdapter({ projectHomeDir: root })],
    ]);
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
      readAuthority,
      service,
      () => true,
    );
    const importConversation = (body: unknown, agent = 'codex') =>
      routes.request(`/${agent}/conversation-imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { root, store, service, codex, claude, importConversation };
  }

  async function imported() {
    const f = await fixture();
    const response = await f.importConversation(importBody());
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      data: { conversationId: string; idempotent: boolean };
    };
    const conversationId = body.data.conversationId;
    const { store, service } = f;
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
          ...(handoffKey
            ? { handoffIntent: createConversationHandoffIntent(handoffKey) }
            : {}),
        },
        deps,
      );
    return { ...f, conversationId, idempotent: body.data.idempotent, execute };
  }

  test('its first turn and a later engine handoff both carry the imported history', async () => {
    const f = await imported();
    expect(f.idempotent).toBe(false);
    expect(f.conversationId).toMatch(/^conversation:import:/);
    // Nothing runs until the first turn is sent.
    expect(f.store.readSessionByThread(f.conversationId)).toBeUndefined();
    await f.execute('codex', FIRST_MESSAGE);
    await vi.waitFor(() => expect(f.codex.turns).toHaveLength(1));
    expect(f.codex.turns[0]?.input).toContain(FIRST_MESSAGE);
    expect(f.codex.turns[0]?.ambientContext).toContain(CARRIED_ONLY);
    expect(f.codex.turns[0]?.ambientContext).toContain('(from Laptop)');
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
    await f.execute('claude', 'Continue on the other engine.', 'switch-key');
    await vi.waitFor(() => expect(f.claude.turns).toHaveLength(1));
    expect(f.claude.turns[0]?.ambientContext).toContain(CARRIED_ONLY);
  });

  test('a same-key retry answers with the same conversation; another request under that key is refused', async () => {
    const f = await imported();
    const again = await f.importConversation(importBody());
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({
      data: { conversationId: f.conversationId, idempotent: true },
    });
    const other = await f.importConversation(
      importBody({ projectSlug: 'another-project' }),
    );
    expect(other.status).toBe(409);
  });

  test('refuses a message one byte over its bound, another Agent, and a hosted caller', async () => {
    const f = await fixture();
    const oversize = await f.importConversation(
      importBody({
        messages: [
          {
            id: 'big',
            role: 'user',
            text: 'x'.repeat(PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES + 1),
          },
        ],
      }),
    );
    expect(oversize.status).toBe(400);
    const atBound = await f.importConversation(
      importBody({
        idempotencyKey: 'at-bound',
        messages: [
          {
            id: 'big',
            role: 'user',
            text: 'x'.repeat(PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES),
          },
        ],
      }),
    );
    expect(atBound.status, await atBound.clone().text()).toBe(200);
    const otherAgent = await f.importConversation(
      importBody({
        idempotencyKey: 'other-agent',
        source: { ...importBody().source, agent: 'claude' },
      }),
    );
    expect(otherAgent.status).toBe(400);
    const hosted = await fixture(
      () => ({ ...authority, mode: 'hosted' }) as typeof authority,
    );
    expect((await hosted.importConversation(importBody())).status).toBe(404);
  });
});
