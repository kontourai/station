/** @vitest-environment jsdom */
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
  useNavigation: () => ({ navigate }),
}));

import {
  APP_DESTINATION_REGISTRY,
  DEVELOPER_TOOLS_FLAG,
} from '../app-shell/destination-registry';
import {
  getManagementNavigationGroup,
  getPathForView,
  resolveViewFromPath,
} from '../app-shell/routing';
import { settingsSectionNavItems } from '../views/SettingsView';

/**
 * The /developer surface (Slice F) replaced the old Monitoring sidebar entry.
 * Modeled on notifications-reachable.test.ts: a destination is only real if it
 * round-trips its route, is a navigable management group something can
 * highlight, and is actually advertised by a control someone can press.
 *
 * #2059 (D3) moved that control: Developer is a configuration surface, so it
 * left the left panel for Settings. #2144 slice 4 then retired the separate
 * Manage grid and made it a row in Settings' own section navigation. The flag
 * gate did not change through either move — it still gates advertisement only.
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

  test('is offered as a Settings navigation row pointing at its route while developer tools are enabled', () => {
    const developer = settingsSectionNavItems(
      (section) => `/settings?view=${section}`,
      APP_DESTINATION_REGISTRY.getSettingsNav(flagsState.flags),
    ).find((item) => item.label === 'Developer');
    expect(developer).toBeTruthy();
    // The row is what a reader presses, so the assertion is the HREF it
    // presses through to, not merely that a row with the word exists.
    expect(developer?.href).toBe('/developer');
  });

  test('stays a deep-linkable route, but not an advertised one, while developer tools are disabled (station#3313)', () => {
    flagsState.flags = new Set();
    // The route still resolves — gating is advertisement-only.
    expect(resolveViewFromPath('/developer')).toEqual({ type: 'developer' });
    expect(
      settingsSectionNavItems(
        (section) => `/settings?view=${section}`,
        APP_DESTINATION_REGISTRY.getSettingsNav(flagsState.flags),
      ).map((item) => item.label),
    ).not.toContain('Developer');
  });
});
