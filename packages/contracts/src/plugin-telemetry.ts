import type { TelemetryPublisherId } from './product-telemetry.js';

/** Shared by plugin and future distribution manifests. Counts are bucketed locally. */
export interface PublisherTelemetryDeclaration {
  publisher: string;
  endpoint: string;
  events: Record<
    string,
    {
      properties: Record<
        string,
        readonly string[] | { countBuckets: readonly number[] }
      >;
    }
  >;
}
export const PLUGIN_TELEMETRY_LIMITS = {
  events: 16,
  properties: 8,
  values: 16,
  cells: 256,
  tokenLength: 48,
  countMaximum: 65535,
} as const;
export type PluginTelemetryCountBucket = '0' | '1' | '2-3' | '4+';
export interface PluginDailyPing {
  event: 'plugin_daily';
  schema_version: 1;
  data_revision: string;
  inventory_revision: string;
  event_id: string;
  publisher: TelemetryPublisherId;
  events: Record<
    string,
    {
      count: PluginTelemetryCountBucket;
      properties: Record<string, Record<string, PluginTelemetryCountBucket>>;
    }
  >;
}
export interface PluginTelemetryEvent {
  event: 'plugin_event';
  schema_version: 1;
  data_revision: string;
  inventory_revision: string;
  event_id: string;
  publisher: TelemetryPublisherId;
  name: string;
  properties: Record<string, string>;
  distinct_id: string;
  timestamp: string;
}
