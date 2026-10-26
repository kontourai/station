/**
 * docs/design/event-content-spill.md, through the real OrchestrationService
 * adapter loop, EventStore and event bus (the source of live SSE frames).
 * The adapter is a minimal queue-backed fake; everything after its stream is
 * production code.
 */

import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import { isRuntimeEventContentRef } from '@kontourai/station-contracts/runtime-event-content';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import {
  computeViewedContentDigest,
  loadApprovalContent,
} from '@kontourai/station-sdk/runtime-event-content';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runApprovalsCommand } from '../../../../packages/cli/src/commands/approvals.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { mapServerRequestToEvent } from '../../../providers/adapters/codex-adapter-events.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
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
    await service.dispatch(
      { type: 'startSession', input: { threadId, provider: 'claude' } },
      { userId: 'default' },
    );
    // The session's recorded owner: the HTTP routes below read as it.
    adapter.events.push({
      eventId: 'configured',
      provider: 'claude',
      threadId,
      createdAt: at(),
      method: 'session.configured',
      sessionId: threadId,
      metadata: { userId: 'default' },
    } as CanonicalRuntimeEvent);
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

    test('a turn terminal too large outside its reply still persists', async () => {
      adapter.events.push({
        eventId: 'done-odd',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        method: 'turn.completed',
        status: 'completed',
        finishReason: 'stop',
        outputText: 'short',
        metadata: { adapterNote: 'm'.repeat(100_000) },
      } as CanonicalRuntimeEvent);
      await vi.waitFor(() =>
        expect(stored().some((e) => e.id === 'done-odd')).toBe(true),
      );
      const terminal = stored().find((e) => e.id === 'done-odd')!.payload;
      expect(terminal).toMatchObject({
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'stop',
        outputText: { $stationContent: 1, unavailable: 'exceeds-ceiling' },
      });
      expect((terminal as { metadata?: unknown }).metadata).toBeUndefined();
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

  describe('Codex command approvals in their real wire shape', () => {
    // CommandExecutionRequestApprovalParams from `codex app-server
    // generate-ts` (codex-cli 0.163.0): `commandActions` repeats the command.
    const approval = (size: number) => {
      const command = `printf '%s' ${'x'.repeat(size)}`;
      const event = mapServerRequestToEvent(
        threadId,
        `req-codex-${size}`,
        'item/commandExecution/requestApproval',
        {
          kind: 'command',
          threadId: 'codex-thread',
          turnId: 'turn-1',
          itemId: 'cmd-1',
          startedAtMs: 1_790_000_000_000,
          approvalId: null,
          environmentId: null,
          reason: null,
          command,
          cwd: '/repo',
          commandActions: [{ type: 'unknown', command }],
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
        },
        at(),
      )!;
      // The queue adapter here is the session's engine.
      return {
        ...event,
        provider: 'claude' as const,
        eventId: `open-codex-${size}`,
        turnId: 'turn-1',
      };
    };

    test.each([30 * 1024, 70 * 1024, 200 * 1024])(
      'a %i-byte command is stored, survives a reload whole, and is approvable with the digest',
      async (size) => {
        const event = approval(size);
        adapter.events.push(event as CanonicalRuntimeEvent);
        await vi.waitFor(() =>
          expect(stored().some((e) => e.id === event.eventId)).toBe(true),
        );
        const persisted = stored().find((e) => e.id === event.eventId)!;
        expect(
          Buffer.byteLength(JSON.stringify(persisted.payload)),
        ).toBeLessThanOrEqual(EVENT_STORED_TARGET_BYTES);
        const window = store.listEventWindowByTurn(threadId, { turnLimit: 1 });
        const reloaded = window.events.find((e) => e.id === event.eventId)!;
        expect(reloaded.elided).toBeUndefined();
        expect(reloaded.payload.spilledContent).toBeDefined();
        const [resolved] = store.resolveEventContent([persisted]);
        expect(
          (resolved!.payload as { payload: Record<string, unknown> }).payload,
        ).toEqual(event.payload);
        await service.dispatch({
          type: 'respondToRequest',
          threadId,
          requestId: event.requestId,
          expectedRequestEventId: event.eventId,
          decision: 'accept',
          viewedContentDigest: await computeViewedContentDigest(
            JSON.parse(JSON.stringify(reloaded.payload)),
          ),
        });
        expect(adapter.respondToRequest).toHaveBeenCalledWith(
          threadId,
          event.requestId,
          'accept',
        );
      },
    );
  });

  test('a spilled form is answered with its content, without a digest', async () => {
    // Claude AskUserQuestion: the form is inline; the duplicated toolInput
    // (three 1.5 KB options per question) is what spills.
    const option = (n: number) => ({
      label: `Option ${n}`,
      description: 'd'.repeat(1_500),
    });
    const questions = [0, 1, 2].map((q) => ({
      question: `Question ${q}?`,
      header: `Q${q}`,
      multiSelect: false,
      options: [option(1), option(2), option(3)],
    }));
    const inputRequest = {
      schema: 'station.input-request/v1',
      source: 'harness:claude',
      requester: 'Claude',
      message: 'Answer these',
      body: {
        kind: 'form',
        fields: questions.map((q, i) => ({
          name: `q${i}`,
          title: q.question,
          required: true,
          kind: 'choice',
          options: q.options.map((o) => ({ value: o.label, label: o.label })),
        })),
      },
    };
    adapter.events.push({
      eventId: 'open-form',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: at(),
      requestId: 'req-form',
      method: 'request.opened',
      requestType: 'approval',
      title: 'Answer these',
      payload: {
        inputRequest,
        toolName: 'AskUserQuestion',
        toolInput: { questions, padding: 'p'.repeat(20_000) },
      },
    } as CanonicalRuntimeEvent);
    await vi.waitFor(() =>
      expect(stored().some((e) => e.id === 'open-form')).toBe(true),
    );
    const persisted = stored().find((e) => e.id === 'open-form')!;
    expect(persisted.payload.spilledContent).toBeDefined();
    expect(
      (persisted.payload as { payload: { inputRequest: unknown } }).payload
        .inputRequest,
    ).toEqual(inputRequest);
    await service.dispatch({
      type: 'respondToRequest',
      threadId,
      requestId: 'req-form',
      expectedRequestEventId: 'open-form',
      decision: 'accept',
      content: { q0: 'Option 1', q1: 'Option 2', q2: 'Option 3' },
    });
    expect(adapter.respondToRequest).toHaveBeenCalledWith(
      threadId,
      'req-form',
      'accept',
      expect.objectContaining({ inputContent: expect.anything() }),
    );
  });

  test('an assistant turn read returns the exact spilled reply', async () => {
    const reply = 'Exact answer line.\n'.repeat(15_000);
    adapter.events.push({
      eventId: 'turn-done-big',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: at(),
      method: 'turn.completed',
      status: 'completed',
      outputText: reply,
    } as CanonicalRuntimeEvent);
    await vi.waitFor(() =>
      expect(stored().some((e) => e.id === 'turn-done-big')).toBe(true),
    );
    const turn = await service.sessionQueries.readAssistantTurn(
      { type: 'assistant-turn', threadId, turnId: 'turn-1' },
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(turn.status).toBe('found');
    const text = (
      turn as { message: { parts: Array<{ text?: string }> } }
    ).message.parts
      .map((part) => part.text ?? '')
      .join('');
    expect(text).toBe(reply);
  });

  describe('a Codex file change approved over its bound call', () => {
    // FileChangeRequestApprovalParams (codex-cli 0.163.0) carries only the
    // item id; the diff is the bound tool.started's arguments.
    const diff = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `src/file-${i}.ts`,
        { kind: 'update', unified_diff: `+${'line\n'.repeat(5_000)}` },
      ]),
    );
    const openFileChange = async () => {
      adapter.events.push({
        eventId: 'start-fc',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        itemId: 'item-fc',
        createdAt: at(),
        method: 'tool.started',
        toolCallId: 'item-fc',
        toolName: 'apply_patch',
        arguments: { changes: diff },
      } as CanonicalRuntimeEvent);
      const opened = mapServerRequestToEvent(
        threadId,
        'req-fc',
        'item/fileChange/requestApproval',
        {
          threadId: 'codex-thread',
          turnId: 'turn-1',
          itemId: 'item-fc',
          reason: null,
        },
        at(),
      )!;
      adapter.events.push({
        ...opened,
        provider: 'claude',
        eventId: 'open-fc',
        turnId: 'turn-1',
      } as CanonicalRuntimeEvent);
      await vi.waitFor(() =>
        expect(stored().some((e) => e.id === 'open-fc')).toBe(true),
      );
      const request = stored().find((e) => e.id === 'open-fc')!.payload;
      expect(request.spilledContent).toBeUndefined();
      expect(
        stored().find((e) => e.id === 'start-fc')!.payload.spilledContent,
      ).toBeDefined();
      return request;
    };
    const withServer = async (run: (apiBase: string) => Promise<void>) => {
      const app = new Hono();
      app.route(
        '/api/orchestration',
        createOrchestrationRoutes(service, {
          eventBus: bus,
          logger: { debug: vi.fn() },
          getUserId: () => 'default',
          isRequestPrincipalCurrent: () => true,
        }),
      );
      const listener = serve({
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      });
      await once(listener, 'listening');
      const { port } = listener.address() as { port: number };
      try {
        await run(`http://127.0.0.1:${port}`);
      } finally {
        await new Promise((resolve) => listener.close(resolve));
      }
    };

    test('the HTTP command route refuses an accept without the digest', async () => {
      await openFileChange();
      await withServer(async (apiBase) => {
        const response = await fetch(`${apiBase}/api/orchestration/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'respondToRequest',
            threadId,
            requestId: 'req-fc',
            expectedRequestEventId: 'open-fc',
            decision: 'accept',
          }),
        });
        const body = await response.clone().text();
        expect(response.status, body).toBe(409);
        expect(await response.json()).toMatchObject({
          code: 'request_content_not_loaded',
        });
      });
      expect(adapter.respondToRequest).not.toHaveBeenCalled();
    });

    test('accepts with the digest covering the bound call', async () => {
      const request = await openFileChange();
      const bound = stored()
        .filter((e) => e.id === 'start-fc')
        .map((e) => e.payload);
      await service.dispatch({
        type: 'respondToRequest',
        threadId,
        requestId: 'req-fc',
        expectedRequestEventId: 'open-fc',
        decision: 'accept',
        viewedContentDigest: await computeViewedContentDigest(
          JSON.parse(JSON.stringify(request)),
          bound,
        ),
      });
      expect(adapter.respondToRequest).toHaveBeenCalledWith(
        threadId,
        'req-fc',
        'accept',
      );
    });

    const cliRespond = (apiBase: string) =>
      runApprovalsCommand(apiBase, {
        flags: { json: true },
        positionals: ['respond', threadId, 'req-fc', 'accept'],
        flagValues: {},
      } as never);

    test('the CLI loads the bound content and its accept is admitted', async () => {
      await openFileChange();
      const write = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      try {
        await withServer(cliRespond);
      } finally {
        write.mockRestore();
      }
      expect(adapter.respondToRequest).toHaveBeenCalledWith(
        threadId,
        'req-fc',
        'accept',
        expect.anything(),
      );
    });

    test('a CLI that could not load the content is refused by the server', async () => {
      await openFileChange();
      const db = new DatabaseSync(join(tmp, 'orchestration.sqlite'));
      db.prepare(
        'DELETE FROM orchestration_event_content WHERE thread_id = ?',
      ).run(threadId);
      db.close();
      await withServer(async (apiBase) => {
        await expect(cliRespond(apiBase)).rejects.toThrow();
      });
      expect(adapter.respondToRequest).not.toHaveBeenCalled();
    });
  });

  describe('the client loads and echoes the server-defined binding', () => {
    const serveRoutes = async <T>(run: (apiBase: string) => Promise<T>) => {
      const app = new Hono();
      app.route(
        '/api/orchestration',
        createOrchestrationRoutes(service, {
          eventBus: bus,
          logger: { debug: vi.fn() },
          getUserId: () => 'default',
          isRequestPrincipalCurrent: () => true,
        }),
      );
      const listener = serve({
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      });
      await once(listener, 'listening');
      const { port } = listener.address() as { port: number };
      try {
        return await run(`http://127.0.0.1:${port}`);
      } finally {
        await new Promise((resolve) => listener.close(resolve));
      }
    };
    const allowAsClient = (requestId: string, requestEventId: string) =>
      serveRoutes(async (apiBase) => {
        const loaded = await loadApprovalContent(apiBase, threadId, requestId);
        expect(loaded.binding.required).toBe(true);
        await service.dispatch({
          type: 'respondToRequest',
          threadId,
          requestId,
          expectedRequestEventId: requestEventId,
          decision: 'accept',
          viewedContentDigest: loaded.viewedContentDigest,
        });
      });
    const waitStored = (id: string) =>
      vi.waitFor(() => expect(stored().some((e) => e.id === id)).toBe(true));

    test('(a) a Codex command whose request spills but whose bound call does not', async () => {
      const command = `cat > f <<'EOF2'\n${'x'.repeat(10 * 1024)}\nEOF2`;
      adapter.events.push({
        eventId: 'start-a',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        method: 'tool.started',
        toolCallId: 'cmd-a',
        toolName: 'shell_exec',
        arguments: { command, cwd: '/repo' },
      } as CanonicalRuntimeEvent);
      const opened = mapServerRequestToEvent(
        threadId,
        'req-a',
        'item/commandExecution/requestApproval',
        {
          kind: 'command',
          threadId: 'codex-thread',
          turnId: 'turn-1',
          itemId: 'cmd-a',
          startedAtMs: 1_790_000_000_000,
          command,
          cwd: '/repo',
          commandActions: [{ type: 'unknown', command }],
        },
        at(),
      )!;
      adapter.events.push({
        ...opened,
        provider: 'claude',
        eventId: 'open-a',
        turnId: 'turn-1',
      } as CanonicalRuntimeEvent);
      await waitStored('open-a');
      await allowAsClient('req-a', 'open-a');
      expect(adapter.respondToRequest).toHaveBeenCalledWith(
        threadId,
        'req-a',
        'accept',
      );
    });

    test('(b) a Claude Write with no tool.started yet', async () => {
      adapter.events.push({
        eventId: 'open-b',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        requestId: 'req-b',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Write',
        payload: {
          toolCallId: 'call-b',
          toolName: 'Write',
          toolInput: { file_path: '/a', content: 'c'.repeat(40_000) },
          suggestions: [],
        },
      } as CanonicalRuntimeEvent);
      await waitStored('open-b');
      await allowAsClient('req-b', 'open-b');
      expect(adapter.respondToRequest).toHaveBeenCalledWith(
        threadId,
        'req-b',
        'accept',
      );
    });

    test('(c) two tool.started for one call id', async () => {
      for (const [id, fill] of [
        ['s1', 'a'],
        ['s2', 'b'],
      ] as const)
        adapter.events.push({
          eventId: id,
          provider: 'claude',
          threadId,
          turnId: 'turn-1',
          createdAt: at(),
          method: 'tool.started',
          toolCallId: 'call-c',
          toolName: 'edit',
          arguments: { rawInput: { content: fill.repeat(40_000) } },
        } as CanonicalRuntimeEvent);
      adapter.events.push({
        eventId: 'open-c',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        requestId: 'req-c',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow edit',
        payload: { toolCallId: 'call-c', toolName: 'edit', options: [] },
      } as CanonicalRuntimeEvent);
      await waitStored('open-c');
      await allowAsClient('req-c', 'open-c');
      expect(adapter.respondToRequest).toHaveBeenCalledWith(
        threadId,
        'req-c',
        'accept',
      );
    });

    test('a bound call that arrives after loading is refused, then admitted after reloading', async () => {
      adapter.events.push({
        eventId: 'open-late',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        requestId: 'req-late',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Write',
        payload: {
          toolCallId: 'call-late',
          toolName: 'Write',
          toolInput: { file_path: '/a', content: 'c'.repeat(40_000) },
        },
      } as CanonicalRuntimeEvent);
      await waitStored('open-late');
      const early = await serveRoutes((apiBase) =>
        loadApprovalContent(apiBase, threadId, 'req-late'),
      );
      adapter.events.push({
        eventId: 'start-late',
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: at(),
        method: 'tool.started',
        toolCallId: 'call-late',
        toolName: 'Write',
        arguments: { file_path: '/a', content: 'd'.repeat(40_000) },
      } as CanonicalRuntimeEvent);
      await waitStored('start-late');
      await expect(
        service.dispatch({
          type: 'respondToRequest',
          threadId,
          requestId: 'req-late',
          expectedRequestEventId: 'open-late',
          decision: 'accept',
          viewedContentDigest: early.viewedContentDigest,
        }),
      ).rejects.toMatchObject({ code: 'request_content_not_loaded' });
      await allowAsClient('req-late', 'open-late');
      expect(adapter.respondToRequest).toHaveBeenCalledWith(
        threadId,
        'req-late',
        'accept',
      );
    });
  });
});
