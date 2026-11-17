import {
  type ACPConnectionConfig,
  type ACPConnectionRegistryEntry,
  type ACPEngineSetupEntry,
  ACPStatus,
} from '@kontourai/station-contracts/acp';
import type { getACPManagerStatus } from './acp-manager-view.js';

/** Project only setup facts; executable configuration stays with the human pane. */
export function engineSetupEntries(
  entries: readonly ACPConnectionRegistryEntry[],
  saved: readonly ACPConnectionConfig[],
  live: ReturnType<typeof getACPManagerStatus>['connections'],
): ACPEngineSetupEntry[] {
  const choices = new Map(entries.map((entry) => [entry.id, entry]));
  const ids = new Set([...choices.keys(), ...saved.map((entry) => entry.id)]);
  return [...ids].map((id) => {
    const entry = choices.get(id);
    const connection = saved.find((item) => item.id === id);
    const observed = live.find((item) => item.id === id);
    const configured = connection !== undefined;
    const enabled = connection?.enabled ?? true;
    const detected = entry?.detected ?? null;
    return {
      id,
      name: connection?.name ?? entry?.name ?? id,
      source: entry?.source === 'core' ? 'core' : entry ? 'plugin' : 'custom',
      detected,
      configured,
      enabled,
      status: observed?.status ?? 'not-connected',
      setupPath: configured
        ? `/connections/engines/${encodeURIComponent(id)}`
        : `/connections/engines/new/${encodeURIComponent(id)}`,
      handshakeObservedAt: observed?.handshakeObservedAt ?? null,
      httpTools: observed?.handshakeObservedAt
        ? observed.capabilities?.mcpCapabilities?.http === true
          ? 'advertised'
          : 'not-advertised'
        : 'unknown',
      nextAction: configured
        ? !enabled
          ? 'enable'
          : observed?.status === ACPStatus.AVAILABLE
            ? 'inspect'
            : 'check'
        : detected === false
          ? 'install'
          : 'connect',
    };
  });
}
