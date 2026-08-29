/** @vitest-environment jsdom */

import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
} from '@kontourai/station-contracts/workspace-home-pane';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { WorkspacePaneDockAction } from '../WorkspacePaneDockAction';
import { WorkspacePaneDockContext } from '../WorkspacePaneDockContext';

test('Dock this pane is absent without the ambient host authority', () => {
  render(
    <WorkspacePaneDockAction
      descriptor={WORKSPACE_HOME_PANE_DESCRIPTOR}
      instance={WORKSPACE_HOME_PANE_INSTANCE}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Dock this pane' })).toBeNull();
});

test('Dock this pane calls the shared ambient-host context via dockPaneAsOnlyContent (station#520)', () => {
  // station#520: "Dock this pane" is rendered BY the pane it docks, so it
  // must call `dockPaneAsOnlyContent` — the entry point that lets the
  // mobile dock-and-empty contract auto-maximize — not the plain `dockPane`
  // `DockOccupantPicker` uses.
  const dockPane = vi.fn();
  const dockPaneAsOnlyContent = vi.fn();
  render(
    <WorkspacePaneDockContext.Provider
      value={{
        suppliable: new Set(),
        dockPane,
        dockPaneAsOnlyContent,
        occupantInstanceId: 'workspace-chat',
        undockOccupant: () => {},
      }}
    >
      <WorkspacePaneDockAction
        descriptor={WORKSPACE_HOME_PANE_DESCRIPTOR}
        instance={WORKSPACE_HOME_PANE_INSTANCE}
      />
      ,
    </WorkspacePaneDockContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Dock this pane' }));
  expect(dockPaneAsOnlyContent).toHaveBeenCalledWith(
    WORKSPACE_HOME_PANE_DESCRIPTOR,
    WORKSPACE_HOME_PANE_INSTANCE,
  );
  expect(dockPane).not.toHaveBeenCalled();
});
