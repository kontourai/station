import type {
  TelemetryFeedbackReason,
  TelemetryPublisherId,
  TelemetryPublisherStatus,
  TelemetryTier,
  TelemetryTierChoices,
} from '@kontourai/station-contracts/product-telemetry';
import { type ReactNode, type Ref, useState } from 'react';
import { PageCallout } from '../../components/PageCallout';
import { TelemetryFeedbackPrompt } from '../../components/TelemetryFeedbackPrompt';
import {
  SHARING_LABELS,
  type SharingCounts,
  type SharingDisclosure,
  UsageSharingChoices,
  UsageSharingIncluded,
} from '../../components/UsageSharingChoices';
import { telemetryPublisherLabel } from '../../hooks/useTelemetryStatus';
import type { AppConfig } from '../../types';
import { SettingsPageRow } from './SettingsPageRow';
import { settingsRow } from './settings-catalog';
import { TelemetryOutbox } from './TelemetryOutbox';

export function TelemetryTierSettings({
  config,
  savedChoices,
  statusError = false,
  onChange,
  publishers,
  onFeedback,
  showOutbox = false,
  disclosure,
  advancedContent,
  counts,
  noticeRef,
  noticeError,
  onDetailedIntent,
}: {
  config: AppConfig;
  disclosure?: SharingDisclosure;
  advancedContent?: ReactNode;
  counts?: SharingCounts;
  noticeRef?: Ref<HTMLElement>;
  noticeError?: boolean;
  onDetailedIntent?: () => void;
  savedChoices?: TelemetryTierChoices;
  statusError?: boolean;
  onChange: (config: AppConfig) => void;
  publishers?: Partial<Record<TelemetryPublisherId, TelemetryPublisherStatus>>;
  onFeedback?: (
    publisher: TelemetryPublisherId,
    reason: TelemetryFeedbackReason,
  ) => void;
  showOutbox?: boolean;
}) {
  const [pending, setPending] = useState<{
    publisher: TelemetryPublisherId;
    tier: TelemetryTier;
    trigger: HTMLSelectElement;
  }>();
  let host: string | undefined = disclosure?.additionalHost;
  try {
    if (!host && config.productTelemetryEndpoint)
      host = new URL(config.productTelemetryEndpoint).host;
  } catch {
    /* Settings validates the address. */
  }
  const choices: TelemetryTierChoices | undefined = config.telemetryTier;
  const savedChoice = (id: 'kontour' | 'operator') =>
    choices?.[id] ??
    publishers?.[id]?.userChoice ??
    (publishers?.[id]?.reason === 'DNT' ? 'lite' : publishers?.[id]?.tier) ??
    'lite';
  const kontourChoice = savedChoice('kontour');
  const additionalChoice = savedChoice('operator');
  const primaryChoice =
    kontourChoice === additionalChoice ? additionalChoice : undefined;
  const rank = { off: 0, lite: 1, full: 2 };
  const change = (
    publisher: TelemetryPublisherId,
    tier: TelemetryTier,
    reason: TelemetryFeedbackReason,
  ) => {
    onFeedback?.(publisher, reason);
    onChange({
      ...config,
      telemetryTier: { ...config.telemetryTier, [publisher]: tier },
    });
    setPending(undefined);
  };
  return (
    <div {...settingsRow('usage-telemetry')} tabIndex={-1}>
      <section aria-label="Usage sharing choices" ref={noticeRef}>
        <UsageSharingChoices
          value={primaryChoice}
          onChange={(tier) => {
            setPending(undefined);
            onFeedback?.('kontour', 'skip');
            onFeedback?.('operator', 'skip');
            onChange({
              ...config,
              telemetryTier: {
                ...choices,
                kontour: tier,
                operator: tier,
              },
            });
          }}
          data={disclosure}
          counts={counts}
          onDetailedIntent={onDetailedIntent}
          detailedAvailable={
            !statusError &&
            !!disclosure &&
            !!publishers?.operator?.fullAvailable
          }
          dnt={Object.values(publishers ?? {}).some(
            (state) => state?.reason === 'DNT',
          )}
          host={host}
        />
        {primaryChoice !== 'full' &&
          (kontourChoice === 'full' || additionalChoice === 'full') &&
          disclosure && <UsageSharingIncluded data={disclosure} />}
        {primaryChoice === undefined && (
          <p>
            Custom choices are set in Advanced. Choosing an option here applies
            to both destinations.
          </p>
        )}
        {noticeError && (
          <PageCallout
            calloutId="usage-sharing-notice-error"
            tone="error"
            role="alert"
            ariaLabel="Sharing notice error"
          >
            The notice could not be saved. Anonymous counts stay paused until it
            is saved.
          </PageCallout>
        )}
        {statusError && (
          <PageCallout
            calloutId="usage-sharing-status-error"
            tone="error"
            role="alert"
            ariaLabel="Sharing status error"
          >
            Sharing status could not be loaded. Detailed sharing is unavailable
            until it loads.
          </PageCallout>
        )}
      </section>
      <details className="telemetry-advanced">
        <summary>Advanced</summary>
        <section aria-label="Advanced sharing controls">
          {(
            [
              ...new Set([
                'kontour',
                'operator',
                ...Object.keys(publishers ?? {}),
                ...Object.keys(choices ?? {}),
              ]),
            ] as TelemetryPublisherId[]
          ).map((publisher) => {
            const label = `${telemetryPublisherLabel(publisher)} telemetry`;
            const status = publishers?.[publisher];
            const choice = choices?.[publisher] ?? status?.userChoice ?? '';
            return (
              <div key={publisher} className="telemetry-publisher">
                <SettingsPageRow
                  label={label}
                  description={
                    publisher === 'kontour'
                      ? "Don't share stops automatic sending. Anonymous usage counts sends one daily count after notice. Detailed sharing needs a configured Kontour destination and your review before saving."
                      : "Don't share stops automatic sending. Anonymous usage counts sends one daily count after notice, when a destination is configured. Detailed usage uses a monthly rotating installation code, never an account identity. Review What's included before saving detailed sharing."
                  }
                  control={
                    <select
                      className="editor-input"
                      aria-label={label}
                      value={
                        pending?.publisher === publisher ? pending.tier : choice
                      }
                      onChange={(event) => {
                        const tier = event.target.value as TelemetryTier;
                        if (
                          (publisher === 'operator' ||
                            publisher === 'kontour') &&
                          tier === 'full'
                        )
                          onDetailedIntent?.();
                        const previous =
                          savedChoices?.[publisher] ??
                          status?.userChoice ??
                          status?.tier ??
                          'lite';
                        if (
                          onFeedback &&
                          status?.reason !== 'DNT' &&
                          rank[tier] < rank[previous]
                        )
                          setPending({
                            publisher,
                            tier,
                            trigger: event.currentTarget,
                          });
                        else change(publisher, tier, 'skip');
                      }}
                    >
                      <option value="" disabled>
                        No saved choice
                      </option>
                      <option value="off">{SHARING_LABELS.off}</option>
                      <option value="lite">{SHARING_LABELS.lite}</option>
                      <option
                        value="full"
                        disabled={statusError || !status?.fullAvailable}
                      >
                        {SHARING_LABELS.full}
                        {!status?.fullAvailable ? ' (unavailable)' : ''}
                      </option>
                    </select>
                  }
                >
                  <span className="settings__field-hint">
                    {effectiveSummary(status)}
                  </span>
                </SettingsPageRow>
                {pending?.publisher === publisher &&
                  status?.reason !== 'DNT' && (
                    <TelemetryFeedbackPrompt
                      deferred
                      targetTier={pending.tier}
                      onCancel={() => {
                        pending.trigger.focus();
                        setPending(undefined);
                      }}
                      publisher={telemetryPublisherLabel(publisher)}
                      onChoose={(reason) => {
                        const { tier, trigger } = pending;
                        change(publisher, tier, reason);
                        trigger.focus();
                      }}
                    />
                  )}
                {pending?.publisher === publisher &&
                  status?.reason === 'DNT' && (
                    <p>
                      DO_NOT_TRACK is active. Choose a tier again to save
                      without feedback.
                    </p>
                  )}
                {showOutbox && (
                  <details className="telemetry-outbox-disclosure">
                    <summary>
                      What was sent to {telemetryPublisherLabel(publisher)}
                    </summary>
                    <TelemetryOutbox publisher={publisher} />
                  </details>
                )}
              </div>
            );
          })}
          {advancedContent}
        </section>
      </details>
    </div>
  );
}

function effectiveSummary(
  status: TelemetryPublisherStatus | undefined,
): string {
  if (!status) return 'Effective state loads from this Station.';
  if (status.reason === 'DNT')
    return 'Effective: Off — DO_NOT_TRACK is active. Saved choices are not changed.';
  if (status.reason === 'disclosure')
    return 'Effective: Lite — Full is awaiting disclosure acknowledgement.';
  if (status.reason === 'environment')
    return `Effective: ${status.tier} (environment). Environment defaults cannot enable Full.`;
  return `Effective: ${status.tier} (${status.reason})`;
}
