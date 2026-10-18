import type { TelemetryPublisherId } from '@kontourai/station-contracts/product-telemetry';
import { authenticatedFetch, mutateJson } from '@kontourai/station-sdk';
import { DEFAULT_CLIENT_REQUEST_TIMEOUT_MS } from '@kontourai/station-sdk/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useOptionalRecoveryScope } from '../contexts/RecoveryQueryBoundary';
import { recoveryConfigKey } from '../hooks/useRecoveryConfig';
import {
  telemetryPublisherLabel,
  useTelemetryStatus,
} from '../hooks/useTelemetryStatus';
import { Button } from './Button';
import './TelemetryPrivacy.css';

/** A committed, visible notice is the receipt owner; fetching status never records it. */
export function TelemetryLiteNotice({ enabled = true }: { enabled?: boolean }) {
  const { apiBase: protectedBase } = useApiBase();
  const scope = useOptionalRecoveryScope();
  const apiBase = scope?.apiBase ?? protectedBase;
  const targetKey = `${apiBase}:${scope?.identityKey ?? 'protected'}`;
  const status = useTelemetryStatus(enabled);
  const client = useQueryClient();
  const update = useMutation({
    mutationFn: async (publisher: TelemetryPublisherId) => {
      const response = await mutateJson(
        `${apiBase}/config/app`,
        'PUT',
        {
          timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
          ...(scope?.requestScope ? { requestScope: scope.requestScope } : {}),
        },
        { telemetryTier: { [publisher]: 'off' } },
      );
      if (!response.ok) throw new Error('The Off choice could not be saved.');
      const result = await response.json();
      if (
        !result.success ||
        result.ignoredKeys?.some(
          (entry: { key: string }) => entry.key === 'telemetryTier',
        )
      )
        throw new Error('The Off choice was refused.');
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['config'] });
      if (scope)
        void client.invalidateQueries({
          queryKey: recoveryConfigKey(scope.apiBase, scope.identityKey),
        });
    },
  });
  const [seen, setSeen] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const element = useRef<HTMLElement>(null);
  const publisher = Object.entries(status.data?.publishers ?? {}).find(
    ([id, state]) =>
      state &&
      state.tier === 'lite' &&
      state.reason !== 'DNT' &&
      status.data?.liteNotices?.[id as TelemetryPublisherId]
        ?.inventoryRevision !== status.data?.liteInventoryRevision &&
      !closed.includes(
        `${targetKey}:${id}:${status.data?.liteInventoryRevision}`,
      ),
  )?.[0] as TelemetryPublisherId | undefined;
  const revision = status.data?.liteInventoryRevision;
  const key = `${targetKey}:${publisher}:${revision}`;
  const receipt = useMutation({
    mutationFn: async (target: {
      publisher: TelemetryPublisherId;
      revision: string;
    }) => {
      const body = {
        publisher: target.publisher,
        inventoryRevision: target.revision,
      };
      const response = scope
        ? await mutateJson(
            `${apiBase}/api/usage-telemetry/lite-notices`,
            'POST',
            {
              timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
              ...(scope.requestScope
                ? { requestScope: scope.requestScope }
                : {}),
            },
            body,
          )
        : await authenticatedFetch(
            `${apiBase}/api/usage-telemetry/lite-notices`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
          );
      if (!response.ok)
        throw new Error('The notice receipt could not be saved.');
    },
  });
  useEffect(() => {
    if (!enabled || !publisher || !revision || seen.includes(key)) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const node = element.current;
          if (
            !node ||
            document.visibilityState !== 'visible' ||
            document.querySelector('[aria-modal="true"]')
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
            rect.top < 0 ||
            rect.top >= window.innerHeight ||
            rect.bottom <= 0
          )
            return;
          setSeen((prior) => [...prior, key]);
          receipt.mutate({ publisher, revision });
        });
      });
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal'],
    });
    document.addEventListener('visibilitychange', check);
    check();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', check);
    };
  }, [enabled, publisher, revision, key, seen, receipt.mutate]);
  if (!enabled || !publisher || !revision) return null;
  const close = () => {
    setClosed((prior) => [...prior, key]);
    void client.invalidateQueries({ queryKey: ['telemetry-status'] });
  };
  return (
    <aside
      ref={element}
      className="telemetry-lite-notice"
      aria-label={`Lite telemetry notice for ${telemetryPublisherLabel(publisher)}`}
    >
      <div className="telemetry-lite-notice__body">
        <h2>Station Lite telemetry — {telemetryPublisherLabel(publisher)}</h2>
        <p>
          With a configured destination, Station sends this publisher one
          identifier-free daily count of app use. It includes version, device
          and channel categories, feature and customization buckets, and
          friction counts. No installation ID, account identity, conversation
          content, or cross-day identifier is sent. You can turn it off here or
          in Privacy &amp; sharing.
        </p>
        <details>
          <summary>See the daily count inventory</summary>
          <pre>{JSON.stringify(status.data?.liteInventory, null, 2)}</pre>
        </details>
        {receipt.isError && (
          <p role="alert">
            The notice receipt could not be saved. Lite stays suppressed until a
            notice is recorded.
          </p>
        )}
        {update.isError && (
          <p role="alert">The Off choice could not be saved. Try again.</p>
        )}
      </div>
      <div className="telemetry-lite-notice__actions">
        <Button
          variant="secondary"
          disabled={update.isPending}
          onClick={() => update.mutate(publisher, { onSuccess: close })}
        >
          Turn off {telemetryPublisherLabel(publisher)} telemetry
        </Button>
        <Button variant="secondary" onClick={close}>
          Dismiss notice
        </Button>
      </div>
    </aside>
  );
}
