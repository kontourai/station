/**
 * archive#settings-revamp (docs/design/settings-architecture.md's
 * "Config with no UI" list). A new leaf section, registry-driven, for the
 * Station-scope `AppConfig` fields that had zero Settings UI before this
 * slice: `defaultMaxTurns`, `defaultMaxOutputTokens`, `terminalShell`,
 * `mcpUiHost`, `surfaceTrustFromVeritasEvidence`,
 * `disableDefaultSkillRegistries`, `registryUrl`, `approvalGuardian`,
 * `distributionProfile`, `builtinAgentEngineConnectionId`. An explicit,
 * enumerated key list (not "every remaining registry key") so the section
 * exactly matches the slice's scoped ask — several other unregistered-UI
 * fields (`gitRemote`, the provider-id defaults,
 * `agentConnections`) stay a disclosed gap rather than guessed placements
 * (see the delivery report's judgment-calls section).
 */

import {
  PROJECT_OVERRIDABLE_APP_SETTING_KEYS,
  type ProjectOverridableAppSettingKey,
} from '@kontourai/station-contracts/project-settings-overrides';
import type {
  SettingDefinition,
  SettingProvenanceEntry,
} from '@kontourai/station-contracts/settings-registry';
import { USER_FACING_APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import type { AppConfig } from '../../types';
import { renderSettingRow } from './registry-row';
import { SettingsSection } from './SettingsSection';

export const STATION_CONFIG_KEYS: readonly (keyof AppConfig)[] = [
  'approvalGuardian',
  'telemetryEnabled',
  'defaultMaxTurns',
  'defaultMaxOutputTokens',
  'defaultChatFontSize',
  'terminalShell',
  'mcpUiHost',
  'surfaceTrustFromVeritasEvidence',
  'disableDefaultSkillRegistries',
  'workspaceCheckpoints',
  'defaultWorkspaceIsolation',
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

/**
 * #2144 slice 3 — the project the page is currently showing settings FOR,
 * supplied only while its selector names one. Absent is the ordinary Station
 * page, and every row below then behaves exactly as it did before the slice.
 */
export interface StationConfigProjectOverride {
  name: string;
  /** The effective override value per setting key; `undefined` = inherits. */
  values: Partial<Record<ProjectOverridableAppSettingKey, unknown>>;
  onChange: (key: ProjectOverridableAppSettingKey, value: unknown) => void;
  /** Drops the key's override, pending save. */
  onReset: (key: ProjectOverridableAppSettingKey) => void;
}

const OVERRIDABLE: ReadonlySet<string> = new Set(
  PROJECT_OVERRIDABLE_APP_SETTING_KEYS,
);

export function StationConfigSection({
  config,
  provenance,
  onChange,
  embedded = false,
  projectOverride,
}: {
  config: AppConfig;
  provenance?: Record<string, SettingProvenanceEntry>;
  onChange: (config: AppConfig) => void;
  /** Host owns the page heading; preserve the Settings route's default. */
  embedded?: boolean;
  projectOverride?: StationConfigProjectOverride;
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
        // A project may override only the keys the contract lists, and only
        // while one is selected. Everything else keeps writing the Station
        // draft even on a project-scoped view — a project has no opinion to
        // record about them, and silently routing the edit somewhere the
        // resolver never reads is the failure this closed list prevents.
        const overridable =
          projectOverride !== undefined && OVERRIDABLE.has(key as string);
        const overrideKey = key as ProjectOverridableAppSettingKey;
        const overrideValue = overridable
          ? projectOverride.values[overrideKey]
          : undefined;
        return renderSettingRow({
          definition,
          value:
            overridable && overrideValue !== undefined
              ? overrideValue
              : config[key],
          provenance: provenance?.[key as string],
          runtimeDefault: hostDerivedDefault(config, key),
          ...(overridable
            ? {
                projectName: projectOverride.name,
                projectValue: overrideValue,
                stationValue: config[key],
                onResetToInherited: () => projectOverride.onReset(overrideKey),
              }
            : {}),
          // `value` is passed through verbatim (never coerced to
          // `undefined`) — an explicit `null` is the documented "clear this
          // field" signal at the PUT layer (`sanitizeAppConfigUpdate`), and
          // for `builtinAgentEngineConnectionId` specifically `null` is a
          // distinct STORED value ("explicitly Station") from absent
          // ("re-derived each boot") — coercing it away would silently
          // change which of those two states a save actually persists.
          onChange: (value) =>
            overridable
              ? projectOverride.onChange(overrideKey, value)
              : onChange({ ...config, [key]: value } as AppConfig),
        });
      })}
    </SettingsSection>
  );
}
