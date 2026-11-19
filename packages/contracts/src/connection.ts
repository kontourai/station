/** Domain types owned by the connection registry, not the tool-server API. */
export type ConnectionKind = 'model' | 'agent';

/** The single Station-engine ownership derivation. */
export function isStationEngine(engineId: unknown): boolean {
  return engineId === 'station';
}

/** A nonempty home path preserved as authored, with tilde expansion left to spawn. */
export function sanitizeConnectionConfigHome(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\u0000')) return undefined;
  return trimmed;
}

/** A configured connection home takes precedence over the Station-managed opt-in. */
export function appHomeActive(
  config: Record<string, unknown> | undefined,
): boolean {
  return (
    config?.useAppHome === true &&
    !sanitizeConnectionConfigHome(config.configHome)
  );
}

export const CLAUDE_PROXY_VERSION_FAILURE =
  'Claude reported a client version requirement. If the connection uses a model proxy, check the proxy’s upstream client version.';
