import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { describe, expect, test } from 'vitest';
import {
  resolveNotificationOpenHref,
  withOpenedNotification,
} from '../notification-deep-link.js';

describe('resolveNotificationOpenHref', () => {
  test('prefers a project-scoped chat link when projectSlug + sessionId resolve', () => {
    expect(
      resolveNotificationOpenHref(
        { projectSlug: 'my project' },
        'thread-1',
        'runtime',
      ),
      // archive#1284 (AC4): dock=open so the deep link actually opens the
      // chat dock, not just the project layout.
    ).toBe('/projects/my%20project?chat=thread-1&dock=open');
  });

  test('falls back to Activity for a runtime session with no project', () => {
    // Activity is not a dock target — no dock=open here (archive#1284).
    expect(resolveNotificationOpenHref({}, 'thread/one', 'runtime')).toBe(
      activityDeepLink({ sessionId: 'thread/one' }),
    );
  });

  test('falls back to the root chat route for a managed session with no project', () => {
    // archive#1284 (AC4): dock=open — the root route's dock is the target.
    expect(resolveNotificationOpenHref({}, 'session-1', 'managed')).toBe(
      '/?chat=session-1&dock=open',
    );
  });

  test('resolves undefined when there is no sessionId at all', () => {
    expect(
      resolveNotificationOpenHref({}, undefined, 'runtime'),
    ).toBeUndefined();
  });

  test('resolves undefined when sessionKind is unrecognized and there is no project', () => {
    expect(
      resolveNotificationOpenHref({}, 'session-1', 'unknown-kind'),
    ).toBeUndefined();
  });

  test('tolerates undefined metadata entirely', () => {
    expect(resolveNotificationOpenHref(undefined, 'session-1', 'managed')).toBe(
      '/?chat=session-1&dock=open',
    );
  });

  describe('metadata.link fallback (station#1100 review fix MEDIUM)', () => {
    test('falls back to a valid relative metadata.link when no session resolves (e.g. a scheduled job failure)', () => {
      expect(
        resolveNotificationOpenHref({
          link: '/schedule?job=nightly-sync',
        }),
      ).toBe('/schedule?job=nightly-sync');
    });

    test('a session-resolvable notification never falls through to metadata.link', () => {
      expect(
        resolveNotificationOpenHref(
          { link: '/schedule?job=nightly-sync' },
          'session-1',
          'managed',
        ),
      ).toBe('/?chat=session-1&dock=open');
    });

    test('rejects a protocol-relative link ("//host/...") as an external-origin bypass', () => {
      expect(
        resolveNotificationOpenHref({ link: '//evil.example/phish' }),
      ).toBeUndefined();
    });

    test('rejects a backslash-prefixed link (browser-normalized to protocol-relative)', () => {
      expect(
        resolveNotificationOpenHref({ link: '/\\evil.example/phish' }),
      ).toBeUndefined();
    });

    test('rejects an absolute/external URL', () => {
      expect(
        resolveNotificationOpenHref({ link: 'https://evil.example/phish' }),
      ).toBeUndefined();
    });

    test('rejects a non-string link', () => {
      expect(resolveNotificationOpenHref({ link: 42 })).toBeUndefined();
    });
  });
});

describe('withOpenedNotification never leaves Station', () => {
  const origin = 'https://station.test';
  test.each([
    '/..//evil.example/phish',
    '/%2e%2e//evil.example/phish',
    '/%2E%2e//evil.example/phish',
    '/.//evil.example/phish',
    '/x/../..//evil.example/phish',
    '//evil.example/phish',
    '///evil.example/phish',
    '/\\evil.example/phish',
    'https://evil.example/phish',
    'https:evil.example/phish',
    'evil.example/phish',
  ])('%j opens the inbox on Station instead', (href) => {
    const link = withOpenedNotification(href, 'n-1');
    expect(link).toBe('/notifications?openedNotification=n-1');
    const opened = new URL(link, `${origin}/`);
    expect(opened.origin).toBe(origin);
  });

  test('a Station link keeps its query as written and its fragment', () => {
    expect(withOpenedNotification('/schedule?job=a%20b&x=1#logs', 'n-1')).toBe(
      '/schedule?job=a%20b&x=1&openedNotification=n-1#logs',
    );
  });

  test('a record id already in the link is replaced, never trusted', () => {
    const link = withOpenedNotification(
      '/notifications?openedNotification=victim',
      'n-1',
    );
    expect(
      new URL(link, `${origin}/`).searchParams.getAll('openedNotification'),
    ).toEqual(['n-1']);
  });

  test('a hostile stored metadata.link (not admitted by the gate) still pushes a Station link', () => {
    expect(
      resolveNotificationOpenHref({ link: '/..//evil.example/phish' }),
    ).toBeUndefined();
    expect(
      resolveNotificationOpenHref({ link: '/%2e%2e//evil.example' }),
    ).toBeUndefined();
    expect(resolveNotificationOpenHref({ link: '/schedule?job=a' })).toBe(
      '/schedule?job=a',
    );
  });
});
