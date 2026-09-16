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
  | 'plugin-visibility'
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
  /**
   * The target exists only for the named runtime condition.
   *
   * `operator` (#2067) is not a device fact like the other two: the section
   * renders only when the SERVER agrees the caller is the instance operator,
   * which this module cannot know. It is therefore treated as false unless a
   * caller positively supplies `isOperator`, so a collaborator's settings
   * search cannot offer a jump to a section that will not be there. A caller
   * that does know may pass it and get the entry back.
   */
  conditional?: 'mobile' | 'desktop' | 'operator';
}

export const SETTINGS_SECTIONS = [
  { id: 'station-config', title: 'Station configuration', group: 'Station' },
  { id: 'system', title: 'System', group: 'Station' },
  // archive#3313 (IA option A): the retired standalone Feature Previews view,
  // as a Station-scope section (previews persist on the Station).
  { id: 'feature-previews', title: 'Feature previews', group: 'Station' },
  { id: 'answer-shares', title: 'Shared answers', group: 'Station' },
  // #2067: which installed plugins each paired person can see. Station scope
  // because the grants live on this Station; operator-only, gated by the
  // route, the same way 'answer-shares' is gated by its own scope tier.
  { id: 'plugin-visibility', title: 'Plugin visibility', group: 'Station' },
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
    id: 'telemetry-destination',
    title: 'Telemetry destination',
    section: 'station-config',
    keywords: ['endpoint', 'where telemetry goes', 'otel'],
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
    id: 'default-chat-font-size',
    title: 'Default chat font size',
    section: 'station-config',
    configKeys: ['defaultChatFontSize'],
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
    id: 'default-skill-registries',
    title: 'Disable default skill registries',
    section: 'station-config',
    configKeys: ['disableDefaultSkillRegistries'],
  },
  {
    id: 'workspace-checkpoints',
    title: 'Workspace checkpoints',
    section: 'station-config',
    configKeys: ['workspaceCheckpoints'],
  },
  {
    id: 'default-workspace-isolation',
    title: 'New chat workspace',
    section: 'station-config',
    configKeys: ['defaultWorkspaceIsolation'],
  },
  {
    id: 'default-approval-mode',
    title: 'Default approval mode',
    section: 'station-config',
    keywords: ['approval', 'permissions', 'auto approve', 'ask first'],
    configKeys: ['defaultApprovalMode'],
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
    id: 'desktop-app-updates',
    title: 'Desktop app updates',
    section: 'system',
    keywords: ['desktop app updater signed release channel'],
    conditional: 'desktop',
  },
  {
    id: 'core-app-updates',
    title: 'Connected Station server',
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
    title: 'Reset Station settings',
    section: 'system',
    keywords: ['factory reset', 'reset to defaults'],
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
    id: 'plugin-visibility',
    title: 'Plugin visibility',
    section: 'plugin-visibility',
    keywords: ['plugins share grant collaborator board panes'],
    conditional: 'operator',
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
    // Device key only: this slider writes `chatFontSize` through the
    // device-settings store. The Station default (`defaultChatFontSize`) is
    // its own row under Station configuration.
    configKeys: ['chatFontSize'],
  },
  {
    // The id is the stable URL/palette identity and stays as minted even
    // though the title no longer matches it (#2144 slice 6 item B) — a
    // rename would break every deep link and every recorded highlight.
    id: 'smooth-answer-reveal',
    title: 'Answer delivery',
    section: 'appearance',
    keywords: ['chat streaming steady cadence', 'smooth reveal'],
    configKeys: ['featureSettings'],
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
  unavailableDesktop: 'Available in the desktop app.',
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
  // #2144 slice 6 item D: a derived status line with no writer, inside a
  // section whose other rows are all Station-scope writes.
  'telemetry-destination': 'informational',
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
  /** Which runtime condition withholds the target, for the honest explanation. */
  unavailableReason?: 'mobile' | 'desktop';
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

/**
 * Sections gated on the caller being the instance operator (#2067), derived
 * from the catalog rather than listed by hand so a second one is covered the
 * day it is added.
 */
export const OPERATOR_ONLY_SECTION_IDS: ReadonlySet<string> = new Set(
  SETTINGS_CATALOG.filter((entry) => entry.conditional === 'operator').map(
    (entry) => entry.section,
  ),
);

export function matchingSettingsRows(
  query: string,
  /**
   * Whether this caller is known to be the instance operator (#2067).
   * Absent reads as "not known to be" — the fail-closed direction — so a
   * collaborator's Settings search cannot offer a jump to a section the
   * server will refuse to populate.
   */
  options: { isOperator?: boolean } = {},
): readonly SettingsCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return SETTINGS_CATALOG.filter((entry) => {
    if (entry.conditional === 'operator' && options.isOperator !== true) {
      return false;
    }
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

export function visibleCatalogIds(options: {
  isMobile: boolean;
  isDesktop: boolean;
  /** Absent reads as "not the operator" — the fail-closed direction (#2067). */
  isOperator?: boolean;
}) {
  return SETTINGS_CATALOG.filter((entry) => {
    if (entry.conditional === 'mobile') return options.isMobile;
    if (entry.conditional === 'desktop') return options.isDesktop;
    if (entry.conditional === 'operator') return options.isOperator === true;
    return true;
  }).map((entry) => entry.id);
}

/**
 * The palette projects this one inventory. It deliberately carries data, not
 * handlers or DOM queries: command execution remains at the palette's one
 * guarded choke point and labels can become locale-aware at render time.
 */
export function settingsPaletteCommands(options: {
  isMobile: boolean;
  isDesktop: boolean;
}): readonly SettingsPaletteCommand[] {
  // #2067: deliberately NOT filtered by `conditional: 'operator'` here.
  //
  // The palette holds no operator fact — it lazily imports this module when
  // somebody types — and acquiring one would fire a server request per
  // search. Filtering on an absent fact removed the entry for EVERYONE
  // including the operator, which is a capability removal dressed as a fix.
  //
  // So the palette offers it, exactly as it offers `answer-shares`, which is
  // credential-gated in the same way. DISCLOSED RESIDUAL: a collaborator who
  // reaches it through the PALETTE (not the Settings search, which IS
  // filtered — `matchingSettingsRows`) lands on Settings with a highlight
  // that finds nothing. A cosmetic no-op carrying no plugin data.
  return SETTINGS_CATALOG.map((entry) => {
    const unavailable =
      entry.conditional === 'mobile' && !options.isMobile
        ? ('mobile' as const)
        : entry.conditional === 'desktop' && !options.isDesktop
          ? ('desktop' as const)
          : undefined;
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
      ...(unavailable
        ? { unavailable: true, unavailableReason: unavailable }
        : {}),
      scope: entry.scope ?? 'informational',
      view: entry.section,
      highlight: entry.id as SettingsCatalogId,
    };
  });
}
