import { DEVICE_SETTINGS_REGISTRY } from '@kontourai/station-contracts/device-settings';
import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import type { IntlLocale } from '../../i18n/formatters';
import { interpolate } from '../../i18n/LocaleContext';
import { pseudoLocalize } from '../../i18n/pseudo';

export type SettingsSectionId =
  | 'station-config'
  | 'system'
  | 'feature-previews'
  | 'answer-shares'
  | 'host-runtime'
  | 'diagnostics'
  | 'agent-defaults'
  | 'appearance'
  | 'keyboard-shortcuts'
  | 'notifications'
  | 'voice'
  | 'developer-tools'
  | 'knowledge';

export interface SettingsCatalogEntry {
  /** Stable URL and palette identity. Never derive this from visible copy. */
  id: string;
  title: string;
  section: SettingsSectionId;
  keywords?: readonly string[];
  /** English-only discovery terms; stable across the render locale. */
  searchKeywords?: readonly string[];
  configKeys?: readonly string[];
  /** The persistence authority that owns an edit, when this is editable. */
  scope?:
    | 'station'
    | 'defaults'
    | 'device'
    | 'mixed'
    | 'temporary'
    | 'informational';
  /** The target exists only for the named runtime condition. */
  conditional?: 'mobile';
}

export const SETTINGS_SECTIONS = [
  { id: 'station-config', title: 'Station configuration', group: 'Station' },
  { id: 'system', title: 'System', group: 'Station' },
  // archive#3313 (IA option A): the retired standalone Feature Previews view,
  // as a Station-scope section (previews persist on the Station).
  { id: 'feature-previews', title: 'Feature previews', group: 'Station' },
  { id: 'answer-shares', title: 'Shared answers', group: 'Station' },
  { id: 'host-runtime', title: 'Station host', group: 'Station' },
  { id: 'diagnostics', title: 'Diagnostics', group: 'Station' },
  { id: 'agent-defaults', title: 'Defaults', group: 'Defaults' },
  { id: 'appearance', title: 'Appearance', group: 'This device' },
  {
    id: 'keyboard-shortcuts',
    title: 'Keyboard shortcuts',
    group: 'This device',
  },
  { id: 'notifications', title: 'Notifications', group: 'This device' },
  { id: 'voice', title: 'Voice & Features', group: 'This device' },
  // archive#3313: gates the Developer surface's sidebar/palette entries on
  // this device (a device setting — see contracts' developerToolsEnabled).
  { id: 'developer-tools', title: 'Developer tools', group: 'This device' },
  { id: 'knowledge', title: 'My knowledge store', group: 'Knowledge' },
] as const satisfies readonly {
  id: SettingsSectionId;
  title: string;
  group: 'Station' | 'Defaults' | 'This device' | 'Knowledge';
}[];

