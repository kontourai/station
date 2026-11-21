import {
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES,
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGES,
  PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES,
  PEER_CONVERSATION_HANDOFF_MAX_TEXT_BYTES,
} from '@kontourai/station-contracts/peer-chat';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { describe, expect, test } from 'vitest';
import { boundTranscriptSeedLabel } from '../../orchestration/conversation-transcript-seed.js';
import {
  boundLabelKeepingTail,
  cleanLabel,
} from '../../orchestration/quoted-text.js';
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

  test('bounds a long origin chain by keeping its last, verified hop', () => {
    const chain = `${'A'.repeat(115)}, via Studio Mac`;
    const [message] = boundCarriedMessages([
      {
        id: 'chained',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
        metadata: { importedFrom: chain },
      } as ConversationMessage,
    ]).messages;
    expect(message!.importedFrom!.endsWith(', via Studio Mac')).toBe(true);
    expect(message!.importedFrom!.startsWith('…')).toBe(true);
    expect([...message!.importedFrom!].length).toBeLessThanOrEqual(120);
  });

  test.each([
    ['ARABIC LETTER MARK', '\u061C'],
    ['a stray tag character', String.fromCodePoint(0xe0041)],
    ['SOFT HYPHEN', '\u00AD'],
    ['COMBINING GRAPHEME JOINER', '\u034F'],
    ['MONGOLIAN VOWEL SEPARATOR', '\u180E'],
    ['INTERLINEAR ANNOTATION ANCHOR', '\uFFF9'],
    ['INTERLINEAR ANNOTATION TERMINATOR', '\uFFFB'],
    ['HANGUL CHOSEONG FILLER', '\u115F'],
    ['HANGUL JUNGSEONG FILLER', '\u1160'],
    ['HANGUL FILLER', '\u3164'],
    ['HALFWIDTH HANGUL FILLER', '\uFFA0'],
    ['LEFT-TO-RIGHT EMBEDDING', '\u202A'],
    ['RIGHT-TO-LEFT OVERRIDE', '\u202E'],
    ['LEFT-TO-RIGHT ISOLATE', '\u2066'],
    ['POP DIRECTIONAL ISOLATE', '\u2069'],
    ['ZERO WIDTH SPACE', '\u200B'],
    ['ESCAPE (a control character)', '\u001b'],
    ['BELL (a control character)', '\u0007'],
  ])('a label is cleaned of %s', (_name, character) => {
    expect(cleanLabel(`La${character}ptop`)).toBe('Laptop');
    expect(cleanLabel(`${character}${character}`)).toBe('');
  });

  test.each([
    ['Persian with a zero-width non-joiner', 'می\u200Cخواهم'],
    ['Devanagari with a zero-width joiner', 'क्\u200Dष'],
    ['an emoji ZWJ family', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
    ['an emoji presentation selector', '\u2764\uFE0F'],
    ['a keycap', '1\uFE0F\u20E3'],
    [
      'the Scotland flag (an emoji tag sequence)',
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
    ],
    ['Hebrew with a right-to-left mark', 'שלום\u200F 2'],
  ])('a real name keeps its joiners and marks: %s', (_name, label) => {
    expect(cleanLabel(label)).toBe(label);
  });

  test('refuses a label made only of joiners, selectors or weak marks', () => {
    expect(cleanLabel('\u200D\u200C\uFE0F\u200E\u200F ')).toBe('');
  });

  test('bounds a seed label on grapheme boundaries', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    for (let maxBytes = 30; maxBytes < 80; maxBytes++) {
      const bounded = boundTranscriptSeedLabel(family.repeat(20), maxBytes);
      expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(maxBytes);
      expect(bounded.endsWith('…')).toBe(true);
      expect(bounded.slice(0, -1).replaceAll(family, '')).toBe('');
    }
  });

  test.each([
    ['emoji ZWJ sequences', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
    ['regional-indicator flags', '\u{1F1EB}\u{1F1F7}'],
    ['combining marks', 'e\u0301'],
  ])('a bounded label never splits %s', (_name, grapheme) => {
    const segments = (text: string) => [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
        text,
      ),
    ];
    const label = `${grapheme.repeat(60)}, via Studio Mac`;
    for (let max = 20; max < 60; max++) {
      const bounded = boundLabelKeepingTail(
        label,
        (candidate) => [...candidate].length <= max,
      );
      expect(bounded.endsWith(', via Studio Mac')).toBe(true);
      const kept = segments(bounded.slice(1))
        .map((segment) => segment.segment)
        .filter((segment) => segment.length > 1 || !/[ ,a-zA-Z]/.test(segment));
      expect(
        kept.every((segment) => segment === grapheme),
        `max ${max}`,
      ).toBe(true);
    }
  });
});
