/** @vitest-environment jsdom */
import { beforeEach, expect, test, vi } from 'vitest';
import type { SavedAnswerQuote } from '../utils/answer-quotes';
import {
  composeQuotedReply,
  parseSavedAnswerQuote,
  quoteFromHref,
  quoteHref,
  quoteMatchesSource,
} from '../utils/answer-quotes';

const quote: SavedAnswerQuote = {
  version: 1,
  origin: 'http://station.test',
  sessionId: 'session-a',
  turnId: 'turn-a',
  messageId: 'answer-a',
  revision: 'a'.repeat(64),
  excerpt: 'Selected **text**\n![bad](https://invalid.test/image)',
};

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

test('serializes a source link and inert user-selected text without changing typed context', () => {
  const output = composeQuotedReply('Keep my draft', [quote]);
  expect(output.startsWith('Keep my draft\n\n')).toBe(true);
  expect(output).toContain('> Selected \\*\\*text\\*\\*');
  expect(output).not.toContain('> ![bad]');
  expect(quoteFromHref(quoteHref(quote))).toEqual(quote);
  expect(composeQuotedReply('untouched', [])).toBe('untouched');
});

test('rejects executable origins, credentials, oversized excerpts and malformed references', () => {
  for (const origin of [
    'javascript:alert(1)',
    'https://user:password@station.test',
    'https://station.test?token=private',
  ])
    expect(parseSavedAnswerQuote({ ...quote, origin })).toBeNull();
  expect(
    parseSavedAnswerQuote({ ...quote, excerpt: 'x'.repeat(4097) }),
  ).toBeNull();
  expect(quoteFromHref('#station-quote=%invalid')).toBeNull();
});

test('requires the original Session, turn, message and text revision when comparing a source', () => {
  const source = {
    version: 1 as const,
    sessionId: quote.sessionId,
    turnId: quote.turnId,
    messageId: quote.messageId,
    revision: quote.revision,
    text: 'not a trust claim',
  };
  expect(quoteMatchesSource(quote, source)).toBe(true);
  for (const key of ['sessionId', 'turnId', 'messageId', 'revision'])
    expect(quoteMatchesSource(quote, { ...source, [key]: 'different' })).toBe(
      false,
    );
});

test('draft quotes survive text edits and reload, and removal does not change words', async () => {
  const { chatDraftsStore: store } = await import(
    '../contexts/chat-drafts-store'
  );
  store.set('reply-a', 'existing words');
  store.addQuote('reply-a', quote);
  store.set('reply-a', 'edited words');
  expect(store.getQuotes('reply-a')).toEqual([quote]);
  vi.resetModules();
  const { chatDraftsStore: restored } = await import(
    '../contexts/chat-drafts-store'
  );
  expect(restored.get('reply-a')).toBe('edited words');
  expect(restored.getQuotes('reply-a')).toEqual([quote]);
  restored.removeQuote('reply-a', 0);
  expect(restored.get('reply-a')).toBe('edited words');
  expect(restored.getQuotes('reply-a')).toEqual([]);
});

test('consuming a sent quote preserves a new quote added while delivery was pending', async () => {
  const { chatDraftsStore: store } = await import(
    '../contexts/chat-drafts-store'
  );
  store.addQuote('reply-a', quote);
  const submitted = store.getQuotes('reply-a');
  const newer = { ...quote, excerpt: 'new user context' };
  store.addQuote('reply-a', newer);
  store.consumeQuotes('reply-a', submitted);
  expect(store.getQuotes('reply-a')).toEqual([newer]);
  expect(store.hasDraft('reply-a')).toBe(true);
  store.clear('reply-a');
  expect(store.getQuotes('reply-a')).toEqual([]);
});

test('quote-only drafts obey the existing store and per-draft budgets', async () => {
  const { chatDraftsStore: store } = await import(
    '../contexts/chat-drafts-store'
  );
  store.addQuote('first', quote);
  store.addQuote('first', quote);
  store.addQuote('first', quote);
  expect(() => store.addQuote('first', quote)).toThrow('three quotes');
  for (let n = 0; n < 30; n++) store.addQuote(`reply-${n}`, quote);
  expect(Object.keys(store.getSnapshot()).length).toBeLessThanOrEqual(20);
});

test('portable drafts retain quote metadata separately from the bounded plain-text field', async () => {
  const { chatDraftsStore: store } = await import(
    '../contexts/chat-drafts-store'
  );
  const words = 'x'.repeat(20_000);
  await store.stash('With source', words, [], undefined, [quote]);
  vi.resetModules();
  const { chatDraftsStore: reloaded } = await import(
    '../contexts/chat-drafts-store'
  );
  const draft = reloaded.getPortableSnapshot()[0];
  expect(draft.text).toBe(words);
  expect(draft.quotes).toEqual([quote]);
});
