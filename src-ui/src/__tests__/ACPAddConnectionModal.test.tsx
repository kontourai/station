/**
 * @vitest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ACPAddConnectionModal } from '../components/acp-connections/ACPAddConnectionModal';
import { FIRST_CONTACT_WAIT_MS } from '../components/acp-connections/useACPConnectionSetup';

const kiro = {
  id: 'kiro',
  name: 'Kiro CLI',
  command: 'kiro',
  args: ['--acp'],
  detected: true,
  installed: false,
};

function connection(status: string) {
  return {
    id: 'kiro',
    name: 'Kiro CLI',
    command: 'kiro',
    args: ['--acp'],
    enabled: true,
    status,
    modes: [],
    sessionId: null,
    mcpServers: [],
    currentModel: null,
    source: 'user' as const,
  };
}

/**
 * What POST /api/acp/registry/kiro/install answers when the engine's first
 * probe fails: the shape is pinned at the producer by acp.routes.test.ts
 * ("answers a failed first add with the probe status and reason"). The
 * connection is never listed by GET /connections, because a failed first add
 * registers no identity, so `connections` stays empty in these tests.
 */
const failedFirstAddResponse = {
  id: 'kiro',
  name: 'Kiro CLI',
  command: 'kiro',
  args: ['--acp'],
  icon: '🔌',
  enabled: true,
  status: 'unavailable',
  modes: [],
  sessionId: null,
  mcpServers: [],
  configOptions: [],
  currentModel: null,
  providerRoutingCurrent: true,
  lastError: { phase: 'initialize', message: 'Timed out after 10000ms' },
};

