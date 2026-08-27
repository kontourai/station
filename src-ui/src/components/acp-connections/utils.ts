import type { ACPConnectionInfo } from '../../hooks/useACPConnections';

export type ACPConnectionReadiness =
  | 'Checking'
  | 'Ready'
  | 'Setup needed'
  | 'Unavailable'
  | 'Off';

export type ACPConnectionStatusTone =
  | 'ready'
  | 'checking'
  | 'setup-needed'
  | 'unavailable'
  | 'off';

type RecommendedAction = 'Enable' | 'Reconnect' | null;

export function getACPConnectionStatusView(conn: ACPConnectionInfo) {
  const isConnected = conn.status === 'available';
  const isConnecting = conn.status === 'probing';
  const isUnavailable = conn.status === 'unavailable';
  const isError = conn.status === 'error';
  const isDisconnected = conn.status === 'disconnected';
  const isPlugin = conn.source === 'plugin';
  const statusLabel: ACPConnectionReadiness = !conn.enabled
    ? 'Off'
    : isConnecting
      ? 'Checking'
      : isConnected
        ? 'Ready'
        : isUnavailable
          ? 'Setup needed'
          : 'Unavailable';
  const recommendedAction: RecommendedAction = isPlugin
    ? null
    : !conn.enabled
      ? 'Enable'
      : isError ||
          isDisconnected ||
          (!isConnected && !isConnecting && !isUnavailable)
        ? 'Reconnect'
        : null;
  const statusTone: ACPConnectionStatusTone =
    statusLabel === 'Ready'
      ? 'ready'
      : statusLabel === 'Checking'
        ? 'checking'
        : statusLabel === 'Setup needed'
          ? 'setup-needed'
          : statusLabel === 'Unavailable'
            ? 'unavailable'
            : 'off';

  return {
    isConnected,
    isConnecting,
    isUnavailable,
    isError,
    isDisconnected,
    isPlugin,
    statusLabel,
    statusTone,
    recommendedAction,
    // Kept for the details dialog, which still owns its own presentation.
    statusColor:
      statusTone === 'ready'
        ? 'var(--success-text)'
        : statusTone === 'checking'
          ? 'var(--accent-primary)'
          : statusTone === 'setup-needed'
            ? 'var(--warning-text)'
            : statusTone === 'unavailable'
              ? 'var(--error-text)'
              : 'var(--text-muted)',
  };
}
