/**
 * The Web Push service worker's tap (`public/sw.js`), run as the browser
 * runs it: the file evaluated in its own global scope with a `self` that
 * records what the tap navigates to or opens. A tap must land on Station's
 * own origin whatever URL the payload carries.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

const ORIGIN = 'https://station.test';
const SOURCE = readFileSync(
  join(__dirname, '..', '..', 'public', 'sw.js'),
  'utf8',
);

function loadWorker(existingWindow: boolean) {
  const handlers = new Map<string, (event: unknown) => void>();
  const navigate = vi.fn(async (_url: string) => undefined);
  const openWindow = vi.fn(async (_url: string) => undefined);
  const client = { focus: vi.fn(async () => undefined), navigate };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      handlers.set(type, handler),
    clients: {
      matchAll: async () => (existingWindow ? [client] : []),
      openWindow,
      claim: async () => undefined,
    },
    registration: { showNotification: async () => undefined },
    skipWaiting: () => undefined,
  };
  runInNewContext(SOURCE, { self, URL, fetch: vi.fn(), console });
  async function tap(url: unknown) {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get('notificationclick')!({
      action: '',
      notification: { data: { notificationId: 'n-1', url }, close: vi.fn() },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    return (existingWindow ? navigate : openWindow).mock.calls.at(-1)?.[0];
  }
  return { tap };
}

describe('service worker notification tap', () => {
  test.each([true, false])(
    'a Station link opens on Station (existing window: %s)',
    async (existing) => {
      const { tap } = loadWorker(existing);
      expect(await tap('/projects/web?openedNotification=n-1')).toBe(
        `${ORIGIN}/projects/web?openedNotification=n-1`,
      );
    },
  );

  test.each([
    '//evil.example/phish',
    '/..//evil.example/phish',
    '/%2e%2e//evil.example/phish',
    '/\\evil.example/phish',
    'https://evil.example/phish',
    'javascript:alert(1)',
  ])('a payload URL off Station (%j) opens the inbox instead', async (url) => {
    for (const existing of [true, false]) {
      const { tap } = loadWorker(existing);
      const opened = await tap(url);
      expect(opened).toBe(`${ORIGIN}/notifications`);
      expect(new URL(opened!).origin).toBe(ORIGIN);
    }
  });

  // Same scheme, no slashes: URL resolution treats it as a relative path,
  // so it stays on Station (a browser resolves it the same way).
  test('a scheme-relative "https:host" path stays on Station', async () => {
    const { tap } = loadWorker(false);
    expect(new URL((await tap('https:evil.example/phish'))!).origin).toBe(
      ORIGIN,
    );
  });

  test('no URL opens the inbox', async () => {
    const { tap } = loadWorker(false);
    expect(await tap(undefined)).toBe(`${ORIGIN}/notifications`);
  });
});
