// @vitest-environment jsdom

import { pairingScopePresetString } from '@kontourai/station-contracts';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import { encodeDevicePairingPayload } from '../core/devicePairing';
import type { StorageAdapter } from '../core/types';
import { ConnectionManagerModalContent } from '../react/ConnectionManagerModalContent';
import { ConnectionsProvider } from '../react/ConnectionsContext';

function memoryAdapter(): StorageAdapter {
  const values: Record<string, string> = {};
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

describe('Connection Manager pairing deep links', () => {
  it('switches an already-open list modal to Join when a payload arrives', async () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const payload = encodeDevicePairingPayload({
      protocolVersion: 1,
      environmentId: 'environment-link',
      offerId: 'offer-link',
      challenge: 'challenge-link',
      manualCode: 'ABCDE12345',
      endpoint: 'https://station.example.ts.net',
      scope: pairingScopePresetString('standard'),
      expiresAt: Date.now() + 60_000,
    });
    const renderContent = (initialPairingPayload?: string) => (
      <ConnectionsProvider store={store}>
        <ConnectionManagerModalContent
          onClose={vi.fn()}
          checkHealth={vi.fn(async () => true)}
          initialPanel="list"
          initialPairingPayload={initialPairingPayload}
        />
      </ConnectionsProvider>
    );
    const view = render(renderContent());

    expect(screen.queryByText('Review pairing offer')).toBeNull();
    await act(async () => view.rerender(renderContent(payload)));

    expect(screen.getByText('Review pairing offer')).toBeTruthy();
  });
});
