import type {
  TelemetryLiteNoticeReceipt,
  TelemetryPublisherId,
  TelemetryPublisherStatus,
} from '@kontourai/station-contracts/product-telemetry';
import { authenticatedFetch, getJson } from '@kontourai/station-sdk';
import { DEFAULT_CLIENT_REQUEST_TIMEOUT_MS } from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useOptionalRecoveryScope } from '../contexts/RecoveryQueryBoundary';

export interface TelemetryStatus {
  authorEndpoint?: string;
  publishers: Partial<Record<TelemetryPublisherId, TelemetryPublisherStatus>>;
  liteInventoryRevision: string;
  liteInventory: Record<
    string,
    {
      domain: string | readonly string[];
      arrayMax?: number;
      maxLength?: number;
      max?: number;
    }
  >;
  liteNotices?: Partial<
    Record<TelemetryPublisherId, TelemetryLiteNoticeReceipt>
  >;
}

export function telemetryPublisherLabel(publisher: string): string {
  return publisher === 'kontour'
    ? 'Kontour'
    : publisher === 'operator'
      ? 'Operator'
      : publisher.replace(/^publisher:/, '');
}

export function useTelemetryStatus(enabled = true) {
  const { apiBase } = useApiBase();
  const scope = useOptionalRecoveryScope();
  const targetBase = scope?.apiBase ?? apiBase;
  return useQuery({
    queryKey: ['telemetry-status', targetBase, scope?.identityKey],
    enabled,
    queryFn: async ({ signal }): Promise<TelemetryStatus> => {
      const response = scope
        ? await getJson(`${targetBase}/api/usage-telemetry/status`, {
            signal,
            timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
            ...(scope.requestScope ? { requestScope: scope.requestScope } : {}),
          })
        : await authenticatedFetch(`${targetBase}/api/usage-telemetry/status`, {
            signal,
          });
      if (!response.ok)
        throw new Error('Telemetry status could not be loaded.');
      return (await response.json()).data;
    },
    staleTime: 0,
    refetchOnMount: 'always',
  });
}
