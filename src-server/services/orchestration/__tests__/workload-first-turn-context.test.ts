/**
 * Station's own first-turn context for engines that run in a bounded workload
 * scope: the budget statement (only while enforcement is live, only for an
 * adapter that declares an engine-process scope), and the recovery note a
 * successor Session receives after its predecessor was killed for memory.
 * Asserted at the adapter's `sendTurn` input, through a real service and a
 * real event store.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import { ENGINE_MEMORY_EXHAUSTED_CODE } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const MIB = 1024 * 1024;
const LIMITS = {
  memoryMaxBytes: 4915 * MIB,
  swapMaxBytes: 256 * MIB,
  tasksMax: 512,
};

class FakeAdapter implements ProviderAdapterShape {
  readonly provider = 'codex' as const;
  readonly metadata: ProviderAdapterMetadata;
  readonly sessions = new Map<string, ProviderSession>();
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly sendTurn = vi.fn(
    async (input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> => {
      const turnId = `${input.threadId}-turn-${this.sendTurn.mock.calls.length}`;
      this.publish({
        method: 'turn.started',
        threadId: input.threadId,
        turnId,
        prompt: input.displayInput ?? input.input,
      });
      return { threadId: input.threadId, turnId };
    },
  );

  constructor(scoped: boolean) {
    this.metadata = {
      displayName: 'Codex',
      description: 'test',
      capabilities: ['agent-runtime'],
      engineId: engineId('codex'),
      builtin: true,
      ...(scoped ? { workloadScope: 'engine-process' as const } : {}),
    };
  }

  publish(event: Record<string, unknown>) {
    this.events.push({
      eventId: randomUUID(),
      provider: 'codex',
      createdAt: new Date().toISOString(),
      ...event,
    } as unknown as CanonicalRuntimeEvent);
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: 'codex',
      threadId: input.threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }
  async stopAll(): Promise<void> {
    this.sessions.clear();
  }
  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }
  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
  async getPrerequisites() {
    return [];
  }
}

function registry(adapter: ProviderAdapterShape): IProviderAdapterRegistry {
  return {
    register() {},
    get: (provider) => (provider === adapter.provider ? adapter : undefined),
    list: () => [adapter],
  };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

describe('Station first-turn workload context', () => {
  let tmp: string;
  let eventStore: EventStore;
  let service: OrchestrationService | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'workload-first-turn-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
  });
  afterEach(async () => {
    await service?.shutdown();
    service = undefined;
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function start(
    adapter: FakeAdapter,
    limits: (() => typeof LIMITS | undefined) | undefined,
  ) {
    service = new OrchestrationService({
      adapterRegistry: registry(adapter),
      eventBus: new EventBus(),
      eventStore,
      ...(limits ? { workloadEngineLimits: limits } : {}),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    return service;
  }

  async function startSession(
    orchestration: OrchestrationService,
    threadId: string,
  ) {
    await orchestration.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'codex' },
    });
  }

  async function send(
    orchestration: OrchestrationService,
    adapter: FakeAdapter,
    threadId: string,
    input: string,
  ) {
    const calls = adapter.sendTurn.mock.calls.length;
    await orchestration.dispatch({
      type: 'sendTurn',
      input: { threadId, input },
    });
    await waitFor(() =>
      eventStore
        .listEvents(threadId)
        .some(
          (event) =>
            event.method === 'turn.started' &&
            event.turnId === `${threadId}-turn-${calls + 1}`,
        ),
    );
    return adapter.sendTurn.mock.calls.at(-1)?.[0];
  }

  test('an engine in an enforced scope is told its budget on its first turn only', async () => {
    const adapter = new FakeAdapter(true);
    const orchestration = start(adapter, () => LIMITS);
    await startSession(orchestration, 'thread-budget');
    const first = await send(orchestration, adapter, 'thread-budget', 'Hello');
    expect(first?.input).toContain('## Station workload budget');
    expect(first?.input).toContain('4915 MiB plus 256 MiB of swap');
    expect(first?.input.endsWith('\nHello')).toBe(true);
    expect(first?.displayInput).toBe('Hello');
    const second = await send(orchestration, adapter, 'thread-budget', 'Again');
    expect(second?.input).toBe('Again');
  });

  test('no budget is claimed without enforcement or for an undeclared engine', async () => {
    const unenforced = new FakeAdapter(true);
    const orchestration = start(unenforced, () => undefined);
    await startSession(orchestration, 'thread-unenforced');
    expect(
      (await send(orchestration, unenforced, 'thread-unenforced', 'Hello'))
        ?.input,
    ).toBe('Hello');
    await orchestration.shutdown();

    const undeclared = new FakeAdapter(false);
    const second = start(undeclared, () => LIMITS);
    await startSession(second, 'thread-undeclared');
    expect(
      (await send(second, undeclared, 'thread-undeclared', 'Hello'))?.input,
    ).toBe('Hello');
  });

  test('a successor of a memory-killed Session receives the recovery note', async () => {
    const adapter = new FakeAdapter(false);
    const orchestration = start(adapter, undefined);
    const conversationId = 'conversation-oom';
    await startSession(orchestration, conversationId);
    await send(orchestration, adapter, conversationId, 'Regenerate icons');
    const turnId = `${conversationId}-turn-1`;
    for (const [callId, command] of [
      ['call-icons', 'npm run icons:generate'],
      ['call-lint', 'npx eslint .'],
      ['call-done', 'git status'],
    ])
      adapter.publish({
        method: 'tool.started',
        threadId: conversationId,
        turnId,
        itemId: callId,
        toolCallId: callId,
        toolName: 'shell_exec',
        arguments: { command, cwd: '/repo' },
      });
    adapter.publish({
      method: 'tool.completed',
      threadId: conversationId,
      turnId,
      itemId: 'call-done',
      toolCallId: 'call-done',
      toolName: 'shell_exec',
      status: 'completed',
      output: 'clean',
    });
    for (const callId of ['call-icons', 'call-lint'])
      adapter.publish({
        method: 'tool.completed',
        threadId: conversationId,
        turnId,
        itemId: callId,
        toolCallId: callId,
        toolName: 'shell_exec',
        status: 'unresolved',
        output: 'No result was reported before the session ended.',
      });
    adapter.publish({
      method: 'runtime.error',
      threadId: conversationId,
      turnId,
      severity: 'error',
      code: ENGINE_MEMORY_EXHAUSTED_CODE,
      message: 'Codex ran out of memory and was stopped.',
      details: {
        exitSignal: 'SIGKILL',
        workload: {
          result: 'oom-kill',
          memoryPeakBytes: 3072 * MIB,
          memoryMaxBytes: 3072 * MIB,
        },
      },
    });
    await waitFor(() =>
      eventStore
        .listEvents(conversationId)
        .some((event) => event.method === 'runtime.error'),
    );

    const successor = `${conversationId}:session:${randomUUID()}`;
    eventStore.reserveNextConversationSession({
      conversationId,
      predecessorSessionId: conversationId,
      proposedSessionId: successor,
      createdAt: new Date().toISOString(),
    });
    await startSession(orchestration, successor);
    const resumed = await send(orchestration, adapter, successor, 'Continue');
    expect(resumed?.displayInput).toBe('Continue');
    expect(resumed?.input).toContain('## Station recovery note');
    expect(resumed?.input).toContain('peak 3072 MiB against a 3072 MiB budget');
    expect(resumed?.input).toContain(
      '- npm run icons:generate\n- npx eslint .\n',
    );
    expect(resumed?.input).not.toContain('git status');
    expect(resumed?.input.endsWith('\nContinue')).toBe(true);

    const later = await send(orchestration, adapter, successor, 'Next');
    expect(later?.input).toBe('Next');
  });

  test('a successor of an ordinary failure receives no recovery note', async () => {
    const adapter = new FakeAdapter(false);
    const orchestration = start(adapter, undefined);
    const conversationId = 'conversation-crash';
    await startSession(orchestration, conversationId);
    await send(orchestration, adapter, conversationId, 'Work');
    adapter.publish({
      method: 'runtime.error',
      threadId: conversationId,
      turnId: `${conversationId}-turn-1`,
      severity: 'error',
      code: 'codex-turn-orphaned',
      message: 'Codex app-server exited before the turn finished.',
    });
    await waitFor(() =>
      eventStore
        .listEvents(conversationId)
        .some((event) => event.method === 'runtime.error'),
    );
    const successor = `${conversationId}:session:${randomUUID()}`;
    eventStore.reserveNextConversationSession({
      conversationId,
      predecessorSessionId: conversationId,
      proposedSessionId: successor,
      createdAt: new Date().toISOString(),
    });
    await startSession(orchestration, successor);
    expect(
      (await send(orchestration, adapter, successor, 'Again'))?.input,
    ).toBe('Again');
  });
});
