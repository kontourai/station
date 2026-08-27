import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { conversationToThread } from '@kontourai/station-shared/thread-projection';
import { describe, expect, test, vi } from 'vitest';
import {
  createSessionQueryModule,
  MAX_ASSISTANT_TURN_EVENTS,
} from '../session-query-module.js';

describe('SessionQueryModule', () => {
  test('uses the real event projection assistant id for both Thread export and Basis binding', async () => {
    const events: CanonicalRuntimeEvent[] = [
      {
        eventId: 'start-a',
        method: 'turn.started',
        provider: 'test',
        threadId: 'session-a',
        turnId: 'turn-a',
        createdAt: '2026-08-25T00:00:00.000Z',
        prompt: 'question',
      },
      {
        eventId: 'delta-a',
        method: 'content.text-delta',
        provider: 'test',
        threadId: 'session-a',
        turnId: 'turn-a',
        itemId: 'item-a',
        createdAt: '2026-08-25T00:00:01.000Z',
        delta: 'answer',
      },
      {
        eventId: 'done-a',
        method: 'turn.completed',
        provider: 'test',
        threadId: 'session-a',
        turnId: 'turn-a',
        createdAt: '2026-08-25T00:00:02.000Z',
        outputText: 'answer',
      },
    ];
    const thread = conversationToThread(
      projectRuntimeEventsToMessages(events),
      {
        threadId: 'session-a',
      },
    );
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'session-a' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(),
      listBasisEventsForTurn: vi.fn(() => ({
        status: 'found' as const,
        events: [
          {
            method: 'turn.started',
            eventId: 'start-a',
            threadId: 'session-a',
            turnId: 'turn-a',
            sequence: 1,
            observedAt: '2026-08-25T00:00:00.000Z',
            input: {
              kind: 'initial' as const,
              prompt: 'question',
              attachments: [],
            },
          },
          {
            method: 'content.text-delta',
            eventId: 'delta-a',
            threadId: 'session-a',
            turnId: 'turn-a',
            sequence: 2,
            observedAt: '2026-08-25T00:00:01.000Z',
            textDelta: true,
          },
          {
            method: 'turn.completed',
            eventId: 'done-a',
            threadId: 'session-a',
            turnId: 'turn-a',
            sequence: 3,
            observedAt: '2026-08-25T00:00:02.000Z',
            outputText: true,
          },
        ],
      })),
    });
    const outcome = await module.readAnswerBasis?.(
      { type: 'answer-basis', threadId: 'session-a', turnId: 'turn-a' },
      sessionReadAuthorityFromRequest('owner', undefined, undefined),
    );
    const exported = thread.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(outcome).toMatchObject({
      status: 'found',
      binding: { answer: { messageId: exported?.id, threadId: 'session-a' } },
    });
  });
  test('replays an exact answer Basis once, preserves steers/result event identities, and omits structured output', async () => {
    const listBasisEventsForTurn = vi.fn(() => ({
      status: 'found' as const,
      events: [
        {
          method: 'turn.started',
          eventId: 'input-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          sequence: 1,
          observedAt: '2026-08-25T00:00:00.000Z',
          input: { kind: 'initial' as const, prompt: 'first', attachments: [] },
        },
        {
          method: 'turn.started',
          eventId: 'input-2',
          threadId: 'thread-1',
          turnId: 'turn-1',
          sequence: 2,
          observedAt: '2026-08-25T00:00:01.000Z',
          input: { kind: 'steer' as const, prompt: 'steer', attachments: [] },
        },
        {
          method: 'tool.completed',
          eventId: 'result-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          sequence: 3,
          observedAt: '2026-08-25T00:00:02.000Z',
          tool: {
            method: 'tool.completed',
            eventId: 'result-1',
            threadId: 'thread-1',
            turnId: 'turn-1',
            toolCallId: 'reused-call',
            toolName: 'shell',
            status: 'success',
          },
        },
        {
          method: 'tool.completed',
          eventId: 'result-2',
          threadId: 'thread-1',
          turnId: 'turn-1',
          sequence: 4,
          observedAt: '2026-08-25T00:00:03.000Z',
          tool: {
            method: 'tool.completed',
            eventId: 'result-2',
            threadId: 'thread-1',
            turnId: 'turn-1',
            toolCallId: 'reused-call',
            toolName: 'shell',
            status: 'success',
            output: 'safe output',
          },
        },
        {
          method: 'content.text-delta',
          eventId: 'delta',
          threadId: 'thread-1',
          turnId: 'turn-1',
          sequence: 5,
          observedAt: '2026-08-25T00:00:04.000Z',
          textDelta: true,
        },
        {
          method: 'turn.completed',
          eventId: 'done',
          threadId: 'thread-1',
          turnId: 'turn-1',
          sequence: 6,
          observedAt: '2026-08-25T00:00:05.000Z',
        },
      ],
    }));
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(() => {
        throw new Error('must not replay Session');
      }),
      listBasisEventsForTurn,
      projectSlugForSession: () => 'project-alpha',
    });
    const outcome = await module.readAnswerBasis?.(
      { type: 'answer-basis', threadId: 'thread-1', turnId: 'turn-1' },
      sessionReadAuthorityFromRequest('owner', undefined, undefined),
    );
    expect(outcome).toMatchObject({
      status: 'found',
      projectSlug: 'project-alpha',
      inputs: [
        { eventId: 'input-1', kind: 'initial' },
        { eventId: 'input-2', kind: 'steer' },
      ],
      results: [
        { eventId: 'result-1', result: { resultId: 'result-1', content: [] } },
        {
          eventId: 'result-2',
          result: {
            resultId: 'result-2',
            content: [{ type: 'text', text: 'safe output' }],
          },
        },
      ],
    });
    expect(listBasisEventsForTurn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(outcome)).not.toContain('never projected');
  });

  test('does not let a reasoning delta establish a Basis answer', async () => {
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(),
      listBasisEventsForTurn: vi.fn(() => ({
        status: 'found' as const,
        events: [
          {
            method: 'turn.started',
            eventId: 'start',
            threadId: 'thread-1',
            turnId: 'turn-1',
            sequence: 1,
            observedAt: '2026-08-25T00:00:00.000Z',
            input: { kind: 'initial' as const, prompt: 'ask', attachments: [] },
          },
          {
            method: 'content.reasoning-delta',
            eventId: 'reasoning',
            threadId: 'thread-1',
            turnId: 'turn-1',
            sequence: 2,
            observedAt: '2026-08-25T00:00:01.000Z',
          },
          {
            method: 'turn.completed',
            eventId: 'done',
            threadId: 'thread-1',
            turnId: 'turn-1',
            sequence: 3,
            observedAt: '2026-08-25T00:00:02.000Z',
          },
        ],
      })),
    });
    await expect(
      module.readAnswerBasis?.(
        { type: 'answer-basis', threadId: 'thread-1', turnId: 'turn-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toEqual({ status: 'not-found' });
  });

  test('accepts a bounded terminal outputText without exposing its content', async () => {
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(() => {
        throw new Error('must not replay Session');
      }),
      listBasisEventsForTurn: vi.fn(() => ({
        status: 'found' as const,
        events: [
          {
            method: 'turn.started',
            eventId: 'start',
            threadId: 'thread-1',
            turnId: 'turn-1',
            sequence: 1,
            observedAt: '2026-08-25T00:00:00.000Z',
            input: { kind: 'initial' as const, prompt: 'ask', attachments: [] },
          },
          {
            method: 'turn.completed',
            eventId: 'done',
            threadId: 'thread-1',
            turnId: 'turn-1',
            sequence: 2,
            observedAt: '2026-08-25T00:00:01.000Z',
            outputText: true,
          },
        ],
      })),
    });
    const outcome = await module.readAnswerBasis?.(
      { type: 'answer-basis', threadId: 'thread-1', turnId: 'turn-1' },
      sessionReadAuthorityFromRequest('owner', undefined, undefined),
    );
    expect(outcome).toMatchObject({ status: 'found' });
    expect(JSON.stringify(outcome)).not.toContain('outputText');
  });

  test('reads one exact authorized terminal tool result without transcript replay', async () => {
    const listEvents = vi.fn(() => []);
    const toolCompletedEventById = vi.fn(() => ({
      eventId: 'event-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      method: 'tool.completed',
      toolCallId: 'call-1',
      toolName: 'shell',
      status: 'success',
      output: 'safe output',
    }));
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents,
      toolCompletedEventById,
      projectSlugForSession: () => 'project-alpha',
    });
    await expect(
      module.readToolResult?.(
        { type: 'tool-result', threadId: 'thread-1', eventId: 'event-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toMatchObject({
      status: 'found',
      sessionId: 'thread-1',
      eventId: 'event-1',
      projectSlug: 'project-alpha',
      result: {
        resultId: 'event-1',
        terminalStatus: 'success',
        content: [{ type: 'text', text: 'safe output' }],
      },
    });
    expect(toolCompletedEventById).toHaveBeenCalledWith('thread-1', 'event-1');
    expect(listEvents).not.toHaveBeenCalled();
  });

  test('collapses wrong method and tuple to not-found for a tool result', async () => {
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(),
      toolCompletedEventById: () => ({
        eventId: 'event-1',
        threadId: 'other-thread',
        method: 'turn.started',
      }),
    });
    await expect(
      module.readToolResult?.(
        { type: 'tool-result', threadId: 'thread-1', eventId: 'event-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toEqual({ status: 'not-found' });
  });

  test('treats a missing descriptor as not-found and structured output as an empty safe projection', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const unavailable = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(),
      toolCompletedEventById: () => undefined,
    });
    await expect(
      unavailable.readToolResult?.(
        { type: 'tool-result', threadId: 'thread-1', eventId: 'corrupt' },
        authority,
      ),
    ).resolves.toEqual({ status: 'not-found' });
    const structured = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(),
      toolCompletedEventById: () => ({
        eventId: 'structured',
        threadId: 'thread-1',
        method: 'tool.completed',
        toolCallId: 'call',
        toolName: 'shell',
        status: 'success',
        output: { url: 'private' },
      }),
    });
    await expect(
      structured.readToolResult?.(
        { type: 'tool-result', threadId: 'thread-1', eventId: 'structured' },
        authority,
      ),
    ).resolves.toMatchObject({
      status: 'found',
      eventId: 'structured',
      result: { resultId: 'structured', content: [] },
    });
  });
  test('projects an authorized conversation and its messages from one ordered replay', async () => {
    const listEvents = vi.fn(
      () =>
        [
          {
            method: 'turn.started',
            threadId: 'thread-1',
            turnId: 'turn-1',
            prompt: 'Find the replay multiplier',
          },
          {
            method: 'turn.completed',
            threadId: 'thread-1',
            turnId: 'turn-1',
            outputText: 'It was three reads.',
          },
        ] as unknown as CanonicalRuntimeEvent[],
    );
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({
        id: 'thread-1',
      })),
      projectConversation: vi.fn(() => ({
        assignedAgentSlug: 'codex',
        conversationId: 'durable-conversation-1',
        environmentId: 'station-a',
        acceptedModel: 'gpt-5.6-sol',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:01:00.000Z',
      })),
      canReadSession: vi.fn(() => true),
      listEvents,
    });

    await expect(
      module.read(
        { type: 'conversation', threadId: 'thread-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toMatchObject({
      status: 'found',
      conversation: {
        id: 'durable-conversation-1',
        environmentId: 'station-a',
        acceptedModel: 'gpt-5.6-sol',
        title: 'Find the replay multiplier',
        messageCount: 2,
      },
      messages: [
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ],
    });
    expect(listEvents).toHaveBeenCalledOnce();
  });

  test('uses the exact Session id as a legacy conversation fallback', async () => {
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'legacy-thread' })),
      projectConversation: vi.fn(() => ({
        assignedAgentSlug: 'codex',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:01:00.000Z',
      })),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(() => []),
    });

    await expect(
      module.read(
        { type: 'conversation', threadId: 'legacy-thread' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toMatchObject({
      status: 'found',
      conversation: { id: 'legacy-thread' },
    });
  });

  test('makes an existing denied conversation indistinguishable from absent without replaying or projecting it', async () => {
    const listEvents = vi.fn();
    const projectConversation = vi.fn();
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'private-thread' })),
      projectConversation,
      canReadSession: vi.fn(() => false),
      listEvents,
    });

    await expect(
      module.read(
        { type: 'conversation', threadId: 'private-thread' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toEqual({ status: 'not-found' });
    expect(listEvents).not.toHaveBeenCalled();
    expect(projectConversation).not.toHaveBeenCalled();
  });

  test('resolves only the exact completed assistant answer by its Session/turn tuple', async () => {
    const listEvents = vi.fn(
      () =>
        [
          {
            method: 'turn.started',
            threadId: 'thread-1',
            turnId: 'turn-1',
            prompt: 'First question',
          },
          {
            method: 'turn.completed',
            threadId: 'thread-1',
            turnId: 'turn-1',
            outputText: 'First answer',
          },
          {
            method: 'turn.started',
            threadId: 'thread-1',
            turnId: 'turn-2',
            prompt: 'Second question',
          },
          {
            method: 'turn.completed',
            threadId: 'thread-1',
            turnId: 'turn-2',
            outputText: 'Second answer',
          },
        ] as unknown as CanonicalRuntimeEvent[],
    );
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(() => ({
        assignedAgentSlug: 'codex',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:01:00.000Z',
      })),
      canReadSession: vi.fn(() => true),
      listEvents,
    });
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );

    await expect(
      module.readAssistantTurn(
        { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-2' },
        authority,
      ),
    ).resolves.toMatchObject({
      status: 'found',
      sessionId: 'thread-1',
      turnId: 'turn-2',
      message: {
        role: 'assistant',
        metadata: { turnId: 'turn-2' },
        parts: [expect.objectContaining({ text: 'Second answer' })],
      },
    });
    expect(listEvents).toHaveBeenCalledOnce();
  });

  test('uses the indexed turn seam and never returns reasoning or a cancelled/partial terminal answer', async () => {
    const listEvents = vi.fn(() => {
      throw new Error('exact answer must not replay the full Session');
    });
    const listBasisEventsForTurn = vi.fn(
      () =>
        [
          {
            method: 'turn.started',
            threadId: 'thread-1',
            turnId: 'turn-1',
            prompt: 'Question',
          },
          {
            method: 'content.reasoning-delta',
            threadId: 'thread-1',
            turnId: 'turn-1',
            delta: 'private reasoning',
          },
          {
            method: 'content.text-delta',
            threadId: 'thread-1',
            turnId: 'turn-1',
            delta: 'Public answer',
          },
          {
            method: 'turn.completed',
            threadId: 'thread-1',
            turnId: 'turn-1',
          },
        ] as unknown as CanonicalRuntimeEvent[],
    );
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(() => ({
        assignedAgentSlug: 'codex',
        projectSlug: 'project-alpha',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:01:00.000Z',
      })),
      canReadSession: vi.fn(() => true),
      listEvents,
      listBasisEventsForTurn,
      projectSlugForSession: () => 'project-alpha',
    });
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );

    await expect(
      module.readAssistantTurn(
        { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
        authority,
      ),
    ).resolves.toMatchObject({
      status: 'found',
      projectSlug: 'project-alpha',
      message: {
        parts: [{ type: 'text', text: 'Public answer' }],
      },
    });
    expect(listBasisEventsForTurn).toHaveBeenCalledWith('thread-1', 'turn-1');
    expect(listEvents).not.toHaveBeenCalled();

    for (const terminal of [
      { method: 'turn.aborted', reason: 'cancelled' },
      { method: 'turn.completed', finishReason: 'cancelled' },
      // A terminal without the prior lifecycle start is not an answer.
      { method: 'turn.completed', withoutStart: true },
    ]) {
      listBasisEventsForTurn.mockReturnValueOnce([
        ...(terminal.withoutStart
          ? []
          : [
              {
                method: 'turn.started',
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            ]),
        {
          ...terminal,
          threadId: 'thread-1',
          turnId: 'turn-1',
        },
      ] as unknown as CanonicalRuntimeEvent[]);
      await expect(
        module.readAssistantTurn(
          { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
          authority,
        ),
      ).resolves.toEqual({ status: 'not-found' });
    }
  });

  test('treats a later abort as authoritative over an earlier completion', async () => {
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(() => ({
        assignedAgentSlug: 'codex',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:01:00.000Z',
      })),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(() => []),
      listBasisEventsForTurn: vi.fn(
        () =>
          [
            { method: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
            {
              method: 'content.text-delta',
              threadId: 'thread-1',
              turnId: 'turn-1',
              delta: 'partial',
            },
            {
              method: 'turn.completed',
              threadId: 'thread-1',
              turnId: 'turn-1',
            },
            {
              method: 'turn.aborted',
              threadId: 'thread-1',
              turnId: 'turn-1',
              reason: 'late cancellation',
            },
          ] as unknown as CanonicalRuntimeEvent[],
      ),
    });
    await expect(
      module.readAssistantTurn(
        { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toEqual({ status: 'not-found' });
  });

  test('does not require an unbounded session presentation projection to reopen an exact answer', async () => {
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      // An exact turn window need not contain session.configured/agent facts.
      projectConversation: vi.fn(() => null),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(() => []),
      listBasisEventsForTurn: vi.fn(
        () =>
          [
            { method: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
            {
              method: 'content.text-delta',
              threadId: 'thread-1',
              turnId: 'turn-1',
              delta: 'Exact public answer',
            },
            {
              method: 'turn.completed',
              threadId: 'thread-1',
              turnId: 'turn-1',
            },
          ] as unknown as CanonicalRuntimeEvent[],
      ),
    });
    await expect(
      module.readAssistantTurn(
        { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toMatchObject({
      status: 'found',
      message: { parts: [{ type: 'text', text: 'Exact public answer' }] },
    });
  });

  test('accepts Claude steer start reannouncements and duplicate successful terminals, but rejects contradictory ordering', async () => {
    const make = (events: CanonicalRuntimeEvent[]) =>
      createSessionQueryModule({
        findSession: vi.fn(async () => ({ id: 'thread-1' })),
        projectConversation: vi.fn(() => null),
        canReadSession: vi.fn(() => true),
        listEvents: vi.fn(() => []),
        listBasisEventsForTurn: vi.fn(() => events),
      });
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const valid = [
      { method: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      { method: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
      {
        method: 'content.text-delta',
        threadId: 'thread-1',
        turnId: 'turn-1',
        delta: 'answer',
      },
      { method: 'turn.completed', threadId: 'thread-1', turnId: 'turn-1' },
      { method: 'turn.completed', threadId: 'thread-1', turnId: 'turn-1' },
    ] as unknown as CanonicalRuntimeEvent[];
    await expect(
      make(valid).readAssistantTurn(
        { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
        authority,
      ),
    ).resolves.toMatchObject({ status: 'found' });

    for (const events of [
      [
        { method: 'turn.completed', threadId: 'thread-1', turnId: 'turn-1' },
        { method: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
        { method: 'turn.completed', threadId: 'thread-1', turnId: 'turn-1' },
      ],
      [
        { method: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
        { method: 'turn.completed', threadId: 'thread-1', turnId: 'turn-1' },
        {
          method: 'turn.aborted',
          threadId: 'thread-1',
          turnId: 'turn-1',
          reason: 'cancelled',
        },
      ],
    ] as unknown as CanonicalRuntimeEvent[][]) {
      await expect(
        make(events).readAssistantTurn(
          { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
          authority,
        ),
      ).resolves.toEqual({ status: 'not-found' });
    }
  });

  test('selects the final answer after a steer, never the earlier partial row', async () => {
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(() => null),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(() => []),
      listBasisEventsForTurn: vi.fn(
        () =>
          [
            { method: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
            {
              method: 'content.text-delta',
              threadId: 'thread-1',
              turnId: 'turn-1',
              delta: 'partial',
            },
            { method: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
            {
              method: 'content.text-delta',
              threadId: 'thread-1',
              turnId: 'turn-1',
              delta: 'final answer',
            },
            {
              method: 'turn.completed',
              threadId: 'thread-1',
              turnId: 'turn-1',
            },
          ] as unknown as CanonicalRuntimeEvent[],
      ),
    });
    await expect(
      module.readAssistantTurn(
        { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toMatchObject({
      status: 'found',
      message: { parts: [{ type: 'text', text: 'final answer' }] },
    });
  });

  test('fails unavailable rather than replaying a partial oversized turn', async () => {
    const oversized = Array.from(
      { length: MAX_ASSISTANT_TURN_EVENTS + 1 },
      () =>
        ({
          method: 'content.text-delta',
          threadId: 'thread-1',
          turnId: 'turn-1',
          delta: 'x',
        }) as unknown as CanonicalRuntimeEvent,
    );
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(() => null),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(() => []),
      listBasisEventsForTurn: vi.fn(() => oversized),
    });
    await expect(
      module.readAssistantTurn(
        { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('fails closed when a normal completion is recorded after an abort', async () => {
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(() => ({
        assignedAgentSlug: 'codex',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:01:00.000Z',
      })),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(() => []),
      listBasisEventsForTurn: vi.fn(
        () =>
          [
            { method: 'turn.started', threadId: 'thread-1', turnId: 'turn-1' },
            {
              method: 'content.text-delta',
              threadId: 'thread-1',
              turnId: 'turn-1',
              delta: 'partial',
            },
            {
              method: 'turn.aborted',
              threadId: 'thread-1',
              turnId: 'turn-1',
              reason: 'cancelled',
            },
            {
              method: 'turn.completed',
              threadId: 'thread-1',
              turnId: 'turn-1',
              finishReason: 'stop',
            },
          ] as unknown as CanonicalRuntimeEvent[],
      ),
    });
    await expect(
      module.readAssistantTurn(
        { type: 'assistant-turn', threadId: 'thread-1', turnId: 'turn-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toEqual({ status: 'not-found' });
  });

  test('makes denied, unfinished, and non-answer turns indistinguishable from absent', async () => {
    const listEvents = vi.fn(
      () =>
        [
          {
            method: 'turn.started',
            threadId: 'thread-1',
            turnId: 'open-turn',
            prompt: 'Still running',
          },
          {
            method: 'turn.aborted',
            threadId: 'thread-1',
            turnId: 'aborted-turn',
            reason: 'cancelled',
          },
        ] as unknown as CanonicalRuntimeEvent[],
    );
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: vi.fn(() => ({
        assignedAgentSlug: 'codex',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:01:00.000Z',
      })),
      canReadSession: vi.fn((threadId: string) => threadId !== 'private'),
      listEvents,
    });
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );

    await expect(
      module.readAssistantTurn(
        { type: 'assistant-turn', threadId: 'thread-1', turnId: 'open-turn' },
        authority,
      ),
    ).resolves.toEqual({ status: 'not-found' });
    await expect(
      module.readAssistantTurn(
        {
          type: 'assistant-turn',
          threadId: 'thread-1',
          turnId: 'aborted-turn',
        },
        authority,
      ),
    ).resolves.toEqual({ status: 'not-found' });

    const denied = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'private' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => false),
      listEvents: vi.fn(),
    });
    await expect(
      denied.readAssistantTurn(
        { type: 'assistant-turn', threadId: 'private', turnId: 'turn-1' },
        authority,
      ),
    ).resolves.toEqual({ status: 'not-found' });
    expect(listEvents).toHaveBeenCalledTimes(2);
  });

  test('totalizes durable replay failures and reports their cause exactly once', async () => {
    const failure = new Error('sqlite busy');
    const reportUnavailable = vi.fn();
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({
        id: 'thread-1',
      })),
      projectConversation: vi.fn(() => ({
        assignedAgentSlug: 'codex',
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-12T00:01:00.000Z',
      })),
      canReadSession: vi.fn(() => true),
      listEvents: () => {
        throw failure;
      },
      reportUnavailable,
    });

    await expect(
      module.read(
        { type: 'conversation', threadId: 'thread-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(reportUnavailable).toHaveBeenCalledTimes(1);
    expect(reportUnavailable).toHaveBeenCalledWith(
      { type: 'conversation', threadId: 'thread-1' },
      failure,
    );
  });

  test('reads one authorized authored turn.started event by exact Session/event id without exposing raw payload', async () => {
    const userInputEventById = vi.fn(() => ({
      method: 'turn.started',
      threadId: 'historical-session',
      eventId: 'steer-event',
      turnId: 'shared-turn',
      prompt: 'Use the safe prompt only',
      attachments: [
        { name: 'brief.pdf', mediaType: 'application/pdf', size: 42 },
      ],
    }));
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'historical-session' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(),
      userInputEventById,
      projectSlugForSession: () => 'project-alpha',
    });
    const outcome = await module.readUserInput(
      {
        type: 'user-input',
        threadId: 'historical-session',
        eventId: 'steer-event',
      },
      sessionReadAuthorityFromRequest('owner', undefined, undefined),
    );
    expect(outcome).toEqual({
      status: 'found',
      sessionId: 'historical-session',
      eventId: 'steer-event',
      turnId: 'shared-turn',
      projectSlug: 'project-alpha',
      input: {
        inputKind: 'unknown',
        prompt: 'Use the safe prompt only',
        attachments: [
          { name: 'brief.pdf', mediaType: 'application/pdf', size: 42 },
        ],
      },
    });
    expect(userInputEventById).toHaveBeenCalledWith('steer-event');
  });

  test('makes missing, denied, and wrong-method user-input events indistinguishable', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const wrongMethod = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'session' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(),
      userInputEventById: () => ({
        method: 'turn.completed',
        threadId: 'session',
        eventId: 'event',
        attachments: [],
      }),
    });
    await expect(
      wrongMethod.readUserInput(
        { type: 'user-input', threadId: 'session', eventId: 'event' },
        authority,
      ),
    ).resolves.toEqual({ status: 'not-found' });
    const denied = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'session' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => false),
      listEvents: vi.fn(),
      userInputEventById: vi.fn(),
    });
    await expect(
      denied.readUserInput(
        { type: 'user-input', threadId: 'session', eventId: 'event' },
        authority,
      ),
    ).resolves.toEqual({ status: 'not-found' });
  });

  test('preserves a known authored input kind and defaults legacy descriptors to unknown', async () => {
    const make = (inputKind?: 'initial' | 'steer') =>
      createSessionQueryModule({
        findSession: vi.fn(async () => ({ id: 'session' })),
        projectConversation: vi.fn(),
        canReadSession: vi.fn(() => true),
        listEvents: vi.fn(),
        userInputEventById: () => ({
          eventId: 'event',
          threadId: 'session',
          turnId: 'turn',
          method: 'turn.started',
          prompt: 'keep me',
          attachments: [],
          ...(inputKind ? { inputKind } : {}),
        }),
      });
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    await expect(
      make('steer').readUserInput(
        { type: 'user-input', threadId: 'session', eventId: 'event' },
        authority,
      ),
    ).resolves.toMatchObject({
      status: 'found',
      input: { inputKind: 'steer' },
    });
    await expect(
      make().readUserInput(
        { type: 'user-input', threadId: 'session', eventId: 'event' },
        authority,
      ),
    ).resolves.toMatchObject({
      status: 'found',
      input: { inputKind: 'unknown' },
    });
  });

  test('rejects a wrong-row descriptor and accepts an attachment-only authored input', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const make = (descriptor: any) =>
      createSessionQueryModule({
        findSession: vi.fn(async () => ({ id: 'session' })),
        projectConversation: vi.fn(),
        canReadSession: vi.fn(() => true),
        listEvents: vi.fn(),
        userInputEventById: vi.fn(() => descriptor),
      });
    await expect(
      make({
        eventId: 'wrong-event',
        threadId: 'session',
        turnId: 'turn',
        method: 'turn.started',
        attachments: [],
      }).readUserInput(
        { type: 'user-input', threadId: 'session', eventId: 'event' },
        authority,
      ),
    ).resolves.toEqual({ status: 'not-found' });
    await expect(
      make({
        eventId: 'event',
        threadId: 'session',
        turnId: 'turn',
        method: 'turn.started',
        attachments: [{ name: 'only.png', mediaType: 'image/png', size: 7 }],
      }).readUserInput(
        { type: 'user-input', threadId: 'session', eventId: 'event' },
        authority,
      ),
    ).resolves.toMatchObject({
      status: 'found',
      input: { prompt: '', attachments: [{ name: 'only.png' }] },
    });
  });

  test('treats a missing user-input point-read composition as unavailable', async () => {
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'session' })),
      projectConversation: vi.fn(),
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(),
    });
    await expect(
      module.readUserInput(
        { type: 'user-input', threadId: 'session', eventId: 'event' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test.each(['turn.failed', 'turn.aborted', 'turn.cancelled'])(
    'retains an already-authored input after %s',
    async () => {
      const module = createSessionQueryModule({
        findSession: vi.fn(async () => ({ id: 'session' })),
        projectConversation: vi.fn(),
        canReadSession: vi.fn(() => true),
        listEvents: vi.fn(),
        userInputEventById: () => ({
          eventId: 'started',
          threadId: 'session',
          turnId: 'turn',
          method: 'turn.started',
          prompt: 'keep me',
          attachments: [],
        }),
      });
      await expect(
        module.readUserInput(
          { type: 'user-input', threadId: 'session', eventId: 'started' },
          sessionReadAuthorityFromRequest('owner', undefined, undefined),
        ),
      ).resolves.toMatchObject({
        status: 'found',
        input: { prompt: 'keep me' },
      });
    },
  );

  test('reports projection failures without allowing an observer failure to escape', async () => {
    const failure = new Error('projection failed');
    const reportUnavailable = vi.fn(() => {
      throw new Error('logger unavailable');
    });
    const module = createSessionQueryModule({
      findSession: vi.fn(async () => ({ id: 'thread-1' })),
      projectConversation: () => {
        throw failure;
      },
      canReadSession: vi.fn(() => true),
      listEvents: vi.fn(() => []),
      reportUnavailable,
    });

    await expect(
      module.read(
        { type: 'conversation', threadId: 'thread-1' },
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      ),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(reportUnavailable).toHaveBeenCalledTimes(1);
    expect(reportUnavailable).toHaveBeenCalledWith(
      { type: 'conversation', threadId: 'thread-1' },
      failure,
    );
  });

  test.each(['corrupt', 'over-budget'] as const)(
    'preserves a descriptor %s outcome for the Task Basis owner adapter',
    async (status) => {
      const module = createSessionQueryModule({
        findSession: vi.fn(async () => ({ id: 'thread-1' })),
        projectConversation: vi.fn(),
        canReadSession: vi.fn(() => true),
        listEvents: vi.fn(),
        listBasisEventsForTurn: vi.fn(() => ({ status })),
      });
      await expect(
        module.readAnswerBasis?.(
          { type: 'answer-basis', threadId: 'thread-1', turnId: 'turn-1' },
          sessionReadAuthorityFromRequest('owner', undefined, undefined),
        ),
      ).resolves.toEqual({ status: 'corrupt' });
    },
  );
});
