// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ConnectionManagerDiscoverPanel } from '../react/ConnectionManagerDiscoverPanel';

describe('connection candidate panel', () => {
  test('offers QR and address alternatives when discovery is unsupported', () => {
    render(
      <ConnectionManagerDiscoverPanel
        discovering={false}
        candidates={[]}
        providers={[]}
        providerCount={0}
        existingUrls={new Set()}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Scan a QR code, enter a pairing code/i),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /scan/i })).toBeNull();
  });

  test.each([
    ['permission-required', /access is needed/],
    ['permission-denied', /permission is denied/],
    ['unavailable', /discovery is unavailable/],
    ['timed-out', /did not finish in time/],
    ['cancelled', /Discovery stopped/],
    ['failed', /discovery failed/],
    ['empty', /No Stations found/],
  ] as const)(
    'reports %s truthfully and offers an explicit retry',
    (status, message) => {
      const refresh = vi.fn();
      render(
        <ConnectionManagerDiscoverPanel
          discovering={false}
          candidates={[]}
          providers={[{ providerId: 'native.lan', status }]}
          providerCount={1}
          existingUrls={new Set()}
          onRefresh={refresh}
          onSelect={vi.fn()}
          onBack={vi.fn()}
        />,
      );
      expect(screen.getByRole('status').textContent).toMatch(message);
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      expect(refresh).toHaveBeenCalledOnce();
    },
  );
});
