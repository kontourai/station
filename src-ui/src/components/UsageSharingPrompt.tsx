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
import {
  type Ref,
  type RefObject,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useOptionalRecoveryScope } from '../contexts/RecoveryQueryBoundary';
import {
  recoveryConfigKey,
  useRecoveryConfig,
} from '../hooks/useRecoveryConfig';
import { useTelemetryNotice } from '../hooks/useTelemetryNotice';
import { useTelemetryStatus } from '../hooks/useTelemetryStatus';
import {
  afterInitialStartup,
  initialStartupIsActive,
} from '../lib/startup-presentation';
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
  dismissNoticeRef,
  initialChoiceRef,
}: {
  data: SharingDisclosure & { inventoryRevision: string };
  onClose: () => void;
  onDecided: (apiBase: string, dnt: boolean) => void;
  dialog?: boolean;
  dismissNoticeRef?: Ref<() => void>;
  initialChoiceRef?: RefObject<HTMLInputElement | null>;
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
  const savedChoice = (id: 'kontour' | 'operator') =>
    settings?.telemetryTier?.[id] ??
    status.data?.publishers[id]?.userChoice ??
    (status.data?.publishers[id]?.reason === 'DNT'
      ? 'lite'
      : status.data?.publishers[id]?.tier) ??
    'lite';
  const kontourChoice = savedChoice('kontour');
  const additionalChoice = savedChoice('operator');
  const initialChoice =
    kontourChoice === additionalChoice ? kontourChoice : undefined;
  const selectionTarget = JSON.stringify([
    apiBase,
    scope?.identityKey,
    data.inventoryRevision,
    data.authorDisclosure?.destination,
    dnt,
    kontourChoice,
    additionalChoice,
  ]);
  const [selection, setSelection] = useState<{
    target: string;
    value: TelemetryTier;
  }>();
  const choice =
    selection?.target === selectionTarget ? selection.value : initialChoice;
  const setChoice = (value: TelemetryTier) =>
    setSelection({ target: selectionTarget, value });
  const client = useQueryClient();
  const internalChoiceRef = useRef<HTMLInputElement>(null);
  const choiceRef = initialChoiceRef ?? internalChoiceRef;
  useLayoutEffect(() => {
    // The native startup dialog makes body portals inert until handoff.
    if (initialStartupIsActive())
      return afterInitialStartup(() => choiceRef.current?.focus());
  }, [choiceRef]);
  const save = useMutation({
    mutationFn: async (action: {
      next: TelemetryTier;
      recordNotice: (() => Promise<void>) | undefined;
    }) => {
      const { next } = action;
      // Guarded recovery writes refuse rotation of the captured authority.
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
      let noticeSaved = true;
      try {
        await action.recordNotice?.();
      } catch {
        noticeSaved = false;
      }
      return { ...target, dnt, noticeSaved };
    },
    onError: () => {
      void client.invalidateQueries({
        queryKey: ['usage-telemetry-disclosure'],
      });
    },
    onSuccess: async (target) => {
      if (!target.noticeSaved) return;
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
  useImperativeHandle(dismissNoticeRef, () => () => {
    // The owner may close while a Save is pending; that Save owns the notice.
    if (!save.isPending) void notice.recordShown().catch(() => {});
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
        initialChoiceRef={choiceRef}
        value={choice}
        onChange={setChoice}
        disabled={save.isPending || !status.data}
        dnt={dnt}
        host={host}
        data={data}
        counts={status.data?.liteInventory}
      />
      {initialChoice === undefined && (
        <p>
          Your current choices differ between the two destinations. Choosing an
          option changes both. Not now keeps your current choices.
        </p>
      )}
      {(save.isError || notice.isError) && (
        <PageCallout
          calloutId="usage-sharing-error"
          tone="error"
          role="alert"
          ariaLabel="Sharing choice error"
        >
          {save.isError
            ? 'Your sharing choice could not be saved. Try again.'
            : save.data?.noticeSaved === false
              ? 'Your sharing choice was saved, but the notice could not be saved. Anonymous counts stay paused. Try Save choice again.'
              : 'The notice could not be saved. Anonymous counts stay paused until it is saved.'}
        </PageCallout>
      )}
    </section>
  );
  const close = async () => {
    if (save.isPending) {
      onClose();
      return;
    }
    try {
      await notice.recordShown();
    } finally {
      if (save.data?.noticeSaved === false) {
        void client.invalidateQueries({ queryKey: ['config'] });
        void client.invalidateQueries({ queryKey: ['telemetry-status'] });
      }
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
        variant="secondary"
        onClick={() => {
          if (choice !== undefined)
            save.mutate({ next: choice, recordNotice: notice.prepareShown() });
        }}
        disabled={save.isPending || !status.data || choice === undefined}
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
      initialFocusRef={choiceRef}
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
