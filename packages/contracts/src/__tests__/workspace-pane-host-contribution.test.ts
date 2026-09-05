import { describe, expect, test } from 'vitest';
import { WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION } from '../workspace-pane-host-contribution.js';

describe('Workspace Pane host contribution contract', () => {
  test('keeps its public version independent of Pane availability requirements', () => {
    expect(WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION).toBe(
      'station.workspace-pane-host-contribution/v1',
    );
  });
});
