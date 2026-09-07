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
import { USER_FACING_APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
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

/**
 * #1582 D9: settings whose default is a property of THIS HOST, paired with the
 * runtime-derived field the server reports it in. `terminalShell`'s registry
 * entry carries no `defaultValue` and could not honestly carry one — the shell
 * a terminal starts is `SHELL`, or a platform fallback, or a Windows path —
 * so the input rendered empty with no hint at all. The server derives the
 * answer from the resolver a spawn actually walks and injects it into
 * `GET /api/config/app`; this table is the only place that says which stored
 * field it is the default FOR.
 */
const HOST_DERIVED_DEFAULTS = {
  terminalShell: 'defaultTerminalShell',
} as const satisfies Partial<Record<keyof AppConfig, keyof AppConfig>>;

function hostDerivedDefault(
  config: AppConfig,
  key: keyof AppConfig,
): string | undefined {
  const source = (HOST_DERIVED_DEFAULTS as Record<string, string | undefined>)[
    key as string
  ];
  if (!source) return undefined;
  const value = config[source as keyof AppConfig];
  return typeof value === 'string' && value ? value : undefined;
}

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
          runtimeDefault: hostDerivedDefault(config, key),
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
