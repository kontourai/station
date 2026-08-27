import { describe, expect, it } from 'vitest';
import type { SavedConnection } from '../core/types';
import {
  connectionCardMeta,
  connectionDisplayLabel,
  connectionNeedsAccessRequest,
  getConnectionManagerTitle,
  getConnectionStatus,
  injectedConnectionDotStatus,
  injectedConnectionStateLabel,
} from '../react/connection-manager-modal-utils';

function connection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    profileVersion: 4,
    id: 'conn-1',
    name: 'Remote Station',
    url: 'https://station.example.test',
    endpoints: [],
    selectedEndpointId: '',
    accessMethods: [],
    selectedAccessMethodId: '',
    environmentId: null,
    authProtocolVersion: null,
    credentialRef: { credentialVersion: 1, kind: 'connection', id: 'conn-1' },
    capabilities: null,
    credentialState: 'not-required',
    ...overrides,
  };
}

describe('connection-manager-modal-utils', () => {
  it('maps panels to stable titles', () => {
    expect(getConnectionManagerTitle('list')).toBe('Stations');
    expect(getConnectionManagerTitle('add')).toBe('Add Station');
    expect(getConnectionManagerTitle('request-access')).toBe('Request Access');
    expect(getConnectionManagerTitle('pair-device')).toBe(
      'Scan a pairing code',
    );
    expect(getConnectionManagerTitle('pair-code')).toBe('Enter a pairing code');
    expect(getConnectionManagerTitle('pair-host')).toBe('Pair a Device');
    expect(getConnectionManagerTitle('devices')).toBe('Paired Devices');
    expect(getConnectionManagerTitle('discover')).toBe('Other Stations');
  });

  it('flags a connection as needing an access request when its credential is missing', () => {
    expect(
      connectionNeedsAccessRequest(connection({ credentialState: 'required' })),
    ).toBe(true);
  });

  it('flags a connection as needing an access request when its last credential was rejected', () => {
    expect(
      connectionNeedsAccessRequest(
        connection({
          credentialState: 'saved',
          lastError: {
            reason: 'authentication-failed',
            at: Date.now(),
          },
        }),
      ),
    ).toBe(true);
  });

  it('does not nag for access when the connection is managed outside the row', () => {
    // `not-required` does not infer protected-route authority from loopback.
    // Durable pairing stays available from Paired devices / Request access.
    expect(
      connectionNeedsAccessRequest(
        connection({ credentialState: 'not-required' }),
      ),
    ).toBe(false);
  });

  it('never flags a host-injected connection, whatever its credential state', () => {
    // The injected bundled-server/CLI-base connection lives outside the
    // persisted list, so credential/pairing mutations silently no-op on it —
    // offering Authorize there would loop through a false success forever.
    expect(
      connectionNeedsAccessRequest(
        connection({ credentialState: 'not-required', injected: true }),
      ),
    ).toBe(false);
    expect(
      connectionNeedsAccessRequest(
        connection({
          credentialState: 'saved',
          injected: true,
          lastError: { reason: 'authentication-failed', at: Date.now() },
        }),
      ),
    ).toBe(false);
  });

  it('does not flag a connection with a working credential or an established device session, and no error', () => {
    expect(
      connectionNeedsAccessRequest(connection({ credentialState: 'saved' })),
    ).toBe(false);
    expect(
      connectionNeedsAccessRequest(
        connection({ credentialState: 'device-session' }),
      ),
    ).toBe(false);
  });

  it('does not flag a connection whose last error was not an auth failure', () => {
    expect(
      connectionNeedsAccessRequest(
        connection({
          credentialState: 'saved',
          lastError: { reason: 'unreachable', at: Date.now() },
        }),
      ),
    ).toBe(false);
  });

  it('labels a connection by its name, falling back to its address', () => {
    expect(connectionDisplayLabel(connection({ name: 'Remote Station' }))).toBe(
      'Remote Station',
    );
    expect(
      connectionDisplayLabel(
        connection({ name: '', url: 'https://station.example.test' }),
      ),
    ).toBe('https://station.example.test');
  });

  it('derives the same connection status semantics as the inline modal logic', () => {
    expect(
      getConnectionStatus({
        connectionId: 'a',
        activeConnectionId: 'a',
        healthValue: null,
      }),
    ).toBe('connecting');
    expect(
      getConnectionStatus({
        connectionId: 'a',
        activeConnectionId: 'a',
        healthValue: true,
      }),
    ).toBe('connected');
    expect(
      getConnectionStatus({
        connectionId: 'a',
        activeConnectionId: 'a',
        healthValue: false,
      }),
    ).toBe('error');
    expect(
      getConnectionStatus({
        connectionId: 'a',
        activeConnectionId: 'b',
        healthValue: true,
      }),
    ).toBe('connected');
    expect(
      getConnectionStatus({
        connectionId: 'a',
        activeConnectionId: 'b',
        healthValue: false,
      }),
    ).toBe('error');
    expect(
      getConnectionStatus({
        connectionId: 'a',
        activeConnectionId: 'b',
        healthValue: undefined,
      }),
    ).toBe('connecting');
  });

  it('labels only a not-running injected local server, in its own words', () => {
    expect(
      injectedConnectionStateLabel(
        connection({ injected: true, injectedStatus: 'starting' }),
      ),
    ).toBe('Starting…');
    expect(
      injectedConnectionStateLabel(
        connection({ injected: true, injectedStatus: 'failed' }),
      ),
    ).toBe('Failed to start');
    expect(
      injectedConnectionStateLabel(
        connection({ injected: true, injectedStatus: 'stopped' }),
      ),
    ).toBe('Not running');
  });

  it('does not label a running injected server, a CLI base, or a saved connection', () => {
    // Running: shows its URL, not a state string.
    expect(
      injectedConnectionStateLabel(
        connection({ injected: true, injectedStatus: 'running' }),
      ),
    ).toBeNull();
    // CLI base (injected, no lifecycle status): always reachable.
    expect(
      injectedConnectionStateLabel(connection({ injected: true })),
    ).toBeNull();
    // An ordinary saved connection is never a local server.
    expect(injectedConnectionStateLabel(connection())).toBeNull();
  });

  it('maps a not-running injected local server onto a lifecycle-driven status dot', () => {
    expect(
      injectedConnectionDotStatus(
        connection({ injected: true, injectedStatus: 'starting' }),
      ),
    ).toBe('connecting');
    expect(
      injectedConnectionDotStatus(
        connection({ injected: true, injectedStatus: 'failed' }),
      ),
    ).toBe('error');
    expect(
      injectedConnectionDotStatus(
        connection({ injected: true, injectedStatus: 'stopped' }),
      ),
    ).toBe('idle');
  });

  it('defers to the normal dot for a running injected server, a CLI base, or a saved connection', () => {
    expect(
      injectedConnectionDotStatus(
        connection({ injected: true, injectedStatus: 'running' }),
      ),
    ).toBeNull();
    expect(
      injectedConnectionDotStatus(connection({ injected: true })),
    ).toBeNull();
    expect(injectedConnectionDotStatus(connection())).toBeNull();
  });

  // station#4513 — the single derivation behind the Stations sheet card's
  // one status line + one action.
  describe('connectionCardMeta', () => {
    it('is null for a healthy connection with nothing to report', () => {
      expect(connectionCardMeta(connection(), false)).toBeNull();
    });

    it('is null for a host-injected connection, whatever its state', () => {
      expect(
        connectionCardMeta(
          connection({
            injected: true,
            credentialState: 'required',
            lastError: { reason: 'identity-mismatch', at: Date.now() },
          }),
          true,
        ),
      ).toBeNull();
    });

    it('reports pending-approval with no action, at the top of precedence', () => {
      const conn = connection({
        credentialState: 'required',
        lastError: { reason: 'identity-mismatch', at: Date.now() },
      });
      expect(connectionCardMeta(conn, true)).toEqual({
        line: 'Access request pending approval',
      });
    });

    it('reports identity-mismatch (short summary) with a Pair again action, second in precedence', () => {
      const conn = connection({
        credentialState: 'required',
        lastError: { reason: 'identity-mismatch', at: Date.now() },
      });
      const meta = connectionCardMeta(conn, false);
      expect(meta?.line).toBe(
        "The Station at Remote Station isn't the one this device paired with.",
      );
      // The short summary only — never the full explanation sentence too.
      expect(meta?.line).not.toContain('Pair again');
      expect(meta?.action).toBe('request-access');
      expect(meta?.actionLabel).toBe('Pair again');
      expect(meta?.actionAriaLabel).toBe('Pair Remote Station again');
    });

    // station#4512 review (M4) — `authentication-failed` used to fall into
    // the generic `credential-required` bucket below (`connectionNeedsAccessRequest`
    // flags it too), which lost the #3903 insight this connection's row used
    // to carry: the address is fine, only this device isn't authorised
    // there. It is its own bucket now, ahead of the generic one, with a
    // request `reason: 'authentication-failed'` fixture — the fallback test
    // below only ever exercised `credentialState: 'required'` and never
    // this reason at all.
    it('names an authentication failure distinctly from a bare missing credential, third in precedence', () => {
      const conn = connection({
        credentialState: 'saved',
        lastError: { reason: 'authentication-failed', at: Date.now() },
      });
      const meta = connectionCardMeta(conn, false);
      expect(meta?.line).toBe("This device isn't authorised on this Station");
      expect(meta?.action).toBe('request-access');
      expect(meta?.actionLabel).toBe('Request access');
      expect(meta?.actionAriaLabel).toBe('Request access to Remote Station');
    });

    it('reports credential-required, fourth in precedence', () => {
      const conn = connection({
        credentialState: 'required',
        lastError: { reason: 'unreachable', at: Date.now() },
      });
      const meta = connectionCardMeta(conn, false);
      expect(meta?.line).toBe('Credential required');
      expect(meta?.action).toBe('request-access');
      expect(meta?.actionLabel).toBe('Request access');
    });

    it('reports any other observed failure as a summary-only line with no action', () => {
      const conn = connection({
        lastError: { reason: 'unreachable', at: Date.now() },
      });
      const meta = connectionCardMeta(conn, false);
      expect(meta?.line).toContain("Can't reach Remote Station");
      expect(meta?.action).toBeUndefined();
    });

    it('never reports a failure for a connection merely awaiting approval', () => {
      const conn = connection({
        lastError: { reason: 'awaiting-approval', at: Date.now() },
      });
      expect(connectionCardMeta(conn, false)).toBeNull();
    });
  });
});
