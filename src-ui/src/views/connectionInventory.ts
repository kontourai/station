import type {
  ConnectionConfig,
  ModelConnectionConfig,
} from '@kontourai/station-contracts/tool';

export function getKnowledgeInventory(connections: ConnectionConfig[]): {
  vectorDb: ModelConnectionConfig | null;
  embeddingProvider: ModelConnectionConfig | null;
} {
  const modelConnections = connections.filter(
    (connection): connection is ModelConnectionConfig =>
      connection.kind === 'model',
  );
  return {
    vectorDb:
      modelConnections.find(
        (connection) =>
          connection.enabled && connection.capabilities.includes('vectordb'),
      ) ??
      modelConnections.find((connection) =>
        connection.capabilities.includes('vectordb'),
      ) ??
      null,
    embeddingProvider:
      modelConnections.find(
        (connection) =>
          connection.enabled && connection.capabilities.includes('embedding'),
      ) ?? null,
  };
}

export function findModelConnectionById(
  connections: ConnectionConfig[],
  id: string | null | undefined,
): ModelConnectionConfig | null {
  if (!id) {
    return null;
  }
  return (
    connections.find(
      (connection): connection is ModelConnectionConfig =>
        connection.kind === 'model' && connection.id === id,
    ) ?? null
  );
}
