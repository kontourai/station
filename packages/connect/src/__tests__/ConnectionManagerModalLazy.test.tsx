// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';
import { ConnectionManagerModal } from '../react/ConnectionManagerModal';
import { ConnectionsProvider } from '../react/ConnectionsContext';

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

function renderModal(isOpen: boolean, listFooterContent?: ReactNode) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  store.add('Remote Station', 'https://station.example.test');
  return render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModal
        isOpen={isOpen}
        onClose={vi.fn()}
        checkHealth={vi.fn(async () => false)}
        listFooterContent={listFooterContent}
      />
    </ConnectionsProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The modal body is code-split so it stays out of the first-paint bundle.
// These pin the boundary itself: nothing renders (and nothing is fetched) while
// closed, and the real body — not the loading placeholder — is what appears once
// the modal opens.
describe('ConnectionManagerModal lazy body', () => {
  it('renders nothing at all while closed', () => {
    const { container } = renderModal(
      false,
      <button type="button">Host route setup</button>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('resolves the split body when opened', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ requests: [] })),
    );
    // station#3465: `ConnectionManagerModal` code-splits its body behind
    // `lazy(() => import('./ConnectionManagerModalContent'))` (see that
    // file), and this test used to race that dynamic `import()` against
    // `findByRole`'s fixed 1000ms default timeout. Under host load the
    // import's own module transform can exceed that bound, failing a test
    // that asserts nothing about timing — a measured 10-run interleaved A/B
    // against `origin/main` showed the same load-tracking failure rate on
    // BOTH branches (station#3465's own measurement), so the race was
    // pre-existing, not something this test was ever meant to assert.
    // Pre-importing the split module here resolves it into Vite/Vitest's
    // module cache (keyed by resolved absolute path, not the literal
    // specifier text) BEFORE `render` runs, so `lazy`'s own internal
    // `import()` call below returns the already-transformed, already-cached
    // module on its next microtask instead of re-doing that work under
    // whatever load the host is under — removing the race rather than
    // widening the window it was losing.
    await import('../react/ConnectionManagerModalContent');
    renderModal(true, <button type="button">Host route setup</button>);

    expect(
      await screen.findByRole('button', { name: 'Paired devices' }),
    ).toBeTruthy();
    expect(await screen.findByText('Remote Station')).toBeTruthy();
    // station#4513 retired the sheet's intro sentence; the list panel's own
    // footer actions are what prove it actually rendered instead.
    expect(
      screen.getByRole('button', { name: 'Add a Station address' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Close Station manager' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Host route setup' }),
    ).toBeTruthy();
  });
});

it('uses the host live status for the selected row without inventing an in-progress check', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ requests: [] })),
  );
  await import('../react/ConnectionManagerModalContent');
  const store = new ConnectionStore({ storage: memoryAdapter() });
  const current = store.add('Current Station', 'https://current.example.test');
  store.add('Another Station', 'https://other.example.test');
  const health = vi.fn(async () => false);
  render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModal
        isOpen
        onClose={vi.fn()}
        checkHealth={health}
        activeHealth={{
          connectionId: current.id,
          status: 'connected',
          reason: null,
        }}
      />
    </ConnectionsProvider>,
  );
  expect(await screen.findByText('Current · Connected')).toBeTruthy();
  expect(screen.getByText('Not checked')).toBeTruthy();
  expect(health).not.toHaveBeenCalled();
});
