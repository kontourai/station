import type { OrchestrationQuoteSource } from '@kontourai/station-contracts/orchestration';
import { afterEach, expect, test, vi } from 'vitest';
import { getAssistantQuoteSource } from '../client/quote-source';

afterEach(() => vi.unstubAllGlobals());
const source: OrchestrationQuoteSource = {
  version: 1,
  sessionId: 'session-a',
  turnId: 'turn-a',
  messageId: 'answer-a',
  text: 'Source text',
  revision: 'a'.repeat(64),
};

test('reads only the exact requested answer without reading another Session', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: source })),
    );
  vi.stubGlobal('fetch', fetch);
  await expect(
    getAssistantQuoteSource('http://station.test', 'session-a', 'turn-a'),
  ).resolves.toEqual(source);
  expect(String(fetch.mock.calls[0][0])).toContain(
    '/sessions/session-a/turns/turn-a/quote-source',
  );
});

test.each([
  { ...source, sessionId: 'other-session' },
  { ...source, turnId: 'other-turn' },
  { ...source, revision: 'unknown' },
  { ...source, messageId: '' },
  { ...source, text: 'x'.repeat(128 * 1024 + 1) },
])('rejects an invalid or misbound answer', async (data) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data }))),
  );
  await expect(
    getAssistantQuoteSource('http://station.test', 'session-a', 'turn-a'),
  ).rejects.toThrow();
});

test.each([403, 404, 413, 503])(
  'preserves refused source status %s without treating response prose as source text',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unavailable', { status })),
    );
    await expect(
      getAssistantQuoteSource('http://station.test', 'session-a', 'turn-a'),
    ).rejects.toMatchObject({ status });
  },
);
