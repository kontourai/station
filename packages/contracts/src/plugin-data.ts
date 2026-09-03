/**
 * Owner-qualified identity for one plugin's private data namespace.
 *
 * `installationKey` is minted by the host from installation provenance. Plugin
 * code never chooses it and never receives a filesystem path.
 */
export interface PluginDataOwner {
  pluginId: string;
  installationKey: string;
}

export type PluginDataJson =
  | null
  | boolean
  | number
  | string
  | PluginDataJson[]
  | { [key: string]: PluginDataJson };

export interface PluginDataRecord {
  key: string;
  value: PluginDataJson;
  revision: number;
  updatedAt: string;
}

export type PluginDataUnavailableReason = 'transient' | 'corrupt';

export type PluginDataReadOutcome =
  | { kind: 'found'; record: PluginDataRecord }
  | { kind: 'not-found' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unavailable'; reason: PluginDataUnavailableReason };

export type PluginDataListOutcome =
  | { kind: 'available'; records: PluginDataRecord[] }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unavailable'; reason: PluginDataUnavailableReason };

export type PluginDataWriteOutcome =
  | { kind: 'written'; record: PluginDataRecord }
  | { kind: 'conflict'; currentRevision: number | null }
  | { kind: 'capacity'; reason: 'keys' | 'value-bytes' | 'total-bytes' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unavailable'; reason: PluginDataUnavailableReason };

export type PluginDataDeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'not-found' }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unavailable'; reason: PluginDataUnavailableReason };

export const PLUGIN_DATA_LIMITS = {
  /** Live keys plus retained revision heads; delete does not reclaim identity. */
  keysPerInstallation: 1_024,
  valueBytes: 256 * 1_024,
  totalBytesPerInstallation: 4 * 1_024 * 1_024,
} as const;
