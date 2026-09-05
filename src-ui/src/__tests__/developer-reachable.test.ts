/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// archive#3313: Developer is settings-gated. The flag derivation has its own
// test (useSurfaceVisibilityFlags.test.ts); here it is controllable so this
// suite can pin both sides of the gate.
const flagsState = vi.hoisted(() => ({ flags: new Set<string>() }));
// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it. This harness mounts a fragment of that tree, and nothing
// here asserts a surface reveal, so the command hook is supplied directly.
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));

vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flagsState.flags,
}));

import { DEVELOPER_TOOLS_FLAG } from '../app-shell/destination-registry';
import {
  getManagementNavigationGroup,
  getPathForView,
  resolveViewFromPath,
} from '../app-shell/routing';
import { ProjectSidebarNav } from '../components/project-sidebar/ProjectSidebarNav';

/**
 * The /developer surface (Slice F) replaced the old Monitoring sidebar entry.
 * Modeled on notifications-reachable.test.ts: a destination is only real if it
 * round-trips its route, is a navigable management group the sidebar can
 * highlight, and actually has a sidebar item — otherwise ProjectSidebarNav
 * throws when the System group lists a `developer` item type that no nav entry
 * provides.
 */
describe('the developer surface is a destination', () => {
  beforeEach(() => {
    flagsState.flags = new Set([DEVELOPER_TOOLS_FLAG]);
  });

  test('round-trips its own route', () => {
    expect(resolveViewFromPath('/developer')).toEqual({ type: 'developer' });
    expect(getPathForView({ type: 'developer' })).toBe('/developer');
    expect(resolveViewFromPath('/developer/system')).toEqual({
      type: 'developer',
      tab: 'system',
    });
    expect(getPathForView({ type: 'developer', tab: 'system' })).toBe(
      '/developer/system',
    );
  });

  test('is a navigable group, so the sidebar can highlight it', () => {
    expect(getManagementNavigationGroup({ type: 'developer' })).toBe(
      'developer',
    );
  });

  test('renders a sidebar Developer control that navigates to its route while developer tools are enabled', () => {
    const navigate = vi.fn();
    render(
      createElement(ProjectSidebarNav, {
        collapsed: false,
        isMobile: false,
        navigate,
        activePath: '/developer',
      }),
    );
    const developer = screen.getByRole('button', { name: 'Developer' });
    expect(developer).toBeTruthy();
    fireEvent.click(developer);
    expect(navigate).toHaveBeenCalledWith('/developer');
  });

  test('stays a deep-linkable route, but not a sidebar item, while developer tools are disabled (station#3313)', () => {
    flagsState.flags = new Set();
    // The route still resolves — gating is advertisement-only.
    expect(resolveViewFromPath('/developer')).toEqual({ type: 'developer' });
    render(
      createElement(ProjectSidebarNav, {
        collapsed: false,
        isMobile: false,
        navigate: vi.fn(),
        activePath: '/developer',
      }),
    );
    expect(screen.queryByRole('button', { name: 'Developer' })).toBeNull();
  });
});
