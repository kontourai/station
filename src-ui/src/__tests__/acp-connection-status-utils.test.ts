import { describe, expect, test } from 'vitest';
import { getACPConnectionStatusView } from '../components/acp-connections/utils';
import type { ACPConnectionInfo } from '../hooks/useACPConnections';

const finiteReadinessLabels = [
  'Checking',
  'Ready',
  'Setup needed',
  'Unavailable',
  'Off',
] as const;

function connection(
  status: string,
  enabled: boolean,
  source: ACPConnectionInfo['source'],
): ACPConnectionInfo {
  return {
    id: `${source}-${status}-${enabled}`,
    name: 'OpenCode',
    command: 'opencode',
    args: [],
    enabled,
    status,
    modes: [],
    sessionId: null,
    mcpServers: [],
    currentModel: null,
    source,
  };
}

describe('acp connection status utils', () => {
  test.each([
    ['available', true, 'user', 'Ready', null],
    ['probing', true, 'user', 'Checking', null],
    ['unavailable', true, 'user', 'Setup needed', null],
    ['error', true, 'user', 'Unavailable', 'Reconnect'],
    ['disconnected', true, 'user', 'Unavailable', 'Reconnect'],
    ['unknown', true, 'user', 'Unavailable', 'Reconnect'],
    ['available', false, 'user', 'Off', 'Enable'],
    ['probing', false, 'user', 'Off', 'Enable'],
    ['unavailable', false, 'user', 'Off', 'Enable'],
    ['error', false, 'user', 'Off', 'Enable'],
    ['disconnected', false, 'user', 'Off', 'Enable'],
    ['unknown', false, 'user', 'Off', 'Enable'],
    ['available', true, 'plugin', 'Ready', null],
    ['probing', true, 'plugin', 'Checking', null],
    ['unavailable', true, 'plugin', 'Setup needed', null],
    ['error', true, 'plugin', 'Unavailable', null],
    ['disconnected', true, 'plugin', 'Unavailable', null],
    ['unknown', true, 'plugin', 'Unavailable', null],
    ['available', false, 'plugin', 'Off', null],
    ['probing', false, 'plugin', 'Off', null],
    ['unavailable', false, 'plugin', 'Off', null],
    ['error', false, 'plugin', 'Off', null],
    ['disconnected', false, 'plugin', 'Off', null],
    ['unknown', false, 'plugin', 'Off', null],
  ] as const)(
    'projects %s / enabled=%s / source=%s as one finite result',
    (status, enabled, source, statusLabel, recommendedAction) => {
      const result = getACPConnectionStatusView(
        connection(status, enabled, source),
      );

      expect(finiteReadinessLabels).toContain(result.statusLabel);
      expect(result.statusLabel).toBe(statusLabel);
      expect(result.recommendedAction).toBe(recommendedAction);
      expect(result.isPlugin).toBe(source === 'plugin');
    },
  );

  test('does not expose more than one recommended action', () => {
    for (const status of [
      'available',
      'probing',
      'unavailable',
      'error',
      'disconnected',
      'unknown',
    ]) {
      const { recommendedAction } = getACPConnectionStatusView(
        connection(status, true, 'user'),
      );

      expect([null, 'Enable', 'Reconnect']).toContain(recommendedAction);
    }
  });
});
