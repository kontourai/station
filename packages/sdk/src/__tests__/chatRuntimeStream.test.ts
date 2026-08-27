import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildConversationTurnPayload,
  CHAT_STREAM_STALL_TIMEOUT_MS,
  ChatHttpError,
  ChatStreamStallError,
  mapConversationMessages,
  streamConversationTurn,
} from '../query-domains/chatRuntimeStream';

describe('chatRuntimeStream', () => {
  it('maps conversation messages with tool metadata fallbacks', () => {
    const messages = mapConversationMessages(
      [
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Hello' },
            { type: 'reasoning', text: 'Thinking' },
            { type: 'file', url: 'file://image', mediaType: 'image/png' },
            { type: 'tool-search', content: 'ran search' },
          ],
          metadata: { timestamp: '2026-01-01T00:00:00Z', traceId: 'trace-1' },
        },
      ],
      {
        search: {
          server: 'builtin',
          toolName: 'Search',
          originalName: 'search',
        },
      },
    );

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: 'Hello\nThinking\nran search',
        timestamp: '2026-01-01T00:00:00Z',
        traceId: 'trace-1',
        contentParts: [
          { type: 'text', content: 'Hello' },
          { type: 'reasoning', content: 'Thinking' },
          {
            type: 'file',
            url: 'file://image',
            mediaType: 'image/png',
            name: 'Image',
          },
          {
            type: 'tool-search',
            content: 'ran search',
            server: 'builtin',
            toolName: 'Search',
            originalName: 'search',
          },
        ],
      },
    ]);
  });

  it('reconstructs a ui-block part from a persisted render_component output', () => {
    const messages = mapConversationMessages([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-render_component',
            toolCallId: 'call_1',
            output: {
              type: 'json',
              value: {
                uiBlock: {
                  type: 'form',
                  title: 'Approve',
                  submitLabel: 'Submit',
                  fields: [
                    {
                      name: 'reviewer',
                      label: 'Reviewer',
                      type: 'text',
                      required: true,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    ]);

    const parts = messages[0].contentParts ?? [];
    // The tool part is preserved AND a ui-block part is derived after it,
    // so a persisted render_component form renders on reload, not just live.
    expect(parts.map((p) => p.type)).toEqual([
      'tool-render_component',
      'ui-block',
    ]);
    const block = parts.find((p) => p.type === 'ui-block');
    expect(block?.toolCallId).toBe('call_1');
    expect(block?.uiBlock).toMatchObject({
      type: 'form',
      title: 'Approve',
      fields: [{ name: 'reviewer' }],
    });
  });

  // station#1399 fix round, M4 (independent review): a part PERSISTED
  // directly as `type: 'ui-block'` (the memory/FileMemory conversation
  // store's own write shape, not a `tool-*` output reconstruction) used to
  // return VERBATIM — carrying whatever provenance was stored, unsanitized.
  it('re-sanitizes a directly-persisted ui-block part rather than returning it verbatim', () => {
    const messages = mapConversationMessages([
      {
        role: 'assistant',
        parts: [
          {
            type: 'ui-block',
            toolCallId: 'call_2',
            uiBlock: {
              type: 'table',
              columns: ['Metric', 'Value'],
              rows: [['Coverage', 98]],
              // A forged claim with no matching sources — exactly what a
              // pre-fix reader would have passed straight through.
              attestationState: 'attested',
              provenanceDigest: 'not-a-real-digest',
            },
          },
        ],
      },
    ]);

    const parts = messages[0].contentParts ?? [];
    const block = parts.find((p) => p.type === 'ui-block');
    expect(block?.uiBlock?.attestationState).toBe('unattested');
    expect(block?.uiBlock?.provenanceDigest).toBeUndefined();
  });

  // station#1399 fix round 2, B2 (independent review): this proves
  // `resanitizeUIBlockProvenance`'s DESIGNED mirror behavior, not that a
  // forged tuple can't reach the client — a well-shaped forged tuple
  // (mutually-consistent derivedFrom/digest/attested) is indistinguishable
  // from a genuinely server-sanitized one at this layer BY DESIGN; this
  // module trusts server-sanitized input rather than re-verifying it,
  // because it cannot recompute a digest itself (no `node:crypto` in the
  // browser). The primary control against a forged tuple in the FileMemory
  // store is server-side (`sanitizeConversationMessagesUIBlockProvenance`,
  // `src-server/runtime/conversation/ui-block-provenance.ts`'s serve-time
  // seam) — proven not to survive serving in that file's own test suite.
  it('mirrors (trusts by design) a directly-persisted ui-block part whose attestation is server-sanitized-shaped', () => {
    const messages = mapConversationMessages([
      {
        role: 'assistant',
        parts: [
          {
            type: 'ui-block',
            toolCallId: 'call_3',
            uiBlock: {
              type: 'table',
              columns: ['Metric', 'Value'],
              rows: [['Coverage', 98]],
              derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
              provenanceDigest: 'b'.repeat(64),
              attestationState: 'attested',
            },
          },
        ],
      },
    ]);

    const parts = messages[0].contentParts ?? [];
    const block = parts.find((p) => p.type === 'ui-block');
    expect(block?.uiBlock?.attestationState).toBe('attested');
    expect(block?.uiBlock?.provenanceDigest).toBe('b'.repeat(64));
  });

  it('builds attachment-backed chat payloads', () => {
    vi.spyOn(Date, 'now').mockReturnValue(42);

    expect(
      buildConversationTurnPayload({
        conversationId: 'conv-1',
        content: 'Review this',
        title: 'My Chat',
        model: 'test-model',
        projectSlug: 'project-a',
        attachments: [{ data: 'data:image/png;base64,abc', type: 'image/png' }],
      }),
    ).toEqual({
      input: [
        {
          id: 'msg-42',
          role: 'user',
          parts: [
            { type: 'text', text: 'Review this' },
            {
              type: 'file',
              url: 'data:image/png;base64,abc',
              mediaType: 'image/png',
            },
          ],
        },
      ],
      options: {
        conversationId: 'conv-1',
        title: 'My Chat',
        model: 'test-model',
      },
      projectSlug: 'project-a',
    });
  });

  it('carries ambient context out-of-band and omits it when absent (#685)', () => {
    const withContext = buildConversationTurnPayload({
      content: 'what time is it?',
      ambientContext: '[Timezone: America/Denver]',
    });
    // The typed content is the input; the context rides a separate field the
    // server composes into the model-facing input only.
    expect(withContext.input).toBe('what time is it?');
    expect(withContext.ambientContext).toBe('[Timezone: America/Denver]');

    expect(
      buildConversationTurnPayload({ content: 'hello' }),
    ).not.toHaveProperty('ambientContext');
  });

  it('accepts conversation-started events when streaming', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"conversation-started","conversationId":"conv-1","title":"Hello"}\n\n' +
              'data: {"type":"finish","finishReason":"stop"}\n\n',
          ),
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body,
      })) as any,
    );

    const onConversationStarted = vi.fn();
    const onStreamEvent = vi.fn(() => ({
      currentTextChunk: '',
      contentParts: [],
      pendingApprovals: new Map(),
      reasoningChunks: [],
      currentReasoningChunk: undefined,
    }));

    const result = await streamConversationTurn({
      agentSlug: 'default',
      content: 'hello',
      onConversationStarted,
      onStreamEvent,
      apiBase: 'http://example.test',
    });

    expect(result.conversationId).toBe('conv-1');
    expect(onConversationStarted).toHaveBeenCalledWith('conv-1', 'Hello');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the server-reported error message on a non-ok JSON response instead of discarding it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          success: false,
          error:
            'AccessDeniedException: User is not authorized to invoke bedrock:InvokeModel',
        }),
      })) as any,
    );

    await expect(
      streamConversationTurn({
        agentSlug: 'default',
        content: 'hello',
        onStreamEvent: vi.fn(),
        apiBase: 'http://example.test',
      }),
    ).rejects.toMatchObject({
      status: 500,
      serverMessage:
        'AccessDeniedException: User is not authorized to invoke bedrock:InvokeModel',
      message:
        'AccessDeniedException: User is not authorized to invoke bedrock:InvokeModel',
    });
  });

  it('falls back to a generic HTTP status message when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('Unexpected token < in JSON');
        },
      })) as any,
    );

    await expect(
      streamConversationTurn({
        agentSlug: 'default',
        content: 'hello',
        onStreamEvent: vi.fn(),
        apiBase: 'http://example.test',
      }),
    ).rejects.toMatchObject({
      status: 502,
      serverMessage: undefined,
      message: 'HTTP 502',
    });
  });

  it('exposes ChatHttpError instances so callers can branch on status/serverMessage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({
          success: false,
          error:
            'UnrecognizedClientException: The security token included in the request is invalid',
        }),
      })) as any,
    );

    try {
      await streamConversationTurn({
        agentSlug: 'default',
        content: 'hello',
        onStreamEvent: vi.fn(),
        apiBase: 'http://example.test',
      });
      expect.unreachable('expected streamConversationTurn to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatHttpError);
      expect((error as ChatHttpError).status).toBe(401);
    }
  });
});

