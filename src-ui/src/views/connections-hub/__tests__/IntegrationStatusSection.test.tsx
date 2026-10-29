/** @vitest-environment jsdom */
import type { IntegrationActionStatus } from '@kontourai/station-contracts/integration-status';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  preview: true,
  operator: true,
  status: {} as any,
  readStatus: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  usePluginVisibilityQuery: () => ({ data: fixture.operator ? {} : undefined }),
  useIntegrationStatusQuery: (...args: unknown[]) => {
    fixture.readStatus(...args);
    return fixture.status;
  },
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.test',
    authorityKey: 'operator',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(fixture.preview ? ['chat-apps'] : []),
}));

import { IntegrationStatusSection } from '../IntegrationStatusSection';

function action(
  name: IntegrationActionStatus['action'],
  state: IntegrationActionStatus['state'],
  reason: string,
): IntegrationActionStatus {
  return { action: name, state, reason, computedBy: `${name}.probe` };
}

function show() {
  render(<IntegrationStatusSection />);
  fireEvent.click(screen.getByText('Integration status'));
}

describe('IntegrationStatusSection', () => {
  beforeEach(() => {
    fixture.preview = true;
    fixture.operator = true;
    fixture.readStatus.mockReset();
    fixture.refetch.mockReset();
    fixture.status = {
      data: {
        connections: [
          {
            connectionId: 'github',
            provider: 'github',
            actions: [
              action('read', 'works', 'Read probe passed.'),
              action(
                'write',
                'unverified',
                'Write permission was not checked.',
              ),
              action('link-pr', 'failed', 'GitHub authentication failed.'),
              action(
                'update-status',
                'not-configured',
                'No account configured.',
              ),
              action(
                'close-issue',
                'waiting-on-provider',
                'Waiting for tracker support.',
              ),
            ],
          },
        ],
      },
      isError: false,
      isFetching: false,
      refetch: fixture.refetch,
    };
  });

  test('renders each probed state and its reason on the status control', () => {
    show();
    expect(screen.getByText('GitHub')).toBeTruthy();
    for (const [name, reason] of [
      ['Read: Works', 'Read probe passed.'],
      ['Write: Unverified', 'Write permission was not checked.'],
      ['Link PR: Failed', 'GitHub authentication failed.'],
      ['Update status: Not configured', 'No account configured.'],
      ['Close issue: Not available yet', 'Waiting for tracker support.'],
    ]) {
      const chip = screen.getByRole('button', { name });
      expect(chip.getAttribute('title')).toBe(reason);
      fireEvent.click(chip);
      const details = screen.getByRole('status');
      expect(within(details).getByText(reason)).toBeTruthy();
      expect(within(details).getByText(/Probe:/)).toBeTruthy();
    }
  });

  test('a capability without a probe cannot render as works', () => {
    fixture.status.data.connections[0].actions = [
      { action: 'read', state: 'works', reason: 'Claimed success' },
    ];
    show();
    expect(screen.queryByRole('button', { name: 'Read: Works' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Read: Unverified' }));
    expect(
      within(screen.getByRole('status')).getByText(
        'No probe result is available.',
      ),
    ).toBeTruthy();
  });

  test('is absent while the preview is off or the operator read is refused', () => {
    fixture.preview = false;
    const { rerender } = render(<IntegrationStatusSection />);
    expect(fixture.readStatus).not.toHaveBeenCalled();
    fixture.preview = true;
    fixture.operator = false;
    rerender(<IntegrationStatusSection />);
    expect(fixture.readStatus).toHaveBeenLastCalledWith(
      'https://station.test',
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.queryByText('Integration status')).toBeNull();
    fixture.operator = true;
    fixture.status = {
      isError: true,
      error: new StationHttpError(403, 'Forbidden'),
      refetch: fixture.refetch,
    };
    rerender(<IntegrationStatusSection />);
    expect(screen.queryByText('Integration status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('offers an empty state and a retry on a non-authority failure', () => {
    fixture.status.data.connections = [];
    const { rerender } = render(<IntegrationStatusSection />);
    fireEvent.click(screen.getByText('Integration status'));
    expect(screen.getByText('No integration status available')).toBeTruthy();
    fixture.status = {
      isError: true,
      error: new Error('network'),
      refetch: fixture.refetch,
    };
    rerender(<IntegrationStatusSection />);
    expect(screen.getByText('Integration status unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fixture.refetch).toHaveBeenCalledOnce();
  });
});
