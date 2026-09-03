/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { launchChat, navigate, telemetryTrack } = vi.hoisted(() => ({
  launchChat: vi.fn().mockResolvedValue('session-1'),
  navigate: vi.fn(),
  telemetryTrack: vi.fn(),
}));

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
