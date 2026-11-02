import { join } from 'node:path';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createChatRuntimeFixture } from '../../../__test-utils__/chat-runtime-fixture.js';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { readStreamUntil } from '../../../__test-utils__/sse-helpers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { streamPrimaryAgentChat } from '../../../routes/chat/chat-primary-stream.js';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { resetFixtureSqliteSynchronousForTest } from '../../../utils/sqlite-fixture-durability.js';
import {
  INTERNAL_TURN_CORRELATION_HEADER,
  readAuthorizedTurnCorrelationHandoff,
  readNativeForegroundRelayCompanion,
  readNativeMemoryRelayCompanion,
  readNativeOutputRelayCompanion,
} from '../../conversation/authorized-turn-correlation.js';
import { VoltAgentFramework } from '../../frameworks/voltagent-adapter.js';
import {
  captureRuntimeConfigurationLease,
  runtimeConfigurationLeaseIsCurrent,
} from '../../plugins/runtime-configuration-lease.js';
import { stationAgentRuntimeOwner } from '../durable-agent-owner.js';
import { configureDurableAgentRecovery } from '../durable-agent-recovery.js';

const temp = trackTempDirs();
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => resetFixtureSqliteSynchronousForTest());
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
it('a client reconnects through GET events and receives the detached durable Station turn exactly once', async () => {
  const home = temp('durable-reconnect-');
  const memory = new FileMemoryAdapter({ projectHomeDir: home });
  await memory.createConversation({
    id: 'conversation',
    userId: 'owner',
    resourceId: 'assistant',
    title: 'Reconnect',
    metadata: {},
  });
  const store = new EventStore(join(home, 'events.sqlite'));
  cleanup.push(() => {
    store.close();
  });
  const ctx = createChatRuntimeFixture(home, memory, {
    orchestrationEventStore: store,
  });
  const owner = stationAgentRuntimeOwner(home);
  const relayDisconnected = new AbortController();
  const release = gate();
  const failures: unknown[] = [];
  let modelCalls = 0;
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'reconnect',
    supportedUrls: {},
    doGenerate: async () => {
      throw Error('Streaming required');
    },
    doStream: async () => {
      modelCalls++;
      return {
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'answer' });
            controller.enqueue({
              type: 'text-delta',
              id: 'answer',
              delta: 'RUNNING',
            });
            await release.promise;
            controller.enqueue({
              type: 'text-delta',
              id: 'answer',
              delta: ' FINISHED',
            });
            controller.enqueue({ type: 'text-end', id: 'answer' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
  const agent = await new VoltAgentFramework().createTempAgent({
    agentId: 'assistant',
    name: 'Assistant',
    instructions: 'Answer',
    model,
    memoryAdapter: memory,
    durable: { home, slug: 'assistant', definition: 'reconnect/1' },
  });
  ctx.activeAgents.set('assistant', agent);
  ctx.agentSpecs.set('assistant', { name: 'Assistant', prompt: 'Answer' });
  const chat = new Hono();
  chat.post('/api/agents/assistant/chat', async (c) => {
    const body = await c.req.json<{
      input: string;
      options: Record<string, unknown>;
    }>();
    const handoff = c.req.header(INTERNAL_TURN_CORRELATION_HEADER);
    const correlation = readAuthorizedTurnCorrelationHandoff(handoff);
    if (!correlation)
      throw Error('The actual native relay did not supply correlation');
    const outputRelay = readNativeOutputRelayCompanion(handoff);
    const lease = captureRuntimeConfigurationLease(ctx);
    if (!lease) throw Error('Configuration prerequisite');
    return streamPrimaryAgentChat({
      c,
      ctx,
      slug: 'assistant',
      plugin: '',
      input: body.input,
      restOptions: body.options,
      injectContext: null,
      ragContext: null,
      agent,
      configurationLease: lease,
      turnCorrelation: correlation,
      orchestrationThreadId: correlation.sessionId,
      nativeMemory: readNativeMemoryRelayCompanion(handoff),
      nativeForeground: readNativeForegroundRelayCompanion(handoff),
      nativeRuntimeAgent: agent,
      nativeWorkspace: outputRelay?.readExecutionWorkspace?.(
        body.options.conversationId,
      ),
      nativeOutputGrant:
        outputRelay?.issueForRuntimeConfiguration(lease, () =>
          runtimeConfigurationLeaseIsCurrent(ctx, lease),
        ) ?? undefined,
    });
  });
  const adapter = new StationAgentAdapter({
    apiBase: 'http://127.0.0.1:0',
    hasAgent: () => true,
    isAgentRegistryReady: () => true,
    approvalRegistry: ctx.approvalRegistry,
    eventBus: ctx.eventBus,
    fetch: async (input, init) =>
      chat.fetch(
        new Request(input, { ...init, signal: relayDisconnected.signal }),
      ),
    durable: {
      enabled: owner.enabled,
      owns: owner.owns,
      snapshot: (thread, turn) => {
        const value = owner.read(thread, turn);
        return value && { ...value.turn, settledAt: value.settledAt };
      },
      frame: owner.readFrame,
      approval: (thread, turn, id) =>
        owner.approvals(thread, turn).find((value) => value.id === id),
      approvals: owner.approvals,
      publish: (event) => service.publishDurableStationEvent(event),
      cancel: (thread, turn) => owner.cancel(thread, turn),
      pause: () => owner.pause(),
      retained: (thread) =>
        owner.list().some((value) => value.spec.key.conversationId === thread),
    },
  });
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventStore: store,
    eventBus: ctx.eventBus,
    logger: ctx.logger,
    recoverDurableTurn: owner.recover,
  });
  configureDurableAgentRecovery({
    owner,
    adapter,
    orchestration: service,
    preview: { select: (branches) => branches.enabled() },
    approvalRegistry: ctx.approvalRegistry,
    agentSpecs: ctx.agentSpecs,
    toolNameMapping: ctx.toolNameMapping,
    logger: {
      ...ctx.logger,
      error: (_message, fields) => {
        failures.push(
          fields && typeof fields === 'object' && 'error' in fields
            ? fields.error
            : fields,
        );
      },
    },
  });
  cleanup.push(() => service.shutdown());
  cleanup.push(() => release.resolve());
  service.initialize();
  await service.whenSessionRecoveryCompleted();
  await service.dispatch(
    {
      type: 'startSession',
      input: {
        provider: 'station-agent',
        threadId: 'conversation',
        cwd: home,
        metadata: { agentId: 'assistant', userId: 'owner' },
      },
    },
    { userId: 'owner' },
  );
  const events = createOrchestrationRoutes(service, {
    eventBus: ctx.eventBus,
    logger: ctx.logger,
    getUserId: () => 'owner',
  });
  const connected = await events.request('/events?threadId=conversation');
  if (!connected.body) throw Error('No initial SSE body');
  const initial = await readStreamUntil(connected.body, (text) =>
    text.includes('orchestration:caughtUp'),
  );
  expect(initial).toContain('orchestration:snapshot');
  const cursor = store.headGlobalSequence();
  const started = await service.dispatch(
    {
      type: 'sendTurn',
      input: {
        threadId: 'conversation',
        input: 'hello',
        clientTurnId: 'durable-reconnect',
      },
    },
    { userId: 'owner' },
  );
  expect(started).toBeDefined();
  await vi.waitFor(
    () => {
      const deltas = store
        .listEvents('conversation')
        .flatMap((value) =>
          value.payload.method === 'content.text-delta'
            ? [value.payload.delta]
            : [],
        )
        .join('');
      expect(deltas).toBe('RUNNING');
    },
    { timeout: 10_000 },
  );
  relayDisconnected.abort('relay transport disconnected');
  release.resolve();
  await vi.waitFor(
    () =>
      expect(
        store
          .listEvents('conversation')
          .filter((value) => value.payload.method === 'turn.completed'),
      ).toHaveLength(1),
    { timeout: 10_000 },
  );
  const reconnected = await events.request('/events?threadId=conversation', {
    headers: { 'Last-Event-ID': String(cursor) },
  });
  if (!reconnected.body) throw Error('No reconnect SSE body');
  const catchup = await readStreamUntil(reconnected.body, (text) =>
    text.includes('orchestration:caughtUp'),
  );
  expect(catchup).not.toContain('orchestration:snapshot');
  const frames: Array<{ event?: { method?: string; delta?: string } }> = catchup
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  const replayed = frames.flatMap((frame) =>
    frame.event ? [frame.event] : [],
  );
  expect(
    replayed
      .filter((event) => event.method === 'content.text-delta')
      .map((event) => event.delta)
      .join(''),
  ).toBe('RUNNING FINISHED');
  expect(
    replayed.filter((event) => event.method === 'turn.completed'),
  ).toHaveLength(1);
  expect(modelCalls).toBe(1);
  expect(failures).toEqual([]);
});
