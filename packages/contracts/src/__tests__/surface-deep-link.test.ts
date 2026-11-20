import { describe, expect, test } from 'vitest';
import { activityDeepLink, surfaceDeepLink } from '../surface-deep-link.js';

describe('Activity surface deep links', () => {
  test('builds and encodes Activity session ids', () => {
    expect(activityDeepLink({ sessionId: 'thread/alpha' })).toBe(
      '/?surface=chat&session=thread%2Falpha',
    );
    expect(activityDeepLink({ sessionId: 'a b' })).toBe(
      '/?surface=chat&session=a%20b',
    );
    expect(activityDeepLink({ sessionId: 'x&y=z' })).toBe(
      '/?surface=chat&session=x%26y%3Dz',
    );
    expect(activityDeepLink({ focus: 'evidence' })).toBe('/notifications');
    expect(
      activityDeepLink({
        messageAnchor: { direction: 'sent', requestKey: 'k' },
      }),
    ).toBe('/notifications');
    expect(
      activityDeepLink({
        sessionId: 's',
        messageAnchor: { direction: 'sent', requestKey: 'x'.repeat(129) },
      }),
    ).toBe('/?surface=chat&session=s');
    expect(
      activityDeepLink({
        sessionId: 'sender',
        messageAnchor: { direction: 'sent', requestKey: 'key / & 1' },
      }),
    ).toBe(
      '/?surface=chat&session=sender&messageSession=sender&messageDirection=sent&messageRequest=key+%2F+%26+1',
    );
  });

  test('builds arbitrary encoded surface ids', () => {
    expect(surfaceDeepLink({ surfaceId: 'work queue/next' })).toBe(
      '/?surface=work%20queue%2Fnext',
    );
  });
});

test('a delegated child URL preserves both parent and child session identity', () => {
  expect(
    surfaceDeepLink({
      surfaceId: 'chat',
      sessionId: 'parent',
      childSessionId: 'child/one',
      childTitle: 'Review',
    }),
  ).toBe(
    '/?surface=chat&session=parent&childSession=child%2Fone&childTitle=Review',
  );
});