describe('chatRuntimeStream — stall watchdog (station#1207)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('rejects with ChatStreamStallError when the stream goes completely silent for the timeout — no bytes at all, not just no parsed event', async () => {
    vi.useFakeTimers();

    // A stream that never enqueues anything and never closes: real-world
    // shape of a server that crashed mid-turn or a connection that dropped
    // with no error event — `reader.read()` just never resolves on its own.
    const body = new ReadableStream<Uint8Array>({
      start() {
        // deliberately never enqueue or close
      },
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body })) as any);

    const onStreamEvent = vi.fn();
    const resultPromise = streamConversationTurn({
      agentSlug: 'default',
      content: 'hello',
      onStreamEvent,
      apiBase: 'http://example.test',
    });
    // Swallow the rejection on this handle immediately so an unawaited
    // rejected promise never reports as an unhandled rejection while the
    // assertion below is what actually awaits/verifies it.
    resultPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(CHAT_STREAM_STALL_TIMEOUT_MS);

    await expect(resultPromise).rejects.toBeInstanceOf(ChatStreamStallError);
    await expect(resultPromise).rejects.toMatchObject({
      name: 'ChatStreamStallError',
    });
    expect(onStreamEvent).not.toHaveBeenCalled();
  });

  it('stays alive through keepalive-only silence during a long tool call, then interrupts once the keepalives themselves stop (review round 1: models the REAL /chat scenario, not synthetic waiting frames)', async () => {
    vi.useFakeTimers();

    // The real Vercel AI SDK shape a `delegateTask` sub-agent or a slow
    // MCP/shell tool produces: a `tool-call` chunk, then nothing from the
    // model at all until `tool-result` — no progress frame of any kind.
    // The real `/chat` route never emits a synthetic `waiting` event (that
    // type is ACP-adapter-only, a different subsystem); what it actually
    // emits during this silence is a bare SSE comment keepalive
    // (`:ping\n\n`, `startSSEKeepalive` in `stream-orchestrator.ts`).
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const encoder = new TextEncoder();

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body })) as any);

    const onStreamEvent = vi.fn(() => ({
      currentTextChunk: '',
      contentParts: [],
      pendingApprovals: new Map(),
      reasoningChunks: [],
      currentReasoningChunk: undefined,
    }));

    const resultPromise = streamConversationTurn({
      agentSlug: 'default',
      content: 'delegate this to a sub-agent',
      onStreamEvent,
      apiBase: 'http://example.test',
    });
    resultPromise.catch(() => {});

    // Let the request/first read() actually start before the clock moves.
    await vi.advanceTimersByTimeAsync(0);

    controller.enqueue(
      encoder.encode(
        'data: {"type":"tool-call","toolCallId":"call-1","toolName":"delegateTask"}\n\n',
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Phase 1 (alive): three rounds, each just under the stall timeout,
    // each followed by ONLY a keepalive comment — never a `data:` line.
    // Total elapsed silence across the three rounds is 3x the timeout, but
    // no single gap between received bytes ever reaches it, so the
    // watchdog must never trip while keepalives are still arriving.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(CHAT_STREAM_STALL_TIMEOUT_MS - 1);
      controller.enqueue(encoder.encode(':ping\n\n'));
      await vi.advanceTimersByTimeAsync(0);
    }

    // Proof that the parser genuinely ignores the keepalive rather than the
    // watchdog just happening not to fire: only the one real `tool-call`
    // event has reached `onStreamEvent` so far, despite 3x the timeout's
    // worth of elapsed time.
    expect(onStreamEvent).toHaveBeenCalledTimes(1);

    // Phase 2 (dead): the connection now actually dies — no more
    // keepalives, no more content, nothing ever arrives again. This MUST
    // still trip the watchdog once the same timeout elapses from the last
    // keepalive.
    await vi.advanceTimersByTimeAsync(CHAT_STREAM_STALL_TIMEOUT_MS);

    await expect(resultPromise).rejects.toBeInstanceOf(ChatStreamStallError);
    // The stall itself never reaches onStreamEvent either — still just the
    // one real tool-call event from phase 1.
    expect(onStreamEvent).toHaveBeenCalledTimes(1);
  });
});
