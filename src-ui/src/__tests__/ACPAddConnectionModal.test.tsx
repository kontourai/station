/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ACPAddConnectionModal } from '../components/acp-connections/ACPAddConnectionModal';

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

    expect(screen.getByRole('dialog', { name: 'Add provider' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Kiro CLI/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Kiro CLI/i })).toHaveLength(
      1,
    );
    expect(
      screen.getByText(
        'Found on this computer — not yet connected to this Station.',
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
      screen.getByRole('button', { name: 'Choose another provider' }),
    ).toBeTruthy();
  });

// the result panel said only "This provider needs more setup before
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
    expect(status.textContent).toContain('make it runnable on this computer');
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
        'Could not refresh this provider status.',
      );
    });
    expect(screen.queryByText('Checking')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Choose another provider' }),
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

    fireEvent.click(screen.getByRole('button', { name: /Custom provider/i }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Check provider' }));

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
      screen.getByRole('button', { name: 'Close add provider' }),
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
    fireEvent.click(screen.getByRole('button', { name: 'Check provider' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Close add provider' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Check provider' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit setup' }));
    expect(screen.getByDisplayValue('Gemini CLI')).toBeTruthy();
    expect(screen.getByDisplayValue('gemini')).toBeTruthy();
  });

  test('uses the shared dialog lifecycle for Escape and backdrop dismissal', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ACPAddConnectionModal
        registryEntries={[kiro]}
        onAdd={vi.fn()}
        onInstallRegistryEntry={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.pointerDown(
      container.querySelector<HTMLElement>('.responsive-surface-overlay')!,
    );
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
