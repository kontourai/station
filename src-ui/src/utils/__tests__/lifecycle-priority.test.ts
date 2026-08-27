import { describe, expect, test } from 'vitest';
import {
  HOME_LIFECYCLE_LABELS,
  LIFECYCLE_CHIP_LABELS,
  LIFECYCLE_PRIORITY,
  lifecycleLabelText,
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
      // station#1783: below every live state and above only `Completed` —
      // nothing here can act on it, but it has not finished either.
      'Unanswerable',
      'Completed',
    ]);
  });

  test('lifecycleLabelText translates the one member that is not user language', () => {
    // Review's secondary HIGH: every sibling is already the user's word, and
    // `Unanswerable` was the only enum leaking verbatim to two surfaces.
    expect(lifecycleLabelText('Unanswerable')).toBe("Can't answer here");
    for (const label of HOME_LIFECYCLE_LABELS) {
      if (label === 'Unanswerable') continue;
      expect(lifecycleLabelText(label)).toBe(label);
    }
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

  test('chip labels include a distinct Failed state, independent of numeric priority', () => {
    expect([...LIFECYCLE_CHIP_LABELS].sort()).toEqual(
      [
        'Completed',
        'Failed',
        'Needs attention',
        'Running',
        'Stopped',
        'Unanswerable',
      ].sort(),
    );
    // station#1783: chipped so a demoted row still says WHY it dropped.
    // De-prioritizing without rendering the fact would be filtering under
    // another name.
    expect(LIFECYCLE_CHIP_LABELS.has('Unanswerable')).toBe(true);
    // Completed (priority 0, the lowest) still renders a chip, while
    // higher-priority Current/Ready/Recent render none — proves this set
    // is not a numeric-priority threshold over LIFECYCLE_PRIORITY.
    expect(LIFECYCLE_CHIP_LABELS.has('Completed')).toBe(true);
    expect(LIFECYCLE_CHIP_LABELS.has('Failed')).toBe(true);
    expect(LIFECYCLE_CHIP_LABELS.has('Stopped')).toBe(true);
    expect(LIFECYCLE_CHIP_LABELS.has('Current')).toBe(false);
    expect(LIFECYCLE_CHIP_LABELS.has('Ready')).toBe(false);
    expect(LIFECYCLE_CHIP_LABELS.has('Recent')).toBe(false);
  });
});
