/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { FullScreenError } from '../components/Loading';

describe('FullScreenError', () => {
  test('renders the legacy onRetry + secondaryAction buttons (back-compat)', () => {
    const onRetry = vi.fn();
    const onSecondary = vi.fn();
    render(
      <FullScreenError
        title="Can't reach server"
        description="Check the host is running."
        onRetry={onRetry}
        retryLabel="Manage Connections"
        secondaryAction={{ label: 'Advanced', onClick: onSecondary }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Manage Connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  test('renders an actions[] set and fires each handler', () => {
    const restart = vi.fn();
    const viewLog = vi.fn();
    const connect = vi.fn();
    render(
      <FullScreenError
        title="Station's local service stopped"
        actions={[
          { label: 'Restart Station', variant: 'primary', onClick: restart },
          { label: 'View log', variant: 'secondary', onClick: viewLog },
          { label: 'Connect to a remote host instead', onClick: connect },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restart Station' }));
    fireEvent.click(screen.getByRole('button', { name: 'View log' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Connect to a remote host instead',
      }),
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(viewLog).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test('actions[] replaces the legacy button pair when both are provided', () => {
    const onRetry = vi.fn();
    render(
      <FullScreenError
        title="Failed"
        onRetry={onRetry}
        retryLabel="Try Again"
        actions={[{ label: 'Restart Station', onClick: vi.fn() }]}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Restart Station' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();
  });

  test('surfaces an optional monospace detail block', () => {
    render(
      <FullScreenError
        title="Station's local service stopped"
        detail={'Log: /tmp/station-server.log\n\npanic: boom'}
      />,
    );

    expect(screen.getByText(/Log: \/tmp\/station-server\.log/)).toBeTruthy();
    expect(screen.getByText(/panic: boom/)).toBeTruthy();
  });
});
