// @vitest-environment jsdom
/**
 * #4519: a Station whose managed policy allows no remote clients. The host
 * passes its explanation as `pairingRefusal`; every pairing entry in the
 * modal is then disabled or replaced, rather than offering a code the
 * server refuses with a generic error.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';
import { ConnectionManagerModal } from '../react/ConnectionManagerModal';
import { ConnectionsProvider } from '../react/ConnectionsContext';
import type { ConnectionManagerPanel } from '../react/connection-manager-modal-utils';

vi.mock('qrcode', () => ({ toCanvas: vi.fn(async () => undefined) }));

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

const REFUSAL = (
  <p>
    Acme’s policy manages remote access.{' '}
    <a href="https://help.acme.example">Get help</a>
  </p>
);

async function renderModal(
  initialPanel: ConnectionManagerPanel,
  pairingRefusal?: React.ReactNode,
) {
  // Pre-resolve the code-split body (see ConnectionManagerModalLazy.test).
  await import('../react/ConnectionManagerModalContent');
  const store = new ConnectionStore({ storage: memoryAdapter() });
  store.add('Desk Station', 'https://station.example.test');
  return render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModal
        isOpen
        onClose={vi.fn()}
        checkHealth={vi.fn(async () => true)}
        initialPanel={initialPanel}
        pairingRefusal={pairingRefusal}
      />
    </ConnectionsProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ConnectionManagerModal under a managed pairing refusal', () => {
  it('replaces the host pairing panel with the explanation, so no code is offered or requested', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ requests: [], devices: [] }),
    );
    vi.stubGlobal('fetch', fetch);
    await renderModal('pair-host', REFUSAL);
    expect(await screen.findByTestId('pairing-refusal')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Get help' })).toBeTruthy();
    expect(screen.queryByText('Create pairing code')).toBeNull();
    // Opening the panel did not ask the server for a pairing offer.
    expect(
      fetch.mock.calls.some(([url]) => String(url).includes('/pairing/offers')),
    ).toBe(false);
    // Paired devices stay reachable from it.
    fireEvent.click(screen.getByRole('button', { name: 'Paired devices' }));
    const approve = await screen.findByRole('button', {
      name: 'Approve another device',
    });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables "Connect another device" on the list and says why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ requests: [] })),
    );
    await renderModal('list', REFUSAL);
    const connect = await screen.findByRole('button', {
      name: 'Connect another device',
    });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    expect(connect.getAttribute('aria-describedby')).toBe(
      'connection-list-pairing-refusal',
    );
    expect(screen.getByRole('link', { name: 'Get help' })).toBeTruthy();
  });

  it('without a refusal the list offers pairing as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ requests: [] })),
    );
    await renderModal('list');
    const connect = await screen.findByRole('button', {
      name: 'Connect another device',
    });
    expect((connect as HTMLButtonElement).disabled).toBe(false);
  });
});
