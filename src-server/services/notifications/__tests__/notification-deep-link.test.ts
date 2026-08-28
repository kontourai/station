import { describe, expect, test } from 'vitest';
import { resolveNotificationOpenHref } from '../notification-deep-link.js';

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

  test('falls back to /activity for a runtime session with no project', () => {
    // /activity is not a dock target — no dock=open here (archive#1284).
    expect(resolveNotificationOpenHref({}, 'thread/one', 'runtime')).toBe(
      '/activity?session=thread%2Fone',
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
