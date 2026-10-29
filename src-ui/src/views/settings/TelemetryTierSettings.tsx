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
  canChooseTelemetryTier,
  detailedConfirmation,
  SHARING_LABELS,
  type SharingCounts,
  type SharingDisclosure,
  type TelemetryChoiceAuthority,
  TelemetryChoiceLimit,
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
  choiceAuthority,
  onChoiceRetry,
}: {
  onChoiceRetry?: () => void;
  /**
   * What the server says this caller may choose. `'loading'` offers nothing;
   * `'error'` offers only Don't share (see `TelemetryChoiceAuthority`); absent
   * is an older host (or a caller that does not gate).
   */
  choiceAuthority?: TelemetryChoiceAuthority;
  config: AppConfig;
  disclosure?: SharingDisclosure;
  advancedContent?: ReactNode;
  counts?: SharingCounts;
  noticeRef?: Ref<HTMLElement>;
  noticeError?: boolean;
  onDetailedIntent?: (publisher?: 'kontour' | 'operator') => void;
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
  const dnt = Object.values(publishers ?? {}).some(
    (state) => state?.reason === 'DNT',
  );
  // Compared against the SAVED choices, as the server compares a write; the
  // draft in `config` is what this page is about to send.
  const may = (tier: TelemetryTier, ids: readonly TelemetryPublisherId[]) =>
    canChooseTelemetryTier(choiceAuthority, tier, ids, savedChoices, dnt);
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
    <div
      {...settingsRow('usage-telemetry')}
      tabIndex={-1}
      className="telemetry-sharing"
    >
      <section ref={noticeRef} aria-label="Usage sharing choices">
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
          selectable={(tier) => may(tier, ['kontour', 'operator'])}
          confirmation={detailedConfirmation(choiceAuthority)}
        />
        <TelemetryChoiceLimit
          authority={choiceAuthority}
          onRetry={onChoiceRetry}
        />
        {primaryChoice !== 'full' &&
          (kontourChoice === 'full' || additionalChoice === 'full') &&
          disclosure && (
            <UsageSharingIncluded
              data={disclosure}
              saveLabel="Save"
              dnt={dnt}
              confirmation={detailedConfirmation(choiceAuthority)}
            />
          )}
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
            const isPlugin = publisher.startsWith('publisher:');
            const choice = choices?.[publisher] ?? status?.userChoice ?? '';
            return (
              <div key={publisher} className="telemetry-publisher">
                <SettingsPageRow
                  label={label}
                  description={
                    isPlugin
                      ? "Plugin counts can encode identifiers. Detailed adds a monthly publisher ID. The plugin's own notice is still required."
                      : publisher === 'kontour'
                        ? 'Sends one daily count after notice. Detailed needs a configured Kontour destination.'
                        : 'Sends one daily count after notice, to a configured destination. Detailed adds a monthly-rotating ID, never your account.'
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
                          onDetailedIntent?.(publisher);
                        const previous =
                          savedChoices?.[publisher] ??
                          status?.userChoice ??
                          status?.tier ??
                          (isPlugin ? 'off' : 'lite');
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
                      <option value="off" disabled={!may('off', [publisher])}>
                        {SHARING_LABELS.off}
                      </option>
                      <option value="lite" disabled={!may('lite', [publisher])}>
                        {isPlugin ? 'Plugin usage counts' : SHARING_LABELS.lite}
                      </option>
                      <option
                        value="full"
                        disabled={
                          statusError ||
                          !status?.fullAvailable ||
                          !may('full', [publisher])
                        }
                      >
                        {isPlugin
                          ? 'Detailed plugin usage'
                          : SHARING_LABELS.full}
                        {!status?.fullAvailable ? ' (unavailable)' : ''}
                      </option>
                    </select>
                  }
                >
                  <span className="settings__field-hint">
                    {effectiveSummary(status, publisher)}
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
  publisher: TelemetryPublisherId,
): string {
  if (!status) return 'Effective state loads from this Station.';
  if (status.reason === 'DNT')
    return 'Effective: Off — DO_NOT_TRACK is active. Saved choices are not changed.';
  if (publisher === 'kontour' && status.fullAvailable === false)
    return 'This build has no Station usage destination, so nothing is sent to Kontour.';
  if (status.reason === 'disclosure')
    return publisher.startsWith('publisher:')
      ? "Detailed plugin sharing is waiting for this publisher's confirmation."
      : 'Effective: Lite — Full is awaiting disclosure acknowledgement.';
  if (status.reason === 'environment')
    return `Effective: ${status.tier} (environment). Environment defaults cannot enable Full.`;
  return `Effective: ${status.tier} (${status.reason})`;
}
