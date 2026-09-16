/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// archive#3313: Developer is settings-gated. The flag derivation has its own
// test (useSurfaceVisibilityFlags.test.ts); here it is controllable so this
// suite can pin both sides of the gate.
const flagsState = vi.hoisted(() => ({ flags: new Set<string>() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flagsState.flags,
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate }),
}));

import { DEVELOPER_TOOLS_FLAG } from '../app-shell/destination-registry';
import {
  getManagementNavigationGroup,
  getPathForView,
  resolveViewFromPath,
} from '../app-shell/routing';
import { SettingsManageSection } from '../views/settings/SettingsManageSection';

/**
 * The /developer surface (Slice F) replaced the old Monitoring sidebar entry.
 * Modeled on notifications-reachable.test.ts: a destination is only real if it
 * round-trips its route, is a navigable management group something can
 * highlight, and is actually advertised by a control someone can press.
 *
 * #2059 (D3) moved that control: Developer is a configuration surface, so it
 * left the left panel for Settings' Manage group. The flag gate did not
 * change — it still gates advertisement only.
 */
describe('the developer surface is a destination', () => {
  beforeEach(() => {
    flagsState.flags = new Set([DEVELOPER_TOOLS_FLAG]);
    navigate.mockReset();
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

  test('renders a Settings Manage control that navigates to its route while developer tools are enabled', () => {
    render(createElement(SettingsManageSection));
    const developer = screen.getByRole('button', { name: 'Developer' });
    expect(developer).toBeTruthy();
    fireEvent.click(developer);
    expect(navigate).toHaveBeenCalledWith('/developer');
  });

  test('stays a deep-linkable route, but not an advertised one, while developer tools are disabled (station#3313)', () => {
    flagsState.flags = new Set();
    // The route still resolves — gating is advertisement-only.
    expect(resolveViewFromPath('/developer')).toEqual({ type: 'developer' });
    render(createElement(SettingsManageSection));
    expect(screen.queryByRole('button', { name: 'Developer' })).toBeNull();
  });
});
