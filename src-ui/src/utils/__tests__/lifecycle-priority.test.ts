import { describe, expect, test } from 'vitest';
import {
  HOME_LIFECYCLE_LABELS,
  LIFECYCLE_PRIORITY,
  moreImportantLifecycle,
} from '../lifecycle-priority';

describe('lifecycle-priority (station#1100 AC4)', () => {
  test('ranks every label from most to least important', () => {
    const ordered = [...HOME_LIFECYCLE_LABELS].sort(
      (left, right) => LIFECYCLE_PRIORITY[right] - LIFECYCLE_PRIORITY[left],
    );
    expect(ordered).toEqual([
      'Needs attention',
      'Failed',
      'Stopped',
      'Running',
      'Current',
      'Ready',
      'Recent',
      // #2310: below every label that records activity, so a local send or
      // an offline-queued first message wins a merge against the server's
      // Draft answer for the same conversation.
      'Draft',
      // archive#1783: below every live state and above only `Completed` —
      // nothing here can act on it, but it has not finished either.
      'Unanswerable',
      'Completed',
    ]);
  });

  test('Unanswerable outranks nothing that is live, and is not deleted from the set', () => {
    expect(moreImportantLifecycle('Unanswerable', 'Needs attention')).toBe(
      'Needs attention',
    );
    expect(moreImportantLifecycle('Unanswerable', 'Ready')).toBe('Ready');
    expect(moreImportantLifecycle('Unanswerable', 'Recent')).toBe('Recent');
    expect(moreImportantLifecycle('Unanswerable', 'Completed')).toBe(
      'Unanswerable',
    );
  });

  test('moreImportantLifecycle prefers the higher-priority label regardless of argument order', () => {
    expect(moreImportantLifecycle('Ready', 'Needs attention')).toBe(
      'Needs attention',
    );
    expect(moreImportantLifecycle('Needs attention', 'Ready')).toBe(
      'Needs attention',
    );
    expect(moreImportantLifecycle('Completed', 'Recent')).toBe('Recent');
    expect(moreImportantLifecycle('Running', 'Failed')).toBe('Failed');
  });

  test('moreImportantLifecycle is a no-op when both sides match', () => {
    expect(moreImportantLifecycle('Running', 'Running')).toBe('Running');
  });
});
