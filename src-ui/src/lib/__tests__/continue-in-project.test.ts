import { describe, expect, test } from 'vitest';
import {
  bindProjectContinuation,
  continuedConversationFromChat,
  draftProjectFromConversation,
  draftTaskFromConversation,
  readProjectContinuation,
  stageProjectContinuation,
} from '../continue-in-project';

const NOW = new Date('2026-11-16T12:00:00.000Z');

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const chat = {
  id: 'chat-1',
  conversationId: 'conversation-9',
  currentSessionId: 'session-2',
  title: 'Quarterly revenue analysis',
  agentName: 'Analyst',
  messages: [
    { role: 'user', content: 'Compare Q3 revenue by region.' },
    {
      role: 'assistant',
      content: 'EMEA grew 12%.',
      turnId: 'turn-1',
      sessionId: 'session-1',
      answerEligible: true,
    },
    { role: 'user', content: 'And APAC?' },
    // Still streaming: never cited.
    { role: 'assistant', content: 'APAC is…', turnId: 'turn-2' },
    {
      role: 'assistant',
      content: 'An answer without an execution Session',
      turnId: 'unbound-turn',
      answerEligible: true,
    },
    { role: 'system', content: 'Reconnected', ephemeral: true },
  ],
};

describe('Continue in Project drafts', () => {
  test('the Task cites the latest completed answer, in the Session that produced it', () => {
    const conversation = continuedConversationFromChat(chat, '~/work/revenue');
    expect(conversation).toEqual({
      sessionId: 'session-1',
      conversationId: 'conversation-9',
      title: 'Quarterly revenue analysis',
      agentName: 'Analyst',
      firstRequest: 'Compare Q3 revenue by region.',
      latestAnswer: 'EMEA grew 12%.',
      latestTurnId: 'turn-1',
      workingDirectory: '~/work/revenue',
    });
  });

  test('a chat with no completed answer is continued without a citation', () => {
    const conversation = continuedConversationFromChat({
      id: 'chat-2',
      currentSessionId: 'session-3',
      messages: [{ role: 'user', content: 'Start a plan' }],
    });
    expect(conversation.latestTurnId).toBeUndefined();
    expect(conversation.sessionId).toBe('session-3');
  });

  test('the new Project brief cites the chat by title and id', () => {
    const draft = draftProjectFromConversation(
      continuedConversationFromChat(chat, '~/work/revenue'),
      NOW,
    );
    expect(draft.name).toBe('Quarterly revenue analysis');
    expect(draft.directory).toBe('~/work/revenue');
    expect(draft.description).toContain(
      'Continued from the chat “Quarterly revenue analysis” with Analyst on 2026-11-16 (chat conversation-9).',
    );
    expect(draft.description).toContain('Asked: Compare Q3 revenue by region.');
  });

  test('an untitled chat is named from its first request', () => {
    const draft = draftTaskFromConversation(
      continuedConversationFromChat({
        id: 'chat-3',
        title: 'New chat',
        messages: [{ role: 'user', content: 'Draft the onboarding email' }],
      }),
      NOW,
    );
    expect(draft.title).toBe('Continue: Draft the onboarding email');
  });

  test('a bound continuation expires an hour after the draft was staged', () => {
    const storage = memoryStorage();
    const scope = {
      apiBase: 'https://station.test',
      authorityKey: 'account-1',
    };
    const draftId = stageProjectContinuation(
      scope,
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        title: 'Continue: Quarterly revenue analysis',
        description: 'brief',
        savedAt: NOW.toISOString(),
      },
      storage,
    );
    expect(draftId).toBeDefined();
    bindProjectContinuation(scope, draftId!, 'project-1', NOW, storage);
    expect(
      readProjectContinuation(scope, 'project-1', NOW, storage)?.turnId,
    ).toBe('turn-1');
    expect(
      readProjectContinuation(
        scope,
        'project-1',
        new Date(NOW.getTime() + 61 * 60_000),
        storage,
      ),
    ).toBeUndefined();
  });
});
