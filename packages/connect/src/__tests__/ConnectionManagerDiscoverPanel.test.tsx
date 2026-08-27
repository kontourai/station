// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ConnectionManagerDiscoverPanel } from '../react/ConnectionManagerDiscoverPanel';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('connection candidate panel', () => {
  test('explains the browser-safe fallback instead of offering a subnet scan', () => {
    render(
      <ConnectionManagerDiscoverPanel
        discovering={false}
        candidates={[]}
        providers={[]}
        providerCount={0}
        existingUrls={new Set()}
        onRefresh={vi.fn()}
        onReview={vi.fn(async () => false)}
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/does not scan every address on your network/i),
    ).toBeTruthy();
    expect(screen.queryByText(/192\.168\.x\.1/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /scan/i })).toBeNull();
  });

  test('keeps provider suggestions ephemeral until a successful identity check', async () => {
    const onReview = vi.fn(async () => true);
    const onOpen = vi.fn();
    render(
      <ConnectionManagerDiscoverPanel
        discovering={false}
        candidates={[
          {
            candidateVersion: 1,
            id: 'candidate:tailnet:station',
            name: 'Media Station',
            url: 'https://station.example.ts.net',
            source: 'tailnet',
            providerId: 'native.tailnet',
            discoveredAt: Date.now(),
          },
        ]}
        providers={[{ providerId: 'native.tailnet', status: 'available' }]}
        providerCount={1}
        existingUrls={new Set()}
        onRefresh={vi.fn()}
        onReview={onReview}
        onOpen={onOpen}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText(/tailnet · unverified/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(onReview).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://station.example.ts.net' }),
    );
    const open = await screen.findByRole('button', { name: 'Open Station' });
    expect(
      screen.getByText(/station found · access not granted/i),
    ).toBeTruthy();
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://station.example.ts.net' }),
    );
  });

  test('serializes identity checks so rows cannot launch duplicate handshakes', async () => {
    const review = deferred<boolean>();
    const onReview = vi.fn(() => review.promise);
    render(
      <ConnectionManagerDiscoverPanel
        discovering={false}
        candidates={[
          {
            candidateVersion: 1,
            id: 'candidate:tailnet:first',
            name: 'First Station',
            url: 'https://first.example.ts.net',
            source: 'tailnet',
            providerId: 'native.tailnet',
            discoveredAt: Date.now(),
          },
          {
            candidateVersion: 1,
            id: 'candidate:tailnet:second',
            name: 'Second Station',
            url: 'https://second.example.ts.net',
            source: 'tailnet',
            providerId: 'native.tailnet',
            discoveredAt: Date.now(),
          },
        ]}
        providers={[{ providerId: 'native.tailnet', status: 'available' }]}
        providerCount={1}
        existingUrls={new Set()}
        onRefresh={vi.fn()}
        onReview={onReview}
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    const checks = screen.getAllByRole('button', { name: 'Check' });
    fireEvent.click(checks[0]);
    expect((checks[0] as HTMLButtonElement).disabled).toBe(true);
    expect((checks[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(checks[1]);
    expect(onReview).toHaveBeenCalledTimes(1);

    review.resolve(false);
    await screen.findByRole('alert');
    expect(
      (screen.getAllByRole('button', { name: 'Check' })[1] as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
