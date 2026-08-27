import { describe, expect, test, vi } from 'vitest';
import { trackCodingFileCompositionReceipt } from '../codingFileCompositionTelemetry';

describe('Coding file composition operational receipt', () => {
  test('emits bounded path/restoration/no-fallback evidence without Project or file data', () => {
    const track = vi.fn();
    trackCodingFileCompositionReceipt(
      {
        control: 'composition',
        outcome: 'composition-selected',
        restorationIdentityMatched: true,
        fallbackUsed: false,
      },
      track,
    );
    expect(track).toHaveBeenCalledWith(
      'ui.workspace_composition.coding_file_path',
      {
        control: 'composition',
        outcome: 'composition-selected',
        restoration_identity_matched: 1,
        fallback_used: 0,
      },
    );
    const properties = track.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(properties).not.toHaveProperty('project_id');
    expect(properties).not.toHaveProperty('file_path');
    expect(properties).not.toHaveProperty('content');
    expect(properties).not.toHaveProperty('credential');
  });
});
