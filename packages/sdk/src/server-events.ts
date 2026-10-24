import type { QueryClient } from '@tanstack/react-query';

const appliedAcpStatuses = new WeakMap<QueryClient, Map<string, string>>();

function acpStatusFingerprint(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const status = payload as Record<string, unknown>;
  if (
    typeof status.connected !== 'boolean' ||
    !Array.isArray(status.connections)
  )
    return undefined;
  if (
    !status.connections.every(
      (connection) =>
        connection &&
        typeof connection === 'object' &&
        typeof connection.id === 'string' &&
        typeof connection.status === 'string',
    )
  )
    return undefined;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return JSON.stringify(
    canonical({
      ...status,
      connections: [...status.connections].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    }),
  );
}

/** Compare with the last applied status for this authority, including across reconnects. */
export function applyACPStatusEvent(
  queryClient: QueryClient,
  payload: unknown,
  scope: { apiBase: string; authorityKey: string; isCurrent(): boolean },
): void {
  if (!scope.isCurrent()) return;
  const fingerprint = acpStatusFingerprint(payload);
  if (fingerprint === undefined) return;
  let statuses = appliedAcpStatuses.get(queryClient);
  const firstObservation = statuses === undefined;
  if (!statuses) {
    statuses = new Map();
    appliedAcpStatuses.set(queryClient, statuses);
  }
  const key = JSON.stringify([scope.apiBase, scope.authorityKey]);
  const boot = queryClient.getQueryData<{ acp?: unknown }>([
    'system-status',
    scope.apiBase,
  ]);
  const previous =
    statuses.get(key) ??
    (firstObservation ? acpStatusFingerprint(boot?.acp) : undefined);
  statuses.delete(key);
  statuses.set(key, fingerprint);
  if (statuses.size > 128) statuses.delete(statuses.keys().next().value!);
  // An absent or evicted baseline is unknown and must refresh conservatively.
  if (previous === fingerprint) return;
  for (const name of ['agents', 'model-picker-catalog', 'system-status']) {
    void queryClient.invalidateQueries({ queryKey: [name] });
  }
  void queryClient.invalidateQueries({
    queryKey: ['connections'],
    refetchType: 'all',
    predicate: ({ queryKey }) =>
      queryKey.length <= 2 ||
      (queryKey.length === 3 &&
        queryKey[1] === 'engines' &&
        queryKey[2] === 'catalog'),
  });
  for (const name of [
    'acp-connections',
    'acp-unregistered-connections',
    'acp-connection-registry',
  ]) {
    void queryClient.invalidateQueries({
      queryKey: [name],
      refetchType: 'all',
    });
  }
}
