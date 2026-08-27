import { useSystemStatusForApiBaseQuery } from '@kontourai/station-sdk';
import { SettingsGlyph } from '../../components/icons/Glyph';
import type { AppConfig } from '../../types';
import { BuildProvenance } from './BuildProvenance';
import { CoreUpdateCheck } from './CoreUpdateCheck';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

export function SystemSection({
  apiBase,
  config,
  onChange,
  onExport,
  onImport,
  onResetToDefaults,
}: {
  apiBase: string;
  config: AppConfig;
  onChange: (config: AppConfig) => void;
  onExport: () => void;
  onImport: (file: File) => Promise<void>;
  onResetToDefaults: () => void;
}) {
  const { data: systemStatus } = useSystemStatusForApiBaseQuery(
    apiBase,
    60_000,
  );

  return (
    <SettingsSection
      icon={<SettingsGlyph />}
      title="System"
      id="section-system"
    >
      <div
        className="settings__field"
        {...settingsRow('core-app-updates')}
        tabIndex={-1}
      >
        <span className="settings__field-label">
          {settingsRow('core-app-updates').title}
        </span>
        <CoreUpdateCheck apiBase={apiBase} />
      </div>

      <div {...settingsRow('deployed-build')} tabIndex={-1}>
        <BuildProvenance build={systemStatus?.build} />
      </div>

      <div
        className="settings__field"
        {...settingsRow('log-level')}
        tabIndex={-1}
      >
        <label className="settings__field-label" htmlFor="logLevel">
          {settingsRow('log-level').title}
        </label>
        <select
          id="logLevel"
          value={config.logLevel || 'info'}
          onChange={(event) =>
            onChange({
              ...config,
              logLevel: event.target.value as AppConfig['logLevel'],
            })
          }
        >
          <option value="error">Error</option>
          <option value="warn">Warning</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
          <option value="trace">Trace</option>
        </select>
        <span className="settings__field-hint">
          Logging verbosity. Higher levels include more detail.
        </span>
      </div>

      <div
        className="settings__field"
        {...settingsRow('backup-restore')}
        tabIndex={-1}
      >
        <span className="settings__field-label">
          {settingsRow('backup-restore').title}
        </span>
        <div className="settings__export-row">
          <button
            type="button"
            className="settings__secondary-btn"
            onClick={onExport}
          >
            Export Settings
          </button>
          <label className="settings__secondary-btn settings__import-label">
            Import Settings
            <input
              type="file"
              accept=".json"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) await onImport(file);
                event.target.value = '';
              }}
            />
          </label>
        </div>
        <span className="settings__field-hint">
          Export or import settings JSON. This does not include projects,
          sessions, or credentials. For a full offline backup, stop Station and
          run <code>station home backup</code>.
        </span>
      </div>

      <div
        className="settings__danger"
        {...settingsRow('reset-defaults')}
        tabIndex={-1}
      >
        <button
          type="button"
          className="settings__danger-btn"
          onClick={onResetToDefaults}
        >
          Reset to Defaults
        </button>
        <span className="settings__field-hint">
          Restore all settings to factory defaults. Cannot be undone.
        </span>
      </div>
    </SettingsSection>
  );
}
