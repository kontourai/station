import { describe, expect, test, vi } from 'vitest';
import { trackCodingDiffCompositionReceipt } from '../codingDiffCompositionTelemetry';

describe('Coding Diff composition migration telemetry', () => {
  test('emits bounded mode/outcome/reason facts without raw identities', () => {
    const track = vi.fn();
    trackCodingDiffCompositionReceipt(
      {
        control: 'compare',
        outcome: 'unavailable',
        restorationIdentityMatched: false,
        fallbackUsed: false,
        reason: 'comparison-mismatch',
      },
      track,
    );
    expect(track).toHaveBeenCalledWith(
      'ui.workspace_composition.coding_diff_path',
      {
        category: 'git-diff',
        control: 'compare',
        outcome: 'unavailable',
        restoration_identity_matched: 0,
        fallback_used: 0,
        reason: 'comparison-mismatch',
      },
    );
    expect(JSON.stringify(track.mock.calls[0]?.[1])).not.toMatch(
      /project|workspaceId|sourceId|revision|descriptor|instance|path/,
    );
  });
});
