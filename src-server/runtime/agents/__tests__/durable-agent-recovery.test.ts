import { join } from 'node:path';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { agentWire } from '@kontourai/agent-runtime';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { captureTurnIntent } from '../../../services/orchestration/prepared-turn-intent.js';
import type { Logger } from '../../../utils/logger.js';
import { resetFixtureSqliteSynchronousForTest } from '../../../utils/sqlite-fixture-durability.js';
import { VoltAgentFramework } from '../../frameworks/voltagent-adapter.js';
import {
  type DurableAgentDescriptor,
  stationAgentRuntimeOwner,
} from '../durable-agent-owner.js';
import { configureDurableAgentRecovery } from '../durable-agent-recovery.js';

const temp = trackTempDirs();
const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => resetFixtureSqliteSynchronousForTest());
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
for (const mode of ['complete', 'lost-terminal', 'cancel'] as const) {
  const lostTerminal = mode === 'lost-terminal';
  const cancelled = mode === 'cancel';
  it(`boot recovery ${cancelled ? 'persists Stop before the original agent is registered' : lostTerminal ? 'repairs a lost terminal publication without another model call' : 'waits for the agent and finishes one fenced native invocation'}`, async () => {
    const home = temp('durable-host-recovery-');
    const file = join(home, 'events.sqlite');
    const first = new EventStore(file);
    const at = '2026-11-01T12:00:00.000Z';
    first.appendEvent({
      eventId: 'session-start',
      provider: 'station-agent',
      threadId: 'conversation',
      method: 'session.started',
      sessionId: 'conversation',
      createdAt: at,
      metadata: { agentId: 'assistant', userId: 'owner' },
    });
    first.upsertSession({
      provider: 'station-agent',
      threadId: 'conversation',
      status: 'running',
      cwd: home,
      createdAt: at,
      updatedAt: at,
    });
    const boundary = first
      .sessionTurnBoundaryAuthority()
      .reserve?.('conversation', at);
    if (boundary?.kind !== 'owner' || !boundary.claim.prepareIntent)
      throw new Error('Prepared boundary prerequisite');
    const intent = captureTurnIntent(
      { threadId: 'conversation', input: 'hello' },
      { binding: {}, requiresFreshCompanions: false },
    );
    expect(boundary.claim.prepareIntent(intent, undefined, at).kind).toBe(
      'applied',
    );
    expect(boundary.claim.beginInvocation(at).kind).toBe('applied');
    const startEvent = {
      eventId: 'turn-start',
      provider: 'station-agent' as const,
      threadId: 'conversation',
      turnId: 'turn',
      invocationId: intent.intent.invocationId,
      method: 'turn.started' as const,
      createdAt: at,
      prompt: 'hello',
    };
    first.appendEvent(startEvent);
    expect(boundary.claim.accepted('turn', at).kind).toBe('applied');
    const descriptor: DurableAgentDescriptor = {
      version: 1,
      slug: 'assistant',
      definition: 'definition/1',
      input: 'hello',
      options: { conversationId: 'conversation', userId: 'owner' },
      correlation: {
        accountId: 'owner',
        sessionId: 'conversation',
        turnId: 'turn',
        correlationId: 'correlation',
      },
      kernelInvocationId: intent.intent.invocationId,
      startEvent,
    };
    const original = stationAgentRuntimeOwner(home);
    await original.runtime.start({
      key: {
        scopeId: 'station',
        conversationId: 'conversation',
        invocationId: 'turn',
      },
      input: agentWire(descriptor),
      implementation: 'station-agent/1',
    });
    const oldFence = original.read('conversation', 'turn')!.turn.fence;
    await original.pause();
    first.close();
    const store = new EventStore(file);
    cleanup.push(() => {
      store.close();
    });
    const records = store.takeInterruptedTurnBoundaries();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    const owner = stationAgentRuntimeOwner(home);
    cleanup.push(() => owner.pause());
    const events = new EventBus();
    const approvals = new ApprovalRegistry(events);
    const failures: unknown[] = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: (_message: string, fields?: Record<string, unknown>) => {
        failures.push(fields?.error);
      },
    } as unknown as Logger;
    let ready = false;
    let decline = lostTerminal;
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:0',
      hasAgent: () => true,
      isAgentRegistryReady: () => ready,
      approvalRegistry: approvals,
      eventBus: events,
      durable: {
        enabled: owner.enabled,
        owns: owner.owns,
        snapshot: (threadId, turnId) => {
          const value = owner.read(threadId, turnId);
          return value && { ...value.turn, settledAt: value.settledAt };
        },
        frame: owner.readFrame,
        approval: (threadId, turnId, id) =>
          owner.approvals(threadId, turnId).find((value) => value.id === id),
        approvals: owner.approvals,
        publish: (event) =>
          event.method === 'turn.completed' && decline
            ? false
            : service.publishDurableStationEvent(event),
        cancel: (threadId, turnId) => owner.cancel(threadId, turnId),
        pause: () => owner.pause(),
        activeTurn: (threadId) =>
          owner
            .list()
            .find(
              (value) =>
                value.state === 'running' &&
                value.spec.key.conversationId === threadId,
            )?.spec.key.invocationId,
        retained: (threadId) =>
          owner
            .list()
            .some((value) => value.spec.key.conversationId === threadId),
      },
    });
    const service = new OrchestrationService({
      eventStore: store,
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: events,
      logger,
    });
    await adapter.startSession({
      provider: 'station-agent',
      threadId: 'conversation',
      cwd: home,
      metadata: { agentId: 'assistant', userId: 'owner' },
    });
    configureDurableAgentRecovery({
      owner,
      adapter,
      orchestration: service,
      preview: { select: (branches) => branches.enabled() },
      approvalRegistry: approvals,
      agentSpecs: new Map([
        ['assistant', { name: 'Assistant', prompt: 'Answer.' }],
      ]),
      toolNameMapping: new Map(),
      logger,
    });
    const storage = new FileMemoryAdapter({ projectHomeDir: home });
    await storage.createConversation({
      id: 'conversation',
      resourceId: 'assistant',
      userId: 'owner',
      title: 'Recovery',
      metadata: {},
    });
    let calls = 0;
    const model: LanguageModelV3 = {
      specificationVersion: 'v3',
      provider: 'scripted',
      modelId: 'recovery',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('stream required');
      },
      doStream: async () => {
        calls++;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 'answer' });
              controller.enqueue({
                type: 'text-delta',
                id: 'answer',
                delta: 'RECOVERED',
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
    if (!cancelled)
      await new VoltAgentFramework().createTempAgent({
        agentId: 'assistant',
        name: 'Assistant',
        instructions: 'Answer.',
        model,
        memoryAdapter: storage,
        durable: { home, slug: 'assistant', definition: 'definition/1' },
      });
    if (cancelled) {
      expect(await adapter.interruptTurn('conversation')).toMatchObject({
        outcome: 'cancelled',
        turnId: 'turn',
      });
      expect(owner.read('conversation', 'turn')?.turn.cancelRequested).toBe(
        true,
      );
    }
    const handoff = {
      record,
      turnId: 'turn',
      signal: new AbortController().signal,
    };
    expect(await owner.recover(handoff)).toBe('retry');
    expect(owner.read('conversation', 'turn')?.turn.fence).toEqual(oldFence);
    ready = true;
    const race = await Promise.all([
      owner.recover(handoff),
      owner.recover(handoff),
    ]);
    expect(race).toContain('claimed');
    await vi.waitFor(
      () =>
        expect(owner.read('conversation', 'turn')?.turn.state).toBe(
          cancelled ? 'cancelled' : 'completed',
        ),
      { timeout: 10_000 },
    );
    if (lostTerminal) {
      await vi.waitFor(() => expect(failures.length).toBe(1));
      expect(
        store
          .listEvents('conversation')
          .filter((event) => event.payload.method === 'turn.completed'),
      ).toHaveLength(0);
      decline = false;
    }
    expect(await owner.recover(handoff)).toBe('claimed');
    expect(await owner.recover(handoff)).toBe('claimed');
    const history = store.listEvents('conversation');
    expect(
      history.filter((event) => event.payload.method === 'turn.completed'),
    ).toHaveLength(cancelled ? 0 : 1);
    expect(
      history.filter((event) => event.payload.method === 'turn.aborted'),
    ).toHaveLength(cancelled ? 1 : 0);
    expect(
      history.find(
        (event) =>
          event.payload.method ===
          (cancelled ? 'turn.aborted' : 'turn.completed'),
      )?.payload.invocationId,
    ).toBe(intent.intent.invocationId);
    expect(calls).toBe(cancelled ? 0 : 1);
    expect(
      (await storage.getMessages('owner', 'conversation')).filter(
        (message) => message.role === 'assistant',
      ),
    ).toHaveLength(cancelled ? 0 : 1);
  });
}
