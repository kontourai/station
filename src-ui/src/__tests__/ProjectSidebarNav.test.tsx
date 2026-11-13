/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

// archive#3313: the nav derives surface visibility from live flags (enabled
// feature previews + the developer-tools device setting). The derivation has
// its own test (useSurfaceVisibilityFlags.test.ts); here it is a controllable
// set so these tests pin what the nav DOES with the flags it is given.
const flagsState = vi.hoisted(() => ({ flags: new Set<string>() }));
const regionState = vi.hoisted(() => ({
  showSurfacePage: vi.fn(),
  toggleSurface: vi.fn(),
  activityVisible: false,
  mainOccupant: null as string | null,
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flagsState.flags,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => ({
    toggleSurface: regionState.toggleSurface,
    regions: {
      main: {
        visible: true,
        size: 0,
        panes: regionState.mainOccupant ? [regionState.mainOccupant] : [],
        occupant: regionState.mainOccupant,
      },
      left: { visible: false, size: 400, panes: [], occupant: null },
      right: {
        visible: regionState.activityVisible,
        size: 400,
        panes: ['activity'],
        occupant: 'activity',
      },
      bottom: { visible: true, size: 320, panes: ['chat'], occupant: 'chat' },
    },
  }),
}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurfacePage: () => regionState.showSurfacePage,
}));

import { ProjectSidebarNav } from '../components/project-sidebar/ProjectSidebarNav';

describe('sidebar places after Activity retirement', () => {
  test('does not advertise Activity or configuration pages', () => {
    render(
      <ProjectSidebarNav
        collapsed={false}
        isMobile={false}
        navigate={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    for (const name of ['Agents', 'Connections', 'Settings', 'Developer'])
      expect(screen.queryByRole('button', { name })).toBeNull();
  });
});
