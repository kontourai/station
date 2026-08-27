/** @vitest-environment jsdom */

/**
 * 2026-08-26 audit F6: `WorkspacePaneDockAction` used to render as a bare
 * sibling directly above `HomeSurface`'s intro header, colliding with the
 * `Your work` eyebrow at every width — Activity's equivalent joins its
 * page-header action cell instead (`ActivityWorkspacePane.tsx`). Home has no
 * `PageFrame` action cell to join (`page-frame-registry.ts` maps
 * `home: null`), so the fix gives it Home's own top-of-content action slot
 * (`HomeSurface`'s `topAction` prop, rendered inside `.home-view__top-row`
 * beside `.home-view__intro`) instead of a floating pre-header sibling.
 *
 * This test drives the real `HomeWorkspacePane` + real `HomeSurface` (no
 * mock on either) so a regression back to the old bare-sibling placement —
 * or any placement that stops putting the action inside the same row as the
 * intro — fails it.
 */

import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { WorkspacePaneDockContext } from '../../../workspace-panes/WorkspacePaneDockContext';
import type { HomeViewModel } from '../HomeSurface';
import {
  HomeWorkspacePane,
  HomeWorkspacePaneBindingProvider,
} from '../HomeWorkspacePane';

function minimalModel(): HomeViewModel {
  return {
    projects: [],
    agents: [],
    defaultSelection: { agent: undefined, effectiveModel: undefined },
    workItems: [],
    workLoading: false,
    workDegraded: false,
    workError: false,
    retryWork: vi.fn(),
    remoteUnavailable: [],
    remoteAuthenticationRequired: [],
    startReady: false,
    startIdentity: 'No agent is ready yet',
    primaryWorkItem: undefined,
    continueWork: vi.fn(),
  } as unknown as HomeViewModel;
}

function renderHomeWorkspacePane() {
  return render(
    <WorkspacePaneDockContext.Provider
      value={{
        suppliable: new Set(),
        dockPane: vi.fn(),
        occupantInstanceId: 'workspace-chat',
        undockOccupant: () => {},
      }}
    >
      <HomeWorkspacePaneBindingProvider
        binding={{
          model: minimalModel(),
          continuation: null,
          onNavigate: vi.fn(),
        }}
      >
        <HomeWorkspacePane
          descriptor={WORKSPACE_HOME_PANE_DESCRIPTOR}
          instance={WORKSPACE_HOME_PANE_INSTANCE}
        />
      </HomeWorkspacePaneBindingProvider>
    </WorkspacePaneDockContext.Provider>,
  );
}

test('Dock this pane renders inside Home’s top-of-content action row, beside the intro, not stacked above the eyebrow', () => {
  renderHomeWorkspacePane();
  const action = screen.getByRole('button', { name: 'Dock this pane' });
  const topRow = action.closest('.home-view__top-row');
  expect(
    topRow,
    'the dock action must share Home’s top-of-content action row',
  ).not.toBeNull();
  expect(
    topRow?.querySelector('.home-view__intro'),
    'that row must also carry the intro (eyebrow/h1/lede) the action used to collide with',
  ).not.toBeNull();
});
