import { describe, expect, test } from 'vitest';
import {
  chatWaitsOnUser,
  requestsWaitingOnUser,
} from '../utils/waiting-approvals';

describe('requestsWaitingOnUser', () => {
  test('is every open request the user has not answered, in order', () => {
    expect(
      requestsWaitingOnUser({
        pendingApprovals: ['a', 'b', 'c'],
        answeredApprovals: ['b'],
      }),
    ).toEqual(['a', 'c']);
  });

  test('is empty when every open request is answered, and when none is open', () => {
    expect(
      requestsWaitingOnUser({
        pendingApprovals: ['a'],
        answeredApprovals: ['a'],
      }),
    ).toEqual([]);
    expect(requestsWaitingOnUser({})).toEqual([]);
  });

  test('ignores an answered id that is no longer open', () => {
    expect(
      requestsWaitingOnUser({
        pendingApprovals: ['a'],
        answeredApprovals: ['gone'],
      }),
    ).toEqual(['a']);
  });
});

describe('chatWaitsOnUser', () => {
  test('is true while a request waits on the user', () => {
    expect(chatWaitsOnUser({ pendingApprovals: ['a'] })).toBe(true);
  });

  test('is true for awaiting-approval with no request behind it', () => {
    expect(chatWaitsOnUser({ orchestrationStatus: 'awaiting-approval' })).toBe(
      true,
    );
  });

  test('is false once every open request is answered, even while the status still says awaiting-approval', () => {
    expect(
      chatWaitsOnUser({
        orchestrationStatus: 'awaiting-approval',
        pendingApprovals: ['a'],
        answeredApprovals: ['a'],
      }),
    ).toBe(false);
  });

  test('is false for an idle chat', () => {
    expect(chatWaitsOnUser({ orchestrationStatus: 'idle' })).toBe(false);
  });
});
