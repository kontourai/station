import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import {
  INTERNAL_TURN_CORRELATION_HEADER,
  readAuthorizedTurnCorrelationHandoff,
  runWithAuthorizedTurnCorrelation,
} from '../../runtime/conversation/authorized-turn-correlation.js';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { tenantExecutionContextOutcomes } from '../../telemetry/metrics.js';
import {
  mapStationAgentStreamEvent,
  readChatRejectionReason,
  STATION_AGENT_STREAM_STALL_TIMEOUT_MS,
  StationAgentAdapter,
} from '../adapters/station-agent-adapter.js';

vi.mock('../../telemetry/metrics.js', () => ({
  approvalDuration: { record: vi.fn() },
  approvalOps: { add: vi.fn() },
  tenantExecutionContextAttributes: vi.fn((value) => value),
  tenantExecutionContextOutcomes: { add: vi.fn() },
}));

function sseResponse(events: Array<Record<string, unknown> | '[DONE]'>) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(
              `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`,
            ),
          );
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function nextEvents(
  iterator: AsyncIterator<CanonicalRuntimeEvent>,
  count: number,
) {
  const events: CanonicalRuntimeEvent[] = [];
  for (let index = 0; index < count; index++) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Timed out waiting for event')),
          1_000,
        ),
      ),
    ]);
    if (!next.done) events.push(next.value);
  }
  return events;
}

function approvalDeps() {
  const eventBus = new EventBus();
  return {
    eventBus,
    approvalRegistry: new ApprovalRegistry(
      { info: vi.fn(), warn: vi.fn() },
      { eventBus },
    ),
  };
}

describe('mapStationAgentStreamEvent — tool-result relay (station#3113, #3117)', () => {
  function run(event: Record<string, unknown>) {
    const published: CanonicalRuntimeEvent[] = [];
    mapStationAgentStreamEvent({
      event,
      threadId: 'thread-1',
      turnId: 'turn-1',
      publish: (e) => published.push(e),
    });
    return published;
  }

  test('forwards a real Station-authored denial reason and policyDenied verbatim', () => {
    const reason =
      "Tool 'write_file' was blocked by the config-protection policy: writes require review";
    const [event] = run({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'write_file',
      error: reason,
      policyDenied: true,
    });

    expect(event).toMatchObject({
      method: 'tool.completed',
      status: 'error',
      error: reason,
      policyDenied: true,
    });
  });

  // archive#3117's original complaint: the relay used to substitute its OWN
  // hardcoded 'Station agent tool failed' literal, discarding whatever the
  // engine adapter decided was safe to say. It must no longer do that —
  // it forwards exactly what arrives, since the engine adapter is the one
  // that made the redaction decision.
  test('forwards an ordinary already-redacted failure verbatim, without policyDenied', () => {
    const [event] = run({
      type: 'tool-result',
      toolCallId: 'call-2',
      toolName: 'write_file',
      error: 'Tool call failed.',
    });

    expect(event).toMatchObject({
      method: 'tool.completed',
      status: 'error',
      error: 'Tool call failed.',
    });
    expect(
      (event as unknown as Record<string, unknown>).policyDenied,
    ).toBeUndefined();
  });

  // Redaction by omission: whatever raw shape the engine adapter left on
  // `output` (which may still carry the real framework error object, per
  // voltagent-adapter.ts's disclosed boundary) never reaches the canonical
  // event once `error` is set.
  test('never forwards `output` once `error` is set, even if output holds raw error internals', () => {
    const [event] = run({
      type: 'tool-result',
      toolCallId: 'call-3',
      toolName: 'write_file',
      error: 'Tool call failed.',
      output: {
        error: true,
        message: 'remote-canary-in-output',
        stack: 'Error: remote-canary-in-output\n    at ...',
      },
    });

    expect(event).not.toHaveProperty('output');
    expect(JSON.stringify(event)).not.toContain('remote-canary-in-output');
  });

  // Negative control: a genuinely successful call carries no error signal
  // and no policyDenied at all.
  test('a successful call forwards output and carries no error/policyDenied', () => {
    const [event] = run({
      type: 'tool-result',
      toolCallId: 'call-4',
      toolName: 'read_file',
      output: { ok: true },
    });

    expect(event).toMatchObject({
      method: 'tool.completed',
      status: 'success',
      output: { ok: true },
    });
    expect((event as unknown as Record<string, unknown>).error).toBeUndefined();
    expect(
      (event as unknown as Record<string, unknown>).policyDenied,
    ).toBeUndefined();
  });
});

