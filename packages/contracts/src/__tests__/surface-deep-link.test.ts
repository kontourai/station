import { describe, expect, test } from 'vitest';
import {
  ACTIVITY_SURFACE_ID,
  type ActivityDeepLinkIntent,
  activityDeepLink,
  clearSurfaceDeepLinkParams,
  parseSurfaceDeepLink,
} from '../surface-deep-link.js';

function roundTrip(intent: ActivityDeepLinkIntent = {}) {
  const search = activityDeepLink(intent).split('?')[1];
  return parseSurfaceDeepLink(new URLSearchParams(search));
}

describe('Activity surface deep links', () => {
  test.each([
    [{}, { surfaceId: ACTIVITY_SURFACE_ID }],
    [
      { sessionId: 'thread-1' },
      { surfaceId: ACTIVITY_SURFACE_ID, sessionId: 'thread-1' },
    ],
    [
      { sessionId: 'thread-1', focus: 'evidence' },
      {
        surfaceId: ACTIVITY_SURFACE_ID,
        sessionId: 'thread-1',
        focus: 'evidence',
      },
    ],
    [
      { sessionId: 'thread/alpha' },
      { surfaceId: ACTIVITY_SURFACE_ID, sessionId: 'thread/alpha' },
    ],
    [
      { sessionId: 'a b' },
      { surfaceId: ACTIVITY_SURFACE_ID, sessionId: 'a b' },
    ],
    [
      { sessionId: 'x&y=z' },
      { surfaceId: ACTIVITY_SURFACE_ID, sessionId: 'x&y=z' },
    ],
  ] satisfies Array<[ActivityDeepLinkIntent, object]>)(
    'round-trips %j',
    (intent, expected) => {
      expect(roundTrip(intent)).toEqual(expected);
    },
  );

  test('encodes session ids in the minted link', () => {
    expect(activityDeepLink({ sessionId: 'thread/alpha' })).toBe(
      '/?surface=activity&session=thread%2Falpha',
    );
    expect(activityDeepLink({ sessionId: 'a b' })).toBe(
      '/?surface=activity&session=a%20b',
    );
    expect(activityDeepLink({ sessionId: 'x&y=z' })).toBe(
      '/?surface=activity&session=x%26y%3Dz',
    );
  });

  test('drops focus without a session when building and parsing', () => {
    expect(activityDeepLink({ focus: 'evidence' })).toBe('/?surface=activity');
    expect(
      parseSurfaceDeepLink(
        new URLSearchParams('surface=activity&focus=evidence'),
      ),
    ).toEqual({ surfaceId: ACTIVITY_SURFACE_ID });
  });

  test.each(['', 'surface='])(
    'returns null when surface is missing or empty: %j',
    (search) => {
      expect(parseSurfaceDeepLink(new URLSearchParams(search))).toBeNull();
    },
  );

  test('returns the complete updateParams clear patch', () => {
    expect(clearSurfaceDeepLinkParams()).toEqual({
      surface: null,
      session: null,
      focus: null,
    });
  });
});
