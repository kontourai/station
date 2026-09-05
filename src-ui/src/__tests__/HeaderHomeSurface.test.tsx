/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { navigate, showSurface } = vi.hoisted(() => ({
  navigate: vi.fn(),
  showSurface: vi.fn(),
}));

// The REAL `useHeaderViewModel` runs here (unlike `HeaderChrome.test.tsx`,
// which stubs it): the subject is what the brand link's click reaches.
vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
  useEngineConnectionsQuery: () => ({ data: [] }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useLaunchChat: () => vi.fn(),
}));
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: vi.fn(),
  useShortcutDisplay: () => '⌘,',
}));
vi.mock('../utils/execution', () => ({
  resolveAgentExecution: () => ({ provider: 'station-agent' }),
  canAgentStartChat: () => true,
}));
vi.mock('../components/header/HeaderActions', () => ({
  HeaderActions: () => null,
}));
vi.mock('../components/header/LayoutSwitcher', () => ({
  LayoutSwitcher: () => null,
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ productName: 'Station' }),
}));

import { Header } from '../components/header/Header';

/**
 * #928 C2a: the brand link is labelled "<product> home" — it means Home BY
 * NAME, so it reveals the Home surface (`showSurface('home')` places it in
 * `main` and the region model navigates to `/`). A header that navigated to
 * `/` itself would show whatever surface occupies `main`.
 */
describe('the header brand link reveals the Home surface', () => {
  beforeEach(() => {
    navigate.mockClear();
    showSurface.mockClear();
  });

  test('clicking "Station home" calls showSurface(home) and does not navigate', () => {
    render(<Header onToggleSettings={vi.fn()} onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByRole('link', { name: 'Station home' }));

    expect(showSurface).toHaveBeenCalledTimes(1);
    expect(showSurface).toHaveBeenCalledWith('home');
    expect(navigate).not.toHaveBeenCalled();
  });
});