const SETTINGS_CATALOG_SOURCE = [
  {
    id: 'approval-guardian',
    title: 'Approval guardian',
    section: 'station-config',
    configKeys: ['approvalGuardian'],
  },
  {
    id: 'usage-telemetry',
    title: 'Usage telemetry',
    section: 'station-config',
    configKeys: ['telemetryEnabled'],
  },
  {
    id: 'default-max-turns',
    title: 'Default max turns',
    section: 'station-config',
    configKeys: ['defaultMaxTurns'],
  },
  {
    id: 'default-max-output-tokens',
    title: 'Default max output tokens',
    section: 'station-config',
    configKeys: ['defaultMaxOutputTokens'],
  },
  {
    id: 'terminal-shell',
    title: 'Terminal shell',
    section: 'station-config',
    configKeys: ['terminalShell'],
  },
  {
    id: 'mcp-ui-host',
    title: 'MCP UI host',
    section: 'station-config',
    configKeys: ['mcpUiHost'],
  },
  {
    id: 'surface-trust',
    title: 'Surface trust from Veritas evidence',
    section: 'station-config',
    configKeys: ['surfaceTrustFromVeritasEvidence'],
  },
  {
    id: 'knowledge-stores-preview',
    title: 'Knowledge stores (preview)',
    section: 'station-config',
    configKeys: ['knowledgeStores'],
  },
  {
    id: 'default-skill-registries',
    title: 'Disable default skill registries',
    section: 'station-config',
    configKeys: ['disableDefaultSkillRegistries'],
  },
  {
    id: 'registry-url',
    title: 'Registry URL',
    section: 'station-config',
    configKeys: ['registryUrl'],
  },
  {
    id: 'distribution-profile',
    title: 'Layout sources',
    section: 'station-config',
    configKeys: ['distributionProfile'],
  },
  {
    id: 'builtin-agent-engine',
    title: 'Built-in agent engine',
    section: 'station-config',
    configKeys: ['builtinAgentEngineConnectionId'],
  },
  {
    id: 'core-app-updates',
    title: 'Core App Updates',
    section: 'system',
    keywords: ['update channel'],
  },
  {
    id: 'deployed-build',
    title: 'Deployed Build',
    section: 'system',
    keywords: ['version provenance'],
  },
  {
    id: 'log-level',
    title: 'Log Level',
    section: 'system',
    configKeys: ['logLevel'],
  },
  {
    id: 'backup-restore',
    title: 'Settings Export & Import',
    section: 'system',
    keywords: ['export import settings backup restore'],
  },
  {
    id: 'reset-defaults',
    title: 'Reset to Defaults',
    section: 'system',
    keywords: ['factory reset'],
  },
  {
    id: 'feature-previews',
    title: 'Feature previews',
    section: 'feature-previews',
    keywords: ['previews', 'experimental', 'feature previews'],
  },
  {
    id: 'enable-developer-tools',
    title: 'Enable developer tools',
    section: 'developer-tools',
    keywords: ['developer', 'logs', 'telemetry', 'debug', 'advanced'],
  },
  {
    id: 'shared-answers',
    title: 'Shared answers',
    section: 'answer-shares',
    keywords: ['permalink revoke expire'],
  },
  {
    id: 'host-runtime',
    title: 'Station host',
    section: 'host-runtime',
    keywords: ['environment prerequisites detected software'],
  },
  {
    id: 'diagnostics-bundle',
    title: 'Diagnostics bundle',
    section: 'diagnostics',
    keywords: ['health logs download'],
  },
  {
    id: 'default-model',
    title: 'Default model',
    section: 'agent-defaults',
    configKeys: ['defaultModel'],
  },
  {
    id: 'default-region',
    title: 'Default Region',
    section: 'agent-defaults',
    configKeys: ['region'],
  },
  {
    id: 'default-agent-instructions',
    title: 'Default Agent Instructions',
    section: 'agent-defaults',
    configKeys: ['systemPrompt'],
  },
  {
    id: 'template-variables',
    title: 'Template Variables',
    section: 'agent-defaults',
    configKeys: ['templateVariables'],
  },
  {
    id: 'chat-font-size',
    title: 'Chat font size',
    section: 'appearance',
    configKeys: ['defaultChatFontSize', 'chatFontSize'],
  },
  { id: 'theme', title: 'Theme', section: 'appearance', configKeys: ['theme'] },
  {
    id: 'sidebar-sections',
    title: 'Sidebar sections',
    section: 'appearance',
    keywords: ['open chats', 'drafts', 'sidebar', 'hide', 'remove'],
    configKeys: ['sidebarSections'],
  },
  {
    id: 'haptic-feedback',
    title: 'Haptic feedback',
    section: 'appearance',
    configKeys: ['hapticsEnabled'],
    conditional: 'mobile',
  },
  {
    id: 'accent-color',
    title: 'Accent color',
    section: 'appearance',
    configKeys: ['accentColor'],
  },
  {
    id: 'keyboard-shortcuts',
    title: 'Keyboard shortcuts',
    section: 'keyboard-shortcuts',
    configKeys: ['shortcutOverrides'],
    keywords: ['commands keys bindings customize'],
  },
  {
    id: 'push-notifications',
    title: 'Push notifications',
    section: 'notifications',
    configKeys: ['featureSettings'],
    keywords: ['inbox alerts'],
  },
  {
    id: 'speech-to-text',
    title: 'Speech-to-text (microphone input)',
    section: 'voice',
    configKeys: ['sttProvider'],
  },
  {
    id: 'text-to-speech',
    title: 'Text-to-speech (agent readback)',
    section: 'voice',
    configKeys: ['ttsProvider'],
  },
  {
    id: 'message-context',
    title: 'Message context',
    section: 'voice',
    keywords: ['context providers'],
  },
  {
    id: 'voice-pill',
    title: 'Voice pill (speech-to-speech)',
    section: 'voice',
    configKeys: ['featureSettings'],
  },
  {
    id: 'mobile-pairing',
    title: 'Mobile pairing & network discovery',
    section: 'voice',
    configKeys: ['featureSettings'],
  },
  {
    id: 'tts-readback',
    title: 'Read agent responses aloud (TTS)',
    section: 'voice',
    configKeys: ['featureSettings'],
  },
  {
    id: 'personal-knowledge-store',
    title: 'My knowledge store',
    section: 'knowledge',
    keywords: ['personal project obsidian adapter root vault'],
  },
] as const satisfies readonly Omit<SettingsCatalogEntry, 'scope'>[];

export type SettingsCatalogId = (typeof SETTINGS_CATALOG_SOURCE)[number]['id'];

const SETTINGS_MESSAGES = {
  paletteTitle: 'Settings: {target}',
  paletteGroup: 'Settings',
  scopeStation: 'Saved to this Station.',
  scopeDefaults: 'Saved as Station defaults.',
  scopeDevice: 'Saved to this device.',
  scopeMixed: 'Exports and imports include this Station and this device.',
  scopeTemporary: 'Available only for this browser session.',
  scopeInformational: 'Status and guidance for this Station.',
  unavailableMobile:
    'Available on a mobile device with haptic feedback support.',
  unavailableStatus: 'Unavailable',
  targetUnavailable: 'That Settings target is no longer available.',
  targetTimedOut:
    'This Settings control is not available yet. Try again or search Settings.',
  revealed: '{target} revealed in Settings.',
} as const;

