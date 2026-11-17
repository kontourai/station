import { describe, expect, test, vi } from 'vitest';
import {
  NOTIFICATION_OPEN_EVENT,
  type NotificationOpenDeps,
  notificationOpenTarget,
  subscribeToNotificationOpen,
  takenNotificationOpen,
} from '../lib/notificationOpen';

describe('notificationOpenTarget (#2608)', () => {
  test('accepts in-app paths and splits the query for the shell navigate', () => {
    expect(notificationOpenTarget('/?surface=activity&session=s-1')).toEqual({
      pathname: '/',
      params: { surface: 'activity', session: 's-1' },
    });
    // The normalized path is what navigates.
    expect(notificationOpenTarget('/a/../b?x=1')).toEqual({
      pathname: '/b',
      params: { x: '1' },
    });
    expect(notificationOpenTarget('/notifications')).toEqual({
      pathname: '/notifications',
      params: {},
    });
  });

  test.each([
    'https://evil.example/',
    '//evil.example/x',
    '/\\evil.example',
    'javascript:alert(1)',
    'relative/path',
    '/a#frag',
    '/a b',
    '/a\nb',
    '/a\u0085b',
    '/a\u009fb',
    '/..//evil.example',
    '/.//evil.example',
    '/%2e%2e//evil.example',
    '/%2E%2E//evil.example/x?y=1',
    '',
    `/${'a'.repeat(2048)}`,
    42,
    null,
  ])('refuses %j', (link) => {
    expect(notificationOpenTarget(link)).toBeNull();
  });
});

function fakeDeps(links: unknown[]) {
  let handler: (() => void) | undefined;
  const unlisten = vi.fn();
  const deps: NotificationOpenDeps = {
    listen: vi.fn(async (event: string, h: () => void) => {
      expect(event).toBe(NOTIFICATION_OPEN_EVENT);
      handler = h;
      return unlisten;
    }),
    take: vi.fn(async () => links.shift() ?? null),
  };
  return { deps, fire: () => handler?.(), unlisten };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('takenNotificationOpen', () => {
  test('a host answer carries the link and the origin it read the alert from', () => {
    expect(
      takenNotificationOpen({
        link: '/?chat=s-1&dock=open&station=env-a',
        origin: 'https://a.example:3141',
      }),
    ).toEqual({
      pathname: '/',
      params: { chat: 's-1', dock: 'open' },
      stationId: 'env-a',
      origin: 'https://a.example:3141',
    });
  });

  test('an older host answers the bare link', () => {
    expect(takenNotificationOpen('/notifications')).toEqual({
      pathname: '/notifications',
      params: {},
    });
  });

  test('an origin that is not http(s) is dropped; a hostile link drops all', () => {
    expect(
      takenNotificationOpen({ link: '/x', origin: 'javascript:alert(1)' }),
    ).toEqual({ pathname: '/x', params: {} });
    expect(
      takenNotificationOpen({
        link: 'https://evil.example/',
        origin: 'https://a.example',
      }),
    ).toBeNull();
  });
});

describe('subscribeToNotificationOpen (#2608)', () => {
  test('a click kept before subscription navigates once, then each event takes its own', async () => {
    const open = vi.fn();
    const { deps, fire } = fakeDeps([
      '/?surface=activity',
      'https://evil.example/',
      '/notifications',
    ]);
    const dispose = subscribeToNotificationOpen(open, Promise.resolve(deps));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenLastCalledWith({
      pathname: '/',
      params: { surface: 'activity' },
    });
    fire(); // hostile link: dropped
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    fire();
    await settle();
    expect(open).toHaveBeenLastCalledWith({
      pathname: '/notifications',
      params: {},
    });
    fire(); // nothing pending
    await settle();
    expect(open).toHaveBeenCalledTimes(2);
    dispose();
  });

  test('disposal stops listening and navigating', async () => {
    const open = vi.fn();
    const { deps, unlisten } = fakeDeps(['/notifications']);
    const dispose = subscribeToNotificationOpen(open, Promise.resolve(deps));
    dispose();
    await settle();
    expect(unlisten).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
