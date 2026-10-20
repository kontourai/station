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
  const fetch = vi.fn(async (_url: string, _init?: unknown) => undefined);
  runInNewContext(SOURCE, { self, URL, fetch, console });
  async function click(action: string, data: Record<string, unknown>) {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get('notificationclick')!({
      action,
      notification: { data, close: vi.fn() },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    return fetch.mock.calls.at(-1)?.[0];
  }
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
  return { tap, click };
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
    // Station's own origin, but not a page: a blob of this origin.
    `blob:${ORIGIN}/0f0e0d0c-0b0a-4908-8706-050403020100`,
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

describe('service worker notification actions', () => {
  test('an action request goes to Station with its path segments encoded', async () => {
    const { click } = loadWorker(false);
    expect(await click('a/../../x', { notificationId: 'n/../1?y' })).toBe(
      `${ORIGIN}/notifications/n%2F..%2F1%3Fy/action/a%2F..%2F..%2Fx`,
    );
  });

  test.each([
    'https://evil.example',
    '//evil.example',
    `blob:${ORIGIN}/x`,
    'javascript:alert(1)',
  ])('a payload apiBase off Station (%j) is not used', async (apiBase) => {
    const { click } = loadWorker(false);
    const sent = await click('allow', {
      approvalId: 'a-1',
      agentSlug: 'dev',
      apiBase,
    });
    expect(new URL(sent!).origin).toBe(ORIGIN);
    expect(sent).toBe(`${ORIGIN}/api/tools/approve`);
  });

  test('an apiBase on Station keeps its path', async () => {
    const { click } = loadWorker(false);
    expect(
      await click('allow', {
        approvalId: 'a-1',
        apiBase: `${ORIGIN}/station/`,
      }),
    ).toBe(`${ORIGIN}/station/api/tools/approve`);
  });
});
