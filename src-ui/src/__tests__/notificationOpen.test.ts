import { describe, expect, test, vi } from 'vitest';
import {
  NOTIFICATION_OPEN_EVENT,
  type NotificationOpenDeps,
  notificationOpenTarget,
  subscribeToNotificationOpen,
} from '../lib/notificationOpen';

describe('notificationOpenTarget (#2608)', () => {
  test('accepts in-app paths and splits the query for the shell navigate', () => {
    expect(notificationOpenTarget('/?surface=activity&session=s-1')).toEqual({
      pathname: '/',
      params: { surface: 'activity', session: 's-1' },
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

describe('subscribeToNotificationOpen (#2608)', () => {
  test('a click kept before subscription navigates once, then each event takes its own', async () => {
    const navigate = vi.fn();
    const { deps, fire } = fakeDeps([
      '/?surface=activity',
      'https://evil.example/',
      '/notifications',
    ]);
    const dispose = subscribeToNotificationOpen(
      navigate,
      Promise.resolve(deps),
    );
    await settle();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenLastCalledWith('/', { surface: 'activity' });
    fire(); // hostile link: dropped
    await settle();
    expect(navigate).toHaveBeenCalledTimes(1);
    fire();
    await settle();
    expect(navigate).toHaveBeenLastCalledWith('/notifications', {});
    fire(); // nothing pending
    await settle();
    expect(navigate).toHaveBeenCalledTimes(2);
    dispose();
  });

  test('disposal stops listening and navigating', async () => {
    const navigate = vi.fn();
    const { deps, unlisten } = fakeDeps(['/notifications']);
    const dispose = subscribeToNotificationOpen(
      navigate,
      Promise.resolve(deps),
    );
    dispose();
    await settle();
    expect(unlisten).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
