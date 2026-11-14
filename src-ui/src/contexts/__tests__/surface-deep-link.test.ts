import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { describe, expect, test } from 'vitest';
import {
  clearSurfaceDeepLinkParams,
  parseSurfaceDeepLink,
} from '../surface-deep-link';

describe('surface deep-link URL handling', () => {
  test.each([
    [{ sessionId: 'thread-1' }, { surfaceId: 'chat', sessionId: 'thread-1' }],
    [
      { sessionId: 'thread-1', focus: 'evidence' },
      {
        surfaceId: 'chat',
        sessionId: 'thread-1',
        focus: 'evidence',
      },
    ],
    [
      { sessionId: 'thread/alpha' },
      { surfaceId: 'chat', sessionId: 'thread/alpha' },
    ],
    [{ sessionId: 'a b' }, { surfaceId: 'chat', sessionId: 'a b' }],
    [
      {
        sessionId: 'parent',
        childSessionId: 'delegate / 1',
        childTitle: 'Research',
      },
      {
        surfaceId: 'chat',
        sessionId: 'parent',
        childSessionId: 'delegate / 1',
        childTitle: 'Research',
      },
    ],
    [{ sessionId: 'x&y=z' }, { surfaceId: 'chat', sessionId: 'x&y=z' }],
    [
      {
        sessionId: 'sender',
        messageAnchor: { direction: 'sent', requestKey: 'key / & 1' },
      },
      {
        surfaceId: 'chat',
        sessionId: 'sender',
        messageAnchor: { direction: 'sent', requestKey: 'key / & 1' },
      },
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
    ).toEqual({ surfaceId: 'chat' });
    expect(parseSurfaceDeepLink(new URLSearchParams(''))).toBeNull();
    expect(parseSurfaceDeepLink(new URLSearchParams('surface='))).toBeNull();
    expect(clearSurfaceDeepLinkParams()).toEqual({
      child: null,
      childTitle: null,
      childSession: null,
      surface: null,
      session: null,
      focus: null,
      messageSession: null,
      messageDirection: null,
      messageRequest: null,
    });
  });
});

test('a message anchor is bounded and belongs to the Session its surface names', () => {
  for (const query of [
    'surface=activity&session=s&messageSession=other&messageDirection=sent&messageRequest=k',
    'surface=activity&session=s&messageSession=s&messageDirection=unknown&messageRequest=k',
    `surface=activity&session=s&messageSession=s&messageDirection=sent&messageRequest=${'x'.repeat(129)}`,
  ])
    expect(parseSurfaceDeepLink(new URLSearchParams(query))).toEqual({
      surfaceId: 'chat',
      sessionId: 's',
    });
});
