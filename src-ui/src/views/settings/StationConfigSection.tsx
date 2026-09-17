/**
 * The registry-driven rows of the Station document, rendered under whichever
 * settings section owns each one.
 *
 * This file used to render ONE card, "Station configuration", holding every
 * Station-scope `AppConfig` field that had no other home — a permission
 * screener beside a shell path beside a telemetry switch beside a step
 * ceiling. #2182 dissolved that card: the same rows now render in the
 * sections named for what they decide, and this module became the renderer
 * they share rather than the section itself. The file name is kept because
 * `scripts/proof-repo-guardrails.mjs` and `settings-row-literal-coverage.test.ts`
 * pin the path.
 *
 * Which keys each section renders is stated once, below, and asserted against
 * the catalog: a row's card and its deep link must name the same section, or a
 * reader who follows `?view=` lands somewhere the row is not.
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
import type { ReactNode } from 'react';
import type { AppConfig } from '../../types';
import { renderSettingRow } from './registry-row';
import type { PendingOverrideChange } from './SettingInheritanceLayers';
import { SettingsSection } from './SettingsSection';
import type { SettingsSectionId } from './settings-catalog';

/**
 * The Station-document keys each section renders, in render order.
 *
 * Every key here was in the single `STATION_CONFIG_KEYS` list this module
 * used to hold; nothing was added and nothing dropped, which
 * `station-config-section.test.tsx` asserts against a literal inventory of
 * that list. It also asserts each key's catalog row names the section it is
 * rendered under — the placement and the deep link are two statements about
 * the same row, and they are only true together.
 */
export const STATION_SETTING_KEYS_BY_SECTION = {
  // The machine: which shell a terminal starts, which origin an MCP UI may be
  // served from, whether Veritas evidence may raise a surface's trust here.
  'host-runtime': [
    'terminalShell',
    'mcpUiHost',
    'surfaceTrustFromVeritasEvidence',
  ],
  // Where this Station gets agents, skills, plugins and layouts.
  sources: [
    'registryUrl',
    'disableDefaultSkillRegistries',
    'distributionProfile',
  ],
  // Whether anything is sent. Where it would go is a derived status line with
  // no writer, so it is a `PageRow` in `SettingsView`, not a registry row.
  telemetry: ['telemetryEnabled'],
  // What agents may do without asking.
  permissions: ['approvalGuardian', 'defaultApprovalMode'],
  // What a run starts with and what bounds it.
  'agent-runs': [
    'builtinAgentEngineConnectionId',
    'defaultMaxTurns',
    'defaultMaxOutputTokens',
    'defaultWorkspaceIsolation',
    'workspaceCheckpoints',
  ],
  // The Station default this device's chat-font-size slider falls back to.
  chat: ['defaultChatFontSize'],
} as const satisfies Partial<Record<SettingsSectionId, readonly string[]>>;

export type StationSettingsSectionId =
  keyof typeof STATION_SETTING_KEYS_BY_SECTION;

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
  /**
   * Which keys the page holds an UNSAVED override change for, and of which
   * kind. The provenance every row renders was computed before the draft, so
   * a key in here is one whose explanation describes the saved state while
   * its control already shows the drafted one.
   */
  pending: Partial<
    Record<ProjectOverridableAppSettingKey, PendingOverrideChange>
  >;
  onChange: (key: ProjectOverridableAppSettingKey, value: unknown) => void;
  /** Drops the key's override, pending save. */
  onReset: (key: ProjectOverridableAppSettingKey) => void;
}

const OVERRIDABLE: ReadonlySet<string> = new Set(
  PROJECT_OVERRIDABLE_APP_SETTING_KEYS,
);

export function StationConfigSection({
  section,
  config,
  provenance,
  onChange,
  icon = '⚙',
  embedded = false,
  containerScope,
  projectOverride,
}: {
  /** Which section's keys to render; see `STATION_SETTING_KEYS_BY_SECTION`. */
  section: StationSettingsSectionId;
  config: AppConfig;
  provenance?: Record<string, SettingProvenanceEntry>;
  onChange: (config: AppConfig) => void;
  icon?: ReactNode;
  /**
   * Render the rows alone, with no card of their own. Used where another
   * component already owns the section's `PageSection` — the Station host
   * report, the Agent runs editor, the Chat card — so the rows join that card
   * instead of opening a second one under the same section id.
   */
  embedded?: boolean;
  /** The rule the enclosing scope group's caption states (`registry-row-types.ts`). */
  /**
   * Required, not optional (#2182 review M6): for a Station row, an ABSENT
   * container and a `device` container print the same "Station" chip, so no
   * rendered assertion can catch a mount that forgot to name its box. The
   * compiler can.
   */
  containerScope: 'station' | 'device';
  projectOverride?: StationConfigProjectOverride;
}) {
  const rows = (
    STATION_SETTING_KEYS_BY_SECTION[section] as readonly (keyof AppConfig)[]
  ).map((key) => {
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
      containerScope,
      ...(overridable
        ? {
            projectName: projectOverride.name,
            projectValue: overrideValue,
            stationValue: config[key],
            pending: projectOverride.pending[overrideKey],
            // Offered only while there is an override left to give back.
            // `undefined` here means the draft ALREADY resets this key
            // (or the project never overrode it), and a second click
            // would write the same `null` twice while the row already
            // shows the inherited value — a control that reports an
            // action it has no work to do.
            ...(overrideValue !== undefined
              ? {
                  onResetToInherited: () =>
                    projectOverride.onReset(overrideKey),
                }
              : {}),
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
  });

  if (embedded) return <>{rows}</>;
  // The empty `title` is not a missing title: `SettingsSection` resolves the
  // heading from `SETTINGS_SECTIONS` by matching `section-<id>`, and the prop
  // is only its fallback for a card with no catalog section. Repeating the
  // title here would be a second place for it to drift.
  return (
    <SettingsSection icon={icon} title="" id={`section-${section}`}>
      {rows}
    </SettingsSection>
  );
}
