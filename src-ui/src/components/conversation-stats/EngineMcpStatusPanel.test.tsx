/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { EngineMcpStatusPanel } from './EngineMcpStatusPanel';
import { formatReportedCost } from './utils';

const servers = [
  {
    name: 'remote',
    state: 'needs-auth',
    error: 'Unauthorized',
    scope: 'engine-config',
  },
  {
    name: 'cron',
    state: 'failed',
    error: 'spawn failed',
    scope: 'engine-config',
  },
  { name: 'local', state: 'ready', toolCount: 3, scope: 'session' },
  { name: 'later', state: 'starting', scope: 'engine-config' },
] as const;

describe('EngineMcpStatusPanel', () => {
  test('lists each server with its state, error and tool count', () => {
    render(<EngineMcpStatusPanel servers={[...servers]} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'remoteSign-in neededUnauthorized',
      'cronFailedspawn failed',
      'localReady3 tools',
      'laterStarting',
    ]);
    // Without a reconnect seam there is no action to offer.
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('Sign in asks for an OAuth start; Reconnect does not', () => {
    const onReconnect = vi.fn();
    render(
      <EngineMcpStatusPanel servers={[...servers]} onReconnect={onReconnect} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in: remote' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect: cron' }));
    expect(onReconnect.mock.calls).toEqual([
      ['remote', { startOAuth: true }],
      ['cron', { startOAuth: false }],
    ]);
    // A ready or starting server offers nothing.
    const local = screen.getByText('local').closest('li')!;
    expect(within(local).queryByRole('button')).toBeNull();
  });

  test('a pending reconnect disables only that server', () => {
    render(
      <EngineMcpStatusPanel
        servers={[...servers]}
        onReconnect={vi.fn()}
        pendingServer="cron"
      />,
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Reconnect: cron',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Sign in: remote',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test('renders nothing for an engine that reported no servers', () => {
    const { container } = render(<EngineMcpStatusPanel servers={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('formatReportedCost', () => {
  test.each([
    [{ amount: 0.0745, unit: 'credit' }, '0.0745 credits'],
    [{ amount: 1, unit: 'credit' }, '1.00 credit'],
    [{ amount: 12.5, unit: 'credits' }, '12.50 credits'],
    [{ amount: 1.2, unit: 'EUR' }, '1.20 EUR'],
    [{ amount: 250, unit: 'USD' }, '250 USD'],
  ])('%j reads %s, in the engine unit, never as $', (cost, text) => {
    expect(formatReportedCost(cost)).toBe(text);
    expect(formatReportedCost(cost)).not.toContain('$');
  });
});
