import { describe, expect, test, vi } from 'vitest';
import { trackCodingEvidenceCompositionReceipt } from '../codingEvidenceCompositionTelemetry';

describe('Coding evidence composition migration telemetry', () => {
  test('emits one bounded shared receipt without evidence identities', () => {
    const track = vi.fn();
    trackCodingEvidenceCompositionReceipt(
      {
        category: 'evidence',
        control: 'compare',
        outcome: 'unavailable',
        restorationIdentityMatched: false,
        fallbackUsed: false,
        reason: 'capability-unavailable',
      },
      track,
    );
    expect(track).toHaveBeenCalledWith(
      'ui.workspace_composition.coding_evidence_path',
      {
        category: 'evidence',
        control: 'compare',
        outcome: 'unavailable',
        restoration_identity_matched: 0,
        fallback_used: 0,
        reason: 'capability-unavailable',
      },
    );
    expect(JSON.stringify(track.mock.calls[0]?.[1])).not.toMatch(
      /project|workspace|task|run|session|source|descriptor|instance/,
    );
  });
});
