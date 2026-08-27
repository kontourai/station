/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const selection = vi.hoisted(() => ({
  result: { state: 'selected' } as unknown,
}));

vi.mock('../workspace-panes/workspacePaneRendererSelection', () => ({
  selectClientWorkspacePaneRenderer: () => selection.result,
}));

vi.mock('../views/activity/ActivityWorkspacePane', () => ({
  ActivityWorkspacePane: ({
    descriptor,
    instance,
  }: {
    descriptor: { id: string };
    instance: { descriptorId: string; instanceId: string };
  }) => (
    <div
      data-descriptor-id={descriptor.id}
      data-instance-descriptor-id={instance.descriptorId}
      data-instance-id={instance.instanceId}
      data-testid="activity-surface"
    />
  ),
}));

vi.mock('../contexts/ConfigContext', () => ({ useConfig: () => null }));

import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-activity-pane';
import { ActivityView } from '../views/ActivityView';

afterEach(() => {
  selection.result = { state: 'selected' };
});

/**
 * The point of M3 is that Activity renders because the shared Workspace Pane
 * selector admitted its renderer — not because `ActivityView` names it.
 * These pin that the selection is load-bearing at the route: if it were
 * decorative, both cases would render the same thing. (Same shape as
 * `HomeViewPaneSelection.test.tsx`, M2's route.)
 */
test('mounts the builtin Activity renderer when the selector admits it as the primary', () => {
  selection.result = {
    state: 'selected',
    candidate: {
      source: 'primary',
      renderer: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.renderer,
      contributorProvenance: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.provenance,
      requiredCapabilities: [],
    },
  };
  render(<ActivityView apiBase="http://test.local" />);
  expect(screen.getByTestId('activity-surface')).toBeTruthy();
});

test('does not mount the builtin when the selector refuses Activity', () => {
  selection.result = { state: 'unavailable' };
  render(<ActivityView apiBase="http://test.local" />);
  expect(screen.queryByTestId('activity-surface')).toBeNull();
  expect(screen.getByText('Activity is unavailable')).toBeTruthy();
});

test('does not mount the builtin when the selected renderer is not the builtin primary', () => {
  selection.result = {
    state: 'selected',
    candidate: {
      source: 'primary',
      renderer: { kind: 'plugin-component', name: 'third-party-activity' },
      contributorProvenance: { origin: 'plugin', pluginId: 'third-party' },
      requiredCapabilities: ['trusted-plugin-react'],
    },
  };
  render(<ActivityView apiBase="http://test.local" />);
  expect(screen.queryByTestId('activity-surface')).toBeNull();
});

test('mounts Activity against its canonical placed instance', () => {
  selection.result = {
    state: 'selected',
    candidate: {
      source: 'primary',
      renderer: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.renderer,
      contributorProvenance: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.provenance,
      requiredCapabilities: [],
    },
  };
  render(<ActivityView apiBase="http://test.local" sessionId="thread-1" />);
  const surface = screen.getByTestId('activity-surface');
  expect(surface.getAttribute('data-descriptor-id')).toBe(
    WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.id,
  );
  expect(surface.getAttribute('data-instance-descriptor-id')).toBe(
    WORKSPACE_ACTIVITY_PANE_INSTANCE.descriptorId,
  );
  expect(surface.getAttribute('data-instance-id')).toBe(
    WORKSPACE_ACTIVITY_PANE_INSTANCE.instanceId,
  );
});
