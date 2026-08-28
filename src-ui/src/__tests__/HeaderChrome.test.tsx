/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const goHome = vi.fn();
const onNavigate = vi.fn();

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
}));

vi.mock('../components/header/HeaderActions', () => ({
  HeaderActions: () => null,
}));

vi.mock('../components/header/LayoutSwitcher', () => ({
  LayoutSwitcher: () => null,
}));

let productName = 'Station';

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ productName }),
}));

let breadcrumb: {
  projectSlug?: string;
  layoutSlug?: string;
  section?: string;
  sectionRoot?: unknown;
} | null = null;

vi.mock('../components/header/useHeaderViewModel', () => ({
  useHeaderViewModel: () => ({
    breadcrumb,
    closeHelp: vi.fn(),
    closeNotifications: vi.fn(),
    closeOverflow: vi.fn(),
    goHome,
    handleHelpPrompt: vi.fn(),
    helpPrompts: [],
    openConnectionModal: vi.fn(),
    openProfile: vi.fn(),
    settingsShortcut: '',
    showHelp: false,
    showNotifications: false,
    showOverflow: false,
    toggleHelp: vi.fn(),
    toggleNotifications: vi.fn(),
    toggleOverflow: vi.fn(),
    userInitials: 'BA',
  }),
}));

import { Header } from '../components/header/Header';

/**
 * Coverage gap closed: nothing asserted the header's
 * home/breadcrumb roles or that the decorative logo stays out of the tab
 * order (both logo and wordmark are visible at the mobile breakpoint — two
 * tab stops for one destination).
 */
describe('Header chrome accessibility', () => {
  test('exactly one home control: the wordmark is a labelled link, the logo is not a tab stop', () => {
    breadcrumb = null;
    productName = 'Station';
    render(<Header onToggleSettings={vi.fn()} onNavigate={onNavigate} />);

    const home = screen.getByRole('link', { name: 'Station home' });
    expect(home.textContent).toBe('Station');

    // The decorative img (alt="") is a mouse convenience for the same
    // destination — a role/tabindex on it would duplicate the tab stop.
    const logo = document.querySelector('.app-toolbar__logo') as HTMLElement;
    expect(logo.getAttribute('role')).toBeNull();
    expect(logo.getAttribute('tabindex')).toBeNull();

    fireEvent.keyDown(home, { key: 'Enter' });
    expect(goHome).toHaveBeenCalledTimes(1);

    // Space over a link must keep scrolling the page, not navigate.
    fireEvent.keyDown(home, { key: ' ' });
    fireEvent.keyUp(home, { key: ' ' });
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['Stable', 'Station'],
    ['Beta', 'Station Beta'],
    ['Nightly', 'Station Nightly'],
    ['Dev', 'Station Dev (header-worktree)'],
  ])(
    'uses the local %s package identity for the home label',
    (_channel, name) => {
      breadcrumb = null;
      productName = name;
      render(<Header onToggleSettings={vi.fn()} onNavigate={onNavigate} />);

      expect(
        screen.getByRole('link', { name: `${name} home` }).textContent,
      ).toBe(name);
    },
  );

  test('a section breadcrumb with a route behind it is a keyboard link', () => {
    breadcrumb = { section: 'Agents', sectionRoot: { type: 'agents' } };
    render(<Header onToggleSettings={vi.fn()} onNavigate={onNavigate} />);

    const crumb = screen.getByText('Agents');
    expect(crumb.getAttribute('role')).toBe('link');

    fireEvent.keyDown(crumb, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith({ type: 'agents' });
  });

  test('a section breadcrumb with NO route is plain text — no role, no tab stop', () => {
    breadcrumb = { section: 'Settings' };
    render(<Header onToggleSettings={vi.fn()} onNavigate={onNavigate} />);

    const crumb = screen.getByText('Settings');
    expect(crumb.getAttribute('role')).toBeNull();
    expect(crumb.getAttribute('tabindex')).toBeNull();
  });
});
