/**
 * #2589: a Station-agent relay turn names its orchestration thread, and the
 * REAL `streamPrimaryAgentChat` must hand it to the elicitation callback it
 * builds, so a tool approval in that turn is registered with
 * `orchestrationThreadId` (the registry twin the agent-activity card also
 * carries). chat.routes.test.ts mocks `streamPrimaryAgentChat` and the
 * stream-orchestrator tests call the callback directly, so neither sees the
 * hand-off itself.
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import { streamPrimaryAgentChat } from '../chat-primary-stream.js';
import { ChatTurnDedupStore } from '../chat-turn-dedup.js';

describe('streamPrimaryAgentChat: the relay thread reaches tool approvals', () => {
  const makeTempDir = trackTempDirs();
  let dedupStore: ChatTurnDedupStore;
  let memoryAdapter: Record<string, unknown>;

  const buildCtx = (register: ReturnType<typeof vi.fn>) =>
    ({
      agentSpecs: new Map([
        ['assistant', { name: 'Assistant', tools: { autoApprove: [] } }],
      ]),
      toolNameMapping: new Map(),
      approvalRegistry: { register },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      agentHooksMap: new Map(),
      memoryAdapters: new Map([['assistant', memoryAdapter]]),
      feedbackService: { getRatings: () => [] },
      agentStatus: new Map(),
      agentStats: new Map(),
      agentTools: new Map(),
      monitoringEvents: undefined,
      monitoringEmitter: new MonitoringEmitter(
        new EventEmitter(),
        async () => {},
      ),
      modelCatalog: undefined,
      metricsLog: [] as unknown[],
      providerService: {
        listProviderConnections: () => [],
        getLaunchabilityRevision: () => 0,
      },
      getAgentConfigurationRevision: () => 0,
      configLoader: { getLaunchabilityRevision: () => 0 },
      commitAgentConfigurationRead: async (
        _expectedRevision: number,
        operation: () => Promise<unknown>,
      ) => operation(),
    }) as any;

  /** Runs one turn whose engine asks for one tool approval. */
  const registeredMetadata = async (orchestrationThreadId?: string) => {
    const register = vi.fn().mockResolvedValue(true);
    const ctx = buildCtx(register);
    const streamText = vi.fn(
      async (
        _input: unknown,
        options: {
          elicitation: (request: Record<string, unknown>) => Promise<unknown>;
        },
      ) => {
        await options.elicitation({
          type: 'tool-approval',
          toolName: 'repo_write',
        });
        // The approval is what this test is about; end the turn here.
        throw new Error('engine stops after the approval');
      },
    );
    const app = new Hono();
    app.post('/chat', (c) =>
      streamPrimaryAgentChat({
        c,
        ctx,
        slug: 'assistant',
        plugin: '',
        input: 'hello',
        restOptions: { conversationId: 'thread-7' },
        injectContext: null,
        ragContext: null,
        agent: {
          getMemory: () => null,
          model: { modelId: 'test-model' },
          streamText,
        } as any,
        configurationLease: captureRuntimeConfigurationLease(ctx)!,
        dedupStore,
        ...(orchestrationThreadId ? { orchestrationThreadId } : {}),
      }),
    );
    const response = await app.request('/chat', { method: 'POST' });
    await response.text();
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    return register.mock.calls[0]?.[1]?.metadata;
  };

  beforeEach(() => {
    dedupStore = new ChatTurnDedupStore(
      join(makeTempDir('chat-primary-stream-relay-'), 'chat-turn-dedup.json'),
    );
    const conversations = new Map<string, { id: string }>();
    memoryAdapter = {
      getConversation: vi.fn(
        async (id: string) => conversations.get(id) ?? null,
      ),
      createConversation: vi.fn(async (payload: { id: string }) => {
        conversations.set(payload.id, { id: payload.id });
      }),
      addMessage: vi.fn(async () => {}),
      getMessages: vi.fn(async () => []),
      getConversations: vi.fn(async () => []),
    };
  });

  test('a relay turn registers its approval with its orchestration thread', async () => {
    expect(await registeredMetadata('thread-7')).toMatchObject({
      conversationId: 'thread-7',
      orchestrationThreadId: 'thread-7',
    });
  });

  test('a turn with no relay thread registers none', async () => {
    const metadata = await registeredMetadata();
    expect(metadata).toMatchObject({ conversationId: 'thread-7' });
    expect(metadata).not.toHaveProperty('orchestrationThreadId');
  });
});
