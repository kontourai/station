/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/**
 * The Home role's production grant surface (archive#3122). These
 * prove the wiring that the independent review found absent — a real,
 * reachable channel — and its shape: the button only OPENS a request and
 * hands the decision to the isolated review page; nothing here (or anywhere
 * same-origin) writes a grant.
 */

const sdk = vi.hoisted(() => ({
  status: { state: 'none' } as unknown,
  candidates: [] as unknown[],
  createRequest: vi.fn(),
  fetchRequest: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useWorkspaceHomeRoleQuery: () => ({ data: sdk.status }),
  useWorkspaceHomeRoleCandidatesQuery: () => ({ data: sdk.candidates }),
  useRevokeWorkspaceHomeRoleMutation: () => ({
    mutate: sdk.revoke,
    isPending: false,
  }),
  createWorkspaceHomeRoleRequest: (...args: unknown[]) =>
    sdk.createRequest(...args),
  fetchWorkspaceHomeRoleRequest: (...args: unknown[]) =>
    sdk.fetchRequest(...args),
  WORKSPACE_HOME_ROLE_QUERY_KEY: ['workspace-home-role'],
}));

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const nativeBroker = vi.hoisted(() => ({
  reviewer: null as
    | null
    | ((requestId: string) => Promise<{ status: string; value?: unknown }>),
}));

vi.mock('../../../platform/native/useNativeConsentBroker', () => ({
  useNativeConsentBroker: () => nativeBroker.reviewer,
}));

import { WorkspaceHomeRoleSection } from '../WorkspaceHomeRoleSection';

beforeEach(() => {
  nativeBroker.reviewer = null;
  sdk.status = { state: 'none' };
  sdk.candidates = [
    {
      pluginName: 'third-party-home',
      paneId: 'third-party-home-home',
      name: 'Third-party Home Pane',
      version: '3.1.0',
    },
  ];
  sdk.createRequest = vi.fn();
  sdk.fetchRequest = vi.fn();
  sdk.revoke = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('renders nothing for a plugin with no eligible panes and no role', () => {
  sdk.candidates = [];
  const { container } = render(
    <WorkspaceHomeRoleSection pluginName="some-plugin" />,
  );
  expect(container.firstChild).toBeNull();
});

test('an eligible pane offers the explicit grant act, which opens the isolated review page rather than granting', async () => {
  sdk.createRequest.mockResolvedValue({
    id: 'req-1',
    status: 'pending',
    reviewUrl: '/api/plugins/home-role/requests/req-1/review',
  });
  sdk.fetchRequest.mockResolvedValue({ id: 'req-1', status: 'approved' });
  const opened: string[] = [];
  const reviewWindow = {
    opener: {} as unknown,
    closed: false,
    location: {
      replace: (url: string) => {
        opened.push(url);
      },
    },
  };
  vi.spyOn(window, 'open').mockReturnValue(reviewWindow as unknown as Window);

  render(<WorkspaceHomeRoleSection pluginName="third-party-home" />);
  fireEvent.click(screen.getByRole('button', { name: 'Use as Home…' }));

  await waitFor(() =>
    expect(sdk.createRequest).toHaveBeenCalledWith({
      pluginName: 'third-party-home',
      paneId: 'third-party-home-home',
    }),
  );
  await waitFor(() => expect(opened.length).toBe(1));
  expect(opened[0]).toBe(
    'http://localhost:3141/api/plugins/home-role/requests/req-1/review',
  );
// The popup is severed from this page — the review page must not be
// scriptable through window.opener.
  expect(reviewWindow.opener).toBeNull();
// Nothing here decided anything: no grant write exists in this component's
// reachable surface at all (the SDK exposes none).
});

test('on a native-broker host the grant opens NO popup and hands the transaction to native chrome (station#3677 PR 3)', async () => {
  sdk.createRequest.mockResolvedValue({
    id: 'req-native',
    status: 'pending',
    reviewUrl: '/api/plugins/home-role/requests/req-native/review',
  });
  const reviewed: string[] = [];
  nativeBroker.reviewer = async (requestId: string) => {
    reviewed.push(requestId);
    return { status: 'ok', value: { status: 'approved' } };
  };
  const open = vi.spyOn(window, 'open');

  render(<WorkspaceHomeRoleSection pluginName="third-party-home" />);
  fireEvent.click(screen.getByRole('button', { name: 'Use as Home…' }));

  await waitFor(() => expect(reviewed).toEqual(['req-native']));
// The webview path is bypassed entirely: no popup, no status-poll loop —
// the native host settles the decision server-side with its own
// local-grant credential and this component only waits for the outcome.
  expect(open).not.toHaveBeenCalled();
  expect(sdk.fetchRequest).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Use as Home…' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
});

test('a native-broker refusal surfaces its message instead of granting silently', async () => {
  sdk.createRequest.mockResolvedValue({
    id: 'req-refused',
    status: 'pending',
    reviewUrl: '/api/plugins/home-role/requests/req-refused/review',
  });
  nativeBroker.reviewer = async () => ({
    status: 'error',
    message: 'The approval could not be reviewed',
  });
  const open = vi.spyOn(window, 'open');

  render(<WorkspaceHomeRoleSection pluginName="third-party-home" />);
  fireEvent.click(screen.getByRole('button', { name: 'Use as Home…' }));

  await waitFor(() =>
    expect(
      screen.queryByText('The approval could not be reviewed'),
    ).not.toBeNull(),
  );
  expect(open).not.toHaveBeenCalled();
});

test('the plugin currently holding the role offers revocation', () => {
  sdk.status = {
    state: 'granted',
    grant: {
      descriptor: {
        id: 'third-party-home-home',
        name: 'Third-party Home Pane',
        provenance: { origin: 'plugin', pluginId: 'third-party-home' },
      },
    },
  };
  render(<WorkspaceHomeRoleSection pluginName="third-party-home" />);
  fireEvent.click(screen.getByRole('button', { name: 'Use built-in Home' }));
  expect(sdk.revoke).toHaveBeenCalledTimes(1);
});
