/**
 * #3159: the page bounds and the reference parse of `read_conversation`.
 * The route's admission is proven through the real MCP boundary in
 * `runtime-routes-station-control-conversation-read.test.ts`.
 */
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { describe, expect, test } from 'vitest';
import {
  parseConversationReferenceIds,
  readConversationPage,
} from '../conversation-reference-read.js';
import {
  READ_CONVERSATION_MAX_LIMIT,
  READ_CONVERSATION_MESSAGE_TEXT_MAX_BYTES,
  READ_CONVERSATION_PAGE_MAX_BYTES,
} from '../conversation-reference-read-limits.js';

const message = (index: number, text: string): ConversationMessage => ({
  id: `m${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  parts: [{ type: 'text', text }],
});

describe('read_conversation bounds', () => {
  test('the bounds are the literals the issue names', () => {
    expect(READ_CONVERSATION_MAX_LIMIT).toBe(50);
    expect(READ_CONVERSATION_PAGE_MAX_BYTES).toBe(65_536);
  });

  test('a page never exceeds the byte cap, and paging still covers every message once', () => {
    // 15 KB each: four fit a page, so a limit of 50 is cut by bytes.
    const messages = Array.from({ length: 11 }, (_, index) =>
      message(index, `${index}:`.padEnd(15 * 1024, 'x')),
    );
    const seen: number[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const page = readConversationPage(messages, offset, 50);
      expect(
        Buffer.byteLength(JSON.stringify(page.messages), 'utf8'),
      ).toBeLessThanOrEqual(READ_CONVERSATION_PAGE_MAX_BYTES);
      expect(page.messages.length).toBeGreaterThan(0);
      seen.push(...page.messages.map((entry) => entry.index));
      offset = page.nextOffset;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(messages.map((_, index) => index));
  });

  test('one oversized message is clipped and says so, so a page always advances', () => {
    const huge = 'é'.repeat(100_000);
    const page = readConversationPage([message(0, huge)], 0, 1);
    const [only] = page.messages;
    expect(only!.textTruncated).toEqual({
      originalBytes: Buffer.byteLength(huge, 'utf8'),
    });
    expect(Buffer.byteLength(only!.text, 'utf8')).toBeLessThanOrEqual(
      READ_CONVERSATION_MESSAGE_TEXT_MAX_BYTES,
    );
    expect(only!.text).not.toContain('�');
    expect(page.nextOffset).toBeUndefined();
  });
});

describe('parseConversationReferenceIds', () => {
  test('reads exactly the link the composer writes, decoded', () => {
    expect(
      parseConversationReferenceIds(
        'See [A chat](/activity?session=conv%3A1) and [B](/activity?session=conv-2).',
      ),
    ).toEqual(['conv:1', 'conv-2']);
  });

  test('matches identities, not prefixes or bare URLs', () => {
    const ids = parseConversationReferenceIds(
      '[x](/activity?session=abcd) /activity?session=bare [y](/activity?session=%E0%A4%A)',
    );
    expect(ids).toEqual(['abcd']);
    expect(ids).not.toContain('abc');
  });
});

describe('read_conversation bounds hold on the serialized bytes', () => {
  test('control characters (six bytes each once escaped) cannot push a page over the cap', () => {
    // 20,000 ESC characters: 20 KB raw, about 120 KB once JSON-escaped.
    const escapes = '\u001b'.repeat(20_000);
    const messages = Array.from({ length: 6 }, (_, index) =>
      message(index, escapes),
    );
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = readConversationPage(messages, offset, 50);
      expect(
        Buffer.byteLength(JSON.stringify(page.messages), 'utf8'),
      ).toBeLessThanOrEqual(READ_CONVERSATION_PAGE_MAX_BYTES);
      for (const entry of page.messages) {
        expect(
          Buffer.byteLength(JSON.stringify(entry.text), 'utf8'),
        ).toBeLessThanOrEqual(READ_CONVERSATION_MESSAGE_TEXT_MAX_BYTES);
        expect(entry.textTruncated).toEqual({ originalBytes: 20_000 });
      }
      seen.push(...page.messages.map((entry) => entry.index));
      offset = page.nextOffset;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('tool names are bounded serialized too', () => {
    const page = readConversationPage(
      [
        {
          id: 'm0',
          role: 'assistant',
          parts: Array.from({ length: 40 }, (_, index) => ({
            type: 'tool-call',
            toolName: `${index}${'\u0001'.repeat(5_000)}`,
          })),
        },
      ],
      0,
      1,
    );
    expect(
      Buffer.byteLength(JSON.stringify(page.messages), 'utf8'),
    ).toBeLessThanOrEqual(READ_CONVERSATION_PAGE_MAX_BYTES);
  });
});
