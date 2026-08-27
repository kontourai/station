/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { MonitoringViewBoundary } from '../MonitoringErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('boom');
  }
  return <div>Monitoring content</div>;
}

describe('MonitoringErrorBoundary', () => {
  test('renders an ErrorState fallback with a Reload action when a child throws', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    render(
      <MonitoringViewBoundary>
        <Bomb shouldThrow={true} />
      </MonitoringViewBoundary>,
    );

    expect(
      screen.getByText('Something went wrong in the monitoring view.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();

    consoleErrorSpy.mockRestore();
  });

  test('resets on Reload so children can render again once the error condition clears', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    let shouldThrow = true;
    function Rerenderable() {
      return <Bomb shouldThrow={shouldThrow} />;
    }

    const { rerender } = render(
      <MonitoringViewBoundary>
        <Rerenderable />
      </MonitoringViewBoundary>,
    );

    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    rerender(
      <MonitoringViewBoundary>
        <Rerenderable />
      </MonitoringViewBoundary>,
    );

    expect(screen.getByText('Monitoring content')).toBeTruthy();

    consoleErrorSpy.mockRestore();
  });
});
