/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const flagsState = vi.hoisted(() => ({ flags: new Set<string>() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flagsState.flags,
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate }),
}));

import { DEVELOPER_TOOLS_FLAG } from '../../../app-shell/destination-registry';
import { SettingsManageSection } from '../SettingsManageSection';

/**
 * #2059 acceptance: "Every removed destination remains reachable from the
 * palette and from a Settings entry point, with a test that drives each route
 * from there." This is the Settings half — every entry is clicked and the
 * route it navigates to is asserted. `SettingsView.test`-level mounting is not
 * what proves reachability; driving each control is.
 */
describe('SettingsManageSection', () => {
  beforeEach(() => {
    flagsState.flags = new Set();
    navigate.mockReset();
  });

  test.each([
    ['Agents', '/agents'],
    ['Guidance', '/guidance'],
    ['Connections', '/connections'],
    ['Registry', '/registry'],
    // #2065 retired the global `/review-queue`: Review is a layout kind a
    // project opens, not a destination of its own, and `routing.ts` now lists
    // both spellings in RETIRED_REVIEW_QUEUE_PATHS. The row is gone from the
    // Manage group with it, so the expectation is what was stale — the same
    // call #2117 made for the two palette expectations.
    ['Plugins', '/plugins'],
    ['Schedule', '/schedule'],
  ])('drives %s to %s', (label, route) => {
    render(<SettingsManageSection />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(navigate).toHaveBeenCalledWith(route);
  });

  test('drives Developer to /developer while developer tools are enabled', () => {
    // archive#3313: the flag gates ADVERTISEMENT only. It used to gate the
    // panel row; it gates this entry the same way, and /developer stays
    // deep-linkable either way.
    flagsState.flags = new Set([DEVELOPER_TOOLS_FLAG]);
    render(<SettingsManageSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Developer' }));
    expect(navigate).toHaveBeenCalledWith('/developer');
  });

  test('omits Developer while developer tools are disabled', () => {
    render(<SettingsManageSection />);
    expect(screen.queryByRole('button', { name: 'Developer' })).toBeNull();
  });

  // A literal inventory, not a re-read of `getManagement()` — comparing the
  // rendered list against the same projection the component renders from
  // would pass however that projection changed, including a destination
  // silently dropping out of both the panel and this group.
  test('lists exactly the destinations moved out of the panel, in order', () => {
    render(<SettingsManageSection />);
    expect(
      screen.getAllByRole('button').map((button) => button.textContent?.trim()),
    ).toEqual([
      'Agents',
      'Guidance',
      'Connections',
      'Registry',
      'Plugins',
      'Schedule',
    ]);
  });

  test('names itself so the group is findable by its heading', () => {
    render(<SettingsManageSection />);
    expect(screen.getByRole('region', { name: 'Manage' }).tagName).toBe(
      'SECTION',
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'Manage' }),
    ).toBeTruthy();
  });
});
