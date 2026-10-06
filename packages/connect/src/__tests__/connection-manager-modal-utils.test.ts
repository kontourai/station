import { describe, expect, it } from 'vitest';
import type { SavedConnection } from '../core/types';
import {
  connectionDisplayLabel,
  connectionNeedsAccessRequest,
  getConnectionManagerTitle,
  getConnectionStatus,
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
    ).toBe('idle');
  });
});
