import type { getACPManagerStatus } from '../../services/acp/acp-manager-view.js';

/**
 * The model ids an ACP connection's initialize handshake offered, read BEFORE
 * a session starts so a request naming another model is refused with nothing
 * run, rather than after the adapter has spawned the engine and created a
 * session it can only throw away (`ACP model value unsupported`).
 *
 * Keyed on the observed handshake, as `acpResumeCursorSupport` is: with no
 * `handshakeObservedAt` we have never met this CLI, and an engine that
 * advertised no model option has made no claim to hold the request to. Both
 * answer `undefined`, which leaves the adapter's own check authoritative.
 */
type ProducerConnection = ReturnType<
  typeof getACPManagerStatus
>['connections'][number];

type AdvertisedModelsConnection = Pick<
  ProducerConnection,
  'id' | 'handshakeObservedAt' | 'configOptions'
>;

export function acpAdvertisedModelIds(acpBridge: {
  getStatus(): { connections: AdvertisedModelsConnection[] };
}): (connectionId: string) => readonly string[] | undefined {
  return (connectionId) => {
    if (!connectionId) return undefined;
    try {
      const connection = acpBridge
        .getStatus()
        .connections.find((entry) => entry.id === connectionId);
      if (!connection?.handshakeObservedAt) return undefined;
      const modelOption = connection.configOptions.find(
        (option) => option?.category === 'model',
      );
      const ids = (modelOption?.options ?? []).flatMap((entry: unknown) => {
        const value =
          typeof entry === 'string'
            ? entry
            : (entry as { value?: unknown } | null)?.value;
        return typeof value === 'string' && value.length > 0 ? [value] : [];
      });
      return ids.length > 0 ? ids : undefined;
    } catch {
      return undefined;
    }
  };
}
