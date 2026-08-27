/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const integrationsQueryData: {
  data: Array<{
    id: string;
    kind: string;
    transport: string;
    displayName?: string;
    requiresEnvSecrets?: boolean;
  }>;
} = { data: [] };

vi.mock('@kontourai/station-sdk', () => ({
  useIntegrationsQuery: () => integrationsQueryData,
}));

import { ACPConnectionDetailModal } from '../components/acp-connections/ACPConnectionDetailModal';
import type { ACPConnectionInfo } from '../hooks/useACPConnections';

function baseConnection(
  overrides: Partial<ACPConnectionInfo> = {},
): ACPConnectionInfo {
  return {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    enabled: true,
    status: 'available',
    modes: [],
    sessionId: null,
    mcpServers: [],
    currentModel: null,
    ...overrides,
  };
}

describe('ACPConnectionDetailModal — MCP passthrough tool-server picker', () => {
  it('HIGH (repo review, 2026-07-26): renders an env-bearing tool server as a disabled checkbox with a reason, never letting it be selected', () => {
    integrationsQueryData.data = [
      {
        id: 'filesystem',
        kind: 'mcp',
        transport: 'stdio',
        displayName: 'Filesystem',
        requiresEnvSecrets: false,
      },
      {
        id: 'github',
        kind: 'mcp',
        transport: 'stdio',
        displayName: 'GitHub',
        requiresEnvSecrets: true,
      },
    ];

    render(
      <ACPConnectionDetailModal
        conn={baseConnection()}
        agents={[]}
        onClose={vi.fn()}
        onUpdateToolServers={vi.fn()}
      />,
    );

    const githubCheckbox = screen.getByRole('checkbox', {
      name: 'GitHub',
    }) as HTMLInputElement;
    expect(githubCheckbox.disabled).toBe(true);
    expect(
      screen.getByText(
        'Requires environment secrets — not shared with external engines.',
      ),
    ).toBeTruthy();

    const filesystemCheckbox = screen.getByRole('checkbox', {
      name: 'Filesystem',
    }) as HTMLInputElement;
    expect(filesystemCheckbox.disabled).toBe(false);
  });

  it('PARTIAL-4 (repo review, 2026-07-26): disables the picker while an internal dispatch is in flight (visual affordance)', async () => {
    integrationsQueryData.data = [
      { id: 'filesystem', kind: 'mcp', transport: 'stdio' },
      { id: 'notebook', kind: 'mcp', transport: 'stdio' },
    ];
    let resolveFirst: (() => void) | undefined;
    const onUpdateToolServers = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    render(
      <ACPConnectionDetailModal
        conn={baseConnection({ provideToolServers: [] })}
        agents={[]}
        onClose={vi.fn()}
        onUpdateToolServers={onUpdateToolServers}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'filesystem' }));
    const notebookCheckbox = screen.getByRole('checkbox', {
      name: 'notebook',
    }) as HTMLInputElement;
    expect(notebookCheckbox.disabled).toBe(true);

    resolveFirst?.();
    await waitFor(() => expect(notebookCheckbox.disabled).toBe(false));
  });

  it('PARTIAL-4: serializes overlapping toggles — a toggle requested while the first mutation is still in flight is dispatched as a merged delta once the first settles, never dropped', async () => {
    integrationsQueryData.data = [
      { id: 'filesystem', kind: 'mcp', transport: 'stdio' },
      { id: 'notebook', kind: 'mcp', transport: 'stdio' },
    ];
    let resolveFirst: (() => void) | undefined;
    const onUpdateToolServers = vi.fn((_ids: string[]) => {
      if (onUpdateToolServers.mock.calls.length === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve();
    });

    render(
      <ACPConnectionDetailModal
        conn={baseConnection({ provideToolServers: [] })}
        agents={[]}
        onClose={vi.fn()}
        onUpdateToolServers={onUpdateToolServers}
      />,
    );

    // Toggle #1: dispatches immediately, with an unresolved promise (in flight).
    fireEvent.click(screen.getByRole('checkbox', { name: 'filesystem' }));
    expect(onUpdateToolServers).toHaveBeenCalledTimes(1);
    expect(onUpdateToolServers).toHaveBeenLastCalledWith(['filesystem']);

    // Toggle #2 happens WHILE #1 is still unresolved — must not fire a
    // second overlapping dispatch yet.
    fireEvent.click(screen.getByRole('checkbox', { name: 'notebook' }));
    expect(onUpdateToolServers).toHaveBeenCalledTimes(1);

    // Settling #1 must trigger the reconciled delta dispatch containing BOTH
    // selections — the whole point of the fix (reversed-completion race).
    resolveFirst?.();
    await waitFor(() => expect(onUpdateToolServers).toHaveBeenCalledTimes(2));
    expect(onUpdateToolServers).toHaveBeenLastCalledWith([
      'filesystem',
      'notebook',
    ]);
  });

  it('computes the next selection from local (desired-ref) state, not a stale server-echoed prop', async () => {
    integrationsQueryData.data = [
      { id: 'filesystem', kind: 'mcp', transport: 'stdio' },
      { id: 'notebook', kind: 'mcp', transport: 'stdio' },
    ];
    const onUpdateToolServers = vi.fn(() => Promise.resolve());

    // `conn` stays stale (as it would mid-mutation, before the query
    // invalidates) across both toggles.
    render(
      <ACPConnectionDetailModal
        conn={baseConnection({ provideToolServers: [] })}
        agents={[]}
        onClose={vi.fn()}
        onUpdateToolServers={onUpdateToolServers}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'filesystem' }));
    await waitFor(() =>
      expect(onUpdateToolServers).toHaveBeenLastCalledWith(['filesystem']),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'notebook' }));
    // Must include BOTH selections — a stale-`conn`-derived computation
    // would have dropped 'filesystem' here since `conn.provideToolServers`
    // was never updated between clicks.
    await waitFor(() =>
      expect(onUpdateToolServers).toHaveBeenLastCalledWith([
        'filesystem',
        'notebook',
      ]),
    );
  });

  it('restores the confirmed tool server choices and reports a failed update', async () => {
    integrationsQueryData.data = [
      { id: 'filesystem', kind: 'mcp', transport: 'stdio' },
    ];
    const onUpdateToolServers = vi.fn(() =>
      Promise.reject(new Error('write failed')),
    );

    render(
      <ACPConnectionDetailModal
        conn={baseConnection({ provideToolServers: [] })}
        agents={[]}
        onClose={vi.fn()}
        onUpdateToolServers={onUpdateToolServers}
      />,
    );

    const checkbox = screen.getByRole('checkbox', {
      name: 'filesystem',
    }) as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(screen.getByRole('alert').textContent).toContain(
      'previous choices were restored',
    );
  });

  it('restores the latest accepted server echo when the following update fails', async () => {
    integrationsQueryData.data = [
      { id: 'filesystem', kind: 'mcp', transport: 'stdio' },
    ];
    const onUpdateToolServers = vi.fn(() =>
      Promise.reject(new Error('write failed')),
    );
    const props = {
      agents: [],
      onClose: vi.fn(),
      onUpdateToolServers,
    };
    const { rerender } = render(
      <ACPConnectionDetailModal
        {...props}
        conn={baseConnection({ provideToolServers: [] })}
      />,
    );
    rerender(
      <ACPConnectionDetailModal
        {...props}
        conn={baseConnection({ provideToolServers: ['filesystem'] })}
      />,
    );

    const checkbox = screen.getByRole('checkbox', {
      name: 'filesystem',
    }) as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(screen.getByRole('alert').textContent).toContain(
      'previous choices were restored',
    );
  });

  it('keeps plugin-owned connections inspection-only even if a caller supplies an update callback', () => {
    integrationsQueryData.data = [
      { id: 'filesystem', kind: 'mcp', transport: 'stdio' },
    ];
    const onUpdateToolServers = vi.fn();

    render(
      <ACPConnectionDetailModal
        conn={baseConnection({
          source: 'plugin',
          provideToolServers: ['filesystem'],
        })}
        agents={[]}
        onClose={vi.fn()}
        onUpdateToolServers={onUpdateToolServers}
      />,
    );

    const filesystemCheckbox = screen.getByRole('checkbox', {
      name: 'filesystem',
    }) as HTMLInputElement;
    expect(filesystemCheckbox.checked).toBe(true);
    expect(filesystemCheckbox.disabled).toBe(true);
    expect(
      screen.getByText(
        'This connection is managed by its plugin. Tool server choices are read-only here.',
      ),
    ).toBeTruthy();

    fireEvent.click(filesystemCheckbox);
    expect(onUpdateToolServers).not.toHaveBeenCalled();
  });
});
