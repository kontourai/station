import type {
  TelemetryTier,
  TelemetryTierResolution,
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
  publishers?: Record<
    'kontour' | 'operator',
    TelemetryTierResolution & { userChoice?: TelemetryTier }
  >;
}) {
  return (
    <div {...settingsRow('usage-telemetry')} tabIndex={-1}>
      {(['kontour', 'operator'] as const).map((publisher) => {
        const label =
          publisher === 'kontour' ? 'Kontour telemetry' : 'Operator telemetry';
        const status = publishers?.[publisher];
        const choice =
          config.telemetryTier?.[publisher] ??
          status?.userChoice ??
          status?.tier ??
          'lite';
        return (
          <SettingsPageRow
            key={publisher}
            label={label}
            description={
              publisher === 'kontour'
                ? 'Off sends nothing. Lite allows identifier-free aggregates when an author destination is built in. Kontour Full is unavailable.'
                : 'Off sends nothing. Lite allows identifier-free aggregates. Full requires acknowledgement of the current event inventory.'
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
                ? 'Effective: Off — DO_NOT_TRACK is active. Your saved choice is retained.'
                : status?.reason === 'disclosure'
                  ? 'Effective: Lite — Full is awaiting disclosure acknowledgement.'
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
