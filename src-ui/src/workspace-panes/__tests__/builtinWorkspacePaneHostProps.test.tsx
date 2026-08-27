/** @vitest-environment jsdom */

import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import {
  parseWorkspacePaneInstance,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { getBuiltinWorkspacePaneRenderer } from '../builtinWorkspacePaneRegistry';

vi.mock('../../views/home/HomeSurface', () => ({
  HomeSurface: () => <div data-testid="home-surface" />,
}));

import { HomeWorkspacePaneBindingProvider } from '../../views/home/HomeWorkspacePane';

const binding = {
  model: {} as never,
  continuation: null,
  onNavigate: () => undefined,
};

/**
 * Home's registry entry takes the same props as every other built-in:
 * `{ descriptor, instance }`, with identity resolved from the occurrence.
 * Home's occurrence binds no Project, so mounting it must not produce the
 * Project renderers' binding refusals — its admission is the canonical
 * occurrence check, not Project ownership.
 */
test('Home mounts through the registry with no Project identity and renders its surface', async () => {
  const Home = getBuiltinWorkspacePaneRenderer(WORKSPACE_HOME_PANE_DESCRIPTOR);
  expect(Home).not.toBeNull();
  if (!Home) return;
  render(
    <HomeWorkspacePaneBindingProvider binding={binding}>
      <Home
        descriptor={WORKSPACE_HOME_PANE_DESCRIPTOR}
        instance={WORKSPACE_HOME_PANE_INSTANCE}
      />
    </HomeWorkspacePaneBindingProvider>,
  );
  expect(await screen.findByTestId('home-surface')).toBeTruthy();
  expect(screen.queryByText('This pane isn’t linked to a Project')).toBeNull();
});

test('Home refuses a non-canonical occurrence with visible unavailable content', async () => {
  const impostorInstance = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: WORKSPACE_HOME_PANE_DESCRIPTOR.id,
    instanceId: 'workspace-home-2',
    stateKey: 'workspace-home-2',
    boundContext: { sourceId: 'plugin:third-party-home' },
  }) as WorkspacePaneInstance;
  const Home = getBuiltinWorkspacePaneRenderer(WORKSPACE_HOME_PANE_DESCRIPTOR);
  expect(Home).not.toBeNull();
  if (!Home) return;
  render(
    <HomeWorkspacePaneBindingProvider binding={binding}>
      <Home
        descriptor={WORKSPACE_HOME_PANE_DESCRIPTOR}
        instance={impostorInstance}
      />
    </HomeWorkspacePaneBindingProvider>,
  );
  expect(await screen.findByText('This pane can’t open here')).toBeTruthy();
  expect(screen.queryByTestId('home-surface')).toBeNull();
});
