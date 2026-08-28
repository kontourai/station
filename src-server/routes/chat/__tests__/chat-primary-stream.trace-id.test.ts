/**
 * archive#3115: a turn that fails after its trace is minted still emits an
 * agent-complete span, and that span used to carry the initial `''` because
 * the finally-block's copy of the trace id was bound only once the stream was
 * built. The insights rollup excludes `''` from both of its chat-count
 * branches, so a named agent's failed turns were reported as no conversations
 * at all. Driven through the REAL `streamPrimaryAgentChat`.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
import type { MonitoringEvent } from '../../../monitoring/schema.js';
import { K, OP, SPAN } from '../../../monitoring/schema.js';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import { streamPrimaryAgentChat } from '../chat-primary-stream.js';
import { ChatTurnDedupStore } from '../chat-turn-dedup.js';

async function* emptyStream() {
  /* no chunks */
}

describe('streamPrimaryAgentChat trace id on the agent-complete span', () => {
  let dir: string;
  let dedupStore: ChatTurnDedupStore;
  let observed: MonitoringEvent[];
  let memoryAdapter: Record<string, unknown>;

  const buildCtx = () =>
    ({
      agentSpecs: new Map(),
      toolNameMapping: new Map(),
      approvalRegistry: {},
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
        async (event) => {
          observed.push(event);
        },
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

  const run = async (streamText: ReturnType<typeof vi.fn>) => {
    const ctx = buildCtx();
    const app = new Hono();
    app.post('/chat', (c) =>
      streamPrimaryAgentChat({
        c,
        ctx,
        slug: 'assistant',
        plugin: '',
        input: 'hello',
        restOptions: {},
        injectContext: null,
        ragContext: null,
        agent: {
          getMemory: () => null,
          model: { modelId: 'test-model' },
          streamText,
        } as any,
        configurationLease: captureRuntimeConfigurationLease(ctx)!,
        dedupStore,
      }),
    );
    const response = await app.request('/chat', { method: 'POST' });
    await response.text();
    await ctx.monitoringEmitter.flush();
    return observed.find(
      (event) =>
        event[K.OP_NAME] === OP.INVOKE_AGENT && event[K.SPAN_KIND] === SPAN.END,
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-primary-stream-trace-'));
    dedupStore = new ChatTurnDedupStore(join(dir, 'chat-turn-dedup.json'));
    observed = [];
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

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a turn whose engine call throws still reports its real trace id', async () => {
    const complete = await run(
      vi.fn(async () => {
        throw new Error('model auth failed');
      }),
    );

    expect(complete).toBeDefined();
    // The join key, present and usable — not `''`, and not absent.
    expect(typeof complete?.[K.TRACE_ID]).toBe('string');
    expect(complete?.[K.TRACE_ID]).not.toBe('');
    // It is THIS turn's trace, not some other non-empty string: the minted id
    // is prefixed with the conversation it belongs to.
    expect(complete?.[K.TRACE_ID]).toContain(
      complete?.[K.CONVERSATION_ID] as string,
    );
  });

  test('a turn that succeeds reports the same trace id shape', async () => {
    const complete = await run(
      vi.fn(async () => ({
        fullStream: emptyStream(),
        text: Promise.resolve(''),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve('stop'),
      })),
    );

    expect(complete?.[K.TRACE_ID]).toContain(
      complete?.[K.CONVERSATION_ID] as string,
    );
  });
});
