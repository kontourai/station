import type {
  TelemetryFeedbackReason,
  TelemetryPublisherId,
  TelemetryPublisherStatus,
  TelemetryTier,
  TelemetryTierChoices,
} from '@kontourai/station-contracts/product-telemetry';
import { useState } from 'react';
import { TelemetryFeedbackPrompt } from '../../components/TelemetryFeedbackPrompt';
import { telemetryPublisherLabel } from '../../hooks/useTelemetryStatus';
import type { AppConfig } from '../../types';
import { SettingsPageRow } from './SettingsPageRow';
import { settingsRow } from './settings-catalog';
import { TelemetryOutbox } from './TelemetryOutbox';

export function TelemetryTierSettings({
  config,
  onChange,
  publishers,
  onFeedback,
  showOutbox = false,
}: {
  config: AppConfig;
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
  }>();
  const choices: TelemetryTierChoices | undefined = config.telemetryTier;
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
      {(Object.keys(publishers ?? choices ?? {}) as TelemetryPublisherId[]).map(
        (publisher) => {
          const label = `${telemetryPublisherLabel(publisher)} telemetry`;
          const status = publishers?.[publisher];
          const choice = choices?.[publisher] ?? status?.userChoice ?? '';
          return (
            <SettingsPageRow
              key={publisher}
              label={label}
              description={
                publisher === 'kontour'
                  ? 'Off stops automatic sending. Lite sends identifier-free daily counts after notice, when a destination is configured. Kontour Full is unavailable.'
                  : 'Off stops automatic sending. Lite sends identifier-free daily counts after notice, when a destination is configured. Full sends pseudonymous events with an installation hash that rotates monthly and is never linked to an account by Station. Full requires acknowledgement of the current event inventory.'
              }
              control={
                <select
                  className="editor-input"
                  aria-label={label}
                  value={choice}
                  onChange={(event) => {
                    const tier = event.target.value as TelemetryTier;
                    const previous =
                      choices?.[publisher] ??
                      status?.userChoice ??
                      status?.tier ??
                      'lite';
                    if (
                      onFeedback &&
                      status?.reason !== 'DNT' &&
                      rank[tier] < rank[previous]
                    )
                      setPending({ publisher, tier });
                    else change(publisher, tier, 'skip');
                  }}
                >
                  <option value="" disabled>
                    No saved choice
                  </option>
                  <option value="off">Off</option>
                  <option value="lite">Lite</option>
                  <option value="full" disabled={publisher === 'kontour'}>
                    Full{publisher === 'kontour' ? ' (unavailable)' : ''}
                  </option>
                </select>
              }
            >
              {pending?.publisher === publisher && status?.reason !== 'DNT' && (
                <TelemetryFeedbackPrompt
                  deferred
                  publisher={telemetryPublisherLabel(publisher)}
                  onChoose={(reason) => change(publisher, pending.tier, reason)}
                />
              )}
              {pending?.publisher === publisher && status?.reason === 'DNT' && (
                <p>
                  DO_NOT_TRACK is active. Choose a tier again to save without
                  feedback.
                </p>
              )}
              <span className="settings__field-hint">
                {effectiveSummary(status)}
              </span>
              {showOutbox && <TelemetryOutbox publisher={publisher} />}
            </SettingsPageRow>
          );
        },
      )}
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
