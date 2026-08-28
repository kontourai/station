import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FileMemoryAdapter } from '../memory-adapter.js';
import {
  createPromptOnlyMemoryView,
  excludeChatErrorMarkers,
  isChatErrorMarkerMessage,
} from '../memory-adapter-prompt-view.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createAdapter() {
  const dir = await mkdtemp(join(tmpdir(), 'memory-adapter-prompt-view-'));
  tempDirs.push(dir);
  return new FileMemoryAdapter({ projectHomeDir: dir });
}

// archive#191 code-review HIGH-1: a fixture conversation with a real persisted
// [CHAT_ERROR] marker (the exact shape `chat-lifecycle.ts`'s
// `finalizeChatRequest` writes), plus a normal user turn before and after
// it, exercising both sides of the fix at the real adapter boundary.
async function seedFixtureConversation(adapter: FileMemoryAdapter) {
  const userId = 'agent:agent-a';
  const conversationId = 'conversation-1';

  await adapter.addMessage(
    {
      id: 'msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'What region is Bedrock in?' }],
    } as any,
    userId,
    conversationId,
  );

  // The failed-turn marker persisted by finalizeChatRequest (archive#191 R2).
  await adapter.addMessage(
    {
      id: 'msg-2',
      role: 'user',
      parts: [
        {
          type: 'text',
          text: '[SYSTEM_EVENT] [CHAT_ERROR] AccessDeniedException: User is not authorized to invoke bedrock:InvokeModel',
        },
      ],
    } as any,
    userId,
    conversationId,
  );

  // A pre-existing, deliberately model-visible add-system-message use —
  // must NOT be filtered by this fix.
  await adapter.addMessage(
    {
      id: 'msg-3',
      role: 'user',
      parts: [
        { type: 'text', text: '[SYSTEM_EVENT] User switched to dark mode' },
      ],
    } as any,
    userId,
    conversationId,
  );

  await adapter.addMessage(
    {
      id: 'msg-4',
      role: 'user',
      parts: [{ type: 'text', text: 'Try again please' }],
    } as any,
    userId,
    conversationId,
  );

  return { userId, conversationId };
}

describe('createPromptOnlyMemoryView (#191 code-review HIGH-1)', () => {
  test('the wrapped view used for prompt assembly excludes the [CHAT_ERROR] marker', async () => {
    const adapter = await createAdapter();
    const { userId, conversationId } = await seedFixtureConversation(adapter);
    const promptView = createPromptOnlyMemoryView(adapter);

    const messages = await promptView.getMessages(userId, conversationId);
    const texts = messages.map(
      (m: any) => m.parts?.[0]?.text as string | undefined,
    );

    expect(texts).not.toContain(expect.stringContaining('[CHAT_ERROR]'));
    expect(texts.some((t) => t?.includes('AccessDeniedException'))).toBe(false);
    // The unrelated add-system-message convention stays visible to the model.
    expect(texts).toContain('[SYSTEM_EVENT] User switched to dark mode');
    // Ordinary turns are untouched.
    expect(texts).toContain('What region is Bedrock in?');
    expect(texts).toContain('Try again please');
    expect(messages).toHaveLength(3);
  });

  test('the raw, unwrapped adapter (UI/history read path) still returns the marker', async () => {
    const adapter = await createAdapter();
    const { userId, conversationId } = await seedFixtureConversation(adapter);

    // This is the same call shape routes/conversations.ts uses to serve
    // the conversation-history API that repopulates the chat dock on
    // reload — it must keep seeing every message, unfiltered.
    const messages = await adapter.getMessages(userId, conversationId);
    const texts = messages.map((m: any) => m.parts?.[0]?.text as string);

    expect(texts.some((t) => t.includes('[SYSTEM_EVENT] [CHAT_ERROR]'))).toBe(
      true,
    );
    expect(messages).toHaveLength(4);
  });

  test('delegates non-getMessages calls to the real adapter (conversation stats, etc.)', async () => {
    const adapter = await createAdapter();
    const { userId, conversationId } = await seedFixtureConversation(adapter);
    const promptView = createPromptOnlyMemoryView(adapter);

    const conversation = await promptView.getConversation(conversationId);
    expect(conversation).toBeNull(); // never explicitly created, matches raw adapter behavior

    await promptView.addMessage(
      {
        id: 'msg-5',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Answer' }],
      } as any,
      userId,
      conversationId,
    );

    // Written through the view lands in the same underlying store.
    const raw = await adapter.getMessages(userId, conversationId);
    expect(raw.map((m: any) => m.id)).toContain('msg-5');
  });
});

describe('isChatErrorMarkerMessage / excludeChatErrorMarkers', () => {
  test('only matches role:user messages carrying the [CHAT_ERROR] sub-marker', () => {
    expect(
      isChatErrorMarkerMessage({
        role: 'user',
        parts: [{ type: 'text', text: '[SYSTEM_EVENT] [CHAT_ERROR] boom' }],
      } as any),
    ).toBe(true);

    expect(
      isChatErrorMarkerMessage({
        role: 'user',
        parts: [
          { type: 'text', text: '[SYSTEM_EVENT] User switched to dark mode' },
        ],
      } as any),
    ).toBe(false);

    expect(
      isChatErrorMarkerMessage({
        role: 'assistant',
        parts: [{ type: 'text', text: '[SYSTEM_EVENT] [CHAT_ERROR] boom' }],
      } as any),
    ).toBe(false);
  });

  test('excludeChatErrorMarkers preserves order of remaining messages', () => {
    const messages = [
      { id: 'a', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: 'b',
        role: 'user',
        parts: [{ type: 'text', text: '[SYSTEM_EVENT] [CHAT_ERROR] boom' }],
      },
      { id: 'c', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
    ] as any;

    expect(excludeChatErrorMarkers(messages).map((m: any) => m.id)).toEqual([
      'a',
      'c',
    ]);
  });
});
