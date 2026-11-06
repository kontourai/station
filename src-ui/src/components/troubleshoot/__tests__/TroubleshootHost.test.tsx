/**
 * @vitest-environment jsdom
 *
 * #4470: the start flow behind every troubleshoot entry point. The host runs
 * on the open event, so these tests dispatch it exactly as the help menu,
 * palette and Settings do.
 */

import type { TroubleshootPrepareResponse } from '@kontourai/station-contracts/troubleshoot';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OPEN_REPORT_PROBLEM_EVENT } from '../../../lib/reportProblemEvents';
import { requestTroubleshoot } from '../../../lib/troubleshootEvents';

const mocks = vi.hoisted(() => ({
  agent: null as Record<string, unknown> | null,
  capability: vi.fn<() => Promise<boolean | null>>(),
  prepare: vi.fn(),
  launchChat: vi.fn(),
  upsertToast: vi.fn((_options: Record<string, unknown>) => 'toast-id'),
  dismissToast: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: [] }),
  usePrepareTroubleshootMutation: () => ({ mutateAsync: mocks.prepare }),
}));
vi.mock('@kontourai/station-sdk/client', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk/client')>()),
  readTroubleshootCapability: mocks.capability,
}));
vi.mock('../../../contexts/AgentsContext', () => ({
  useAgent: (slug: string) => (slug === 'station' ? mocks.agent : null),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://viewed-station.test' }),
}));
vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({
    upsertToast: mocks.upsertToast,
    dismissToast: mocks.dismissToast,
  }),
}));
vi.mock('../../../hooks/useActiveChatSessions', () => ({
  useLaunchChat:
    (apiBase: string) =>
    (...args: unknown[]) =>
      mocks.launchChat(apiBase, ...args),
}));
// Any navigation would be a silent detour to engine settings.
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: mocks.navigate }),
}));

const { TroubleshootHost } = await import('../TroubleshootHost');

const PREPARED: TroubleshootPrepareResponse = {
  runId: '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a',
  agentId: 'station',
  ambientContext: 'Station troubleshooting session (playbook v2, run …).',
  openingMessage: "I'd like help troubleshooting a problem with Station.",
  display: {
    stationName: 'studio-mac',
    version: '0.1.11',
    channel: 'nightly',
    sourceRevision: 'a'.repeat(40),
    platform: 'darwin',
    surface: 'desktop',
    role: 'owner',
    serverLogs: 'available',
  },
  cliCommand: 'station triage',
};

const RUNNABLE_STATION = {
  slug: 'station',
  name: 'Station Assistant',
  available: true,
};

let reportProblem: ReturnType<typeof vi.fn<(event: Event) => void>>;

beforeEach(() => {
  mocks.agent = RUNNABLE_STATION;
  mocks.capability.mockResolvedValue(true);
  mocks.prepare.mockResolvedValue(PREPARED);
  mocks.launchChat.mockResolvedValue('session-1');
  reportProblem = vi.fn<(event: Event) => void>();
  window.addEventListener(OPEN_REPORT_PROBLEM_EVENT, reportProblem);
});

afterEach(() => {
  window.removeEventListener(OPEN_REPORT_PROBLEM_EVENT, reportProblem);
  vi.clearAllMocks();
});

async function openTroubleshoot() {
  render(<TroubleshootHost />);
  await act(async () => {
    requestTroubleshoot();
  });
}

describe('TroubleshootHost', () => {
  test('prepares on the viewed Station and starts a no-project conversation with the Station Assistant', async () => {
    await openTroubleshoot();
    expect(mocks.capability).toHaveBeenCalledWith('http://viewed-station.test');
    expect(mocks.prepare).toHaveBeenCalledTimes(1);

    expect(
      await screen.findByRole('heading', { name: 'What went wrong?' }),
    ).toBeTruthy();
    expect(screen.getByTestId('troubleshoot-station').textContent).toBe(
      'studio-mac',
    );
    expect(screen.getByTestId('troubleshoot-version').textContent).toBe(
      '0.1.11 · nightly',
    );
    expect(screen.getByText('station triage')).toBeTruthy();

    fireEvent.change(screen.getByTestId('troubleshoot-description'), {
      target: { value: 'Pairing my phone fails after the update.' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Start troubleshooting' }),
    );

    await waitFor(() => expect(mocks.launchChat).toHaveBeenCalledTimes(1));
    const [apiBase, agentSlug, agentName, message, projectSlug, , , ambient] =
      mocks.launchChat.mock.calls[0]!;
    expect(apiBase).toBe('http://viewed-station.test');
    expect(agentSlug).toBe('station');
    expect(agentName).toBe('Station Assistant');
    expect(message).toBe('Pairing my phone fails after the update.');
    expect(projectSlug).toBeUndefined();
    expect(ambient).toBe(PREPARED.ambientContext);
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'What went wrong?' }),
      ).toBeNull(),
    );
  });

  test('turns an error entry point’s facts into the prepare seed, with the route at dispatch time', async () => {
    window.history.pushState({}, '', '/projects/demo?token=abc123#frag');
    try {
      render(<TroubleshootHost />);
      await act(async () => {
        requestTroubleshoot({
          code: 'runtime-error',
          message: 'Engine exited\n    at run (/Users/alice/station/x.ts:1:2)',
          conversationId: 'conv-1',
          turnId: 'turn-1',
        });
      });
      await waitFor(() =>
        expect(mocks.prepare).toHaveBeenCalledWith({
          seed: {
            route: '/projects/demo',
            errorSummary: 'runtime-error: Engine exited',
            conversationId: 'conv-1',
            turnId: 'turn-1',
          },
        }),
      );
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  test('sends no seed for an open event with no facts', async () => {
    await openTroubleshoot();
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith({}));
  });

  test('an error entry point falls back like the help menu when the assistant has no engine', async () => {
    mocks.agent = { ...RUNNABLE_STATION, available: false };
    render(<TroubleshootHost />);
    await act(async () => {
      requestTroubleshoot({ code: 'HTTP 500', message: 'Boom' });
    });
    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  test('sends the opening message when the description is left empty', async () => {
    await openTroubleshoot();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start troubleshooting' }),
    );
    await waitFor(() => expect(mocks.launchChat).toHaveBeenCalledTimes(1));
    expect(mocks.launchChat.mock.calls[0]![3]).toBe(PREPARED.openingMessage);
  });

  test('with no usable engine, opens Report a problem and shows the CLI command without preparing or navigating', async () => {
    mocks.agent = {
      ...RUNNABLE_STATION,
      available: false,
      unavailableReason: 'No engine connected.',
    };
    await openTroubleshoot();
    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.launchChat).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.upsertToast).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining('station triage'),
        actions: [expect.objectContaining({ label: 'Copy station triage' })],
      }),
    );
  });

  test('falls back the same way when the viewed Station lacks the capability', async () => {
    mocks.capability.mockResolvedValue(false);
    await openTroubleshoot();
    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  test('a failed prepare shows a failure toast offering Report a problem and the CLI command', async () => {
    mocks.prepare.mockRejectedValue(new Error('HTTP 500'));
    await openTroubleshoot();
    const failure = mocks.upsertToast.mock.calls
      .map(([options]) => options as Record<string, any>)
      .find((options) => options.tone === 'error');
    expect(failure).toMatchObject({ detail: 'Try again in a moment.' });
    expect(failure!.actions.map((a: { label: string }) => a.label)).toEqual([
      'Report a problem',
      'Copy station triage',
    ]);
    failure!.actions[0].onClick();
    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('heading', { name: 'What went wrong?' }),
    ).toBeNull();
  });
});
