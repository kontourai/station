/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const selection = vi.hoisted(() => ({
  result: { state: 'selected' } as unknown,
}));

vi.mock('../workspace-panes/workspacePaneRendererSelection', () => ({
  selectClientWorkspacePaneRenderer: () => selection.result,
}));

vi.mock('../views/home/useHomeViewModel', () => ({
  useHomeViewModel: () => ({ workItems: [], projects: [] }),
}));

vi.mock('../views/home/HomeWorkspacePane', () => ({
  HomeWorkspacePaneBindingProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <>{children}</>,
  HomeWorkspacePane: ({
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
      data-testid="home-surface"
    />
  ),
}));

vi.mock('../components/first-run/FirstRunHomeChapter', () => ({
  FirstRunHomeChapter: () => null,
}));

vi.mock('../contexts/ConfigContext', () => ({ useConfig: () => null }));

// Route chrome from #3636, not part of pane selection; it unconditionally
// calls `useConfigActions`, which the minimal ConfigContext mock above
// deliberately does not provide.
vi.mock('../components/first-run/FirstRunHomeChapter', () => ({
  FirstRunHomeChapter: () => null,
}));

// The Home role seam (stage 3), not pane selection: no grant here, and the
// real hook needs a QueryClient this minimal harness deliberately lacks.
vi.mock('../views/home/useWorkspaceHomeRole', () => ({
  useWorkspaceHomeRoleStatus: () => ({ state: 'none' }),
  useRevokeWorkspaceHomeRole: () => () => undefined,
}));

import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import { HomeView } from '../views/HomeView';

afterEach(() => {
  selection.result = { state: 'selected' };
});

/**
 * The point of station#3122 stage 2 is that Home renders because the shared
 * Workspace Pane selector admitted its renderer — not because `HomeView`
 * names it. These pin that the selection is load-bearing at the route: if it
 * were decorative, both cases would render the same thing.
 */
test('mounts the builtin Home renderer when the selector admits it as the primary', () => {
  selection.result = {
    state: 'selected',
    candidate: {
      source: 'primary',
      renderer: WORKSPACE_HOME_PANE_DESCRIPTOR.renderer,
      contributorProvenance: WORKSPACE_HOME_PANE_DESCRIPTOR.provenance,
      requiredCapabilities: [],
    },
  };
  render(<HomeView continuation={null} onNavigate={() => undefined} />);
  expect(screen.getByTestId('home-surface')).toBeTruthy();
});

test('does not mount the builtin when the selector refuses Home', () => {
  selection.result = { state: 'unavailable' };
  render(<HomeView continuation={null} onNavigate={() => undefined} />);
  expect(screen.queryByTestId('home-surface')).toBeNull();
  expect(screen.getByText('Home is unavailable')).toBeTruthy();
});

test('does not mount the builtin when the selected renderer is not the builtin primary', () => {
  // A contributed Home reaches this route through the same call. Mounting
  // the builtin for it would be the Pane system's worst failure: a renderer
  // running under a declaration that did not name it.
  selection.result = {
    state: 'selected',
    candidate: {
      source: 'primary',
      renderer: { kind: 'plugin-component', name: 'third-party-home' },
      contributorProvenance: { origin: 'plugin', pluginId: 'third-party' },
      requiredCapabilities: ['trusted-plugin-react'],
    },
  };
  render(<HomeView continuation={null} onNavigate={() => undefined} />);
  expect(screen.queryByTestId('home-surface')).toBeNull();
});

test('mounts Home against its canonical placed instance', () => {
  selection.result = {
    state: 'selected',
    candidate: {
      source: 'primary',
      renderer: WORKSPACE_HOME_PANE_DESCRIPTOR.renderer,
      contributorProvenance: WORKSPACE_HOME_PANE_DESCRIPTOR.provenance,
      requiredCapabilities: [],
    },
  };
  render(<HomeView continuation={null} onNavigate={() => undefined} />);
  const pane = screen.getByTestId('home-surface');
  expect(pane.dataset.descriptorId).toBe(WORKSPACE_HOME_PANE_DESCRIPTOR.id);
  expect(pane.dataset.instanceDescriptorId).toBe(
    WORKSPACE_HOME_PANE_INSTANCE.descriptorId,
  );
  expect(pane.dataset.instanceId).toBe(WORKSPACE_HOME_PANE_INSTANCE.instanceId);
});
