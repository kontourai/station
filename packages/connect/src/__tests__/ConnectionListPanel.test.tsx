// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '../core/types';
import { ConnectionListPanel } from '../react/connection-manager-modal/ConnectionListPanel';

const connection: SavedConnection = {
  profileVersion: 4,
  id: 'station-one',
  name: 'Station One',
  url: 'https://station-one.example.ts.net',
  endpoints: [
    {
      endpointVersion: 1,
      id: 'station-one-endpoint',
      url: 'https://station-one.example.ts.net',
      kind: 'tailnet-https',
      priority: 0,
    },
  ],
  selectedEndpointId: 'station-one-endpoint',
  accessMethods: [
    {
      accessVersion: 1,
      id: 'station-one-access',
      kind: 'direct-http',
      endpointId: 'station-one-endpoint',
    },
  ],
  selectedAccessMethodId: 'station-one-access',
  environmentId: null,
  authProtocolVersion: null,
  credentialRef: {
    credentialVersion: 1,
    kind: 'connection',
    id: 'station-one-credential',
  },
  capabilities: null,
  credentialState: 'not-required',
};

/**
 * The desktop-supervised local server while it is NOT running:
 * `injectedConnectionStateLabel` returns 'Not running' for this shape, which is
 * the row's `isLocalServerDown` cue. Without a fixture in this state the row's
 * only conditional never evaluates true and nothing here has power over it.
 */
const downLocalServer: SavedConnection = {
  ...connection,
  id: 'local-server',
  name: 'Local Server',
  url: 'http://127.0.0.1:3141',
  injected: true,
  injectedStatus: 'stopped',
};

function renderPanel(
  onSelect = vi.fn(),
  {
    connections = [connection],
    onRestartInjectedConnection,
    onMakeDefaultProfile,
  }: {
    connections?: SavedConnection[];
    onRestartInjectedConnection?: (connection: SavedConnection) => void;
    onMakeDefaultProfile?: (connection: SavedConnection) => void;
  } = {},
) {
  render(
    <ConnectionListPanel
      connections={connections}
      activeConnectionId={connection.id}
      onRestartInjectedConnection={onRestartInjectedConnection}
      editingId={null}
      editName=""
      editUrl=""
      credentialEntry=""
      getStatus={() => 'connected'}
      onSelect={onSelect}
      onCheck={() => {}}
      onStartEdit={() => {}}
      onRemove={() => {}}
      onEditNameChange={() => {}}
      onEditUrlChange={() => {}}
      onCredentialEntryChange={() => {}}
      onRemoveCredential={() => {}}
      onConfirmEndpoint={() => {}}
      onSaveEdit={() => {}}
      onCancelEdit={() => {}}
      onAddManual={() => {}}
      onRequestAccess={() => {}}
      onMakeDefaultProfile={onMakeDefaultProfile}
      onScanQr={() => {}}
      onEnterPairingCode={() => {}}
      onViewDevices={() => {}}
      discoveryAvailable={false}
      onDiscover={() => {}}
    />,
  );
  return onSelect;
}

