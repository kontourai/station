/**
 * @vitest-environment jsdom
 */

import { describe, expect, test } from 'vitest';
import { getSchedulerEventInvalidationKeys } from '../hooks/useScheduler';

describe('scheduler event invalidation', () => {
  test('keeps started and missed events scheduler-only', () => {
    expect(getSchedulerEventInvalidationKeys('job.started')).toEqual([
      ['scheduler'],
    ]);
    expect(getSchedulerEventInvalidationKeys('job.missed')).toEqual([
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
});
