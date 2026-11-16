import {
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES,
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGES,
  PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES,
  PEER_CONVERSATION_HANDOFF_MAX_TEXT_BYTES,
} from '@kontourai/station-contracts/peer-chat';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { describe, expect, test } from 'vitest';
import {
  boundCarriedMessages,
  conversationImportRequestSchema,
  encodedTextBytes,
  encodeImportRequest,
} from '../peer-conversation-handoff.js';

const text = (id: string, body: string, role: 'user' | 'assistant' = 'user') =>
  ({ id, role, parts: [{ type: 'text', text: body }] }) as ConversationMessage;

describe('the history a paired-Station handoff carries', () => {
  test('keeps the newest messages within the count bound and counts the rest', () => {
    const messages = Array.from(
      { length: PEER_CONVERSATION_HANDOFF_MAX_MESSAGES + 3 },
      (_, index) => text(`m${index}`, `message ${index}`),
    );
    const carried = boundCarriedMessages(messages);
    expect(PEER_CONVERSATION_HANDOFF_MAX_MESSAGES).toBe(400);
    expect(carried.messages).toHaveLength(400);
    expect(carried.omittedMessages).toBe(3);
    expect(carried.messages[0]!.id).toBe('m3');
    expect(carried.messages.at(-1)!.id).toBe(`m${messages.length - 1}`);
  });

  test('stops at the total byte bound, newest first, and never exceeds it', () => {
    const chunk = 'y'.repeat(PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES - 10);
    const count =
      Math.floor(PEER_CONVERSATION_HANDOFF_MAX_TEXT_BYTES / chunk.length) + 2;
    const carried = boundCarriedMessages(
      Array.from({ length: count }, (_, index) => text(`m${index}`, chunk)),
    );
    const bytes = carried.messages.reduce(
      (total, message) => total + Buffer.byteLength(message.text),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(PEER_CONVERSATION_HANDOFF_MAX_TEXT_BYTES);
    expect(carried.omittedMessages).toBe(count - carried.messages.length);
    expect(carried.omittedMessages).toBeGreaterThan(0);
    expect(carried.messages.at(-1)!.id).toBe(`m${count - 1}`);
  });

  test('cuts one oversized message to its bound with a visible marker, keeping both ends', () => {
    const big = `HEAD-${'z'.repeat(PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES * 2)}-TAIL`;
    const carried = boundCarriedMessages([text('big', big)]);
    const [kept] = carried.messages;
    expect(carried.shortenedMessages).toBe(1);
    expect(Buffer.byteLength(kept!.text)).toBeLessThanOrEqual(
      PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES,
    );
    expect(kept!.text.startsWith('HEAD-')).toBe(true);
    expect(kept!.text.endsWith('-TAIL')).toBe(true);
    expect(kept!.text).toMatch(/characters left out of this message/);
    // What it sends, the receiver accepts.
    expect(
      conversationImportRequestSchema.safeParse({
        version: 1,
        idempotencyKey: 'k',
        source: {
          conversationId: 'c',
          title: '',
          agent: 'a',
        },
        ...carried,
      }).success,
    ).toBe(true);
  });

  test('carries only user and assistant text, counting rows without any', () => {
    const carried = boundCarriedMessages([
      text('u', 'question'),
      {
        id: 'tool',
        role: 'assistant',
        parts: [{ type: 'tool-call' }],
      } as never,
      { id: 'sys', role: 'system', parts: [{ type: 'text', text: 'hidden' }] },
      text('a', 'answer', 'assistant'),
    ]);
    expect(carried.messages).toEqual([
      { id: 'u', role: 'user', text: 'question' },
      { id: 'a', role: 'assistant', text: 'answer' },
    ]);
    expect(carried.nonTextMessages).toBe(1);
  });

  test('counts JSON escapes: a control character costs six bytes against every bound', () => {
    expect(encodedTextBytes('\u0001')).toBe(6);
    const carried = boundCarriedMessages([
      text('esc', '\u0001'.repeat(PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES)),
    ]);
    expect(carried.shortenedMessages).toBe(1);
    expect(encodedTextBytes(carried.messages[0]!.text)).toBeLessThanOrEqual(
      PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES,
    );
  });

  test('refuses an encoded request one byte over its ceiling and sends one exactly at it', () => {
    const request = {
      version: 1 as const,
      idempotencyKey: 'k',
      source: { conversationId: 'c', title: '', agent: 'a' },
      messages: [{ id: 'm', role: 'user' as const, text: 'hello' }],
      omittedMessages: 0,
      nonTextMessages: 0,
      shortenedMessages: 0,
    };
    const size = Buffer.byteLength(JSON.stringify(request), 'utf8');
    expect(encodeImportRequest(request, size)).toBe(JSON.stringify(request));
    expect(encodeImportRequest(request, size - 1)).toBeNull();
    expect(PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES).toBe(768 * 1024);
  });

  test('re-exports rows another Station sent unquoted, keeping where they came from', () => {
    const carried = boundCarriedMessages([
      {
        id: 'from-laptop',
        role: 'user',
        parts: [{ type: 'text', text: 'hello\nworld' }],
        metadata: { importedFrom: 'Laptop' },
      } as ConversationMessage,
      text('own', 'mine'),
    ]);
    expect(carried.messages).toEqual([
      {
        id: 'from-laptop',
        role: 'user',
        text: 'hello\nworld',
        importedFrom: 'Laptop',
      },
      { id: 'own', role: 'user', text: 'mine' },
    ]);
  });
});
