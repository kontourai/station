import { describe, expect, test } from 'vitest';
import { APP_DESTINATION_REGISTRY } from '../app-shell/destination-registry';
import {
  getLegacyPathRedirect,
  resolveViewFromPath,
} from '../app-shell/routing';

describe('retired Activity compatibility', () => {
  test('Activity is absent from sidebar, palette and destination registry', () => {
    expect(APP_DESTINATION_REGISTRY.get('activity')).toBeNull();
    expect(
      APP_DESTINATION_REGISTRY.getSidebar().map((entry) => entry.id),
    ).not.toContain('activity');
    expect(
      APP_DESTINATION_REGISTRY.getPalette().map((entry) => entry.id),
    ).not.toContain('activity');
  });
  test.each(['/activity', '/sessions'])(
    'old %s links open Chat and keep notification and dock state',
    (path) => {
      const result = getLegacyPathRedirect(
        `${path}?session=thread-1&openedNotification=n1&dock=open&chat=c1`,
      );
      const url = new URL(result!, 'https://station.test');
      expect(url.pathname).toBe('/');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        surface: 'chat',
        session: 'thread-1',
        openedNotification: 'n1',
        dock: 'open',
        chat: 'c1',
      });
      expect(resolveViewFromPath(result!)).toEqual({ type: 'home' });
    },
  );
  test('a project-scoped legacy notification stays on its project', () => {
    const result = getLegacyPathRedirect(
      '/projects/demo?surface=activity&session=t&openedNotification=n',
    );
    expect(result).toBe(
      '/projects/demo?surface=chat&session=t&openedNotification=n',
    );
  });
});
