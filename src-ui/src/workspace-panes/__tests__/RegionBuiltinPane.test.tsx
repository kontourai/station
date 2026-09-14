/** @vitest-environment jsdom */

import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { LazyBoundary } from '../../components/LazyBoundary';
import { RegionBuiltinPane } from '../RegionBuiltinPane';

/**
 * #2047: `RegionBuiltinPane` throws for an instance whose descriptor the
 * region's built-in map does not hold, rather than rendering nothing — the
 * lazy boundary the host wraps it in reports it, the way an Activity pane
 * with no renderer does. Every input is a code-owned built-in, so a miss is
 * a build defect and must be visible.
 *
 * Mounted through the same `LazyBoundary` the host wraps it in
 * (`RegionPaneHost.tsx`), so the assertion is over what that boundary
 * actually renders. The module is resolved here rather than imported inside
 * the factory: the host's chunk boundary is not what is under test, and
 * racing the real dynamic import is the known mount-under-load flake.
 * Reverting the throw to `return null` fails this at the boundary text.
 */
test('a descriptor the region built-in map lacks is reported by the boundary', async () => {
  const instance = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'pane:builtin:not-a-region-builtin',
    instanceId: 'region-builtin-unknown',
    stateKey: 'region-builtin-unknown',
  });
  if (!instance) throw new Error('fixture must parse');

  // React logs the boundary-caught error; the assertion below is the report.
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(
      <LazyBoundary
        load={() => Promise.resolve({ default: RegionBuiltinPane })}
        componentProps={{ instance }}
        pending={<span>Loading pane</span>}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Unable to load this part of Station.',
      ),
    );
  } finally {
    errors.mockRestore();
  }
});
