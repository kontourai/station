/**
 * docs/design/event-content-spill.md, through the real OrchestrationService
 * adapter loop, EventStore and event bus (the source of live SSE frames).
 * The adapter is a minimal queue-backed fake; everything after its stream is
 * production code.
 */
import { join } from 'node:path';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import { isRuntimeEventContentRef } from '@kontourai/station-contracts/runtime-event-content';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { computeViewedContentDigest } from '@kontourai/station-sdk/runtime-event-content';
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
import { DELTA_SPLIT_MAX_BYTES } from '../delta-splitting.js';
import { EventBus } from '../event-bus.js';
import {
  EVENT_STORED_TARGET_BYTES,
  storedEventDigest,
} from '../event-content-spill.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();

class QueueAdapter implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'claude Runtime',
    description: 'claude adapter for tests',
    capabilities: ['agent-runtime'],
    engineId: engineId('claude'),
    builtin: true,
  };
  readonly provider = 'claude' as const;
  readonly sessions = new Map<string, ProviderSession>();
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>(64);
  readonly respondToRequest = vi.fn(async () => {});

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      model: input.modelId,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }
  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    return { threadId: input.threadId, turnId: 'turn-1' };
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async stopSession(threadId: string) {
    this.sessions.delete(threadId);
  }
  async stopAll() {
    this.sessions.clear();
  }
  async listSessions() {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string) {
    return this.sessions.has(threadId);
  }
  streamEvents(options?: { signal?: AbortSignal }) {
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

const at = () => new Date().toISOString();

describe('oversized event content through the live adapter loop', () => {
  let tmp: string;
  let store: EventStore;
  let bus: EventBus;
  let adapter: QueueAdapter;
  let service: OrchestrationService;
  let frames: CanonicalRuntimeEvent[];
  const threadId = 'thread-live';

  beforeEach(async () => {
    tmp = makeTempDir('oversized-content-');
    store = new EventStore(join(tmp, 'orchestration.sqlite'));
    bus = new EventBus();
    frames = [];
    bus.subscribe((message) => {
      if (message.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
      const event = (
        message.data as { event?: CanonicalRuntimeEvent } | undefined
      )?.event;
      if (event?.threadId === threadId) frames.push(event);
    });
    adapter = new QueueAdapter();
    service = new OrchestrationService({
      adapterRegistry: registry(adapter),
      eventBus: bus,
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    service.initialize();
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    adapter.events.push({
      eventId: 'turn-start',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: at(),
      method: 'turn.started',
    });
  });

  afterEach(async () => {
    await service.shutdown();
    store.close();
  });

  const stored = () => store.listEvents(threadId);

  test('a huge single delta is split into plain-string chunks, never spilled', async () => {
    // Mixed scripts and escapes: CJK is 3 bytes per character, a quote or a
    // newline 2, a control character 6.
    const delta = '回答 "quoted"\n\u0001 text '.repeat(40_000);
    adapter.events.push({
      eventId: 'huge-delta',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      itemId: 'item-1',
      createdAt: at(),
      method: 'content.text-delta',
      delta,
    } as CanonicalRuntimeEvent);
    adapter.events.push({
      eventId: 'turn-done',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: at(),
      method: 'turn.completed',
      status: 'completed',
    } as CanonicalRuntimeEvent);
    await vi.waitFor(() =>
      expect(stored().some((e) => e.payload.method === 'turn.completed')).toBe(
        true,
      ),
    );
    const deltas = stored().filter(
      (e) => e.payload.method === 'content.text-delta',
    );
    expect(deltas.length).toBeGreaterThan(1);
    for (const event of deltas) {
      const text = (event.payload as { delta?: unknown }).delta;
      expect(typeof text).toBe('string');
      expect(event.payload.spilledContent).toBeUndefined();
      expect(
        Buffer.byteLength(JSON.stringify(event.payload)),
      ).toBeLessThanOrEqual(EVENT_STORED_TARGET_BYTES);
      expect(Buffer.byteLength(JSON.stringify(text)) - 2).toBeLessThanOrEqual(
        DELTA_SPLIT_MAX_BYTES,
      );
    }
    expect(
      deltas.map((e) => (e.payload as { delta: string }).delta).join(''),
    ).toBe(delta);
    expect(deltas[0]!.id).toBe('huge-delta');
    expect(deltas[1]!.id).toBe('huge-delta:1');
    // The live frames carried the same plain strings.
    const liveDeltas = frames.filter((e) => e.method === 'content.text-delta');
    expect(
      liveDeltas.every(
        (e) => typeof (e as { delta?: unknown }).delta === 'string',
      ),
    ).toBe(true);
  });

  test('a large approval reaches the bus and the store as the same small form', async () => {
    const content = 'const x = 1;\n'.repeat(80_000);
    adapter.events.push({
      eventId: 'open-write',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: at(),
      requestId: 'req-write',
      method: 'request.opened',
      requestType: 'approval',
      title: 'Allow Write',
      payload: {
        toolName: 'Write',
        toolCallId: 'toolu_1',
        toolInput: { file_path: '/repo/big.ts', content },
        suggestions: [],
      },
    } as CanonicalRuntimeEvent);
    await vi.waitFor(() =>
      expect(stored().some((e) => e.payload.method === 'request.opened')).toBe(
        true,
      ),
    );
    const frame = frames.find((e) => e.method === 'request.opened')!;
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
      EVENT_STORED_TARGET_BYTES,
    );
    const persisted = stored().find(
      (e) => e.payload.method === 'request.opened',
    )!;
    expect(persisted.payload).toEqual(frame);
    const input = (frame as { payload: { toolInput: { content: unknown } } })
      .payload.toolInput;
    expect(isRuntimeEventContentRef(input.content)).toBe(true);
    const [resolved] = store.resolveEventContent([persisted]);
    expect(
      (resolved!.payload as { payload: { toolInput: { content: string } } })
        .payload.toolInput.content,
    ).toBe(content);
  });

  test('a 100 KB tool result no longer interrupts the stream', async () => {
    adapter.events.push({
      eventId: 'big-result',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: at(),
      method: 'tool.completed',
      toolCallId: 'huge-tool',
      itemId: 'huge-tool',
      toolName: 'read_file',
      status: 'success',
      output: 'x'.repeat(100_000),
    } as CanonicalRuntimeEvent);
    adapter.events.push({
      eventId: 'after-result',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      itemId: 'item-2',
      createdAt: at(),
      method: 'content.text-delta',
      delta: 'still streaming',
    } as CanonicalRuntimeEvent);
    await vi.waitFor(() =>
      expect(stored().some((e) => e.id === 'after-result')).toBe(true),
    );
    expect(stored().some((e) => e.id === 'big-result')).toBe(true);
    expect(
      stored().some(
        (e) =>
          e.payload.method === 'runtime.warning' &&
          (e.payload as { code?: string }).code ===
            'adapter-event-stream-interrupted',
      ),
    ).toBe(false);
  });

  describe('allowing a request whose content was stored out of line', () => {
    const openBigWrite = async () => {
      adapter.events.push({
        eventId: 'open-big',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        requestId: 'req-big',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Write',
        payload: {
          toolName: 'Write',
          toolCallId: 'toolu_big',
          toolInput: { file_path: '/repo/x.ts', content: 'y'.repeat(200_000) },
          suggestions: [],
        },
      } as CanonicalRuntimeEvent);
      await vi.waitFor(() =>
        expect(stored().some((e) => e.id === 'open-big')).toBe(true),
      );
      return stored().find((e) => e.id === 'open-big')!.payload;
    };

    test('refuses an accept without the viewed-content digest', async () => {
      await openBigWrite();
      await expect(
        service.dispatch({
          type: 'respondToRequest',
          threadId,
          requestId: 'req-big',
          expectedRequestEventId: 'open-big',
          decision: 'accept',
        }),
      ).rejects.toMatchObject({ code: 'request_content_not_loaded' });
      expect(adapter.respondToRequest).not.toHaveBeenCalled();
    });

    test('refuses a digest of a different event', async () => {
      await openBigWrite();
      await expect(
        service.dispatch({
          type: 'respondToRequest',
          threadId,
          requestId: 'req-big',
          expectedRequestEventId: 'open-big',
          decision: 'acceptForSession',
          viewedContentDigest: `sha256-${'0'.repeat(64)}`,
        }),
      ).rejects.toMatchObject({ code: 'request_content_not_loaded' });
      expect(adapter.respondToRequest).not.toHaveBeenCalled();
    });

    test('accepts with the digest a client computes from the live frame', async () => {
      const stored = await openBigWrite();
      // The client hashes the event as it arrived (an SSE frame, parsed);
      // the server hashes its stored row. They must agree.
      const frame = JSON.parse(
        JSON.stringify(frames.find((e) => e.eventId === 'open-big')),
      );
      const clientDigest = await computeViewedContentDigest(frame);
      expect(clientDigest).toBe(storedEventDigest(stored));
      await service.dispatch({
        type: 'respondToRequest',
        threadId,
        requestId: 'req-big',
        expectedRequestEventId: 'open-big',
        decision: 'accept',
        viewedContentDigest: clientDigest,
      });
      expect(adapter.respondToRequest).toHaveBeenCalledWith(
        threadId,
        'req-big',
        'accept',
      );
    });

    test('a decline never needs the digest', async () => {
      await openBigWrite();
      await service.dispatch({
        type: 'respondToRequest',
        threadId,
        requestId: 'req-big',
        decision: 'decline',
      });
      expect(adapter.respondToRequest).toHaveBeenCalledWith(
        threadId,
        'req-big',
        'decline',
      );
    });
  });

  describe('residual refusal keeps the stream running', () => {
    const warnings = () =>
      stored()
        .map((e) => e.payload)
        .filter((e) => e.method === 'runtime.warning')
        .map((e) => (e as { code?: string }).code);
    const pushNext = () =>
      adapter.events.push({
        eventId: 'next-event',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        itemId: 'item-next',
        createdAt: at(),
        method: 'content.text-delta',
        delta: 'still here',
      } as CanonicalRuntimeEvent);

    test('an approval over the per-event ceiling is declined, not stranded', async () => {
      adapter.events.push({
        eventId: 'open-huge',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        requestId: 'req-huge',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Write',
        payload: {
          toolName: 'Write',
          toolInput: { file_path: '/x', content: 'z'.repeat(17 * 1024 * 1024) },
        },
      } as CanonicalRuntimeEvent);
      pushNext();
      await vi.waitFor(() =>
        expect(stored().some((e) => e.id === 'next-event')).toBe(true),
      );
      expect(adapter.respondToRequest).toHaveBeenCalledWith(
        threadId,
        'req-huge',
        'decline',
      );
      expect(warnings()).toContain('request-too-large-to-show');
      expect(warnings()).not.toContain('adapter-event-stream-interrupted');
      expect(stored().some((e) => e.id === 'open-huge')).toBe(false);
    });

    test('a reply over the ceiling keeps its turn terminal, marked unavailable', async () => {
      adapter.events.push({
        eventId: 'done-huge',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        method: 'turn.completed',
        status: 'completed',
        outputText: 'r'.repeat(17 * 1024 * 1024),
      } as CanonicalRuntimeEvent);
      await vi.waitFor(() =>
        expect(stored().some((e) => e.id === 'done-huge')).toBe(true),
      );
      const terminal = stored().find((e) => e.id === 'done-huge')!;
      expect((terminal.payload as { outputText?: unknown }).outputText).toEqual(
        {
          $stationContent: 1,
          unavailable: 'exceeds-ceiling',
        },
      );
      expect(warnings()).toContain('event-content-too-large');
    });

    test('an adapter field over the backstop is skipped with a warning', async () => {
      adapter.events.push({
        eventId: 'odd-event',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        method: 'tool.completed',
        toolCallId: 'c1',
        toolName: 'x',
        status: 'success',
        output: 'ok',
        adapterNote: 'n'.repeat(100_000),
      } as CanonicalRuntimeEvent);
      pushNext();
      await vi.waitFor(() =>
        expect(stored().some((e) => e.id === 'next-event')).toBe(true),
      );
      expect(warnings()).toContain('event-not-stored');
      expect(warnings()).not.toContain('adapter-event-stream-interrupted');
    });
  });
});
