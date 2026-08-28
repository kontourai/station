import type { SavedConnection } from '@kontourai/station-connect';

// Host-injected connections (`cli-base` / `managed-loopback`) are composed into
// the connection list at runtime but never persist, so they do not count as a
// real saved host.
const INJECTED_CONNECTION_IDS = new Set(['cli-base', 'managed-loopback']);

/**
 * A "real" saved host is one the user has actually reached or entered — a
 * non-same-origin endpoint, or one that has learned a server identity or
 * connected before. Injected (host-supplied) connections are excluded.
 *
 * Shared rather than local to `OnboardingGate` (archive#3311): this predicate
 * is what decides whether the mobile "No Station connected" banner appears, so
 * the toolbar's connection chip has to key its own copy and its mobile
 * suppression on the SAME condition. A second reader that re-derived
 * "unconnected" from the health status instead announced "Reconnecting" on a
 * device that had never connected to anything, beside a banner saying the
 * opposite.
 */
export function hasRealSavedConnection(
  connections: SavedConnection[] | undefined,
): boolean {
  return (connections ?? []).some((connection) => {
    if (INJECTED_CONNECTION_IDS.has(connection.id)) return false;
    if (connection.environmentId || connection.lastSuccessAt) return true;
    const selectedEndpoint = connection.endpoints.find(
      (endpoint) => endpoint.id === connection.selectedEndpointId,
    );
    return Boolean(selectedEndpoint && selectedEndpoint.kind !== 'same-origin');
  });
}
