import { describe, expect, test, vi } from 'vitest';
import {
  createChatConversationId,
  createChatTraceId,
  ensureChatConversation,
  persistUserTurnIfMissing,
} from '../chat-persistence.js';

describe('chat persistence helpers', () => {
  test('creates conversation and trace ids with the user or conversation prefix', () => {
    expect(createChatConversationId('user-1')).toMatch(/^user-1:/);
    expect(createChatTraceId('conv-1')).toMatch(/^conv-1:/);
  });

  test('creates a conversation when storage has no existing record', async () => {
    const conversationStorage = {
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue(undefined),
    };

    await ensureChatConversation({
      conversationStorage,
      conversationId: 'conv-1',
      userId: 'user-1',
      slug: 'agent-a',
      input: 'A short title',
    });

    expect(conversationStorage.createConversation).toHaveBeenCalledWith({
      id: 'conv-1',
      resourceId: 'agent-a',
      userId: 'user-1',
      title: 'A short title',
      metadata: { titleSource: 'prompt' },
    });
  });

  test('uses a neutral label only when the first turn has no text', async () => {
    const conversationStorage = {
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue(undefined),
    };

    await ensureChatConversation({
      conversationStorage,
      conversationId: 'conv-empty',
      userId: 'user-1',
      slug: 'agent-a',
      input: [
        {
          role: 'user',
          parts: [{ type: 'file', url: 'data:...' } as any],
        },
      ],
    });

    expect(conversationStorage.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'New chat',
        metadata: { titleSource: 'generated' },
      }),
    );
  });

  test('preserves an explicit provider title instead of treating it as a prompt fallback', async () => {
    const conversationStorage = {
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue(undefined),
    };

    await ensureChatConversation({
      conversationStorage,
      conversationId: 'conv-provider-title',
      userId: 'user-1',
      slug: 'agent-a',
      input: 'Summarize the deployment plan',
      title: 'Provider supplied title',
    });

    expect(conversationStorage.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Provider supplied title',
        metadata: { titleSource: 'provider' },
      }),
    );
  });

  test('persists delegation metadata on new child conversations', async () => {
    const conversationStorage = {
      getConversation: vi.fn().mockResolvedValue(null),
      createConversation: vi.fn().mockResolvedValue(undefined),
    };

    await ensureChatConversation({
      conversationStorage,
      conversationId: 'conv-child',
      userId: 'user-1',
      slug: 'agent-a',
      input: 'A short title',
      metadata: {
        delegation: {
          mode: 'isolated-child',
          depth: 1,
          maxDepth: 2,
          parentAgentSlug: 'planner',
          rootAgentSlug: 'planner',
        },
      },
    });

    expect(conversationStorage.createConversation).toHaveBeenCalledWith({
      id: 'conv-child',
      resourceId: 'agent-a',
      userId: 'user-1',
      title: 'A short title',
      metadata: {
        delegation: {
          mode: 'isolated-child',
          depth: 1,
          maxDepth: 2,
          parentAgentSlug: 'planner',
          rootAgentSlug: 'planner',
        },
        titleSource: 'prompt',
      },
    });
  });
});

