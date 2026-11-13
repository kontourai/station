import { expect, test } from 'vitest';
import {
  childWorkUsageClauses,
  formatChildWorkElapsed,
} from '../utils/child-work-display';
import { formatDuration } from '../utils/relativeTime';

test('child work uses the canonical elapsed formatter for clocks and usage', () => {
  expect(formatChildWorkElapsed).toBe(formatDuration);
  expect(childWorkUsageClauses({ durationMs: 121000 })).toContain('ran 2m 1s');
});
