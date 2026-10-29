// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../../../contexts/banner-store';
import {
  SetupReturnNotice,
  StationDetailsHost,
  WorkspaceStationState,
} from '../StationConditions';
import { openStationDetails } from '../stationDetailsEvents';

const selected = vi.hoisted(() => ({
  apiBase: 'https://station.test',
  activeConnection: {
    id: 'station-one',
    name: 'Studio Station',
    url: 'https://station.test',
  },
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => selected,
}));
beforeEach(() => {
  bannerStore.reset();
  selected.apiBase = 'https://station.test';
  selected.activeConnection = {
    id: 'station-one',
    name: 'Studio Station',
    url: selected.apiBase,
  };
});
afterEach(() => bannerStore.reset());

test('opens local Station facts only on request and closes the panel when selection changes', () => {
  const view = render(<StationDetailsHost />);
  expect(screen.queryByRole('dialog')).toBeNull();
  act(openStationDetails);
  const details = screen.getByRole('dialog', { name: 'Station details' });
  expect(within(details).getByText('Studio Station')).toBeTruthy();
  expect(within(details).getByText('https://station.test')).toBeTruthy();
  expect(
    within(details).getByText('No additional Station notices.'),
  ).toBeTruthy();
  selected.apiBase = 'https://other.test';
  selected.activeConnection = {
    id: 'station-two',
    name: 'Other Station',
    url: selected.apiBase,
  };
  view.rerender(<StationDetailsHost />);
  expect(screen.queryByRole('dialog')).toBeNull();
  act(openStationDetails);
  expect(screen.getByText('Other Station')).toBeTruthy();
  expect(screen.queryByText('Studio Station')).toBeNull();
});

test('keeps routine connection information in details and exposes a workspace restriction only while work is blocked', () => {
  bannerStore.present({
    id: BANNER_IDS.offline,
    priority: BANNER_PRIORITY.connectionTransient,
    tone: 'warning',
    message: 'Check this Station address.',
  });
  render(
    <>
      <WorkspaceStationState />
      <StationDetailsHost />
    </>,
  );
  expect(screen.queryByRole('status')).toBeNull();
  act(openStationDetails);
  expect(screen.getByText('Check this Station address.')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Close Station details' }),
  );
  act(() =>
    bannerStore.present({
      id: BANNER_IDS.credential,
      priority: BANNER_PRIORITY.connectionBlocking,
      tone: 'blocked',
      message: 'Station access is required.',
      detail: 'Request access before resuming work.',
    }),
  );
  const workspace = screen.getByRole('status');
  expect(workspace.textContent).toContain('Station access is required.');
  expect(screen.queryByText('Request access before resuming work.')).toBeNull();
  fireEvent.click(
    within(workspace).getByRole('button', { name: 'Review Station' }),
  );
  expect(
    within(screen.getByRole('dialog')).getByText(
      'Request access before resuming work.',
    ),
  ).toBeTruthy();
  act(() => bannerStore.clear(BANNER_IDS.credential));
  expect(screen.queryByRole('status')).toBeNull();
});

test('keeps setup-return guidance and its action in the current workspace instead of Station details', () => {
  const resume = vi.fn();
  const id = 'chrome:new-chat:setup-return:project-one';
  bannerStore.present({
    id,
    priority: BANNER_PRIORITY.setup,
    tone: 'info',
    message: 'Provider setup is ready to resume.',
    actions: [{ label: 'Resume setup', onClick: resume }],
  });
  render(
    <>
      <main>
        <SetupReturnNotice />
      </main>
      <StationDetailsHost />
    </>,
  );
  const workspace = screen.getByRole('main');
  expect(
    within(workspace).getByText('Provider setup is ready to resume.'),
  ).toBeTruthy();
  fireEvent.click(
    within(workspace).getByRole('button', { name: 'Resume setup' }),
  );
  expect(resume).toHaveBeenCalledOnce();
  act(openStationDetails);
  expect(
    within(screen.getByRole('dialog')).queryByText(
      'Provider setup is ready to resume.',
    ),
  ).toBeNull();
  act(() => bannerStore.clear(id));
  expect(
    within(workspace).queryByRole('button', { name: 'Resume setup' }),
  ).toBeNull();
});
