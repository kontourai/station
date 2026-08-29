import { agentId } from '@kontourai/station-contracts/agent-identity';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatHttpError as ClientChatHttpError } from '../client';
import {
  continueExecutionMessage,
  ForegroundMessageIndeterminateError,
  getConversationContextBoundaryStatus,
  getConversationHandoffStatus,
  handoffExecutionMessage,
  ResourcePostureOverrideRequiredError,
  sendExecutionMessage,
} from '../client/execution';
import { ChatHttpError } from '../query-domains/chatRuntimeStream';

describe('client execution', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('sends the canonical target to the controlling Station', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            conversationId: 'conv-1',
            sessionId: 'session-1',
            providerTurnId: 'provider-turn-1',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await sendExecutionMessage('http://station.test', {
      message: 'Inspect the target',
      target: {
        environment: { kind: 'current' },
        agent: agentId('station'),
      },
      ambientContext: '[Timezone: America/Denver]',
      clientTurnId: 'client-turn-1',
    });

    expect(receipt.providerTurnId).toBe('provider-turn-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          message: 'Inspect the target',
          target: { environment: { kind: 'current' }, agent: 'station' },
          ambientContext: '[Timezone: America/Denver]',
          clientTurnId: 'client-turn-1',
        }),
      }),
    );
  });

  test('never treats a receipt without provider turn evidence as accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { conversationId: 'conv-1', sessionId: 'session-1' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(
      sendExecutionMessage('http://station.test', {
        message: 'Do not accept without identity',
        target: { environment: { kind: 'current' }, agent: agentId('station') },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'foreground_message_indeterminate',
    });
  });

  test('uses the explicit handoff route and requires its durable disclosure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            conversationId: 'conv-1',
            sessionId: 'session-2',
            providerTurnId: 'turn-2',
            handoff: {
              predecessorSessionId: 'session-1',
              sessionId: 'session-2',
              currentSessionId: 'session-2',
              outcome: 'created',
              target: {
                agentId: 'codex',
                engine: { kind: 'connection', connectionId: 'codex' },
              },
              carried: ['authorizedTranscript'],
              reset: ['providerNativeCursor'],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await handoffExecutionMessage(
      'http://station.test',
      'conv/1',
      {
        message: 'Continue with Codex',
        idempotencyKey: 'handoff-1',
        target: { environment: { kind: 'current' }, agent: agentId('codex') },
      },
    );

    expect(receipt.handoff.predecessorSessionId).toBe('session-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/conversations/conv%2F1/handoff',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('classifies a response without a handoff receipt as indeterminate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              conversationId: 'conversation-a',
              sessionId: 'session-b',
              providerTurnId: 'turn-b',
              target: { kind: 'agent', id: 'codex' },
              resolution: {},
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    let error: unknown;
    try {
      await handoffExecutionMessage('http://station.test', 'conversation-a', {
        message: 'Continue',
        idempotencyKey: 'handoff-key',
        target: { agent: agentId('codex') },
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({
      status: 409,
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
  });

  test('reads durable handoff status without a target payload', async () => {
    const data = {
      conversationId: 'conversation-a',
      currentSessionId: 'session-b',
      status: 'accepted',
      marker: {
        predecessorSessionId: 'session-a',
        sessionId: 'session-b',
        idempotencyKey: 'handoff/key',
        targetAgentId: 'deleted-agent',
        createdAt: '2026-08-24T00:00:00.000Z',
        carried: [],
        reset: [],
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getConversationHandoffStatus(
        'http://station.test',
        'conversation/a',
        'handoff/key',
      ),
    ).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/conversations/conversation%2Fa/handoffs/handoff%2Fkey',
      expect.anything(),
    );
  });

  test('reads durable context-boundary status with the idempotency key', async () => {
    const data = {
      boundaryId: 'boundary-a',
      conversationId: 'conversation-a',
      predecessorSessionId: 'session-a',
      successorSessionId: 'session-b',
      policy: 'empty-next-cold-start',
      status: 'claimed',
      actorId: 'user-a',
      createdAt: '2026-08-25T00:00:00.000Z',
      priorTranscriptInjected: false,
      omitted: ['provider-native history'],
      preserved: ['canonical transcript'],
      retryable: false,
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getConversationContextBoundaryStatus(
        'http://station.test',
        'conversation/a',
        'key/a',
      ),
    ).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/conversations/conversation%2Fa/context-boundary/key%2Fa',
      expect.anything(),
    );
  });

  test('preserves a coded orchestration refusal for the composer', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: "This conversation's worktree is gone and cannot be resumed.",
          code: 'continuation_workspace_worktree_gone',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    let error: unknown;
    try {
      await sendExecutionMessage('http://station.test', {
        message: 'Resume safely',
        target: {
          environment: { kind: 'current' },
          agent: agentId('station'),
        },
      });
      expect.unreachable('expected an orchestration refusal');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChatHttpError);
    expect(error).toMatchObject({
      status: 400,
      serverMessage:
        "This conversation's worktree is gone and cannot be resumed.",
      code: 'continuation_workspace_worktree_gone',
    });
    expect(ChatHttpError).toBe(ClientChatHttpError);
  });

  test('parses foreground indeterminacy as typed no-retry evidence', async () => {
    const receipt = {
      commandId: 'command-uncertain',
      threadId: 'conversation-uncertain',
      commandType: 'startSession',
      status: 'accepted',
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    const session = {
      threadId: 'conversation-uncertain',
      provider: 'claude',
      status: 'ready',
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error:
              'Session may already be running; do not retry automatically.',
            code: 'foreground_message_indeterminate',
            outcome: 'indeterminate',
            receipt,
            receiptStatus: 'unavailable',
            session,
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    let error: unknown;
    try {
      await sendExecutionMessage('http://station.test', {
        message: 'Start safely',
        target: {
          environment: { kind: 'current' },
          agent: agentId('claude'),
        },
      });
      expect.unreachable('expected typed foreground indeterminacy');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ForegroundMessageIndeterminateError);
    expect(error).toMatchObject({
      name: 'ForegroundMessageIndeterminateError',
      status: 409,
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
      detail: { receipt, receiptStatus: 'unavailable', session },
    });
    expect(error).toBeInstanceOf(ChatHttpError);
  });

  test('preserves a sustained-critical one-shot override challenge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'This Station remains busy.',
            code: 'resource_posture_override_required',
            resourceAdmissionOverride: {
              token: 'override-token-1',
              expiresAt: 123_456,
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const request = sendExecutionMessage('http://station.test', {
      message: 'Start anyway',
      target: {
        environment: { kind: 'current' },
        agent: agentId('claude'),
      },
    });
    await expect(request).rejects.toMatchObject({
      name: 'ResourcePostureOverrideRequiredError',
      code: 'resource_posture_override_required',
      override: { token: 'override-token-1', expiresAt: 123_456 },
    });
    await expect(request).rejects.toBeInstanceOf(
      ResourcePostureOverrideRequiredError,
    );
  });

  test('continues through the server-verified conversation binding', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            conversationId: 'conv/1',
            sessionId: 'conv/1',
            providerTurnId: 'provider-turn-continued',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await continueExecutionMessage('http://station.test', 'conv/1', {
      message: 'Continue safely',
      clientTurnId: 'turn-2',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/chat/conv%2F1/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          message: 'Continue safely',
          clientTurnId: 'turn-2',
        }),
      }),
    );
  });

  test.each(['start', 'continue'] as const)(
    '%s preserves detail-less indeterminacy and empty provider IDs as no-retry outcomes',
    async (kind) => {
      const invoke = () =>
        kind === 'start'
          ? sendExecutionMessage('http://station.test', {
              message: 'Do not accept an empty receipt',
              target: {
                environment: { kind: 'current' },
                agent: agentId('station'),
              },
            })
          : continueExecutionMessage('http://station.test', 'conv-1', {
              message: 'Do not accept an empty receipt',
            });
      for (const response of [
        {
          success: false,
          error: 'The foreground operation may already have started.',
          code: 'foreground_message_indeterminate',
          outcome: 'indeterminate',
        },
        {
          success: true,
          data: {
            conversationId: 'conv-1',
            sessionId: 'conv-1',
            providerTurnId: '',
          },
        },
      ]) {
        vi.stubGlobal(
          'fetch',
          vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify(response), {
              status: response.success ? 200 : 409,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
        );
        await expect(invoke()).rejects.toMatchObject({
          status: 409,
          code: 'foreground_message_indeterminate',
          outcome: 'indeterminate',
        });
      }
    },
  );
});
