/**
 * Station's orchestration instructions on a Session's genuine first turn:
 * the real resolver stamps the `first-turn` receipt, the adapter spreads it
 * into `session.started` metadata, and the real OrchestrationService composes
 * it into the first turn's ambient context after the authored prompt. Asserted
 * at the adapter's `sendTurn` input through a real EventStore. Wording is
 * Lane A's; these tests only pin presence, order and the first-turn rule.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import {
  SESSION_CAPABILITY_DELIVERY_METADATA_KEY,
  type SessionCapabilityDeliveryMetadata,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
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
import { createRuntimeSelfIntegration } from '../../../runtime/agents/runtime-default-agent.js';
import { builtinStationControlServerPath } from '../../../runtime/bootstrap/station-control-runtime-env.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';

const AUTHORED_PROMPT = 'You are the authored test agent.';

class FakeCodexAdapter implements ProviderAdapterShape {
  readonly provider = 'codex' as const;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Codex',
    description: 'test',
    capabilities: ['agent-runtime'],
    engineId: engineId('codex'),
    builtin: true,
  };
  readonly sessions = new Map<string, ProviderSession>();
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  /** What the adapter's channel stage reports for toolServers, if anything. */
  toolServersReport: SessionCapabilityDeliveryMetadata['toolServers'];
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
    // A delivering adapter spreads the resolved metadata into its
    // session.started publish; this is the receipt's only path to the log.
    const delivery = input.metadata?.[
      SESSION_CAPABILITY_DELIVERY_METADATA_KEY
    ] as SessionCapabilityDeliveryMetadata | undefined;
    this.publish({
      method: 'session.started',
      threadId: input.threadId,
      metadata: {
        ...input.metadata,
        ...(input.resumeCursor !== undefined
          ? { nativeSessionResumed: true }
          : {}),
        ...(delivery
          ? {
              [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
                ...delivery,
                ...(this.toolServersReport
                  ? { toolServers: this.toolServersReport }
                  : {}),
              },
            }
          : {}),
      },
    });
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

const makeTempDir = trackTempDirs();

