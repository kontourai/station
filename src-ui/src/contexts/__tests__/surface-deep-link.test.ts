import {
  ACTIVITY_SURFACE_ID,
  activityDeepLink,
} from '@kontourai/station-contracts/surface-deep-link';
import { describe, expect, test } from 'vitest';
import {
  clearSurfaceDeepLinkParams,
  parseSurfaceDeepLink,
} from '../surface-deep-link';

describe('surface deep-link URL handling', () => {
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
  ] as const)('round-trips %j', (intent, expected) => {
    expect(
      parseSurfaceDeepLink(
        new URLSearchParams(activityDeepLink(intent).split('?')[1]),
      ),
    ).toEqual(expected);
  });

  test('drops focus without session, rejects empty surfaces, and clears the shape', () => {
    expect(
      parseSurfaceDeepLink(
        new URLSearchParams('surface=activity&focus=evidence'),
      ),
    ).toEqual({ surfaceId: ACTIVITY_SURFACE_ID });
    expect(parseSurfaceDeepLink(new URLSearchParams(''))).toBeNull();
    expect(parseSurfaceDeepLink(new URLSearchParams('surface='))).toBeNull();
    expect(clearSurfaceDeepLinkParams()).toEqual({
      surface: null,
      session: null,
      focus: null,
    });
  });
});
