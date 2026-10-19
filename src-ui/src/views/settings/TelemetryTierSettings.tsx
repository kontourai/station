import type {
  TelemetryPublisherStatus,
  TelemetryTier,
} from '@kontourai/station-contracts/product-telemetry';
import type { AppConfig } from '../../types';
import { SettingsPageRow } from './SettingsPageRow';
import { settingsRow } from './settings-catalog';

export function TelemetryTierSettings({
  config,
  onChange,
  publishers,
}: {
  config: AppConfig;
  onChange: (config: AppConfig) => void;
  publishers?: Record<'kontour' | 'operator', TelemetryPublisherStatus>;
}) {
  return (
    <div {...settingsRow('usage-telemetry')} tabIndex={-1}>
      {(['kontour', 'operator'] as const).map((publisher) => {
        const label =
          publisher === 'kontour' ? 'Kontour telemetry' : 'Operator telemetry';
        const status = publishers?.[publisher];
        const choice =
          config.telemetryTier?.[publisher] ?? status?.userChoice ?? '';
        return (
          <SettingsPageRow
            key={publisher}
            label={label}
            description={
              publisher === 'kontour'
                ? 'Off sends nothing. Lite sending is not available yet. Kontour Full is unavailable.'
                : 'Off sends nothing. Lite sending is not available yet. Full sends pseudonymous events with an installation hash that rotates monthly and is never linked to an account by Station. Full requires acknowledgement of the current event inventory.'
            }
            control={
              <select
                className="editor-input"
                aria-label={label}
                value={choice}
                onChange={(event) =>
                  onChange({
                    ...config,
                    telemetryTier: {
                      ...config.telemetryTier,
                      [publisher]: event.target.value as TelemetryTier,
                    },
                  })
                }
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
            <span className="settings__field-hint">
              {status?.reason === 'DNT'
                ? 'Effective: Off — DO_NOT_TRACK is active. Saved choices are not changed.'
                : status?.reason === 'disclosure'
                  ? 'Effective: Lite — Full is awaiting disclosure acknowledgement.'
                  : status?.reason === 'environment'
                    ? publisher === 'operator'
                      ? `Effective: ${status.tier} (environment). Environment defaults cannot enable Full. Choose Full here and acknowledge the disclosure to send Full events.`
                      : `Effective: ${status.tier} (environment). Kontour Full is unavailable.`
                    : status
                      ? `Effective: ${status.tier} (${status.reason})`
                      : 'Effective state loads from this Station.'}
            </span>
          </SettingsPageRow>
        );
      })}
    </div>
  );
}
