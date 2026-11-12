// @vitest-environment jsdom

import {
  act,
  fireEvent,
  type RenderOptions,
  render,
  screen,
} from '@testing-library/react';
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

function renderModal(
  isOpen: boolean,
  listFooterContent?: ReactNode,
  onConnectStation?: () => void,
  renderOptions?: Pick<RenderOptions, 'reactStrictMode'>,
) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  store.add('Remote Station', 'https://station.example.test');
  const close = vi.fn();
  const view = render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModal
        isOpen={isOpen}
        onClose={close}
        checkHealth={vi.fn(async () => false)}
        listFooterContent={listFooterContent}
        onConnectStation={onConnectStation}
      />
    </ConnectionsProvider>,
    renderOptions,
  );
  return { ...view, close };
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
  it.each(['Save', 'Cancel'])(
    'keeps focus in the Station row through editing and %s',
    async (action) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ requests: [] })),
      );
      await import('../react/ConnectionManagerModalContent');
      renderModal(true);
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'View details for Remote Station',
        }),
      );
      const edit = screen.getByRole('button', { name: 'Edit Station' });
      edit.focus();
      fireEvent.click(edit);
      const name = screen.getByRole('textbox', { name: 'Station name' });
      expect(document.activeElement).toBe(name);
      fireEvent.change(name, { target: { value: 'Renamed Station' } });
      const finish = screen.getByRole('button', { name: action });
      finish.focus();
      fireEvent.click(finish);
      const row = await screen.findByRole('button', {
        name: `View details for ${action === 'Save' ? 'Renamed Station' : 'Remote Station'}`,
      });
      expect(document.activeElement).toBe(row);
    },
  );

  it('Escape closes Station actions before requesting the manager close', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ requests: [] })),
    );
    await import('../react/ConnectionManagerModalContent');
    const view = renderModal(true);
    const more = await screen.findByRole('button', {
      name: 'More actions for Remote Station',
    });
    fireEvent.click(more);
    const action = screen.getByRole('menuitem', { name: 'Check reachability' });
    expect(document.activeElement).toBe(action);
    fireEvent.keyDown(action, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(view.close).not.toHaveBeenCalled();
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: 'Escape' });
    expect(view.close).toHaveBeenCalledOnce();
  });

  it('retains the opener across StrictMode replay without restoring focus while open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ requests: [] })),
    );
    await import('../react/ConnectionManagerModalContent');
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const nextFrame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const view = renderModal(true, undefined, undefined, {
      reactStrictMode: true,
    });
    try {
      await screen.findByRole('button', { name: 'Close Station manager' });
      const dialog = screen.getByRole('dialog');
      await act(nextFrame);
      expect(dialog.contains(document.activeElement)).toBe(true);
      view.unmount();
      await act(nextFrame);
      expect(document.activeElement).toBe(trigger);
    } finally {
      view.unmount();
      trigger.remove();
    }
  });

  it('moves focus into the dialog before inerting and hiding the focused background', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ requests: [] })),
    );
    await import('../react/ConnectionManagerModalContent');
    const background = document.createElement('div');
    const trigger = document.createElement('button');
    background.append(trigger);
    document.body.append(background);
    trigger.focus();
    const focusAtIsolation: Array<Element | null> = [];
    let inert = false;
    Object.defineProperty(background, 'inert', {
      configurable: true,
      get: () => inert,
      set: (value: boolean) => {
        if (value) focusAtIsolation.push(document.activeElement);
        inert = value;
      },
    });
    const setAttribute = background.setAttribute.bind(background);
    vi.spyOn(background, 'setAttribute').mockImplementation((name, value) => {
      if (name === 'aria-hidden' && value === 'true') {
        focusAtIsolation.push(document.activeElement);
      }
      setAttribute(name, value);
    });

    const view = renderModal(true);
    const dialog = await screen.findByRole('dialog');
    expect(focusAtIsolation).toHaveLength(2);
    for (const focused of focusAtIsolation) {
      expect(focused).not.toBe(trigger);
      expect(dialog.contains(focused)).toBe(true);
    }
    view.unmount();
    background.remove();
  });

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

it('the primary Add action delegates to the host setup without opening a competing address form', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ requests: [] })),
  );
  await import('../react/ConnectionManagerModalContent');
  const connect = vi.fn();
  renderModal(true, undefined, connect);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Connect a Station' }),
  );
  expect(connect).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText('Station address')).toBeNull();
  expect(screen.getByText('Remote Station')).toBeTruthy();
});

it('forwards host details through the lazy modal to the expanded current Station row', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ requests: [] })),
  );
  await import('../react/ConnectionManagerModalContent');
  const store = new ConnectionStore({ storage: memoryAdapter() });
  const current = store.add('Current Station', 'https://current.example.test');
  store.add('Other Station', 'https://other.example.test');
  store.setActive(current.id);
  render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModal
        isOpen
        onClose={vi.fn()}
        checkHealth={vi.fn(async () => false)}
        renderConnectionDetails={(connection) =>
          connection.id === current.id ? (
            <button type="button">Manage current extensions</button>
          ) : null
        }
      />
    </ConnectionsProvider>,
  );
  await screen.findByText('Current Station');
  expect(
    screen.queryByRole('button', { name: 'Manage current extensions' }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'View details for Other Station' }),
  );
  expect(
    screen.queryByRole('button', { name: 'Manage current extensions' }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'View details for Current Station' }),
  );
  expect(
    screen.getByRole('button', { name: 'Manage current extensions' }),
  ).toBeTruthy();
});
