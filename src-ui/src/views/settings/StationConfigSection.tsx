/**
 * archive#settings-revamp (docs/design/settings-architecture.md's
 * "Config with no UI" list). A new leaf section, registry-driven, for the
 * Station-scope `AppConfig` fields that had zero Settings UI before this
 * slice: `defaultMaxTurns`, `defaultMaxOutputTokens`, `terminalShell`,
 * `mcpUiHost`, `surfaceTrustFromVeritasEvidence`, `knowledgeStores`,
 * `disableDefaultSkillRegistries`, `registryUrl`, `approvalGuardian`,
 * `distributionProfile`, `builtinAgentEngineConnectionId`. An explicit,
 * enumerated key list (not "every remaining registry key") so the section
 * exactly matches the slice's scoped ask — several other unregistered-UI
 * fields (`gitRemote`, the provider-id defaults,
 * `agentConnections`) stay a disclosed gap rather than guessed placements
 * (see the delivery report's judgment-calls section).
 */

import type {
  SettingDefinition,
  SettingProvenanceEntry,
} from '@kontourai/station-contracts/settings-registry';
import {
  USER_FACING_APP_SETTINGS_REGISTRY,
} from '@kontourai/station-contracts/settings-registry';
import type { AppConfig } from '../../types';
import { renderSettingRow } from './registry-row';
import { SettingsSection } from './SettingsSection';

const STATION_CONFIG_KEYS: readonly (keyof AppConfig)[] = [
  'approvalGuardian',
  'telemetryEnabled',
  'defaultMaxTurns',
  'defaultMaxOutputTokens',
  'terminalShell',
  'mcpUiHost',
  'surfaceTrustFromVeritasEvidence',
  'knowledgeStores',
  'disableDefaultSkillRegistries',
  'registryUrl',
  'distributionProfile',
  'builtinAgentEngineConnectionId',
];

const REGISTRY_BY_KEY: ReadonlyMap<keyof AppConfig, SettingDefinition> =
  new Map(
    USER_FACING_APP_SETTINGS_REGISTRY.map((definition) => [
      definition.key,
      definition,
    ]),
  );

export function StationConfigSection({
  config,
  provenance,
  onChange,
  embedded = false,
}: {
  config: AppConfig;
  provenance?: Record<string, SettingProvenanceEntry>;
  onChange: (config: AppConfig) => void;
  /** Host owns the page heading; preserve the Settings route's default. */
  embedded?: boolean;
}) {
  return (
    <SettingsSection
      icon={embedded ? null : '⚙'}
      title={embedded ? '' : 'Station configuration'}
      id="section-station-config"
    >
      {STATION_CONFIG_KEYS.map((key) => {
        const definition = REGISTRY_BY_KEY.get(key);
        if (!definition) return null;
        return renderSettingRow({
          definition,
          value: config[key],
          provenance: provenance?.[key as string],
          // `value` is passed through verbatim (never coerced to
          // `undefined`) — an explicit `null` is the documented "clear this
          // field" signal at the PUT layer (`sanitizeAppConfigUpdate`), and
          // for `builtinAgentEngineConnectionId` specifically `null` is a
          // distinct STORED value ("explicitly Station") from absent
          // ("re-derived each boot") — coercing it away would silently
          // change which of those two states a save actually persists.
          onChange: (value) =>
            onChange({ ...config, [key]: value } as AppConfig),
        });
      })}
    </SettingsSection>
  );
}