describe('ConnectionListPanel', () => {
  it('marks the exact saved target as pending without duplicating Request access', () => {
    const pending = { ...connection, credentialState: 'required' as const };
    render(
      <ConnectionListPanel
        connections={[pending]}
        activeConnectionId={pending.id}
        pendingConnectionId={pending.id}
        editingId={null}
        editName=""
        editUrl=""
        credentialEntry=""
        getStatus={() => 'connecting'}
        onSelect={() => {}}
        onCheck={() => {}}
        onStartEdit={() => {}}
        onRemove={() => {}}
        onEditNameChange={() => {}}
        onEditUrlChange={() => {}}
        onCredentialEntryChange={() => {}}
        onRemoveCredential={() => {}}
        onConfirmEndpoint={() => {}}
        onSaveEdit={() => {}}
        onCancelEdit={() => {}}
        onAddManual={() => {}}
        onRequestAccess={() => {}}
        onScanQr={() => {}}
        onEnterPairingCode={() => {}}
        onViewDevices={() => {}}
        discoveryAvailable={false}
        onDiscover={() => {}}
      />,
    );

    expect(screen.getByText('Access request pending approval')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Request access to Station One' }),
    ).toBeNull();
  });

  it('keeps every connection method visible without an advanced disclosure', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Add a Station address' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan a QR code' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Enter a pairing code' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /advanced/i })).toBeNull();
  });

  it('uses a dedicated native selection button beside the row actions', () => {
    const onSelect = renderPanel();
    const selectButton = screen.getByRole('button', {
      name: 'Select Station One',
    });

    selectButton.focus();
    fireEvent.click(selectButton);

    expect(selectButton.tagName).toBe('BUTTON');
    expect(document.activeElement).toBe(selectButton);
    expect(selectButton.getAttribute('aria-pressed')).toBe('true');
    expect(selectButton.querySelector('button')).toBeNull();
    const row = selectButton.closest('.station-connect-row');
    const siblingActionButtons = row
      ? Array.from(row.querySelectorAll('button')).filter(
          (button) => button !== selectButton,
        )
      : [];
    expect(siblingActionButtons.length).toBeGreaterThan(0);
    expect(
      siblingActionButtons.every((button) => !selectButton.contains(button)),
    ).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(connection);
  });

  it('keeps the active Station name visible and reserves row width for its identity', () => {
    renderPanel();

    const name = screen.getByText('Station One');
    const row = name.closest('.station-connect-row');
    expect(row?.className).toContain('station-connect-row--active');
    expect(name.className).toContain('station-connect-row__name');
    expect(screen.queryByText('Active')).toBeNull();
    expect(row?.querySelector('.station-connect-row__url')?.textContent).toBe(
      connection.url,
    );
  });

  it('puts reachability, edit, and Forget behind a keyboard-operable overflow', () => {
    const onCheck = vi.fn();
    const onStartEdit = vi.fn();
    const onRemove = vi.fn();
    render(
      <ConnectionListPanel
        connections={[connection]}
        activeConnectionId={connection.id}
        editingId={null}
        editName=""
        editUrl=""
        credentialEntry=""
        getStatus={() => 'connected'}
        onSelect={() => {}}
        onCheck={onCheck}
        onStartEdit={onStartEdit}
        onRemove={onRemove}
        onEditNameChange={() => {}}
        onEditUrlChange={() => {}}
        onCredentialEntryChange={() => {}}
        onRemoveCredential={() => {}}
        onConfirmEndpoint={() => {}}
        onSaveEdit={() => {}}
        onCancelEdit={() => {}}
        onAddManual={() => {}}
        onRequestAccess={() => {}}
        onScanQr={() => {}}
        onEnterPairingCode={() => {}}
        onViewDevices={() => {}}
        discoveryAvailable={false}
        onDiscover={() => {}}
      />,
    );

    expect(
      screen.queryByRole('menuitem', { name: 'Forget Station' }),
    ).toBeNull();
    const overflow = screen.getByRole('button', {
      name: 'More actions for Station One',
    });
    expect(overflow.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(overflow);
    expect(overflow.getAttribute('aria-expanded')).toBe('true');
    const check = screen.getByRole('menuitem', { name: 'Check reachability' });
    expect(document.activeElement).toBe(check);
    fireEvent.keyDown(check, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Edit Station' }),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(overflow);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Forget Station' }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm forgetting Station One' }),
    );
    expect(onRemove).toHaveBeenCalledWith(connection.id);
  });

  it('offers no selection control while the local server is down', () => {
    const onRestart = vi.fn();
    const onSelect = renderPanel(vi.fn(), {
      connections: [downLocalServer],
      onRestartInjectedConnection: onRestart,
    });

    // A not-running local server has no base to select or probe. The row must
    // not carry the selection overlay at all — not merely an inert one.
    expect(
      screen.queryByRole('button', { name: 'Select Local Server' }),
    ).toBeNull();

    const row = screen.getByText('Not running').closest('.station-connect-row');
    expect(row).not.toBeNull();
    expect(row?.className).toContain('station-connect-row--inactive');
    expect(row?.querySelector('.station-connect-row__select')).toBeNull();

    // Nothing reachable in the row can select it. This holds however the
    // control is spelled, so it survives a rename of the class or the label.
    const rowButtons = Array.from(row?.querySelectorAll('button') ?? []);
    expect(rowButtons.map((button) => button.textContent)).toEqual(['Restart']);
    for (const button of rowButtons) fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onRestart).toHaveBeenCalledWith(downLocalServer);
  });

  it('still offers selection while the local server is running', () => {
    const onSelect = renderPanel(vi.fn(), {
      connections: [{ ...downLocalServer, injectedStatus: 'running' as const }],
    });

    const selectButton = screen.getByRole('button', {
      name: 'Select Local Server',
    });
    fireEvent.click(selectButton);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('offers an explicit CLI-default action only for a shared saved Station', () => {
    const onMakeDefaultProfile = vi.fn();
    const sharedProfile = { ...connection, id: 'station-profile:kontour' };
    renderPanel(vi.fn(), {
      connections: [sharedProfile],
      onMakeDefaultProfile,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Make Station One the CLI default',
      }),
    );
    expect(onMakeDefaultProfile).toHaveBeenCalledWith(sharedProfile);
  });

  /**
   * station#1776 — the row's failure copy names the actual saved connection,
   * not a generic "this address" (constraint #1 of the connection-truth
   * plan: never invent a placeholder, thread the real label through).
   */
  it('names the connection in its failure copy row', () => {
    renderPanel(vi.fn(), {
      connections: [
        {
          ...connection,
          lastError: { reason: 'unreachable', at: Date.now() },
        },
      ],
    });

    // `role="status"` is also used elsewhere (e.g. the local-server state
    // label); scope to the failure-copy element by its warning class.
    const failureRow = document.querySelector(
      '.station-connect-row__meta--warning',
    );
    expect(failureRow).not.toBeNull();
    expect(failureRow?.textContent).toContain('Station One');
    expect(failureRow?.textContent).toContain(
      'https://station-one.example.ts.net',
    );
  });

  /**
   * station#1713 — a healthy host awaiting device approval is never
   * rendered as a row failure; there is nothing wrong to explain.
   */
  it('renders no failure row for a connection merely awaiting approval', () => {
    renderPanel(vi.fn(), {
      connections: [
        {
          ...connection,
          lastError: { reason: 'awaiting-approval', at: Date.now() },
        },
      ],
    });

    expect(
      document.querySelector('.station-connect-row__meta--warning'),
    ).toBeNull();
  });

  // station#4513 — a card carrying more than one problem at once used to
  // stack every prose block it had; it now shows exactly one status line
  // (and one action) for its DOMINANT state, precedence pending-approval >
  // identity-mismatch > credential-required.
  describe('one status line per card (station#4513)', () => {
    const compound: SavedConnection = {
      ...connection,
      id: 'station-profile:kontour',
      credentialState: 'required',
      lastError: { reason: 'identity-mismatch', at: Date.now() },
    };

    function warningRows() {
      return Array.from(
        document.querySelectorAll('.station-connect-row__meta--warning'),
      );
    }

    it('shows only the pending line for a card carrying mismatch + credential + pending', () => {
      render(
        <ConnectionListPanel
          connections={[compound]}
          activeConnectionId={compound.id}
          pendingConnectionId={compound.id}
          editingId={null}
          editName=""
          editUrl=""
          credentialEntry=""
          getStatus={() => 'connecting'}
          onSelect={() => {}}
          onCheck={() => {}}
          onStartEdit={() => {}}
          onRemove={() => {}}
          onEditNameChange={() => {}}
          onEditUrlChange={() => {}}
          onCredentialEntryChange={() => {}}
          onRemoveCredential={() => {}}
          onConfirmEndpoint={() => {}}
          onSaveEdit={() => {}}
          onCancelEdit={() => {}}
          onAddManual={() => {}}
          onRequestAccess={() => {}}
          onScanQr={() => {}}
          onEnterPairingCode={() => {}}
          onViewDevices={() => {}}
          discoveryAvailable={false}
          onDiscover={() => {}}
        />,
      );

      const rows = warningRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain('Access request pending approval');
      // The retired copy: none of the other three prose blocks render
      // alongside it — including the identity-mismatch explanation this
      // same connection also carries in `lastError`.
      expect(document.body.textContent).not.toContain('Credential required');
      expect(document.body.textContent).not.toContain(
        'This Station is shared with the CLI',
      );
      expect(document.body.textContent).not.toContain(
        "isn't the one this device paired with",
      );
      // No action for a pending row — waiting is the only thing to do.
      expect(rows[0]?.querySelector('button')).toBeNull();
    });

    it('shows only the mismatch line (short summary + Pair again) when nothing is pending', () => {
      renderPanel(vi.fn(), { connections: [compound] });

      const rows = warningRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain(
        "isn't the one this device paired with",
      );
      // The SHORT summary only — the full explanation sentence moved to the
      // edit view and must not render on the collapsed card.
      expect(document.body.textContent).not.toContain('Credential required');
      expect(
        screen.getByRole('button', { name: /Pair .* again/ }),
      ).toBeTruthy();
    });

    it('falls back to Credential required when nothing outranks it', () => {
      renderPanel(vi.fn(), {
        connections: [{ ...connection, credentialState: 'required' as const }],
      });

      const rows = warningRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toBe('Credential requiredRequest access');
      expect(
        screen.getByRole('button', {
          name: 'Request access to Station One',
        }),
      ).toBeTruthy();
    });

    it('never renders the CLI-sharing note on the sheet', () => {
      renderPanel(vi.fn(), {
        connections: [{ ...connection, id: 'station-profile:kontour' }],
      });
      expect(document.body.textContent).not.toContain(
        'This Station is shared with the CLI',
      );
    });

    it('renders no status line at all for a healthy connection', () => {
      renderPanel();
      expect(warningRows()).toHaveLength(0);
    });

    it('moves the full mismatch explanation to the edit view, not the row', () => {
      render(
        <ConnectionListPanel
          connections={[
            {
              ...connection,
              lastError: { reason: 'identity-mismatch', at: Date.now() },
            },
          ]}
          activeConnectionId={connection.id}
          editingId={connection.id}
          editName={connection.name}
          editUrl={connection.url}
          credentialEntry=""
          getStatus={() => 'error'}
          onSelect={() => {}}
          onCheck={() => {}}
          onStartEdit={() => {}}
          onRemove={() => {}}
          onEditNameChange={() => {}}
          onEditUrlChange={() => {}}
          onCredentialEntryChange={() => {}}
          onRemoveCredential={() => {}}
          onConfirmEndpoint={() => {}}
          onSaveEdit={() => {}}
          onCancelEdit={() => {}}
          onAddManual={() => {}}
          onRequestAccess={() => {}}
          onScanQr={() => {}}
          onEnterPairingCode={() => {}}
          onViewDevices={() => {}}
          discoveryAvailable={false}
          onDiscover={() => {}}
        />,
      );

      const rows = warningRows();
      expect(rows).toHaveLength(1);
      // The FULL explanation — summary AND action sentence — only in the
      // edit view, which is the one place it renders.
      expect(rows[0]?.textContent).toContain(
        "isn't the one this device paired with",
      );
      expect(rows[0]?.textContent).toMatch(/pair again, or remove/i);
    });

    /**
     * station#4512 review (H2/L5) — `tests/connect-remote-auth-recovery.spec.ts`
     * locates the row by `getByText('Credential required', { exact: true })`.
     * The old single-`div` shape concatenated the status text and the
     * button's own label into one string ("Credential requiredRequest
     * access"), so no element's exact text was ever "Credential required" —
     * the status line now has its own `<span role="status">`, and the
     * action button is a SIBLING of it, not a descendant, so an assistive
     * technology's live-region announcement is the status alone.
     */
    it('gives the status text its own exact-text, live-region span, separate from the action button', () => {
      renderPanel(vi.fn(), {
        connections: [{ ...connection, credentialState: 'required' as const }],
      });

      const statusSpan = screen.getByText('Credential required', {
        exact: true,
      });
      expect(statusSpan.tagName).toBe('SPAN');
      expect(statusSpan.getAttribute('role')).toBe('status');

      const actionButton = screen.getByRole('button', {
        name: 'Request access to Station One',
      });
      // The button must not be a descendant of the status span — it is
      // outside the announced live region.
      expect(statusSpan.contains(actionButton)).toBe(false);
      expect(actionButton.closest('[role="status"]')).toBeNull();
    });

    // station#4512 review (M4) — `authentication-failed` used to fall into
    // the same generic "Credential required" bucket as a connection that
    // never had a credential at all, which lost the #3903 insight this row
    // used to carry: the address is fine, only this device isn't
    // authorised. It is its own line now, ahead of the generic bucket.
    it('names an authentication failure distinctly from a bare missing credential', () => {
      renderPanel(vi.fn(), {
        connections: [
          {
            ...connection,
            lastError: { reason: 'authentication-failed', at: Date.now() },
          },
        ],
      });

      const rows = warningRows();
      expect(rows).toHaveLength(1);
      expect(
        screen.getByText("This device isn't authorised on this Station", {
          exact: true,
        }),
      ).toBeTruthy();
      expect(rows[0]?.textContent).not.toBe('Credential required');
      expect(
        screen.getByRole('button', {
          name: 'Request access to Station One',
        }),
      ).toBeTruthy();
    });

    it('moves the full #3903 explanation for an authentication failure to the edit view', () => {
      render(
        <ConnectionListPanel
          connections={[
            {
              ...connection,
              lastError: { reason: 'authentication-failed', at: Date.now() },
            },
          ]}
          activeConnectionId={connection.id}
          editingId={connection.id}
          editName={connection.name}
          editUrl={connection.url}
          credentialEntry=""
          getStatus={() => 'error'}
          onSelect={() => {}}
          onCheck={() => {}}
          onStartEdit={() => {}}
          onRemove={() => {}}
          onEditNameChange={() => {}}
          onEditUrlChange={() => {}}
          onCredentialEntryChange={() => {}}
          onRemoveCredential={() => {}}
          onConfirmEndpoint={() => {}}
          onSaveEdit={() => {}}
          onCancelEdit={() => {}}
          onAddManual={() => {}}
          onRequestAccess={() => {}}
          onScanQr={() => {}}
          onEnterPairingCode={() => {}}
          onViewDevices={() => {}}
          discoveryAvailable={false}
          onDiscover={() => {}}
        />,
      );

      const rows = warningRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain("isn't accepting this device");
      expect(rows[0]?.textContent).toMatch(
        /the address is fine.*isn't authorised there/i,
      );
    });
  });

  /**
   * station#4512 review (M6) — Forget used to remove a saved connection on
   * a single tap. Two deliberate taps now, matching `PairedDeviceList.tsx`'s
   * `DeviceRow` revoke confirm (`confirming ? <Confirm/Cancel> : <normal
   * actions>`) — the same mechanism `ConnectionBannerSource.tsx` names as
   * its own "Remove connection" control's origin. The confirm step also
   * restores the sheet's only remaining statement of Forget's blast radius
   * (station#4513 deleted the header subtitle that used to carry it).
   */
  describe('Forget confirmation (station#4512 M6)', () => {
    it('arms on the first tap without removing anything, then requires a second, explicit tap', () => {
      const onRemove = vi.fn();
      render(
        <ConnectionListPanel
          connections={[connection]}
          activeConnectionId={connection.id}
          editingId={null}
          editName=""
          editUrl=""
          credentialEntry=""
          getStatus={() => 'connected'}
          onSelect={() => {}}
          onCheck={() => {}}
          onStartEdit={() => {}}
          onRemove={onRemove}
          onEditNameChange={() => {}}
          onEditUrlChange={() => {}}
          onCredentialEntryChange={() => {}}
          onRemoveCredential={() => {}}
          onConfirmEndpoint={() => {}}
          onSaveEdit={() => {}}
          onCancelEdit={() => {}}
          onAddManual={() => {}}
          onRequestAccess={() => {}}
          onScanQr={() => {}}
          onEnterPairingCode={() => {}}
          onViewDevices={() => {}}
          discoveryAvailable={false}
          onDiscover={() => {}}
        />,
      );

      fireEvent.click(
        screen.getByRole('button', {
          name: 'More actions for Station One',
        }),
      );
      const forgetButton = screen.getByRole('menuitem', {
        name: 'Forget Station',
      });
      fireEvent.click(forgetButton);
      // Arming must not remove anything by itself.
      expect(onRemove).not.toHaveBeenCalled();
      // The scope statement the deleted subtitle used to carry, restored
      // here — the moment it is actually relevant.
      expect(
        screen.getByText('Removes it from this device only.'),
      ).toBeTruthy();
      // The plain Forget affordance is gone; Confirm/Cancel replace it.
      expect(
        screen.queryByRole('menuitem', { name: 'Forget Station' }),
      ).toBeNull();

      const confirmButton = screen.getByRole('button', {
        name: `Confirm forgetting ${connection.name}`,
      });
      fireEvent.click(confirmButton);
      expect(onRemove).toHaveBeenCalledWith(connection.id);
    });

    it('Cancel disarms without removing anything, and restores the plain Forget control', () => {
      const onRemove = vi.fn();
      render(
        <ConnectionListPanel
          connections={[connection]}
          activeConnectionId={connection.id}
          editingId={null}
          editName=""
          editUrl=""
          credentialEntry=""
          getStatus={() => 'connected'}
          onSelect={() => {}}
          onCheck={() => {}}
          onStartEdit={() => {}}
          onRemove={onRemove}
          onEditNameChange={() => {}}
          onEditUrlChange={() => {}}
          onCredentialEntryChange={() => {}}
          onRemoveCredential={() => {}}
          onConfirmEndpoint={() => {}}
          onSaveEdit={() => {}}
          onCancelEdit={() => {}}
          onAddManual={() => {}}
          onRequestAccess={() => {}}
          onScanQr={() => {}}
          onEnterPairingCode={() => {}}
          onViewDevices={() => {}}
          discoveryAvailable={false}
          onDiscover={() => {}}
        />,
      );

      fireEvent.click(
        screen.getByRole('button', {
          name: 'More actions for Station One',
        }),
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Forget Station' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onRemove).not.toHaveBeenCalled();
      expect(
        screen.queryByText('Removes it from this device only.'),
      ).toBeNull();
      expect(
        screen.getByRole('button', {
          name: 'More actions for Station One',
        }),
      ).toBeTruthy();
    });
  });
});