describe('persistUserTurnIfMissing (#797)', () => {
  test('persists the user turn when a failed turn left the transcript empty', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: 'the message the user actually sent',
    });

    expect(persisted).toBe(true);
    expect(memoryAdapter.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        parts: [{ type: 'text', text: 'the message the user actually sent' }],
      }),
      'user-1',
      'conv-1',
    );
    expect(memoryAdapter.addMessage).toHaveBeenCalledTimes(1);
  });

  test('deduplicates an identical caption-less image despite stored part property order (#1939)', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([
        {
          role: 'user',
          parts: [
            {
              persistedAt: '2026-08-10T00:00:00.000Z',
              url: 'data:image/png;base64,c2FtZQ==',
              mediaType: 'image/png',
              type: 'file',
            },
          ],
        },
      ]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: [
        {
          role: 'user',
          parts: [
            {
              type: 'file',
              mediaType: 'image/png',
              url: 'data:image/png;base64,c2FtZQ==',
            },
          ],
        },
      ],
    });

    expect(persisted).toBe(false);
    expect(memoryAdapter.addMessage).not.toHaveBeenCalled();
  });

  test('does not duplicate a user turn the framework already persisted', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'user', parts: [{ type: 'text', text: 'first turn' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'a reply' }] },
        { role: 'user', parts: [{ type: 'text', text: 'second turn' }] },
      ]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: 'second turn',
    });

    expect(persisted).toBe(false);
    expect(memoryAdapter.addMessage).not.toHaveBeenCalled();
  });

  test('persists a repeated prompt when the previous turn already answered it', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'user', parts: [{ type: 'text', text: 'continue' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'a reply' }] },
      ]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: 'continue',
    });

    expect(persisted).toBe(true);
    expect(memoryAdapter.addMessage).toHaveBeenCalledTimes(1);
  });

  test('keeps attachment parts from a structured input', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([]),
    };

    await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'what is in this image?' },
            { type: 'file', url: 'data:image/png;base64,AAA' } as any,
          ],
        },
      ],
    });

    expect(memoryAdapter.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'file', url: 'data:image/png;base64,AAA' },
        ],
      }),
      'user-1',
      'conv-1',
    );
  });

  test('persists a caption-less image when the recovery scan contains a different image (#1939)', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([
        {
          role: 'user',
          parts: [
            {
              type: 'file',
              url: 'data:image/png;base64,b2xk',
              mediaType: 'image/png',
            },
          ],
        },
      ]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: [
        {
          role: 'user',
          parts: [
            {
              type: 'file',
              url: 'data:image/png;base64,bmV3',
              mediaType: 'image/png',
            },
          ],
        },
      ],
    });

    expect(persisted).toBe(true);
    expect(memoryAdapter.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          {
            type: 'file',
            url: 'data:image/png;base64,bmV3',
            mediaType: 'image/png',
          },
        ],
      }),
      'user-1',
      'conv-1',
    );
    expect(memoryAdapter.addMessage).toHaveBeenCalledTimes(1);
  });

  // archive#1293: the old tail-only check missed a race where this turn's
  // user message DID already land (the framework's queued write beat this
  // read) but a different row became the new literal tail in between —
  // e.g. an interleaved, unrelated genuine user message (a slash command, a
  // model-switch notice stored with a user role, …). A bounded backward
  // scan still recognizes the already-persisted row even though it isn't
  // last. This row is deliberately NOT a `[SYSTEM_EVENT]` marker — see the
  // dedicated marker-stop tests below for why a marker row behaves
  // differently (it stops the scan rather than being skipped past).
  test('recognizes an already-persisted turn even when a later, differently-worded row is the new tail (bounded-window race widening)', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'user', parts: [{ type: 'text', text: 'first turn' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'a reply' }] },
        { role: 'user', parts: [{ type: 'text', text: 'the message' }] },
        {
          role: 'user',
          parts: [{ type: 'text', text: 'an unrelated aside' }],
        },
      ]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: 'the message',
    });

    expect(persisted).toBe(false);
    expect(memoryAdapter.addMessage).not.toHaveBeenCalled();
  });

  // archive#1293 review (HIGH-1): the `[CHAT_ERROR]` marker
  // (`chat-lifecycle.ts`) is persisted with role `'user'`, so a scan that
  // only stopped at `role === 'assistant'` walked straight past it — two
  // back-to-back zero-output failed turns with IDENTICAL text then read as
  // "already persisted" and turn 2's own message was silently dropped. The
  // marker row must stop the scan, not be skipped past like an ordinary
  // differently-worded row (contrast with the test above).
  test('a [SYSTEM_EVENT] marker row stops the scan rather than being skipped past — prevents silently losing a second identical failed turn', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'user', parts: [{ type: 'text', text: 'retry this' }] },
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: '[SYSTEM_EVENT] [CHAT_ERROR] transient failure',
            },
          ],
        },
      ]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: 'retry this',
    });

    // Turn 2's identical text must persist — the marker proves turn 1
    // already closed out, so this is NOT the same turn re-appearing.
    expect(persisted).toBe(true);
    expect(memoryAdapter.addMessage).toHaveBeenCalledTimes(1);
  });

  test('a [SYSTEM_EVENT] marker that is not a failed-turn CHAT_ERROR row also stops the scan (any system-event row is a turn boundary)', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'user', parts: [{ type: 'text', text: 'the message' }] },
        {
          role: 'user',
          parts: [{ type: 'text', text: '[SYSTEM_EVENT] model switched' }],
        },
      ]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: 'the message',
    });

    expect(persisted).toBe(true);
  });

  // The stop-at-assistant rule (see isUserTurnAlreadyPersisted's doc
  // comment) is what keeps the widened window from becoming the
  // silent-data-loss alternative archive#797's review rejected: an assistant reply
  // between the match and the tail means that earlier occurrence belongs to
  // a DIFFERENT, already-answered turn, not this one.
  test('does not treat an earlier, already-answered occurrence of the same text as a duplicate of this turn', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'user', parts: [{ type: 'text', text: 'continue' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'a reply' }] },
        { role: 'user', parts: [{ type: 'text', text: 'an unrelated ask' }] },
      ]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: 'continue',
    });

    expect(persisted).toBe(true);
    expect(memoryAdapter.addMessage).toHaveBeenCalledTimes(1);
  });

  test('stays bounded — a match older than the scan window is not found (accepted narrow scope, not an unbounded history scan)', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'user', parts: [{ type: 'text', text: 'the message' }] },
        // 5 unrelated user rows push the real match outside the bounded
        // window (RECENT_MESSAGE_SCAN_WINDOW = 5).
        { role: 'user', parts: [{ type: 'text', text: 'filler 1' }] },
        { role: 'user', parts: [{ type: 'text', text: 'filler 2' }] },
        { role: 'user', parts: [{ type: 'text', text: 'filler 3' }] },
        { role: 'user', parts: [{ type: 'text', text: 'filler 4' }] },
        { role: 'user', parts: [{ type: 'text', text: 'filler 5' }] },
      ]),
    };

    const persisted = await persistUserTurnIfMissing({
      memoryAdapter,
      conversationId: 'conv-1',
      userId: 'user-1',
      input: 'the message',
    });

    expect(persisted).toBe(true);
  });

  test('writes nothing for an empty input', async () => {
    const memoryAdapter = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockResolvedValue([]),
    };

    expect(
      await persistUserTurnIfMissing({
        memoryAdapter,
        conversationId: 'conv-1',
        userId: 'user-1',
        input: '   ',
      }),
    ).toBe(false);
    expect(memoryAdapter.addMessage).not.toHaveBeenCalled();
  });
});