export type SettingsMessageKey = keyof typeof SETTINGS_MESSAGES;

/** Lazy settings-local locale formatter; substitutions retain their own text. */
export function formatSettingsMessage(
  key: SettingsMessageKey,
  locale: IntlLocale,
  values?: Record<string, string | number>,
): string {
  const template = SETTINGS_MESSAGES[key];
  return interpolate(
    import.meta.env.DEV && locale === 'en-XA'
      ? pseudoLocalize(template)
      : template,
    values,
  );
}

export function localizedSettingsTargetLabel(
  id: SettingsCatalogId,
  locale: IntlLocale,
): string {
  const title = CATALOG_BY_ID.get(id)?.title;
  if (!title) throw new Error(`Unknown Settings target: ${id}`);
  return import.meta.env.DEV && locale === 'en-XA'
    ? pseudoLocalize(title)
    : title;
}

const SETTING_SCOPE_OVERRIDES: Readonly<
  Partial<Record<SettingsCatalogId, NonNullable<SettingsCatalogEntry['scope']>>>
> = {
  'backup-restore': 'mixed',
  'deployed-build': 'informational',
  'message-context': 'temporary',
};

function scopeForSection(
  id: SettingsCatalogId,
  section: SettingsSectionId,
): NonNullable<SettingsCatalogEntry['scope']> {
  const override = SETTING_SCOPE_OVERRIDES[id];
  if (override) return override;
  if (section === 'agent-defaults') return 'defaults';
  if (
    section === 'appearance' ||
    section === 'keyboard-shortcuts' ||
    section === 'notifications' ||
    section === 'voice' ||
    section === 'developer-tools'
  )
    return 'device';
  if (section === 'host-runtime' || section === 'diagnostics')
    return 'informational';
  return 'station';
}

/** Every entry has write authority metadata, derived once from its owning section. */
type SettingsCatalogWithScope = readonly (SettingsCatalogEntry & {
  readonly id: SettingsCatalogId;
  readonly scope: NonNullable<SettingsCatalogEntry['scope']>;
})[];

export const SETTINGS_CATALOG = SETTINGS_CATALOG_SOURCE.map((entry) => ({
  ...entry,
  scope: scopeForSection(entry.id, entry.section),
})) as SettingsCatalogWithScope;

export interface SettingsPaletteCommand {
  id: `settings:${SettingsCatalogId}`;
  label: string;
  keywords: readonly string[];
  scope: NonNullable<SettingsCatalogEntry['scope']>;
  /** An unavailable target still explains itself; it never pretends to navigate. */
  unavailable?: boolean;
  view: SettingsSectionId;
  highlight: SettingsCatalogId;
}

const CATALOG_BY_ID = new Map<string, SettingsCatalogEntry>(
  SETTINGS_CATALOG.map((entry) => [entry.id, entry]),
);
const REGISTRY_BY_KEY = new Map(
  [...APP_SETTINGS_REGISTRY, ...DEVICE_SETTINGS_REGISTRY].map((entry) => [
    String(entry.key),
    entry,
  ]),
);

export function settingsRow(id: string) {
  const entry = CATALOG_BY_ID.get(id);
  return {
    id,
    title: entry?.title ?? `[missing settings catalog entry: ${id}]`,
    'data-catalog-id': id,
  } as const;
}

export function settingsCatalogEntryForConfigKey(key: string) {
  return SETTINGS_CATALOG.find((entry) => entry.configKeys?.includes(key));
}

export function matchingSettingsRows(
  query: string,
): readonly SettingsCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return SETTINGS_CATALOG.filter((entry) => {
    const registryText = (entry.configKeys ?? []).flatMap((key) => {
      const definition = REGISTRY_BY_KEY.get(key);
      return definition
        ? [definition.label, definition.description, key]
        : [key];
    });
    return [
      entry.title,
      ...(entry.keywords ?? []),
      ...(entry.searchKeywords ?? []),
      ...registryText,
    ]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });
}

export function visibleCatalogIds(options: { isMobile: boolean }) {
  return SETTINGS_CATALOG.filter(
    (entry) => entry.conditional !== 'mobile' || options.isMobile,
  ).map((entry) => entry.id);
}

/**
 * The palette projects this one inventory. It deliberately carries data, not
 * handlers or DOM queries: command execution remains at the palette's one
 * guarded choke point and labels can become locale-aware at render time.
 */
export function settingsPaletteCommands(options: {
  isMobile: boolean;
}): readonly SettingsPaletteCommand[] {
  return SETTINGS_CATALOG.map((entry) => {
    const unavailable = entry.conditional === 'mobile' && !options.isMobile;
    return {
      id: `settings:${entry.id}` as SettingsPaletteCommand['id'],
      label: entry.title,
      keywords: [
        'settings',
        entry.title,
        entry.section,
        ...(entry.keywords ?? []),
        ...(entry.searchKeywords ?? []),
        ...(entry.configKeys ?? []),
      ],
      ...(unavailable ? { unavailable: true } : {}),
      scope: entry.scope ?? 'informational',
      view: entry.section,
      highlight: entry.id as SettingsCatalogId,
    };
  });
}
