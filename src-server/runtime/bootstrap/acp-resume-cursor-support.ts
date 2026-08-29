import type { getACPManagerStatus } from '../../services/acp/acp-manager-view.js';

/**
 * #764: a user-requested continuation of a stopped ACP conversation must
 * know BEFORE the child start whether the connection's observed initialize
 * handshake advertised `loadSession`; without it the resume cursor path is a
 * start the ACP adapter must fail-closed (A3), leaving a durable reservation
 * the supervision read then has to look through.
 *
 * Keyed on the HANDSHAKE, not on the presence of capabilities (mirrors
 * connection-service-helpers): `capabilities` undefined can be a successful
 * handshake that advertised nothing — a real observation whose answer is
 * "unsupported" — while no `handshakeObservedAt` means we have never met this
 * CLI and the adapter's own fail-closed ruling stays authoritative.
 * `undefined` (no handshake evidence, or a non-ACP provider) keeps the cursor
 * path.
 */
type ProducerConnection = ReturnType<
  typeof getACPManagerStatus
>['connections'][number];

// Typed against the producer so a field rename is a compile error here, not a
// silent every-connection-undefined regression; Pick keeps test fakes minimal.
type ResumeSupportConnection = Pick<
  ProducerConnection,
  'id' | 'handshakeObservedAt' | 'capabilities'
>;

export function acpResumeCursorSupport(acpBridge: {
  getStatus(): { connections: ResumeSupportConnection[] };
}): (input: {
  provider?: string;
  connectionId?: string;
}) => boolean | undefined {
  return ({ provider, connectionId }) => {
    if (provider !== 'acp' || !connectionId) return undefined;
    try {
      const connection = acpBridge
        .getStatus()
        .connections.find((entry) => entry.id === connectionId);
      if (!connection?.handshakeObservedAt) return undefined;
      return connection.capabilities?.loadSession === true;
    } catch {
      return undefined;
    }
  };
}
