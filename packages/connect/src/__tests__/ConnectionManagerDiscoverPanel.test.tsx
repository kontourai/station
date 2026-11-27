// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ConnectionCandidate } from '../core/types';
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

  test('keeps the busy retry control focused and ignores activation until ready', () => {
    const onRefresh = vi.fn();
    const props = {
      candidates: [],
      providers: [],
      providerCount: 1,
      existingUrls: new Set<string>(),
      onRefresh,
      onSelect: vi.fn(),
    };
    const view = render(
      <ConnectionManagerDiscoverPanel {...props} discovering={false} />,
    );
    screen.getByRole('button', { name: 'Check again' }).focus();
    view.rerender(<ConnectionManagerDiscoverPanel {...props} discovering />);
    const check = screen.getByRole('button', { name: 'Checking…' });
    expect(check.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(check);
    fireEvent.click(check);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  test.each([
    ['permission-required', /After returning to Station, choose Check again/],
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

  test.each([
    ['a new network address', 'http://studio.local:3141', false, true],
    ['numeric loopback', 'http://127.0.0.1:3141', false, false],
    ['the current browser origin', window.location.origin, false, false],
    ['a saved network address', 'http://studio.local:3141', true, false],
  ] as const)(
    'reports HTTP risk and discovery state for %s',
    (_scenario, url, saved, consentRequired) => {
      const candidate: ConnectionCandidate = {
        id: 'lan:studio',
        candidateVersion: 1,
        name: 'StudioStation'.repeat(8),
        url,
        source: 'lan-dns-sd',
        providerId: 'native.lan',
        discoveredAt: 0,
      };
      const select = vi.fn();
      render(
        <ConnectionManagerDiscoverPanel
          discovering={false}
          candidates={[candidate]}
          providers={[]}
          providerCount={1}
          existingUrls={new Set(saved ? [url] : [])}
          onRefresh={vi.fn()}
          onSelect={select}
          onBack={vi.fn()}
        />,
      );

      expect(
        screen.getByText(
          saved
            ? 'Local network · Unverified'
            : 'Local network · Unverified · Access not granted',
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          consentRequired
            ? 'Unencrypted HTTP · consent required'
            : 'Unencrypted HTTP',
        ),
      ).toBeTruthy();
      const summary = screen.getByText('Connection details');
      const disclosure = summary.closest('details');
      expect(disclosure?.open).toBe(false);
      fireEvent.click(summary);
      expect(disclosure?.open).toBe(true);
      expect(disclosure?.textContent).toContain(candidate.name);
      expect(disclosure?.textContent).toContain(candidate.url);
      expect(select).not.toHaveBeenCalled();

      const requestName = `Request access to ${candidate.name}`;
      if (saved) {
        expect(screen.getByText('Saved')).toBeTruthy();
        expect(screen.queryByRole('button', { name: requestName })).toBeNull();
      } else {
        fireEvent.click(screen.getByRole('button', { name: requestName }));
        expect(select).toHaveBeenCalledExactlyOnceWith(candidate);
      }
    },
  );
});
