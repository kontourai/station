import { describe, expect, test } from 'vitest';
import manifest from '../../package.json' with { type: 'json' };
import * as contracts from '../index.js';

describe('retired Activity pane contracts', () => {
  test('the public barrel and subpaths no longer advertise removed renderers', () => {
    expect('WORKSPACE_ACTIVITY_PANE_DESCRIPTOR' in contracts).toBe(false);
    expect('WORKSPACE_ACTIVITY_REVIEW_PANE_DESCRIPTOR' in contracts).toBe(
      false,
    );
    expect(Object.keys(manifest.exports)).not.toContain(
      './workspace-activity-pane',
    );
    expect(Object.keys(manifest.exports)).not.toContain(
      './workspace-activity-review-pane',
    );
  });
});