describe('Station orchestration instructions on the first turn', () => {
  let tmp: string;
  let eventStore: EventStore;
  let service: OrchestrationService | undefined;
  let previewOn: boolean;
  let available: string[] | undefined;

  beforeEach(() => {
    tmp = makeTempDir('station-instructions-first-turn-');
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    previewOn = true;
    available = undefined;
  });
  afterEach(async () => {
    await service?.shutdown();
    service = undefined;
    eventStore.close();
  });

  function start(adapter: FakeCodexAdapter) {
    const { selfIntegration } = createRuntimeSelfIntegration();
    service = new OrchestrationService({
      adapterRegistry: registry(adapter),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async () => ({
          name: 'Test Agent',
          prompt: AUTHORED_PROMPT,
          tools: {
            mcpServers: ['station-control'],
            ...(available ? { available } : {}),
          },
        }),
        resolveToolServer: async () =>
          ({
            ...selfIntegration,
            command: 'node',
            args: [builtinStationControlServerPath()],
            env: { STATION_PORT: '7777' },
          }) as ToolDef,
        resolveSkillDir: async () => null,
        stationInstructionsEnabled: () => previewOn,
      }),
    });
    return service;
  }

  async function startSession(
    orchestration: OrchestrationService,
    threadId: string,
    resumeCursor?: unknown,
  ) {
    await orchestration.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'codex',
        metadata: { agentSlug: 'test-agent' },
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
      },
    });
    await waitFor(() =>
      eventStore
        .listEvents(threadId)
        .some((event) => event.method === 'session.started'),
    );
  }

  async function send(
    orchestration: OrchestrationService,
    adapter: FakeCodexAdapter,
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

  /** The capability-delivery report off the durable session.started event. */
  function deliveryOf(threadId: string) {
    const started = eventStore
      .listEvents(threadId)
      .find((event) => event.method === 'session.started');
    const metadata = (
      started?.payload as { metadata?: Record<string, unknown> } | undefined
    )?.metadata;
    return metadata?.[SESSION_CAPABILITY_DELIVERY_METADATA_KEY] as
      | SessionCapabilityDeliveryMetadata
      | undefined;
  }

  /** The text the receipt carries. */
  function receiptText(threadId: string): string {
    const delivery = deliveryOf(threadId);
    const text = delivery?.stationInstructions?.firstTurnText;
    expect(text).toEqual(expect.any(String));
    expect(text?.length).toBeGreaterThan(0);
    return text as string;
  }

  test('composed into the first turn after the authored prompt, and not on the second turn', async () => {
    const adapter = new FakeCodexAdapter();
    const orchestration = start(adapter);
    await startSession(orchestration, 'thread-guide');
    const text = receiptText('thread-guide');

    const first = await send(orchestration, adapter, 'thread-guide', 'Hello');
    expect(first?.input).toContain(AUTHORED_PROMPT);
    expect(first?.input).toContain(text);
    expect(first?.input.indexOf(AUTHORED_PROMPT)).toBeLessThan(
      first?.input.indexOf(text) as number,
    );
    expect(first?.input.endsWith('\nHello')).toBe(true);
    expect(first?.displayInput).toBe('Hello');

    const second = await send(orchestration, adapter, 'thread-guide', 'Again');
    expect(second?.input).toBe('Again');
  });

  test('preview off: the first turn carries only the authored prompt', async () => {
    previewOn = false;
    const adapter = new FakeCodexAdapter();
    const orchestration = start(adapter);
    await startSession(orchestration, 'thread-off');
    // The report landed (so the check below is not vacuous), without a receipt.
    expect(deliveryOf('thread-off')?.systemPrompt).toBeDefined();
    expect(deliveryOf('thread-off')?.stationInstructions).toBeUndefined();
    const first = await send(orchestration, adapter, 'thread-off', 'Hello');
    expect(first?.input).toContain(AUTHORED_PROMPT);
    expect(first?.input).not.toContain('<station_instructions>');
  });

  test('withheld when the latest toolServers report lists station-control undelivered', async () => {
    const adapter = new FakeCodexAdapter();
    adapter.toolServersReport = {
      source: 'agent',
      requested: ['station-control'],
      delivered: [],
      undelivered: [
        {
          capability: 'toolServers',
          id: 'station-control',
          reason: 'unsupported-transport',
        },
      ],
    };
    const orchestration = start(adapter);
    await startSession(orchestration, 'thread-undelivered');
    const text = receiptText('thread-undelivered');
    const first = await send(
      orchestration,
      adapter,
      'thread-undelivered',
      'Hello',
    );
    expect(first?.input).toContain(AUTHORED_PROMPT);
    expect(first?.input).not.toContain(text);
  });

  test('withheld when a present delivered list omits station-control, delivered when it lists it', async () => {
    const omitted = new FakeCodexAdapter();
    omitted.toolServersReport = {
      source: 'agent',
      requested: ['station-control', 'other'],
      delivered: ['other'],
      undelivered: [],
    };
    const first = start(omitted);
    await startSession(first, 'thread-omitted');
    const omittedText = receiptText('thread-omitted');
    expect(
      (await send(first, omitted, 'thread-omitted', 'Hello'))?.input,
    ).not.toContain(omittedText);
    await first.shutdown();

    const listed = new FakeCodexAdapter();
    listed.toolServersReport = {
      source: 'agent',
      requested: ['station-control'],
      delivered: ['station-control'],
      undelivered: [],
    };
    const second = start(listed);
    await startSession(second, 'thread-listed');
    const listedText = receiptText('thread-listed');
    expect(
      (await send(second, listed, 'thread-listed', 'Hello'))?.input,
    ).toContain(listedText);
  });

  test('withheld when engine recovery before the first turn reports station-control undelivered', async () => {
    const adapter = new FakeCodexAdapter();
    const orchestration = start(adapter);
    await startSession(orchestration, 'thread-recovered');
    const text = receiptText('thread-recovered');
    // The engine is lost before any turn; the recovered start reports
    // station-control undelivered, so the first turn must not name its tools.
    adapter.sessions.delete('thread-recovered');
    adapter.toolServersReport = {
      source: 'agent',
      requested: ['station-control'],
      delivered: [],
      undelivered: [
        {
          capability: 'toolServers',
          id: 'station-control',
          reason: 'unsupported-transport',
        },
      ],
    };
    const startsBefore = eventStore
      .listEvents('thread-recovered')
      .filter((event) => event.method === 'session.started').length;
    const first = await send(
      orchestration,
      adapter,
      'thread-recovered',
      'Hello',
    );
    // Non-vacuous: recovery really restarted the engine and logged its report.
    expect(
      eventStore
        .listEvents('thread-recovered')
        .filter((event) => event.method === 'session.started').length,
    ).toBeGreaterThan(startsBefore);
    expect(first?.input).toContain(AUTHORED_PROMPT);
    expect(first?.input).not.toContain(text);
    expect(first?.input).not.toContain('<station_instructions>');
  });

  test('a successor resuming the native transcript is not re-told; a fresh one is', async () => {
    const adapter = new FakeCodexAdapter();
    const orchestration = start(adapter);
    const conversationId = 'thread-lineage';
    await startSession(orchestration, conversationId);
    const text = receiptText(conversationId);
    const first = await send(orchestration, adapter, conversationId, 'Hello');
    expect(first?.input).toContain(text);

    async function successor(resumeCursor?: unknown) {
      const id = `${conversationId}:session:${randomUUID()}`;
      eventStore.reserveNextConversationSession({
        conversationId,
        predecessorSessionId: conversationId,
        proposedSessionId: id,
        createdAt: new Date().toISOString(),
      });
      await startSession(orchestration, id, resumeCursor);
      return id;
    }

    // The continuation path's shape: the predecessor's cursor, so the engine
    // resumes the transcript that already holds the first turn's text.
    const resumed = await successor({ nativeSession: 'native-1' });
    expect(
      eventStore
        .listEvents(resumed)
        .find((event) => event.method === 'session.started')?.payload,
    ).toMatchObject({ metadata: { nativeSessionResumed: true } });
    const again = await send(orchestration, adapter, resumed, 'Continue');
    expect(again?.input).toBe('Continue');

    // Instructions that changed since (here, delegate_task withdrawn) still
    // do not reach the resumed transcript: delivery is once per native
    // transcript. A fresh native transcript gets the current version.
    available = ['station-control_wait_session'];
    const changed = await successor({ nativeSession: 'native-1' });
    expect(deliveryOf(changed)?.stationInstructions).toBeUndefined();
    expect((await send(orchestration, adapter, changed, 'More'))?.input).toBe(
      'More',
    );
    const fresh = await successor();
    const freshText = receiptText(fresh);
    expect(freshText).not.toBe(text);
    const told = await send(orchestration, adapter, fresh, 'Restart');
    expect(told?.input).toContain(AUTHORED_PROMPT);
    expect(told?.input).toContain(freshText);
    expect(told?.input.endsWith('\nRestart')).toBe(true);
  });
});