describe('StationAgentAdapter', () => {
  test('relays only an exact authorized turn correlation and uses its canonical turn id', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
    });
    await adapter.startSession({
      threadId: 'fleet-session',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer', userId: 'account-a' },
    });

    const correlation = {
      accountId: 'account-a',
      sessionId: 'fleet-session',
      turnId: 'fleet-turn',
      correlationId: 'fleet-correlation',
    };
    const result = await runWithAuthorizedTurnCorrelation(correlation, () =>
      adapter.sendTurn({
        threadId: 'fleet-session',
        input: 'private prompt that must not enter correlation',
      }),
    );

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(result.turnId).toBe('fleet-turn');
    expect(
      readAuthorizedTurnCorrelationHandoff(
        headers[INTERNAL_TURN_CORRELATION_HEADER],
      ),
    ).toEqual(correlation);
    expect(JSON.stringify(headers)).not.toContain('private prompt');
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain(
      'fleet-correlation',
    );
  });

  test('declares engine-selected omission and supported overrides at every lifecycle point', () => {
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
    });

    expect(adapter.metadata.modelLaunch).toEqual({
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    });
  });

  test('forwards an accepted start model on a later omitted-model turn', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
    });

    await adapter.startSession({
      threadId: 'retained-start-model',
      provider: 'station-agent',
      modelId: 'start-model',
      metadata: { agentId: 'reviewer' },
    });
    await adapter.sendTurn({
      threadId: 'retained-start-model',
      input: 'Keep the start model',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.options).toMatchObject({
      model: 'start-model',
      providerManagedFallback: true,
      providerModel: 'start-model',
    });
  });

  test('declares image-input so the orchestration capability gate accepts image attachments', () => {
    // archive#1885: the defect was that the gate refused what the UI offered.
    // Pinning the declaration guards against a regression that reintroduces
    // the disagreement (capability declared ⟺ affordance offered/accepted).
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
    });
    expect(adapter.metadata.capabilities).toContain('image-input');
    // file-input is deliberately NOT declared — see the adapter's capability
    // comment and the orchestration-level file-refusal test.
    expect(adapter.metadata.capabilities).not.toContain('file-input');
  });

  test('forwards image attachments to /chat as multipart file parts in the relay body (station#1885 silent-drop guard)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
    });

    await adapter.startSession({
      threadId: 'station-agent-attachment',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });
    await adapter.sendTurn({
      threadId: 'station-agent-attachment',
      input: 'describe this image',
      attachments: [
        {
          kind: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          size: 5,
          dataUrl: 'data:image/png;base64,aGVsbG8=',
        },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    // The relay input must be the multipart array /chat consumes — proving the
    // attachment is carried past the relay, not dropped after the gate passed.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0].role).toBe('user');
    expect(body.input[0].parts).toEqual([
      { type: 'text', text: 'describe this image' },
      {
        type: 'file',
        url: 'data:image/png;base64,aGVsbG8=',
        mediaType: 'image/png',
      },
    ]);
  });

  test('keeps the relay input a plain string when a turn carries no attachments (station#1885)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
    });

    await adapter.startSession({
      threadId: 'station-agent-no-attachment',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });
    await adapter.sendTurn({
      threadId: 'station-agent-no-attachment',
      input: 'plain text turn',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.input).toBe('plain text turn');
  });

  test('relays only its server-owned tenant execution context as the internal tenant header', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
    });

    const session = await adapter.startSession({
      threadId: 'tenant-bound-station-agent',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
      tenantExecutionContext: { tenantId: 'alpha' as any, source: 'request' },
    });
    await adapter.sendTurn({
      threadId: 'tenant-bound-station-agent',
      input: 'Do not use model input for tenant selection',
      modelOptions: { tenantId: 'bravo' },
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-station-internal-tenant': 'alpha',
    });
    expect(JSON.stringify(session.resumeCursor)).not.toContain(
      'tenantExecutionContext',
    );
    expect(tenantExecutionContextOutcomes.add).toHaveBeenCalledWith(1, {
      operation: 'relay',
      source: 'session',
      outcome: 'accepted',
      reason: 'none',
    });
  });

  test('classifies a personal relay without manufacturing tenant authority', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
    });
    await adapter.startSession({
      threadId: 'personal-station-agent',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });
    await adapter.sendTurn({ threadId: 'personal-station-agent', input: 'hi' });

    expect(tenantExecutionContextOutcomes.add).toHaveBeenCalledWith(1, {
      operation: 'relay',
      source: 'none',
      outcome: 'skipped',
      reason: 'personal_mode',
    });
  });

  test.each(['', '  \t  '])(
    'treats a blank turn selector %j as omission and forwards the accepted start model',
    async (modelId) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
        );
      const adapter = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: () => true,
        ...approvalDeps(),
        fetch: fetchMock,
      });

      await adapter.startSession({
        threadId: `retained-blank-${modelId.length}`,
        provider: 'station-agent',
        modelId: 'start-model',
        metadata: { agentId: 'reviewer' },
      });
      await adapter.sendTurn({
        threadId: `retained-blank-${modelId.length}`,
        input: 'Keep the start model',
        modelId,
      });

      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.options).toMatchObject({
        model: 'start-model',
        providerManagedFallback: true,
        providerModel: 'start-model',
      });
    },
  );

  test('forwards an accepted resume model on a later omitted-model turn', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
    });

    await adapter.startSession({
      threadId: 'retained-resume-model',
      provider: 'station-agent',
      modelId: 'resume-model',
      resumeCursor: { agentId: 'reviewer' },
    });
    await adapter.sendTurn({
      threadId: 'retained-resume-model',
      input: 'Keep the resume model',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.options).toMatchObject({
      model: 'resume-model',
      providerManagedFallback: true,
      providerModel: 'resume-model',
    });
  });

  test('never lets caller modelOptions replace server-owned model evidence in canonical metadata', async () => {
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      threadId: 'reserved-model-options',
      provider: 'station-agent',
      metadata: {
        agentId: 'reviewer',
        modelLaunchPlan: {
          kind: 'engine-selected',
          evidence: 'adapter-declared',
        },
      },
      modelOptions: {
        modelSelectionReceipt: { appliedModel: 'forged' },
        modelLaunchPlan: { kind: 'station-resolved', modelId: 'forged' },
        modelLaunchRequestedOverride: true,
        capabilityDelivery: { forged: true },
        displayDensity: 'compact',
      },
    });
    const [, configured] = await nextEvents(iterator, 2);

    expect(configured).toMatchObject({
      method: 'session.configured',
      metadata: {
        agentId: 'reviewer',
        modelLaunchPlan: {
          kind: 'engine-selected',
          evidence: 'adapter-declared',
        },
        displayDensity: 'compact',
      },
    });
    if (configured.method !== 'session.configured') {
      throw new Error(
        `Expected session.configured, received ${configured.method}`,
      );
    }
    expect(configured.metadata).not.toHaveProperty('modelSelectionReceipt');
    expect(configured.metadata).not.toHaveProperty(
      'modelLaunchRequestedOverride',
    );
    expect(configured.metadata).not.toHaveProperty('capabilityDelivery');
  });

  test('runs a configured Station agent through the canonical resumable task stream', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        { type: 'text-delta', id: 'text-1', text: 'Reviewed ' },
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'repo_read',
          input: { path: 'README.md' },
        },
        {
          type: 'tool-result',
          toolCallId: 'tool-1',
          toolName: 'repo_read',
          output: 'ok',
        },
        { type: 'text-delta', id: 'text-2', text: 'successfully.' },
        { type: 'finish', finishReason: 'stop' },
        '[DONE]',
      ]),
    );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: (agentId) => agentId === 'reviewer',
      ...approvalDeps(),
      fetch: fetchMock,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const session = await adapter.startSession({
      threadId: 'task-1',
      provider: 'station-agent',
      cwd: '/work/station',
      modelId: 'sonnet',
      metadata: {
        agentId: 'reviewer',
        projectSlug: 'station',
        userId: 'user-1',
        taskId: 'task-1',
      },
    });
    const turn = await adapter.sendTurn({
      threadId: 'task-1',
      input: 'Review this change',
      modelId: 'sonnet',
    });
    const events = await nextEvents(iterator, 10);

    expect(session.resumeCursor).toEqual({
      agentId: 'reviewer',
      projectSlug: 'station',
      userId: 'user-1',
    });
    expect(turn.threadId).toBe('task-1');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'session.state-changed',
      'turn.started',
      'content.text-delta',
      'tool.started',
      'tool.completed',
      'content.text-delta',
      'turn.completed',
      'session.state-changed',
    ]);
    expect(events[8]).toMatchObject({
      method: 'turn.completed',
      outputText: 'Reviewed successfully.',
      finishReason: 'stop',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/agents/reviewer/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          input: 'Review this change',
          options: {
            conversationId: 'task-1',
            userId: 'user-1',
            model: 'sonnet',
            // archive#1288: a modelId turn must carry the provider-fallback
            // carrier or /chat's model-override guard 400s (no resolved
            // provider connection).
            providerManagedFallback: true,
            providerModel: 'sonnet',
          },
          projectSlug: 'station',
        }),
      }),
    );
  });

  describe('effectiveModel metadata (station#1455)', () => {
    test('stamps effectiveModel on both turn.started and the turn.completed terminal event, and never a reportedModel', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
        );
      const adapter = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: () => true,
        ...approvalDeps(),
        fetch: fetchMock,
        now: () => new Date('2026-08-01T00:00:00.000Z'),
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        threadId: 'task-model-metadata',
        provider: 'station-agent',
        metadata: { agentId: 'reviewer' },
      });
      await adapter.sendTurn({
        threadId: 'task-model-metadata',
        input: 'Review this change',
        modelId: 'sonnet',
        modelOptions: { effort: 'high' },
      });
      const events = await nextEvents(iterator, 6);

      const turnStarted = events.find(
        (event) => event.method === 'turn.started',
      );
      const turnCompleted = events.find(
        (event) => event.method === 'turn.completed',
      );
      expect(turnStarted).toMatchObject({
        metadata: {
          effectiveModel: 'sonnet',
          effectiveModelOptions: { effort: 'high' },
        },
      });
      expect(turnCompleted).toMatchObject({
        metadata: {
          effectiveModel: 'sonnet',
          effectiveModelOptions: { effort: 'high' },
        },
      });
      // The deliberate refusal (station-agent-adapter.ts:526-544 note)
      // stands: station's own engine executes the turn end-to-end, so
      // there is no independent runtime report to surface — a
      // `reportedModel` here would just restate the requested value
      // under a name implying independent confirmation.
      expect(
        (turnStarted as { metadata?: Record<string, unknown> }).metadata,
      ).not.toHaveProperty('reportedModel');
      expect(
        (turnCompleted as { metadata?: Record<string, unknown> }).metadata,
      ).not.toHaveProperty('reportedModel');
    });

    test('omits effectiveModel when no modelId was requested', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
        );
      const adapter = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: () => true,
        ...approvalDeps(),
        fetch: fetchMock,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        threadId: 'task-no-model',
        provider: 'station-agent',
        metadata: { agentId: 'reviewer' },
      });
      await adapter.sendTurn({
        threadId: 'task-no-model',
        input: 'Review this change',
      });
      const events = await nextEvents(iterator, 5);

      const turnStarted = events.find(
        (event) => event.method === 'turn.started',
      );
      expect(
        (turnStarted as { metadata?: Record<string, unknown> }).metadata,
      ).not.toHaveProperty('effectiveModel');
    });
  });

  test('relays the typed text plus raw ambientContext instead of the composed input (#685 review MEDIUM-1)', async () => {
    // The /chat pipeline persists its `input` (conversation title, temp
    // agent messages), so the relay must forward the typed text and let
    // /chat's own choke point compose exactly once.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'text-delta', id: 'text-1', text: 'ok' }]),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: (agentId) => agentId === 'reviewer',
      ...approvalDeps(),
      fetch: fetchMock,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    void adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      threadId: 'task-ambient',
      provider: 'station-agent',
      cwd: '/work/station',
      modelId: 'sonnet',
      metadata: { agentId: 'reviewer', projectSlug: 'station' },
    });

    await adapter.sendTurn({
      threadId: 'task-ambient',
      input: '[Timezone: America/Denver]\nwhat time is it?',
      displayInput: 'what time is it?',
      ambientContext: '[Timezone: America/Denver]',
      modelId: 'sonnet',
    });

    const chatCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/agents/reviewer/chat'),
    );
    expect(chatCall).toBeDefined();
    const body = JSON.parse(String(chatCall?.[1]?.body));
    expect(body.input).toBe('what time is it?');
    expect(body.ambientContext).toBe('[Timezone: America/Denver]');
    expect(body.input).not.toContain('[Timezone:');
  });

  // archive#1288: `/chat`'s model-override guard (chat-model-override.ts)
  // 400s any request carrying `options.model` without a resolved provider
  // connection, and `chat-request-preparation.ts` only resolves one when
  // `options.providerManagedFallback` is set. This relay is the only caller
  // that can reach `/chat` with a model override and no provider connection
  // of its own — every flipped managed-chat turn and every `delegateTask`
  // call with an explicit model 400ed on "A configured provider connection
  // is required for model overrides." until the relay forwards the carrier
  // itself.
  describe('forwards the provider-connection carrier for a modelId turn (#1288)', () => {
    test('a turn with modelId sets providerManagedFallback and providerModel', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
        );
      const adapter = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: (agentId) => agentId === 'reviewer',
        ...approvalDeps(),
        fetch: fetchMock,
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      });
      void adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        threadId: 'task-model-override',
        provider: 'station-agent',
        metadata: { agentId: 'reviewer' },
      });

      await adapter.sendTurn({
        threadId: 'task-model-override',
        input: 'Use qwen for this one',
        modelId: 'qwen3-coder:latest',
      });

      const chatCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/agents/reviewer/chat'),
      );
      expect(chatCall).toBeDefined();
      const body = JSON.parse(String(chatCall?.[1]?.body));
      expect(body.options.model).toBe('qwen3-coder:latest');
      expect(body.options.providerManagedFallback).toBe(true);
      expect(body.options.providerModel).toBe('qwen3-coder:latest');
    });

    test('a turn without modelId does not set providerManagedFallback', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
        );
      const adapter = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: (agentId) => agentId === 'reviewer',
        ...approvalDeps(),
        fetch: fetchMock,
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      });
      void adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        threadId: 'task-no-override',
        provider: 'station-agent',
        metadata: { agentId: 'reviewer' },
      });

      await adapter.sendTurn({
        threadId: 'task-no-override',
        input: 'No model override here',
      });

      const chatCall = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/agents/reviewer/chat'),
      );
      expect(chatCall).toBeDefined();
      const body = JSON.parse(String(chatCall?.[1]?.body));
      expect(body.options.model).toBeUndefined();
      expect(body.options.providerManagedFallback).toBeUndefined();
      expect(body.options.providerModel).toBeUndefined();
    });
  });

  test('interrupts only the active turn while keeping the session resumable', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream({
            start() {},
          }),
          { status: 200 },
        );
      });
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      threadId: 'task-interrupt',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });
    const turn = await adapter.sendTurn({
      threadId: 'task-interrupt',
      input: 'Keep working',
    });
    await adapter.interruptTurn('task-interrupt', turn.turnId);
    const events = await nextEvents(iterator, 6);

    expect(requestSignal?.aborted).toBe(true);
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'session.state-changed',
      'turn.started',
      'turn.aborted',
      'session.state-changed',
    ]);
    expect(await adapter.hasSession('task-interrupt')).toBe(true);
    expect((await adapter.listSessions())[0]?.status).toBe('ready');
  });

  /**
   * station#1569 (item 4): this adapter had NO tool-call state — the SSE
   * relay is a stateless per-chunk translator — so a call whose stream was
   * abandoned (a stop aborts the controller, and `consumeChatStream`'s
   * aborted branch returns silently by design) left a row running forever
   * with no terminal from any path.
   */
  describe('open tool calls at session end (station#1569 item 4)', () => {
    /** A session with a live turn whose stream stays open, so a `tool-call`
     * chunk can be delivered without a matching `tool-result`. */
    async function sessionWithOpenToolCall(threadId: string) {
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
      const adapter = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: () => true,
        ...approvalDeps(),
        fetch: fetchMock,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        threadId,
        provider: 'station-agent',
        metadata: { agentId: 'reviewer' },
      });
      const turn = await adapter.sendTurn({
        threadId,
        input: 'Use the repository tool',
      });
      streamController.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: 'tool-call',
            toolCallId: 'call-open',
            toolName: 'repo_write',
            input: { path: 'README.md' },
          })}\n\n`,
        ),
      );
      // session.started, session.configured, session.state-changed,
      // turn.started, tool.started
      const opened = await nextEvents(iterator, 5);
      expect(opened.at(-1)).toMatchObject({
        method: 'tool.started',
        toolCallId: 'call-open',
      });
      return { adapter, iterator, encoder, streamController, turn };
    }

    test('stopSession settles them as unresolved, on their own turn, before session.exited', async () => {
      const { adapter, iterator, turn } = await sessionWithOpenToolCall(
        'task-stop-open-tool',
      );

      await adapter.stopSession('task-stop-open-tool');

      const [settled, exited] = await nextEvents(iterator, 2);
      expect(settled).toMatchObject({
        method: 'tool.completed',
        toolCallId: 'call-open',
        toolName: 'repo_write',
        status: 'unresolved',
        turnId: turn.turnId,
        output:
          'No result was reported before the session ended; whether the tool ran is unknown.',
      });
      expect(exited).toMatchObject({ method: 'session.exited' });
    });

    test('an id-less chunk pair is never settled as unresolved', async () => {
      // station#1569 (M2): the relay mints a fallback id per chunk, so an
      // id-less start and its id-less result carry DIFFERENT ids. Tracking
      // the start would leave an entry its own result can never delete, and
      // the settle would then publish "no result was reported" for a call
      // whose success it had already published.
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
      const adapter = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: () => true,
        ...approvalDeps(),
        fetch: fetchMock,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        threadId: 'task-idless-tool',
        provider: 'station-agent',
        metadata: { agentId: 'reviewer' },
      });
      await adapter.sendTurn({
        threadId: 'task-idless-tool',
        input: 'Use the repository tool',
      });
      for (const chunk of [
        { type: 'tool-call', toolName: 'repo_write', input: {} },
        { type: 'tool-result', toolName: 'repo_write', output: 'written' },
      ]) {
        streamController.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      // session.started, session.configured, session.state-changed,
      // turn.started, tool.started, tool.completed
      const seen = await nextEvents(iterator, 6);
      expect(seen.at(-1)).toMatchObject({
        method: 'tool.completed',
        status: 'success',
      });

      await adapter.stopSession('task-idless-tool');

      // Straight to the exit: no fabricated `unresolved` in between.
      const [next] = await nextEvents(iterator, 1);
      expect(next).toMatchObject({ method: 'session.exited' });
    });

    test('a call that already reported is not settled again', async () => {
      // The discriminating control: the settle publishes for calls still
      // open, not for every call the session ran.
      const { adapter, iterator, encoder, streamController } =
        await sessionWithOpenToolCall('task-stop-closed-tool');

      streamController.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: 'tool-result',
            toolCallId: 'call-open',
            toolName: 'repo_write',
            output: 'written',
          })}\n\n`,
        ),
      );
      expect(await nextEvents(iterator, 1)).toMatchObject([
        { method: 'tool.completed', status: 'success' },
      ]);

      await adapter.stopSession('task-stop-closed-tool');

      const [next] = await nextEvents(iterator, 1);
      expect(next).toMatchObject({ method: 'session.exited' });
    });
  });

  test('routes scoped approvals through the shared registry and remembers allow-for-session', async () => {
    const eventBus = new EventBus();
    const approvalRegistry = new ApprovalRegistry(
      { info: vi.fn(), warn: vi.fn() },
      { eventBus },
    );
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      fetch: fetchMock,
      approvalRegistry,
      eventBus,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      threadId: 'task-approval',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });
    await adapter.startSession({
      threadId: 'task-other',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });
    await adapter.sendTurn({
      threadId: 'task-approval',
      input: 'Use the repository tool',
    });

    const firstApproval = approvalRegistry.register('approval-1', {
      metadata: {
        source: 'runtime',
        title: 'repo_write',
        conversationId: 'task-approval',
      },
    });
    streamController.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          type: 'tool-approval-request',
          approvalId: 'approval-1',
          toolName: 'repo_write',
          toolDescription: 'Update the requested file',
          toolArgs: { path: 'README.md' },
        })}\n\n`,
      ),
    );
    const opened = await nextEvents(iterator, 7);

    expect(opened.at(-1)).toMatchObject({
      method: 'request.opened',
      threadId: 'task-approval',
      requestId: 'approval-1',
      requestType: 'approval',
      title: 'repo_write',
      description: 'Update the requested file',
      payload: {
        toolName: 'repo_write',
        toolArgs: { path: 'README.md' },
      },
    });
    await expect(
      adapter.respondToRequest('task-other', 'approval-1', 'acceptForSession'),
    ).rejects.toThrow('Unknown Station agent approval request: approval-1');
    await adapter.respondToRequest(
      'task-approval',
      'approval-1',
      'acceptForSession',
    );
    await expect(firstApproval).resolves.toBe(true);
    expect(await nextEvents(iterator, 1)).toMatchObject([
      {
        method: 'request.resolved',
        requestId: 'approval-1',
        status: 'approved',
      },
    ]);

    const rememberedApproval = approvalRegistry.register('approval-2', {
      metadata: {
        source: 'runtime',
        title: 'repo_write',
        conversationId: 'task-approval',
      },
    });
    streamController.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          type: 'tool-approval-request',
          approvalId: 'approval-2',
          toolName: 'repo_write',
        })}\n\n`,
      ),
    );
    await expect(rememberedApproval).resolves.toBe(true);
    expect(await nextEvents(iterator, 2)).toMatchObject([
      { method: 'request.opened', requestId: 'approval-2' },
      {
        method: 'request.resolved',
        requestId: 'approval-2',
        status: 'approved',
      },
    ]);

    const earlyResolution = approvalRegistry.register('approval-3', {
      metadata: {
        source: 'runtime',
        title: 'repo_delete',
        conversationId: 'task-approval',
      },
    });
    approvalRegistry.resolve('approval-3', false);
    await expect(earlyResolution).resolves.toBe(false);
    streamController.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          type: 'tool-approval-request',
          approvalId: 'approval-3',
          toolName: 'repo_delete',
        })}\n\n`,
      ),
    );
    expect(await nextEvents(iterator, 2)).toMatchObject([
      { method: 'request.opened', requestId: 'approval-3' },
      {
        method: 'request.resolved',
        requestId: 'approval-3',
        status: 'denied',
      },
    ]);

    streamController.close();
    expect(await nextEvents(iterator, 2)).toMatchObject([
      { method: 'turn.completed' },
      { method: 'session.state-changed', to: 'idle' },
    ]);
  });

  test('does not let an interrupted stream clear or abort its replacement turn', async () => {
    const signals: AbortSignal[] = [];
    const streamControllers: ReadableStreamDefaultController[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              streamControllers.push(controller);
              signals.push(init?.signal as AbortSignal);
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
    });
    await adapter.startSession({
      threadId: 'task-replace',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });

    const first = await adapter.sendTurn({
      threadId: 'task-replace',
      input: 'First turn',
    });
    await adapter.interruptTurn('task-replace', first.turnId);
    const second = await adapter.sendTurn({
      threadId: 'task-replace',
      input: 'Replacement turn',
    });
    streamControllers[0]?.error(new Error('interrupted stream closed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect((await adapter.listSessions())[0]?.status).toBe('running');
    await adapter.interruptTurn('task-replace', first.turnId);
    expect(signals[1]?.aborted).toBe(false);
    await adapter.interruptTurn('task-replace', second.turnId);
    expect(signals[1]?.aborted).toBe(true);
  });

  test('recovers the Station agent binding from the persisted resume cursor', async () => {
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: (agentId) => agentId === 'reviewer',
      ...approvalDeps(),
    });

    await expect(
      adapter.startSession({
        threadId: 'task-recovered',
        provider: 'station-agent',
        resumeCursor: {
          agentId: 'reviewer',
          projectSlug: 'station',
          userId: 'user-1',
        },
      }),
    ).resolves.toMatchObject({
      threadId: 'task-recovered',
      status: 'ready',
      resumeCursor: { agentId: 'reviewer', projectSlug: 'station' },
    });
  });

  test('defers recovery validation until agents load, then fails closed on use', async () => {
    let registryReady = false;
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => false,
      ...approvalDeps(),
      isAgentRegistryReady: () => registryReady,
    });

    await adapter.startSession({
      threadId: 'task-missing',
      provider: 'station-agent',
      resumeCursor: { agentId: 'removed-agent' },
    });
    registryReady = true;
    await expect(
      adapter.sendTurn({
        threadId: 'task-missing',
        input: 'Continue',
      }),
    ).rejects.toThrow('Unknown Station agent: removed-agent');
  });

  // archive#1071: /api/agents/:slug/chat rejections carry a specific, actionable
  // reason in their JSON error body (e.g. which config to fix); swallowing it
  // leaves the user with only a generic string.
  test('threads the /chat rejection reason into the thrown error and the runtime.error event (#1071)', async () => {
    const reason =
      'Multiple enabled LLM provider connections require an explicit default.';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: reason }), { status: 409 }),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: (agentId) => agentId === 'reviewer',
      ...approvalDeps(),
      fetch: fetchMock,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      threadId: 'task-rejected',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer', userId: 'user-1' },
    });
    const thrown: unknown = await adapter
      .sendTurn({
        threadId: 'task-rejected',
        input: 'Review this change',
      })
      .then(() => null)
      .catch((error: unknown) => error);
    // Exact equality, not toThrow's substring match — a doubled or suffixed
    // message must fail here (review LOW).
    expect((thrown as Error).message).toBe(
      `Station agent did not accept the task turn: ${reason}`,
    );

    const events = await nextEvents(iterator, 6);
    const runtimeErrors = events.filter(
      (event) => event.method === 'runtime.error',
    );
    expect(runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]).toMatchObject({
      method: 'runtime.error',
      code: 'station_agent_turn_unavailable',
      message: `Station agent did not accept the task turn: ${reason}`,
    });
  });

  test('falls back to the generic rejection message when /chat returns no usable reason (#1071)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('Bad Gateway', { status: 502 }));
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: (agentId) => agentId === 'reviewer',
      ...approvalDeps(),
      fetch: fetchMock,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      threadId: 'task-rejected-opaque',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer', userId: 'user-1' },
    });
    await expect(
      adapter.sendTurn({
        threadId: 'task-rejected-opaque',
        input: 'Review this change',
      }),
    ).rejects.toThrow(/^Station agent did not accept the task turn$/);

    const events = await nextEvents(iterator, 6);
    const runtimeErrors = events.filter(
      (event) => event.method === 'runtime.error',
    );
    expect(runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]).toMatchObject({
      method: 'runtime.error',
      code: 'station_agent_turn_unavailable',
      message: 'Station agent did not accept the task turn',
    });
  });

  // archive#1885 review HIGH: the mutation-budget middleware's 413 body is an
  // OBJECT (`{ error: { code: 'request_too_large', limit_bytes } }`), not a
  // string. `readChatRejectionReason` used to read `body.error` through
  // `stringField`, which returns undefined for an object, so the user got the
  // generic "Station agent did not accept the task turn" — no mention of size
  // — for exactly the image-attachment size range this feature was meant to
  // fix. This test pins the legible, size-specific reason through both the
  // thrown error and the republished runtime.error event.
  test('surfaces the size limit from a structured 413 rejection body instead of the generic message (station#1885)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'request_too_large', limit_bytes: 5_242_880 },
        }),
        { status: 413, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: (agentId) => agentId === 'reviewer',
      ...approvalDeps(),
      fetch: fetchMock,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      threadId: 'task-413-sized',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer', userId: 'user-1' },
    });
    const thrown: unknown = await adapter
      .sendTurn({
        threadId: 'task-413-sized',
        input: 'describe this image',
      })
      .then(() => null)
      .catch((error: unknown) => error);
    // The thrown error names the size — not the generic fallback.
    expect((thrown as Error).message).toBe(
      'Station agent did not accept the task turn: request body too large (limit 5242880 bytes)',
    );

    const events = await nextEvents(iterator, 6);
    const runtimeErrors = events.filter(
      (event) => event.method === 'runtime.error',
    );
    expect(runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]).toMatchObject({
      method: 'runtime.error',
      code: 'station_agent_turn_unavailable',
      message:
        'Station agent did not accept the task turn: request body too large (limit 5242880 bytes)',
    });
  });

  // Review round 1 (Codex MED-1/MED-2): the rejection-body read is bounded
  // and abort-aware, and the republished reason is a normalized single line.
  describe('readChatRejectionReason bounds (#1071 review round 1)', () => {
    test('an oversized body falls back to the generic message', async () => {
      const huge = JSON.stringify({ error: 'x'.repeat(64 * 1024) });
      await expect(
        readChatRejectionReason(new Response(huge, { status: 409 }), {
          maxBytes: 16 * 1024,
        }),
      ).resolves.toBeUndefined();
    });

    test('a within-bounds but overlong reason is truncated for republication', async () => {
      const reason = `${'a'.repeat(600)}`;
      const result = await readChatRejectionReason(
        new Response(JSON.stringify({ error: reason }), { status: 409 }),
      );
      expect(result).toHaveLength(501);
      expect(result?.endsWith('…')).toBe(true);
    });

    test('control characters are normalized out of the reason', async () => {
      const esc = String.fromCharCode(27);
      const bell = String.fromCharCode(7);
      const result = await readChatRejectionReason(
        new Response(
          JSON.stringify({
            error: `line one\nline two${esc}[31mred${bell}`,
          }),
          { status: 409 },
        ),
      );
      expect(result).toBe('line one line two [31mred');
    });

    test('a body that never closes resolves undefined at the deadline instead of hanging', async () => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"par'));
            // never closes
          },
        }),
        { status: 409 },
      );
      await expect(
        readChatRejectionReason(response, { deadlineMs: 50 }),
      ).resolves.toBeUndefined();
    });

    test('a multi-chunk body is decoded whole', async () => {
      const payload = new TextEncoder().encode(
        JSON.stringify({ error: 'chunked reason' }),
      );
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(payload.slice(0, 7));
            controller.enqueue(payload.slice(7));
            controller.close();
          },
        }),
        { status: 409 },
      );
      await expect(readChatRejectionReason(response)).resolves.toBe(
        'chunked reason',
      );
    });

    test('a complete JSON prefix followed by a stall is NOT trusted (closure-round MED)', async () => {
      // The body emits a full, parseable JSON object and then never closes.
      // The deadline cancels the read; the accepted prefix must not be
      // published — completion within bounds is part of the contract.
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ error: 'complete-before-stall' }),
              ),
            );
            // never closes
          },
        }),
        { status: 409 },
      );
      await expect(
        readChatRejectionReason(response, { deadlineMs: 50 }),
      ).resolves.toBeUndefined();
    });

    test('an abort mid-read cancels the loop and yields undefined', async () => {
      const controller = new AbortController();
      const response = new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(new TextEncoder().encode('{"error":"par'));
            // never closes; the abort must unblock the pending read
          },
        }),
        { status: 409 },
      );
      const pending = readChatRejectionReason(response, {
        signal: controller.signal,
        deadlineMs: 5_000,
      });
      setTimeout(() => controller.abort(), 20);
      await expect(pending).resolves.toBeUndefined();
    });

    test('an aborted signal skips the body read entirely', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        readChatRejectionReason(
          new Response(JSON.stringify({ error: 'reason' }), { status: 409 }),
          { signal: controller.signal },
        ),
      ).resolves.toBeUndefined();
    });

    // archive#1885: the mutation-budget middleware (and the security
    // middleware) emit STRUCTURED error bodies — `{ error: { code, ... } }` —
    // not string errors. `stringField` silently dropped objects, so a 413
    // surfaced as the generic fallback. These pin the object-shape read.
    test('reads the size limit from a structured request_too_large body (station#1885)', async () => {
      await expect(
        readChatRejectionReason(
          new Response(
            JSON.stringify({
              error: { code: 'request_too_large', limit_bytes: 5_242_880 },
            }),
            { status: 413 },
          ),
        ),
      ).resolves.toBe('request body too large (limit 5242880 bytes)');
    });

    test('reads a structured code with no limit_bytes', async () => {
      await expect(
        readChatRejectionReason(
          new Response(JSON.stringify({ error: { code: 'rate_limited' } }), {
            status: 429,
          }),
        ),
      ).resolves.toBe('rate_limited');
    });

    test('still reads a plain string error alongside the structured shape', async () => {
      // The route's own 409s carry `{ error: "specific reason" }` — the
      // object-body fix must not regress the original archive#1071 string path.
      await expect(
        readChatRejectionReason(
          new Response(
            JSON.stringify({ error: 'Agent is not currently launchable.' }),
            { status: 409 },
          ),
        ),
      ).resolves.toBe('Agent is not currently launchable.');
    });
  });

  // archive#796: the UI starts a Station agent session without a model — the model
  // is resolved only when a turn is sent. Only `session.configured` carries a
  // model into the read model and the persisted session row, so a settled
  // model that is never republished lives in adapter memory alone and a
  // resumed session shows 'Model not reported'.
  test('republishes session.configured when a turn settles a model the session did not have (#796)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: (agentId) => agentId === 'reviewer',
      ...approvalDeps(),
      fetch: fetchMock,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      threadId: 'task-no-model',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer', userId: 'user-1' },
    });
    await adapter.sendTurn({
      threadId: 'task-no-model',
      input: 'Review this change',
      modelId: 'qwen3:1.7b',
    });
    const events = await nextEvents(iterator, 4);

    // The start-time configured event honestly carries no model; the
    // turn-time one carries the model that actually ran.
    const configured = events.filter(
      (event) => event.method === 'session.configured',
    );
    expect(configured).toHaveLength(2);
    expect((configured[0] as { model?: string }).model).toBeUndefined();
    expect((configured[1] as { model?: string }).model).toBe('qwen3:1.7b');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'session.configured',
      'session.state-changed',
    ]);
  });

  test('does not republish session.configured when the turn repeats the session model (#796)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sseResponse([{ type: 'finish', finishReason: 'stop' }, '[DONE]']),
      );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: (agentId) => agentId === 'reviewer',
      ...approvalDeps(),
      fetch: fetchMock,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      threadId: 'task-same-model',
      provider: 'station-agent',
      modelId: 'sonnet',
      metadata: { agentId: 'reviewer', userId: 'user-1' },
    });
    await adapter.sendTurn({
      threadId: 'task-same-model',
      input: 'Review this change',
      modelId: 'sonnet',
    });
    const events = await nextEvents(iterator, 3);

    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'session.state-changed',
    ]);
  });

  // archive#1071: the /chat route's own reason (a specific, actionable 409
  // body) used to be discarded in favor of a generic message. Both the
  // thrown error (surfaced to HTTP callers of /api/orchestration/commands)
  // and the published runtime.error event (surfaced to the UI/CLI) must
  // carry the route's real reason.
  test("surfaces the /chat route's own reason instead of a generic message (#1071)", async () => {
    const reason = "Agent 'x' is not currently launchable.";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: reason }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      threadId: 'task-not-launchable',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });

    await expect(
      adapter.sendTurn({
        threadId: 'task-not-launchable',
        input: 'Review this change',
      }),
    ).rejects.toThrow(reason);

    const events = await nextEvents(iterator, 5);
    const failure = events.find((event) => event.method === 'runtime.error');
    expect(failure).toBeDefined();
    expect((failure as { message?: string }).message).toContain(reason);
  });

  test('falls back to the generic message when the /chat route body is unusable (#1071)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not json', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    const adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      ...approvalDeps(),
      fetch: fetchMock,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      threadId: 'task-unusable-body',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });

    await expect(
      adapter.sendTurn({
        threadId: 'task-unusable-body',
        input: 'Review this change',
      }),
    ).rejects.toThrow('Station agent did not accept the task turn');

    const events = await nextEvents(iterator, 5);
    const failure = events.find((event) => event.method === 'runtime.error');
    expect(failure).toBeDefined();
    expect((failure as { message?: string }).message).toBe(
      'Station agent did not accept the task turn',
    );
  });

  // archive#1207 review round 1, HIGH 2 — the actual production trigger
  // under `managed-chat-orchestration`: before this fix, a silent stall on
  // the inner /chat bridge stream (server crash, dropped connection, no
  // error event) meant `reader.read()` inside `consumeChatStream` never
  // resolved, no terminal event was ever published, and the client's own
  // timeout-free `/api/orchestration/events` stream waited forever with no
  // signal to surface an error.
  describe('chat bridge stall watchdog (station#1207 review HIGH 2)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test('a silently stalled inner /chat stream publishes runtime.error instead of hanging the turn forever', async () => {
      vi.useFakeTimers();

      // The POST itself succeeds (200, stream opens) — the server accepted
      // the turn and then went completely silent: no more bytes, ever, and
      // the response body never closes. This is the exact shape a crashed
      // downstream process or a dropped connection produces.
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // deliberately never enqueue or close
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
      const adapter = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: (agentId) => agentId === 'reviewer',
        ...approvalDeps(),
        fetch: fetchMock,
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        threadId: 'task-stalled-bridge',
        provider: 'station-agent',
        metadata: { agentId: 'reviewer', userId: 'user-1' },
      });

      // sendTurn's own await only covers the initial POST + response.ok
      // check (which resolves immediately here) — `consumeChatStream` keeps
      // running in the background exactly as it does in production.
      const turn = await adapter.sendTurn({
        threadId: 'task-stalled-bridge',
        input: 'Review this change',
      });
      expect(turn.threadId).toBe('task-stalled-bridge');

      // Let the background consumeChatStream reach its first read() and
      // arm the watchdog timer before advancing the clock.
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(STATION_AGENT_STREAM_STALL_TIMEOUT_MS);

      const events = await nextEvents(iterator, 6);
      const failure = events.find((event) => event.method === 'runtime.error');
      expect(failure).toBeDefined();
      expect((failure as { message?: string; code?: string }).code).toBe(
        'station_agent_turn_unavailable',
      );
      // The stall reason is threaded through, not swallowed into the
      // generic "did not accept the task turn" text.
      expect((failure as { message?: string }).message).toMatch(
        /stalled — no response for \d+s/,
      );
    });

    // archive#1207 review round 2, item 2: the sibling case to the stall
    // test above — a HEALTHY long-running tool call (delegateTask sub-agent
    // or a slow MCP/shell tool) that legitimately produces zero `data:`
    // frames for well over the stall timeout, with only server-emitted
    // `:ping` keepalive comments in between, must NOT be false-tripped.
    // Mirrors the client-side SDK test's shape (`chatRuntimeStream.test.ts`)
    // at this adapter layer.
    test('keepalive-only silence past the timeout does NOT trip the bridge watchdog — a long tool call still completes normally', async () => {
      vi.useFakeTimers();

      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
      const adapter = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: (agentId) => agentId === 'reviewer',
        ...approvalDeps(),
        fetch: fetchMock,
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        threadId: 'task-alive-bridge',
        provider: 'station-agent',
        metadata: { agentId: 'reviewer', userId: 'user-1' },
      });
      const turn = await adapter.sendTurn({
        threadId: 'task-alive-bridge',
        input: 'Review this change',
      });
      expect(turn.threadId).toBe('task-alive-bridge');

      await vi.advanceTimersByTimeAsync(0);

      controller.enqueue(
        encoder.encode(
          'data: {"type":"tool-call","toolCallId":"tool-1","toolName":"repo_read","input":{"path":"README.md"}}\n\n',
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      // Three rounds, each just under the stall timeout, each followed by
      // ONLY a keepalive comment — never a `data:` line. Total elapsed
      // silence across the three rounds is 3x the timeout, but no single
      // gap between received bytes ever reaches it.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(
          STATION_AGENT_STREAM_STALL_TIMEOUT_MS - 1,
        );
        controller.enqueue(encoder.encode(':ping\n\n'));
        await vi.advanceTimersByTimeAsync(0);
      }

      // The long tool call finally finishes — real content resumes.
      controller.enqueue(
        encoder.encode(
          'data: {"type":"tool-result","toolCallId":"tool-1","toolName":"repo_read","output":"ok"}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode('data: {"type":"finish","finishReason":"stop"}\n\n'),
      );
      controller.close();
      await vi.advanceTimersByTimeAsync(0);

      const events = await nextEvents(iterator, 8);
      expect(events.map((event) => event.method)).toEqual([
        'session.started',
        'session.configured',
        'session.state-changed',
        'turn.started',
        'tool.started',
        'tool.completed',
        'turn.completed',
        'session.state-changed',
      ]);
      expect(events.some((event) => event.method === 'runtime.error')).toBe(
        false,
      );
      const completed = events.find(
        (event) => event.method === 'turn.completed',
      );
      expect(completed).toMatchObject({
        method: 'turn.completed',
        finishReason: 'stop',
      });
    });
  });
});
