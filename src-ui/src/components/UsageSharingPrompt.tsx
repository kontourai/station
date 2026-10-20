import {
  PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
  type TelemetryTier,
} from '@kontourai/station-contracts/product-telemetry';
import {
  authenticatedFetch,
  mutateJson,
  useConfigQuery,
} from '@kontourai/station-sdk';
import { DEFAULT_CLIENT_REQUEST_TIMEOUT_MS } from '@kontourai/station-sdk/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useOptionalRecoveryScope } from '../contexts/RecoveryQueryBoundary';
import {
  recoveryConfigKey,
  useRecoveryConfig,
} from '../hooks/useRecoveryConfig';
import { useTelemetryNotice } from '../hooks/useTelemetryNotice';
import { useTelemetryStatus } from '../hooks/useTelemetryStatus';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { PageCallout } from './PageCallout';
import { ResponsiveSurfaceActions } from './ResponsiveDialogSurface';
import {
  type SharingDisclosure,
  UsageSharingChoices,
} from './UsageSharingChoices';

export function UsageSharingPrompt({
  data,
  onClose,
  onDecided,
  dialog = false,
}: {
  data: SharingDisclosure & { inventoryRevision: string };
  onClose: () => void;
  onDecided: (apiBase: string, dnt: boolean) => void;
  dialog?: boolean;
}) {
  const scope = useOptionalRecoveryScope();
  const { apiBase: protectedBase } = useApiBase();
  const apiBase = scope?.apiBase ?? protectedBase;
  const config = useConfigQuery({ enabled: !scope });
  const recovery = useRecoveryConfig();
  const settings = scope ? recovery.data : config.data;
  const status = useTelemetryStatus();
  const dnt = Object.values(status.data?.publishers ?? {}).some(
    (state) => state?.reason === 'DNT',
  );
  const notice = useTelemetryNotice(true);
  const selectionTarget = JSON.stringify([
    apiBase,
    scope?.identityKey,
    data.inventoryRevision,
    data.authorDisclosure?.destination,
    dnt,
  ]);
  const [selection, setSelection] = useState<{
    target: string;
    value: TelemetryTier;
  }>();
  const choice =
    selection?.target === selectionTarget ? selection.value : 'lite';
  const setChoice = (value: TelemetryTier) =>
    setSelection({ target: selectionTarget, value });
  const client = useQueryClient();
  const saveRef = useRef<HTMLButtonElement>(null);
  const save = useMutation({
    mutationFn: async (next: TelemetryTier) => {
      // Capture one authority for both requests; guarded recovery writes refuse rotation.
      const target = { apiBase, scope };
      const write = async (
        path: string,
        method: 'PUT' | 'POST',
        body: unknown,
      ) => {
        const response = target.scope
          ? await mutateJson(
              `${target.apiBase}${path}`,
              method,
              {
                timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
                ...(target.scope.requestScope
                  ? { requestScope: target.scope.requestScope }
                  : {}),
              },
              body,
            )
          : await authenticatedFetch(`${target.apiBase}${path}`, {
              method,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
        if (!response.ok)
          throw new Error('Your sharing choice could not be saved. Try again.');
        const result = await response.json();
        if (
          !result.success ||
          result.ignoredKeys?.some(
            (entry: { key: string }) => entry.key === 'telemetryTier',
          )
        )
          throw new Error('Your sharing choice could not be saved. Try again.');
      };
      if (next === 'full' && !dnt) {
        if (status.data?.authorEndpoint) {
          const author = data.authorDisclosure;
          if (
            !author ||
            author.inventoryRevision !== data.inventoryRevision ||
            author.destination !== status.data.authorEndpoint
          )
            throw new Error(
              'Sharing details changed. Review them and try again.',
            );
          await write(
            '/api/usage-telemetry/disclosure/acknowledgements',
            'POST',
            {
              publisher: 'kontour',
              destination: author.destination,
              inventoryRevision: author.inventoryRevision,
              acknowledgementProtocol:
                PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
            },
          );
        }
        await write(
          '/api/usage-telemetry/disclosure/acknowledgements',
          'POST',
          {
            acknowledgementProtocol: PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
            inventoryRevision: data.inventoryRevision,
          },
        );
      }
      await write('/config/app', 'PUT', {
        telemetryTier: {
          kontour: next,
          operator: next,
        },
      });
      return { ...target, dnt };
    },
    onError: () => {
      void client.invalidateQueries({
        queryKey: ['usage-telemetry-disclosure'],
      });
    },
    onSuccess: async (target) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['config'] }),
        client.invalidateQueries({ queryKey: ['usage-telemetry-disclosure'] }),
        client.invalidateQueries({ queryKey: ['telemetry-status'] }),
        ...(target.scope
          ? [
              client.invalidateQueries({
                queryKey: recoveryConfigKey(
                  target.apiBase,
                  target.scope.identityKey,
                ),
              }),
            ]
          : []),
      ]);
      onDecided(target.apiBase, target.dnt);
    },
  });
  let host: string | undefined = data.additionalHost;
  try {
    if (!host && settings?.productTelemetryEndpoint)
      host = new URL(settings.productTelemetryEndpoint).host;
  } catch {
    /* Invalid addresses are handled by Settings validation. */
  }
  const body = (
    <section
      ref={notice.element}
      data-testid={
        dialog ? 'usage-telemetry-disclosure-modal' : 'first-run-disclosure'
      }
    >
      <UsageSharingChoices
        firstRun
        value={choice}
        onChange={setChoice}
        disabled={save.isPending || !status.data}
        dnt={dnt}
        host={host}
        data={data}
        counts={status.data?.liteInventory}
      />
      {(save.isError || notice.isError) && (
        <PageCallout
          calloutId="usage-sharing-error"
          tone="error"
          role="alert"
          ariaLabel="Sharing choice error"
        >
          {save.isError
            ? 'Your sharing choice could not be saved. Try again.'
            : 'The notice could not be saved. Anonymous counts stay paused until it is saved.'}
        </PageCallout>
      )}
    </section>
  );
  const close = async () => {
    try {
      await notice.recordShown();
    } finally {
      onClose();
    }
  };
  const actions = (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          void close().catch(() => {});
        }}
        disabled={save.isPending}
      >
        Not now
      </Button>
      <Button
        ref={saveRef}
        variant="secondary"
        onClick={() => save.mutate(choice)}
        disabled={save.isPending || !status.data}
      >
        Save choice
      </Button>
    </>
  );
  return dialog ? (
    <Dialog
      title="Usage sharing"
      eyebrow="Privacy & sharing"
      closeLabel="Close usage sharing"
      onClose={() => {
        void close().catch(() => {});
      }}
      size="lg"
      historyMode="none"
      panelClassName="usage-telemetry-disclosure"
      initialFocusRef={saveRef}
      initialFocusPolicy="always"
      footer={actions}
    >
      {body}
    </Dialog>
  ) : (
    <>
      {body}
      <ResponsiveSurfaceActions className="first-run-chapter__actions">
        {actions}
      </ResponsiveSurfaceActions>
    </>
  );
}
