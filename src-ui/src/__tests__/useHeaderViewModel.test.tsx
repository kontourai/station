/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { launchChat, navigate, showSurface, telemetryTrack } = vi.hoisted(
  () => ({
    launchChat: vi.fn().mockResolvedValue('session-1'),
    navigate: vi.fn(),
    showSurface: vi.fn(),
    telemetryTrack: vi.fn(),
  }),
);

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: telemetryTrack },
  useEngineConnectionsQuery: () => ({ data: [] }),
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
// #928 C2a: `goHome` reveals the Home surface through the region command
// hook, which needs a `RegionModelProvider` this hook-level harness does not
// mount. `HeaderHomeSurface.test.tsx` asserts the reveal itself.
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useLaunchChat: () => launchChat,
}));
vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => '⌘,',
}));
vi.mock('../utils/execution', () => ({
  resolveAgentExecution: () => ({ provider: 'station-agent' }),
  canAgentStartChat: () => true,
}));

import { useHeaderViewModel } from '../components/header/useHeaderViewModel';

/**
 * #1523: the header holds both meanings of "go to `/`". `goHome` is Home BY
 * NAME (the Home surface); the profile toggle's return is a dismissal — back
 * to `/` and whatever occupies `main` — and must not route through the
 * surface reveal, or a user who had Activity in `main` loses it on the way
 * out of their profile.
 */
describe('useHeaderViewModel home producers', () => {
  beforeEach(() => {
    navigate.mockClear();
    showSurface.mockClear();
  });

  test('goHome reveals the Home surface and does not navigate itself', () => {
    const { result } = renderHook(() =>
      useHeaderViewModel({
        currentView: { type: 'profile' },
        agents: [],
        onNavigate: vi.fn(),
      }),
    );

    act(() => result.current.goHome());

    expect(showSurface).toHaveBeenCalledWith('home');
    expect(navigate).not.toHaveBeenCalled();
  });

  test('the profile toggle returns to the outlet, whatever occupies main, and NOT to the Home surface', () => {
    const onNavigate = vi.fn();
    const { result } = renderHook(() =>
      useHeaderViewModel({
        currentView: { type: 'profile' },
        agents: [],
        onNavigate,
      }),
    );

    act(() => result.current.openProfile());

    expect(navigate).toHaveBeenCalledWith('/');
    expect(showSurface).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  test('the profile toggle opens the profile from any other view', () => {
    const onNavigate = vi.fn();
    const { result } = renderHook(() =>
      useHeaderViewModel({
        currentView: { type: 'settings' },
        agents: [],
        onNavigate,
      }),
    );

    act(() => result.current.openProfile());

    expect(onNavigate).toHaveBeenCalledWith({ type: 'profile' });
    expect(navigate).not.toHaveBeenCalled();
    expect(showSurface).not.toHaveBeenCalled();
  });
});

describe('useHeaderViewModel help launch', () => {
  beforeEach(() => {
    launchChat.mockClear();
    navigate.mockClear();
    telemetryTrack.mockClear();
  });

  test('uses the canonical launcher once with routed project context and bounded telemetry', async () => {
    const { result } = renderHook(() =>
      useHeaderViewModel({
        currentView: { type: 'project', slug: 'alpha' },
        // The binding is the shape `GET /api/agents` really returns for the
        // station row (`execution.agentConnectionId: 'station'`). It became
        // load-bearing when the header's target selection started consulting
        // the shared `agentRunnability` predicate, which — unlike the mocked
        // `canAgentStartChat` above — is real code here and correctly refuses
        // an Agent bound to no engine at all.
        agents: [
          {
            slug: 'station',
            name: 'Station Agent',
            execution: { agentConnectionId: 'station' },
          },
        ] as any,
        onNavigate: vi.fn(),
      }),
    );

    act(() => result.current.handleHelpPrompt('Help with this project'));

    await waitFor(() => expect(launchChat).toHaveBeenCalledOnce());
    expect(launchChat).toHaveBeenCalledWith(
      'station',
      'Station Agent',
      'Help with this project',
      'alpha',
      undefined,
      { provider: 'station-agent' },
    );
    await waitFor(() =>
      expect(telemetryTrack).toHaveBeenCalledWith('ui.chat.entry', {
        source: 'header-help',
        outcome: 'launched',
        projectScoped: 1,
      }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  test('navigates to Connections and records no-target without attempting a send', () => {
    const { result } = renderHook(() =>
      useHeaderViewModel({
        currentView: undefined,
        agents: [],
        onNavigate: vi.fn(),
      }),
    );

    act(() => result.current.handleHelpPrompt('Help'));

    expect(launchChat).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/connections/engines');
    expect(telemetryTrack).toHaveBeenCalledWith('ui.chat.entry', {
      source: 'header-help',
      outcome: 'no-target',
      projectScoped: 0,
    });
  });

  test('records a rejected send without leaving an unhandled help-launch promise', async () => {
    launchChat.mockRejectedValueOnce(new Error('send failed'));
    const { result } = renderHook(() =>
      useHeaderViewModel({
        currentView: undefined,
        // The binding is the shape `GET /api/agents` really returns for the
        // station row (`execution.agentConnectionId: 'station'`). It became
        // load-bearing when the header's target selection started consulting
        // the shared `agentRunnability` predicate, which — unlike the mocked
        // `canAgentStartChat` above — is real code here and correctly refuses
        // an Agent bound to no engine at all.
        agents: [
          {
            slug: 'station',
            name: 'Station Agent',
            execution: { agentConnectionId: 'station' },
          },
        ] as any,
        onNavigate: vi.fn(),
      }),
    );

    act(() => result.current.handleHelpPrompt('Help'));

    await waitFor(() =>
      expect(telemetryTrack).toHaveBeenCalledWith('ui.chat.entry', {
        source: 'header-help',
        outcome: 'send-failed',
        projectScoped: 0,
      }),
    );
  });
});
