// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { findPrecedingUserTurn } from '../components/chat-dock/ChatDockBody';
import type { ChatMessage } from '../types';

function userMessage(text: string): ChatMessage {
  return { role: 'user', content: text } as ChatMessage;
}

function assistantMessage(text: string): ChatMessage {
  return { role: 'assistant', content: text } as ChatMessage;
}

describe('findPrecedingUserTurn (#797)', () => {
  it('finds the user turn a failed-turn marker belongs to', () => {
    const messages = [
      userMessage('an earlier question'),
      assistantMessage('an earlier answer'),
      userMessage('the message that got cut short'),
      userMessage('[SYSTEM_EVENT] [CHAT_ERROR] Stream aborted by client'),
    ];

    expect(findPrecedingUserTurn(messages, 3)?.text).toBe(
      'the message that got cut short',
    );
  });

  it('skips system-event markers stored with a user role', () => {
    const messages = [
      userMessage('the real question'),
      userMessage('[SYSTEM_EVENT] agent switched'),
      userMessage('[SYSTEM_EVENT] [CHAT_ERROR] Stream aborted by client'),
    ];

    expect(findPrecedingUserTurn(messages, 2)?.text).toBe('the real question');
  });

  it('reads text out of structured content parts', () => {
    const messages = [
      {
        role: 'user',
        content: '',
        contentParts: [{ type: 'text', content: 'from parts' }],
      } as unknown as ChatMessage,
      userMessage('[SYSTEM_EVENT] [CHAT_ERROR] boom'),
    ];

    expect(findPrecedingUserTurn(messages, 1)?.text).toBe('from parts');
  });

  it('returns empty when no user turn precedes the marker', () => {
    const messages = [
      userMessage('[SYSTEM_EVENT] [CHAT_ERROR] Stream aborted by client'),
    ];

    expect(findPrecedingUserTurn(messages, 0)).toBeNull();
  });

  // archive#1292: the writer (active-chats-state.ts) sets `ephemeral`, and
  // this reader must check the SAME field — it used to check the dead
  // `isEphemeral` field, which nothing ever wrote, so this skip never fired.
  it('skips an ephemeral notice stored with a user role', () => {
    const messages = [
      userMessage('the real question'),
      { ...userMessage('a dismissible notice'), ephemeral: true },
      userMessage('[SYSTEM_EVENT] [CHAT_ERROR] Stream aborted by client'),
    ];

    expect(findPrecedingUserTurn(messages, 2)?.text).toBe('the real question');
  });

  // The server persists the failed turn's `file` parts, so a resend that
  // carried only the text would silently drop an attachment the user had
  // added — recovering less than the button claims (archive#797).
  it('recovers attachments alongside the text', () => {
    const messages = [
      {
        role: 'user',
        content: '',
        contentParts: [
          { type: 'text', content: 'what is in this image?' },
          {
            type: 'file',
            url: 'data:image/png;base64,AAA',
            mediaType: 'image/png',
            name: 'shot.png',
          },
        ],
      } as unknown as ChatMessage,
      userMessage('[SYSTEM_EVENT] [CHAT_ERROR] Stream aborted by client'),
    ];

    const turn = findPrecedingUserTurn(messages, 1);

    expect(turn?.text).toBe('what is in this image?');
    expect(turn?.attachments).toHaveLength(1);
    expect(turn?.attachments[0]).toMatchObject({
      name: 'shot.png',
      type: 'image/png',
      data: 'data:image/png;base64,AAA',
    });
  });

  it('still offers a turn that was attachment-only, with no text', () => {
    const messages = [
      {
        role: 'user',
        content: '',
        contentParts: [
          {
            type: 'file',
            url: 'data:image/png;base64,BBB',
            mediaType: 'image/png',
          },
        ],
      } as unknown as ChatMessage,
      userMessage('[SYSTEM_EVENT] [CHAT_ERROR] Stream aborted by client'),
    ];

    const turn = findPrecedingUserTurn(messages, 1);

    expect(turn?.text).toBe('');
    expect(turn?.attachments).toHaveLength(1);
  });
});
