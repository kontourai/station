/**
 * @vitest-environment jsdom
 */

import { describe, expect, test } from 'vitest';
import {
  getSchedulerEventInvalidationKeys,
  isSchedulerDeferralTerminal,
} from '../hooks/useScheduler';

describe('scheduler event invalidation', () => {
  test('keeps started and missed events scheduler-only', () => {
    expect(getSchedulerEventInvalidationKeys('job.started')).toEqual([
      ['scheduler'],
    ]);
    expect(getSchedulerEventInvalidationKeys('job.missed')).toEqual([
      ['scheduler'],
    ]);
    expect(getSchedulerEventInvalidationKeys('job.deferred')).toEqual([
      ['scheduler'],
    ]);
  });

  test('refreshes runs only for terminal or run-state-changing events', () => {
    expect(getSchedulerEventInvalidationKeys('job.completed')).toEqual([
      ['scheduler'],
      ['runs'],
    ]);
    expect(getSchedulerEventInvalidationKeys('job.failed')).toEqual([
      ['scheduler'],
      ['runs'],
    ]);
    expect(getSchedulerEventInvalidationKeys('job.retrying')).toEqual([
      ['scheduler'],
      ['runs'],
    ]);
  });

  test('keeps a waiting retry live while treating a released occurrence as terminal', () => {
    expect(isSchedulerDeferralTerminal({ disposition: 'waiting' })).toBe(false);
    expect(isSchedulerDeferralTerminal({ disposition: 'released' })).toBe(true);
    expect(isSchedulerDeferralTerminal({})).toBe(true);
  });
});
