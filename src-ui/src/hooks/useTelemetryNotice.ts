import type { TelemetryPublisherId } from '@kontourai/station-contracts/product-telemetry';
import { authenticatedFetch, mutateJson } from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
} from '@kontourai/station-sdk/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useOptionalRecoveryScope } from '../contexts/RecoveryQueryBoundary';
import { type TelemetryStatus, useTelemetryStatus } from './useTelemetryStatus';

/** Capture a visible notice at interaction time; persist it only after any choice write. */
export function useTelemetryNotice(enabled: boolean) {
  const { apiBase: protectedBase } = useApiBase();
  const scope = useOptionalRecoveryScope();
  const apiBase = scope?.apiBase ?? protectedBase;
  const targetKey = `${apiBase}:${scope?.identityKey ?? 'protected'}`;
  const status = useTelemetryStatus(enabled);
  const client = useQueryClient();
  const element = useRef<HTMLElement>(null);
  const inFlight = useRef(new Set<string>());
  const receipt = useMutation({
    mutationFn: async (target: {
      publisher: TelemetryPublisherId;
      revision: string;
      apiBase: string;
      identityKey: string | undefined;
      requestScope: ApiRequestScope | null;
    }) => {
      const body = {
        publisher: target.publisher,
        inventoryRevision: target.revision,
      };
      const response =
        target.identityKey !== undefined
          ? await mutateJson(
              `${target.apiBase}/api/usage-telemetry/lite-notices`,
              'POST',
              {
                timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
                ...(target.requestScope
                  ? { requestScope: target.requestScope }
                  : {}),
              },
              body,
            )
          : await authenticatedFetch(
              `${target.apiBase}/api/usage-telemetry/lite-notices`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              },
            );
      if (!response.ok)
        throw new Error('The notice receipt could not be saved.');
    },
    onSuccess: async (_result, target) => {
      await client.cancelQueries({
        queryKey: ['telemetry-status', target.apiBase, target.identityKey],
        exact: true,
      });
      client.setQueryData<TelemetryStatus>(
        ['telemetry-status', target.apiBase, target.identityKey],
        (current) => {
          if (!current || current.liteInventoryRevision !== target.revision)
            return current;
          return {
            ...current,
            liteNotices: {
              ...current.liteNotices,
              [target.publisher]: {
                publisher: target.publisher,
                inventoryRevision: target.revision,
                shownAt: new Date().toISOString(),
              },
            },
          };
        },
      );
    },
  });
  const prepareShown = useCallback(() => {
    const node = element.current;
    const current = status.data;
    if (
      !enabled ||
      !node ||
      !current ||
      document.visibilityState !== 'visible' ||
      [...document.querySelectorAll('[aria-modal="true"]')].some(
        (modal) => !modal.contains(node),
      )
    )
      return;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (
      style.visibility === 'hidden' ||
      style.display === 'none' ||
      rect.width <= 0 ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth ||
      rect.height <= 0 ||
      rect.top >= window.innerHeight ||
      rect.bottom <= 0
    )
      return;
    const revision = current.liteInventoryRevision;
    const targets = (['kontour', 'operator'] as const)
      .filter((publisher) => {
        const state = current.publishers[publisher];
        return (
          state &&
          state.reason !== 'DNT' &&
          current.liteNotices?.[publisher]?.inventoryRevision !== revision
        );
      })
      .map((publisher) => ({
        publisher,
        revision,
        apiBase,
        identityKey: scope?.identityKey,
        requestScope: scope?.requestScope ?? null,
      }));
    return async () => {
      for (const target of targets) {
        const key = `${targetKey}:${target.publisher}:${target.revision}`;
        if (inFlight.current.has(key)) continue;
        inFlight.current.add(key);
        try {
          await receipt.mutateAsync(target);
        } finally {
          inFlight.current.delete(key);
        }
      }
    };
  }, [
    enabled,
    status.data,
    targetKey,
    apiBase,
    scope?.identityKey,
    scope?.requestScope,
    receipt.mutateAsync,
  ]);
  const recordShown = useCallback(async () => {
    await prepareShown()?.();
  }, [prepareShown]);
  return { element, isError: receipt.isError, prepareShown, recordShown };
}
