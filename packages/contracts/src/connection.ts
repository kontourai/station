/** Domain types owned by the connection registry, not the tool-server API. */
export type ConnectionKind = 'model' | 'agent';

/** The single Station-engine ownership derivation. */
export function isStationEngine(engineId: unknown): boolean {
  return engineId === 'station';
}