describe('ACPAddConnectionModal', () => {
  test('keeps every unconfigured choice behind the named accessible dialog', () => {
    render(
      <ACPAddConnectionModal
        registryEntries={[kiro, { ...kiro, id: 'installed', installed: true }]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Add engine' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Kiro CLI/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Kiro CLI/i })).toHaveLength(
      1,
    );
    expect(
      screen.getByText(
        'Found on the computer Station runs on — not yet connected.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/\bACP\b/i)).toBeNull();
  });

  test('shows Checking until the refreshed connection result reports Ready', async () => {
    const onInstallRegistryEntry = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
    expect(screen.getByRole('status').textContent).toContain('Checking');
    expect(onInstallRegistryEntry).toHaveBeenCalledWith('kiro');

    rerender(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        connections={[connection('available')]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Ready');
    });
    expect(screen.queryByText('Checking')).toBeNull();
  });

  test('renders a finite non-ready query result and never upgrades it to Ready', async () => {
    const onInstallRegistryEntry = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
    rerender(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        connections={[connection('unavailable')]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Setup needed');
    });
    expect(screen.queryByText('Ready')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Choose another engine' }),
    ).toBeTruthy();
  });

  // CI-R8 — the result panel said only "This provider needs more setup before
  // it can run work" and offered two buttons that both walk away. The probe's
  // own failure is on the connection; the panel now reads it.
  test('a non-ready result names the observed failure and the action that fixes it', async () => {
    const onInstallRegistryEntry = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
    rerender(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        connections={[
          {
            ...connection('unavailable'),
            lastError: {
              phase: 'spawn',
              message: 'spawn kiro ENOENT',
            },
          },
        ]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Setup needed');
    });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('spawn kiro ENOENT');
    expect(status.textContent).toContain('spawn:');
    expect(status.textContent).toContain(
      'make it runnable on the computer Station runs on',
    );
  });

  // The action is derived from the phase: after `initialize` the command IS
  // running, so telling the operator to install it would be wrong advice
  // (observed live against a real cursor-agent auth refusal).
  test('a post-spawn failure points at the provider, not at installing it', async () => {
    const onInstallRegistryEntry = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
    rerender(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        connections={[
          {
            ...connection('unavailable'),
            lastError: {
              phase: 'session creation',
              message: 'Authentication required',
            },
          },
        ]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Setup needed');
    });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain(
      'session creation: Authentication required',
    );
    expect(status.textContent).toContain('did not finish connecting');
    expect(status.textContent).not.toContain('Install it');
  });

  test('a ready result carries no failure line', async () => {
    const onInstallRegistryEntry = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
    rerender(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        connections={[
          {
            ...connection('available'),
            lastError: { phase: 'spawn', message: 'a stale earlier failure' },
          },
        ]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Ready');
    });
    expect(screen.getByRole('status').textContent).not.toContain(
      'a stale earlier failure',
    );
  });

  test('a failed first add lands on Setup needed from the add response, and Retry check re-runs it', async () => {
    const { lastError: _failure, ...connected } = failedFirstAddResponse;
    const onInstallRegistryEntry = vi
      .fn()
      .mockResolvedValueOnce(failedFirstAddResponse)
      .mockResolvedValueOnce({ ...connected, status: 'available' });
    render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        connections={[]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Setup needed');
    });
    expect(screen.queryByText('Checking')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      'initialize: Timed out after 10000ms',
    );
    expect(
      screen.getByRole('button', { name: 'Choose another engine' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry check' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Ready');
    });
    expect(onInstallRegistryEntry).toHaveBeenNthCalledWith(2, 'kiro');
    expect(screen.queryByRole('button', { name: 'Retry check' })).toBeNull();
  });

  test('a failed first custom add offers Retry check and Edit setup', async () => {
    const onAdd = vi.fn().mockResolvedValue({
      ...failedFirstAddResponse,
      id: 'gemini',
      name: 'Gemini CLI',
      command: 'gemini',
      args: [],
      lastError: { phase: 'spawn', message: 'spawn gemini ENOENT' },
    });
    render(
      <ACPAddConnectionModal
        registryEntries={[]}
        connections={[]}
        onAdd={onAdd}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Gemini CLI' },
    });
    fireEvent.change(screen.getByLabelText('Command'), {
      target: { value: 'gemini' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check engine' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Setup needed');
    });
    expect(screen.getByRole('status').textContent).toContain(
      'spawn: spawn gemini ENOENT',
    );
    expect(screen.getByRole('button', { name: 'Retry check' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }));
    expect(screen.getByDisplayValue('Gemini CLI')).toBeTruthy();
  });

  // A first add whose request-budget probe timed out on a never-connected
  // engine answers `probing` (acp-first-contact.routes.test.ts): the cold
  // start continues on the server, and the dialog follows it.
  describe('a first start that continues in the background', () => {
    const probingResponse = {
      ...failedFirstAddResponse,
      status: 'probing',
      lastError: undefined,
    };

    function renderProbing(
      props: Partial<Parameters<typeof ACPAddConnectionModal>[0]> = {},
    ) {
      const onFirstContactPendingChange = vi.fn();
      const onRefreshConnections = vi.fn();
      const base = {
        registryEntries: [kiro],
        connections: [] as ReturnType<typeof connection>[],
        onAdd: vi.fn(),
        onInstallRegistryEntry: vi.fn().mockResolvedValue(probingResponse),
        onRefreshConnections,
        onFirstContactPendingChange,
        onCancel: vi.fn(),
      };
      const view = render(<ACPAddConnectionModal {...base} {...props} />);
      const rerender = (next: Partial<typeof base> & Record<string, unknown>) =>
        view.rerender(<ACPAddConnectionModal {...base} {...next} />);
      return { rerender, onFirstContactPendingChange, onRefreshConnections };
    }

    test('stays on Checking with first-start copy, then lands on Setup needed from the polled status', async () => {
      const { rerender, onFirstContactPendingChange } = renderProbing();
      fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));

      await waitFor(() =>
        expect(onFirstContactPendingChange).toHaveBeenLastCalledWith(true),
      );
      expect(screen.getByRole('status').textContent).toContain(
        'Starting Kiro CLI for the first time. A first start can take up to a minute.',
      );

      rerender({
        probeStatusesUpdatedAt: Date.now(),
        probeStatuses: [
          {
            id: 'kiro',
            status: 'unavailable',
            lastError: {
              phase: 'initialize',
              message: 'Timed out after 60000ms',
            },
          },
        ],
      });

      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain(
          'Setup needed',
        ),
      );
      expect(screen.getByRole('status').textContent).toContain(
        'initialize: Timed out after 60000ms',
      );
      expect(onFirstContactPendingChange).toHaveBeenLastCalledWith(false);
    });

    // The dialog is not a trap while a first start runs: it can be closed,
    // and saying what happens next is the action's own label.
    test('a first start can be left to finish in the background', async () => {
      const onCancel = vi.fn();
      renderProbing({ onCancel });
      fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain('first time'),
      );

      fireEvent.click(
        screen.getByRole('button', { name: 'Keep checking in background' }),
      );
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    test('the short check before an answer can be closed too', async () => {
      const onCancel = vi.fn();
      render(
        <ACPAddConnectionModal
          registryEntries={[kiro]}
          connections={[]}
          onAdd={vi.fn()}
          onInstallRegistryEntry={() => new Promise(() => {})}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
      expect(screen.getByRole('status').textContent).toContain('Checking');
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    // Retry check after a Setup needed result: the section still holds the
    // last poll, which says `unavailable` for this id. That answer is about
    // the previous attempt and must not end the new wait.
    test('a poll from before this add does not end its first-start wait', async () => {
      const { rerender } = renderProbing({
        probeStatusesUpdatedAt: Date.now() - 60_000,
        probeStatuses: [
          {
            id: 'kiro',
            status: 'unavailable',
            lastError: { phase: 'initialize', message: 'the OLD failure' },
          },
        ],
      });
      fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain('first time'),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.getByRole('status').textContent).toContain('Checking');
      expect(screen.queryByText(/the OLD failure/)).toBeNull();

      rerender({
        probeStatusesUpdatedAt: Date.now(),
        probeStatuses: [
          {
            id: 'kiro',
            status: 'unavailable',
            lastError: { phase: 'initialize', message: 'the NEW failure' },
          },
        ],
      });
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain(
          'initialize: the NEW failure',
        ),
      );
    });

    test('a connected first start waits for the registered engine, then lands on Ready', async () => {
      const { rerender, onRefreshConnections } = renderProbing();
      fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain('first start'),
      );

      rerender({
        probeStatusesUpdatedAt: Date.now(),
        probeStatuses: [{ id: 'kiro', status: 'available' }],
      });
      await waitFor(() => expect(onRefreshConnections).toHaveBeenCalled());
      expect(screen.getByRole('status').textContent).toContain('Checking');

      rerender({
        probeStatusesUpdatedAt: Date.now(),
        probeStatuses: [{ id: 'kiro', status: 'available' }],
        connections: [connection('available')],
      });
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain('Ready'),
      );
    });

    test('never stays on Checking past the first-start bound', async () => {
      vi.useFakeTimers();
      try {
        renderProbing();
        fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
        await vi.waitFor(() =>
          expect(screen.getByRole('status').textContent).toContain(
            'first start',
          ),
        );

        await act(async () => {
          vi.advanceTimersByTime(FIRST_CONTACT_WAIT_MS);
        });

        expect(screen.getByRole('alert').textContent).toContain(
          'Station keeps checking it while Station is running; if Station restarts first, add it again.',
        );
        expect(screen.queryByText('Checking')).toBeNull();
        expect(
          screen.getByRole('button', { name: 'Retry refresh' }),
        ).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test('recovers a successful mutation when its connection refresh fails', async () => {
    const onInstallRegistryEntry = vi.fn().mockResolvedValue(undefined);
    const onRefreshConnections = vi.fn().mockResolvedValue(undefined);
    render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        connectionQueryError={new Error('Connection refresh failed')}
        onAdd={vi.fn()}
        onInstallRegistryEntry={onInstallRegistryEntry}
        onRefreshConnections={onRefreshConnections}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Kiro CLI/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Could not refresh this engine’s status.',
      );
    });
    expect(screen.queryByText('Checking')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Choose another engine' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry refresh' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }));
    await waitFor(() => expect(onRefreshConnections).toHaveBeenCalledTimes(1));
  });

  test('keeps custom setup simple until Advanced and derives the draft id', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        onAdd={onAdd}
        onInstallRegistryEntry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Custom engine/i }));
    expect(screen.getByText('Advanced').parentElement).not.toHaveProperty(
      'open',
      true,
    );

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Gemini CLI' },
    });
    fireEvent.change(screen.getByLabelText('Command'), {
      target: { value: 'gemini' },
    });
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByLabelText('ID')).toBeTruthy();
    expect(screen.getByLabelText('Arguments')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check engine' }));

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith({
        id: 'gemini',
        name: 'Gemini CLI',
        command: 'gemini',
        args: '',
        icon: '',
        cwd: '',
      });
    });
    expect(screen.getByRole('status').textContent).toContain('Checking');
  });

  test('focuses the first custom field and contains Tab at the shared dialog boundary', () => {
    render(
      <ACPAddConnectionModal
        registryEntries={[]}
        onAdd={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const name = screen.getByLabelText('Name');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(name);

    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close add engine' }),
    );
  });

  test('preserves safe custom input after a mutation error and retries the original mutation', async () => {
    const onAdd = vi
      .fn()
      .mockRejectedValueOnce(new Error('Command could not start'))
      .mockResolvedValueOnce(undefined);
    render(
      <ACPAddConnectionModal
        registryEntries={[]}
        onAdd={onAdd}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Gemini CLI' },
    });
    fireEvent.change(screen.getByLabelText('Command'), {
      target: { value: 'gemini' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check engine' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Command could not start',
      );
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry refresh' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status').textContent).toContain('Checking');

    // A successful retry waits for a result from the connection query. Start
    // over to prove the same safe draft also survives an explicit edit.
    fireEvent.click(screen.getByRole('button', { name: 'Close add engine' }));
  });

  test('preserves the custom draft when a mutation error is edited', async () => {
    const onAdd = vi
      .fn()
      .mockRejectedValueOnce(new Error('Command could not start'));
    render(
      <ACPAddConnectionModal
        registryEntries={[]}
        onAdd={onAdd}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Gemini CLI' },
    });
    fireEvent.change(screen.getByLabelText('Command'), {
      target: { value: 'gemini' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check engine' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }));
    expect(screen.getByDisplayValue('Gemini CLI')).toBeTruthy();
    expect(screen.getByDisplayValue('gemini')).toBeTruthy();
  });

  test('uses the shared dialog lifecycle for Escape and backdrop dismissal', () => {
    const onCancel = vi.fn();
    render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>('.responsive-surface-overlay')!,
    );
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
