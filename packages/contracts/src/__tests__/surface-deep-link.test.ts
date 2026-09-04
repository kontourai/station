import { describe, expect, test } from 'vitest';
import { activityDeepLink, surfaceDeepLink } from '../surface-deep-link.js';

describe('Activity surface deep links', () => {
  test('builds and encodes Activity session ids', () => {
    expect(activityDeepLink({ sessionId: 'thread/alpha' })).toBe(
      '/?surface=activity&session=thread%2Falpha',
    );
    expect(activityDeepLink({ sessionId: 'a b' })).toBe(
      '/?surface=activity&session=a%20b',
    );
    expect(activityDeepLink({ sessionId: 'x&y=z' })).toBe(
      '/?surface=activity&session=x%26y%3Dz',
    );
    expect(activityDeepLink({ focus: 'evidence' })).toBe('/?surface=activity');
  });

  test('builds arbitrary encoded surface ids', () => {
    expect(surfaceDeepLink({ surfaceId: 'work queue/next' })).toBe(
      '/?surface=work%20queue%2Fnext',
    );
  });
});
