import { useQuery } from '@tanstack/react-query';
import { authenticatedFetch } from '../client/http';
import type { QueryConfig } from '../query-core';

export interface SystemInstance {
  component: 'command-station';
  instance?: string;
  port?: number;
  buildSha?: string;
  /** Names what computed `buildSha`: the baked bundle stamp or the checkout. */
  shaSource?: 'build-stamp' | 'checkout';
  builtAt?: string;
  channel?: string;
  dirty?: boolean;
}

export interface ServerLogEntry {
  level?: string;
  timestamp?: string;
  msg?: string;
  [key: string]: unknown;
}

export interface ServerLogsParams {
  level?: string;
  since?: string;
  until?: string;
  limit?: number;
  q?: string;
}

export interface ServerLogsResult {
  entries: ServerLogEntry[];
  truncated: boolean;
  scannedFiles: number;
  unreadableFiles: number;
  oldestScannedDay: string | null;
  skippedMalformedLines: number;
  scanBudgetExhausted: boolean;
}

export interface BootHistoryRecord {
  bootTime: string;
  pid?: number;
  shortSha?: string;
  fullSha?: string;
  instanceId?: string;
  source: 'recorded' | 'derived';
  cause?: string;
}

export interface BootHistoryResult {
  records: BootHistoryRecord[];
  currentUptimeSeconds: number;
}

export function useBootHistoryQuery(
  apiBase: string,
  config?: QueryConfig<BootHistoryResult>,
) {
  return useQuery({
    queryKey: ['system-boot-history', apiBase],
    queryFn: async (): Promise<BootHistoryResult> => {
      const response = await authenticatedFetch(
        `${apiBase}/api/system/boot-history`,
      );
      if (!response.ok) throw new Error('Failed to fetch boot history');
      return (await response.json()) as BootHistoryResult;
    },
    staleTime: config?.staleTime ?? 10_000,
    gcTime: config?.gcTime,
    enabled: Boolean(apiBase) && (config?.enabled ?? true),
  });
}

export function useSystemInstanceQuery(
  apiBase: string,
  config?: QueryConfig<SystemInstance>,
) {
  return useQuery({
    queryKey: ['system-instance', apiBase],
    queryFn: async (): Promise<SystemInstance> => {
      const response = await authenticatedFetch(
        `${apiBase}/api/system/instance`,
      );
      if (!response.ok) throw new Error('Failed to fetch system instance');
      return (await response.json()) as SystemInstance;
    },
    staleTime: config?.staleTime ?? 60_000,
    gcTime: config?.gcTime,
    enabled: Boolean(apiBase) && (config?.enabled ?? true),
  });
}

export function useServerLogsQuery(
  apiBase: string,
  params: ServerLogsParams = {},
  config?: QueryConfig<ServerLogsResult>,
) {
  const { level, since, until, limit, q } = params;
  return useQuery({
    queryKey: [
      'server-logs',
      apiBase,
      level ?? null,
      since ?? null,
      until ?? null,
      limit ?? null,
      q ?? null,
    ],
    queryFn: async (): Promise<ServerLogsResult> => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries({
        level,
        since,
        until,
        limit,
        q,
      })) {
        if (value !== undefined) search.set(key, String(value));
      }
      const response = await authenticatedFetch(
        `${apiBase}/api/diagnostics/logs${search.size ? `?${search}` : ''}`,
      );
      if (!response.ok) throw new Error('Failed to fetch server logs');
      return (await response.json()) as ServerLogsResult;
    },
    staleTime: config?.staleTime ?? 10_000,
    gcTime: config?.gcTime,
    enabled: Boolean(apiBase) && (config?.enabled ?? true),
  });
}
