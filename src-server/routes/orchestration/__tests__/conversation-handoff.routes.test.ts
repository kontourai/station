import { agentId } from '@kontourai/station-contracts/agent-identity';
import { describe, expect, test, vi } from 'vitest';
import { createOrchestrationRoutes } from '../orchestration.js';

describe('conversation handoff route', () => {
  test('uses only the explicit route and returns the structural reset disclosure', async () => {
    const handoffConversation = vi.fn().mockResolvedValue({
      conversationId: 'conversation-a',
      sessionId: 'session-b',
      providerTurnId: 'turn-b',
      target: { id: 'codex' },
      handoff: {
        predecessorSessionId: 'session-a',
        sessionId: 'session-b',
        currentSessionId: 'session-b',
        outcome: 'created',
        target: { agentId: 'codex', engine: { kind: 'connection' } },
        carried: ['authorizedTranscript'],
        reset: ['providerNativeCursor', 'sessionApprovals'],
      },
    });
    const app = createOrchestrationRoutes({} as any, {
      eventBus: { subscribe: () => () => {} },
      logger: { debug: () => {} },
      handoffConversation,
      getUserId: () => 'owner',
    });

    const response = await app.request(
      '/conversations/conversation-a/handoff',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Continue with Codex',
          idempotencyKey: 'handoff-1',
          target: { agent: agentId('codex') },
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { handoff: { reset: string[] } };
    };
    expect(body.data.handoff.reset).toContain('sessionApprovals');
    expect(handoffConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-a',
        idempotencyKey: 'handoff-1',
      }),
    );
  });

  // station#4075 stage 2 review round 1 (F1, HIGH): this route dropped the
  // resolved principal from the payload to `handoffConversation` even though
  // it resolved one for `userId` — the every-other-test-only-checks-userId
  // gap the review named. This pins the fix by asserting `principal` reaches
  // the deps call, not just `userId`.
  test('forwards the resolved principal to handoffConversation, not only userId', async () => {
    const handoffConversation = vi.fn().mockResolvedValue({
      conversationId: 'conversation-a',
      sessionId: 'session-b',
      providerTurnId: 'turn-b',
      target: { id: 'codex' },
      handoff: {
        predecessorSessionId: 'session-a',
        sessionId: 'session-b',
        currentSessionId: 'session-b',
        outcome: 'created',
        target: { agentId: 'codex', engine: { kind: 'connection' } },
        carried: [],
        reset: [],
      },
    });
    const principal = {
      id: 'human:tailscale-serve:alice',
      kind: 'human' as const,
      display: 'Alice',
    };
    const app = createOrchestrationRoutes({} as any, {
      eventBus: { subscribe: () => () => {} },
      logger: { debug: () => {} },
      handoffConversation,
      resolvePrincipal: () => principal,
    });

    const response = await app.request(
      '/conversations/conversation-a/handoff',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Continue with Codex',
          idempotencyKey: 'handoff-1',
          target: { agent: agentId('codex') },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(handoffConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-a',
        userId: principal.id,
        principal,
      }),
    );
  });

  test('preserves indeterminate outcome instead of presenting a definite refusal', async () => {
    const app = createOrchestrationRoutes({} as any, {
      eventBus: { subscribe: () => () => {} },
      logger: { debug: () => {} },
      handoffConversation: vi.fn().mockRejectedValue({
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      }),
      getUserId: () => 'owner',
    });

    const response = await app.request(
      '/conversations/conversation-a/handoff',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Continue with Codex',
          idempotencyKey: 'handoff-1',
          target: { agent: agentId('codex') },
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
  });

  test('does not project handoff markers when conversation authorization fails', async () => {
    const readConversationEventWindow = vi.fn().mockResolvedValue(null);
    const app = createOrchestrationRoutes(
      { readConversationEventWindow } as any,
      {
        eventBus: { subscribe: () => () => {} },
        logger: { debug: () => {} },
        getUserId: () => 'not-the-owner',
      },
    );

    const response = await app.request(
      '/conversations/conversation-a/event-window?turnLimit=1',
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Conversation not found',
    });
    expect(readConversationEventWindow).toHaveBeenCalledWith(
      'conversation-a',
      expect.objectContaining({
        authority: expect.objectContaining({ userId: 'not-the-owner' }),
      }),
    );
  });

  test('projects authorized durable status without resolving an Agent', async () => {
    const readConversationHandoffStatus = vi.fn().mockResolvedValue({
      conversationId: 'conversation-a',
      currentSessionId: 'session-b',
      status: 'accepted',
      marker: {
        predecessorSessionId: 'session-a',
        sessionId: 'session-b',
        idempotencyKey: 'handoff-key',
        targetAgentId: 'deleted-agent',
        createdAt: '2026-08-24T00:00:00.000Z',
        carried: [],
        reset: [],
      },
    });
    const app = createOrchestrationRoutes(
      { readConversationHandoffStatus } as any,
      {
        eventBus: { subscribe: () => () => {} },
        logger: { debug: () => {} },
        getUserId: () => 'owner',
      },
    );

    const response = await app.request(
      '/conversations/conversation-a/handoffs/handoff-key',
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: Record<string, unknown>;
    };
    expect(payload.data).toMatchObject({
      status: 'accepted',
      currentSessionId: 'session-b',
      marker: { targetAgentId: 'deleted-agent' },
    });
    expect(readConversationHandoffStatus).toHaveBeenCalledWith(
      'conversation-a',
      'handoff-key',
      expect.objectContaining({ userId: 'owner' }),
    );
  });
});
