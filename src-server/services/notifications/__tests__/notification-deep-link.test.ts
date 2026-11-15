import type { NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import { describe, expect, test } from 'vitest';
import {
  notificationOpenLink,
  resolveNotificationOpenHref,
  resolveNotificationTarget,
  withOpenedNotification,
} from '../notification-deep-link.js';
import { nativeSessionReference } from '../notification-session.js';

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

  test('opens a runtime session with no project in the dock, like a managed one', () => {
    // One href for every session kind; the dock resolves the id.
    expect(resolveNotificationOpenHref({}, 'thread/one', 'runtime')).toBe(
      '/?chat=thread%2Fone&dock=open',
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

  // The fragment is dropped: no Station link carries one, and the desktop
  // host refuses a link with '#' (it would open nothing).
  test('a Station link keeps its query as written and loses any fragment', () => {
    expect(withOpenedNotification('/schedule?job=a%20b&x=1#logs', 'n-1')).toBe(
      '/schedule?job=a%20b&x=1&openedNotification=n-1',
    );
    expect(
      withOpenedNotification(
        `/x#station-ui-bootstrap=${'A'.repeat(40)}`,
        'n-1',
      ),
    ).toBe('/x?openedNotification=n-1');
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
    // A stored link that names a record (only the OS-alert builder may) or
    // carries a fragment is not a Station link.
    expect(
      resolveNotificationOpenHref({
        link: '/notifications?openedNotification=victim',
      }),
    ).toBeUndefined();
    expect(
      resolveNotificationOpenHref({
        link: '/x?a=1&opened%4Eotification=victim',
      }),
    ).toBeUndefined();
    expect(
      resolveNotificationOpenHref({
        link: `/x#station-ui-bootstrap=${'A'.repeat(40)}`,
      }),
    ).toBeUndefined();
  });
});

describe('the open link names the sending Station', () => {
  const origin = 'https://station.test';
  test('a Station id is added, and one already in the link is replaced', () => {
    const link = withOpenedNotification(
      '/schedule?job=a&station=env-victim',
      'n-1',
      'env-a',
    );
    const url = new URL(link, `${origin}/`);
    expect(url.pathname).toBe('/schedule');
    expect(url.searchParams.getAll('station')).toEqual(['env-a']);
    expect(url.searchParams.get('job')).toBe('a');
    expect(url.searchParams.get('openedNotification')).toBe('n-1');
  });

  test('a forged Station id is dropped even when this Station has none to add', () => {
    const link = withOpenedNotification('/x?station=env-victim', 'n-1');
    expect(link).toBe('/x?openedNotification=n-1');
  });

  test.each(['', ' env', 'env/a', '../a', 'a'.repeat(129)])(
    'an id outside the grammar (%j) is left out',
    (stationId) => {
      expect(withOpenedNotification('/x', 'n-1', stationId)).toBe(
        '/x?openedNotification=n-1',
      );
    },
  );
});

describe('resolveNotificationTarget: one target for every channel', () => {
  const envelope = (
    fields: Partial<NotificationEnvelopeV1>,
  ): NotificationEnvelopeV1 =>
    ({
      v: 1,
      source: { kind: 'system', subsystem: 'test' },
      audience: { kind: 'owner' },
      urgency: 'info',
      ...fields,
    }) as NotificationEnvelopeV1;

  test('a path target wins over the metadata session', () => {
    expect(
      resolveNotificationTarget(
        { metadata: { sessionId: 's-1', sessionKind: 'managed' } },
        envelope({ target: { kind: 'path', path: '/automations?job=a' } }),
      ),
    ).toBe('/automations?job=a');
  });

  test('a session target opens that session, in the Project the metadata names', () => {
    expect(
      resolveNotificationTarget(
        { metadata: { projectSlug: 'alpha' } },
        envelope({ target: { kind: 'session', sessionId: 's-1' } }),
      ),
    ).toBe('/projects/alpha?chat=s-1&dock=open');
  });

  test('the metadata session wins, as it does for the read gate and the phones', () => {
    // `notificationSessionIdentity`: the session the audience was checked
    // against is the one a tap opens, on every channel.
    expect(
      resolveNotificationTarget(
        { metadata: { sessionId: 's-other', projectSlug: 'alpha' } },
        envelope({ target: { kind: 'session', sessionId: 's-1' } }),
      ),
    ).toBe('/projects/alpha?chat=s-other&dock=open');
    expect(
      nativeSessionReference(
        { metadata: { sessionId: 's-other', projectSlug: 'alpha' } },
        envelope({ target: { kind: 'session', sessionId: 's-1' } }),
      ),
    ).toEqual({ session_id: 's-other', project_slug: 'alpha' });
  });

  test("an agent's record with no target opens the agent's session (design §2)", () => {
    expect(
      resolveNotificationTarget(
        { metadata: {} },
        envelope({
          source: { kind: 'agent', sessionId: 'agent-session' },
        } as Partial<NotificationEnvelopeV1>),
      ),
    ).toBe('/?chat=agent-session&dock=open');
  });

  test('nothing to open: the inbox, still naming the Station', () => {
    expect(
      notificationOpenLink(
        {
          id: 'n-1',
          metadata: {},
        } as unknown as Parameters<typeof notificationOpenLink>[0],
        'env-a',
      ),
    ).toBe('/notifications?openedNotification=n-1&station=env-a');
  });
});
