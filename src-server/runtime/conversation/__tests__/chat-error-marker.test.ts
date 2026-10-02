import { describe, expect, test } from 'vitest';
import {
  isOutwardSafeTurnFailureText,
  scrubChatErrorMarkers,
  scrubChatErrorMarkerText,
} from '../chat-error-marker.js';

const SECRET = 'sk-live-SECRET-1a2b3c';

describe('isOutwardSafeTurnFailureText', () => {
  test.each([
    'The response stream failed.',
    'Stream aborted by client',
    'The model provider rejected the credentials.',
    'The model provider returned an error (HTTP 500).',
    'The model provider rate-limited the request (HTTP 429).',
    'The model provider refused the request (HTTP 400).',
  ])('accepts %j', (text) => {
    expect(isOutwardSafeTurnFailureText(text)).toBe(true);
  });

  test.each([
    `upstream exploded ${SECRET}`,
    // Status-shaped, but not what the sentence for that status says.
    'The model provider returned an error (HTTP 404).',
    `The model provider ${SECRET} (HTTP 500).`,
    'The model provider returned an error (HTTP 302).',
    'The model provider returned an error (HTTP 500). ',
    '',
  ])('rejects %j', (text) => {
    expect(isOutwardSafeTurnFailureText(text)).toBe(false);
  });
});

describe('scrubChatErrorMarkers', () => {
  test('replaces only an unsafe uncoded marker, leaving every other message the same object', () => {
    const plain = {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
    };
    const assistant = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: `[SYSTEM_EVENT] [CHAT_ERROR] ${SECRET}` }],
    };
    const unsafe = {
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: `[SYSTEM_EVENT] [CHAT_ERROR] ${SECRET}` }],
      metadata: { timestamp: 1 },
    };
    const messages = [plain, assistant, unsafe];

    const scrubbed = scrubChatErrorMarkers(messages);

    expect(scrubbed[0]).toBe(plain);
    expect(scrubbed[1]).toBe(assistant);
    expect(scrubbed[2]).toEqual({
      ...unsafe,
      parts: [
        {
          type: 'text',
          text: '[SYSTEM_EVENT] [CHAT_ERROR] The response stream failed.',
        },
      ],
    });
    // Stored data is not modified.
    expect(unsafe.parts[0].text).toContain(SECRET);
  });

  test('returns the same array when nothing needs scrubbing', () => {
    const messages = [
      {
        id: 'm1',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: '[SYSTEM_EVENT] [CHAT_ERROR] The model provider timed out (HTTP 504).',
          },
        ],
      },
    ];
    expect(scrubChatErrorMarkers(messages)).toBe(messages);
  });

  test('a string content field is scrubbed too', () => {
    expect(
      scrubChatErrorMarkers([
        { role: 'user', content: `[SYSTEM_EVENT] [CHAT_ERROR] ${SECRET}` },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: '[SYSTEM_EVENT] [CHAT_ERROR] The response stream failed.',
      },
    ]);
  });

  test('non-marker text is untouched', () => {
    expect(scrubChatErrorMarkerText(`[SYSTEM_EVENT] ${SECRET}`)).toBe(
      `[SYSTEM_EVENT] ${SECRET}`,
    );
  });
});
