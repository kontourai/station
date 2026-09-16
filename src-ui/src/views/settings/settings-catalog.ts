import { DEVICE_SETTINGS_REGISTRY } from '@kontourai/station-contracts/device-settings';
import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import type { IntlLocale } from '../../i18n/formatters';
import { interpolate } from '../../i18n/LocaleContext';
import { pseudoLocalize } from '../../i18n/pseudo';

export type SettingsSectionId =
  // #2182 dissolved 'station-config'. It was a card named after a FILE
  // FORMAT that had collected sixteen unrelated controls — a permission
  // screener beside a shell path beside a telemetry switch — and nobody
  // could have guessed which of them lived there. Its rows moved to the
  // sections named for what they decide; the id is gone, and a stale
  // `?view=station-config` heals whenever the link carries a highlight.
  | 'system'
  | 'feature-previews'
  | 'answer-shares'
  | 'plugin-visibility'
  | 'host-runtime'
  | 'sources'
  | 'telemetry'
  | 'permissions'
  | 'diagnostics'
  // #2182: renamed from 'agent-defaults'. "Defaults" named a precedence
  // rule and said nothing about what the rule applies TO; these are the
  // values a new agent run inherits. Section ids are the one identity in
  // this module that CAN move — `SettingsView` heals a stale `view=` from
  // the row's own catalog entry whenever the link carries a highlight.
  | 'agent-runs'
  | 'appearance'
  // #2144 slice 4: chat behaviour owns its rows now, rather than borrowing
  // Appearance's. The only new section id this slice adds.
  | 'chat'
  | 'keyboard-shortcuts'
  | 'notifications'
  | 'voice'
  | 'pairing'
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

/**
 * Which navigation group a section is listed under.
 *
 * IDs, not the words on screen: #2144 decision 6 renamed the groups a reader
 * sees ("This Station", "Control", "This device" — the last of which `SettingsView`
 * still keys as `you`) without moving a single section id, and it must be able
 * to do that again. `SettingsView` owns the mapping from
 * these ids to labels, and it is the only consumer — a group is a presentation
 * fact about the nav strip, never a persistence or authority fact. What
 * DECIDES a setting is the row's own `scope`, stated on the row (#2144
 * slice 3), and the two deliberately do not have to agree: an informational
 * Station-host reading and a saved Station setting can share a group.
 */
export type SettingsNavGroup = 'this-station' | 'control' | 'you' | 'knowledge';

export const SETTINGS_SECTIONS = [
  { id: 'system', title: 'System', group: 'this-station' },
  // archive#3313 (IA option A): the retired standalone Feature Previews view,
  // as a Station-scope section (previews persist on the Station).
  { id: 'feature-previews', title: 'Feature previews', group: 'this-station' },
  { id: 'answer-shares', title: 'Shared answers', group: 'this-station' },
  // #2067: which installed plugins each paired person can see. Station scope
  // because the grants live on this Station; operator-only, gated by the
  // route, the same way 'answer-shares' is gated by its own scope tier.
  {
    id: 'plugin-visibility',
    title: 'Plugin visibility',
    group: 'this-station',
  },
  { id: 'host-runtime', title: 'Station host', group: 'this-station' },
  // #2182: where this Station gets agents, skills, plugins and layouts from.
  { id: 'sources', title: 'Sources', group: 'this-station' },
  // #2182: whether anything is sent, and whether there is anywhere to send
  // it. The disclosure card that lists what a payload contains moved here
  // with the toggle that decides it.
  // The SECTION is "Telemetry" and the ROW inside it is "Usage telemetry":
  // the two were the same words, so the nav offered a destination whose only
  // apparent content was itself, and the card's heading restated its first
  // row. The id stays `telemetry`.
  { id: 'telemetry', title: 'Telemetry', group: 'this-station' },
  { id: 'diagnostics', title: 'Diagnostics', group: 'this-station' },
  // #2182: what agents may do without asking. Two rows, and that is the
  // whole of it today — the epic's other permissions ideas have no consumer
  // yet, and a section padded to look substantial would be the same lie as
  // the card this one came out of.
  { id: 'permissions', title: 'Permissions', group: 'control' },
  { id: 'agent-runs', title: 'Agent runs', group: 'control' },
  { id: 'appearance', title: 'Appearance', group: 'you' },
  // #2144 decision 2: chat behaviour is per-device, so it sits beside the
  // other choices this device makes for the person using it.
  { id: 'chat', title: 'Chat', group: 'you' },
  {
    id: 'keyboard-shortcuts',
    title: 'Keyboard shortcuts',
    group: 'you',
  },
  { id: 'notifications', title: 'Notifications', group: 'you' },
  // #2182: "Voice & Features" was two nouns because the section held one
  // thing that was not voice — mobile pairing. "Features" named no category
  // a reader could predict; it named the leftovers.
  { id: 'voice', title: 'Voice', group: 'you' },
  // #2182: reaching this Station from a phone. It was the one non-voice row
  // of "Voice & Features", which is what made "Features" necessary.
  { id: 'pairing', title: 'Pairing', group: 'you' },
  // archive#3313: gates the Developer surface's sidebar/palette entries on
  // this device (a device setting — see contracts' developerToolsEnabled).
  { id: 'developer-tools', title: 'Developer tools', group: 'you' },
  // #2144 decision 5: Knowledge keeps a group of its own this slice.
  { id: 'knowledge', title: 'My knowledge store', group: 'knowledge' },
] as const satisfies readonly {
  id: SettingsSectionId;
  title: string;
  group: SettingsNavGroup;
}[];

const SETTINGS_CATALOG_SOURCE = [
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
    id: 'reset-device-defaults',
    title: 'Restore device defaults',
    section: 'system',
    keywords: ['reset this device', 'device defaults', 'restore'],
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
  // ── Station host (#2182) ────────────────────────────────────────────────
  // Three settings whose subject is the machine: which shell a terminal
  // starts, which origin an MCP UI may be served from, and whether Veritas
  // evidence is allowed to raise a surface's trust on it. The shell's own
  // default is a HOST reading (`HOST_DERIVED_DEFAULTS`), which is the clearest
  // statement that these belong beside the prerequisite report rather than in
  // a general configuration bin.
  {
    id: 'terminal-shell',
    title: 'Terminal shell',
    section: 'host-runtime',
    configKeys: ['terminalShell'],
  },
  {
    id: 'mcp-ui-host',
    title: 'MCP UI host',
    section: 'host-runtime',
    configKeys: ['mcpUiHost'],
  },
  {
    id: 'surface-trust',
    title: 'Surface trust from Veritas evidence',
    section: 'host-runtime',
    configKeys: ['surfaceTrustFromVeritasEvidence'],
  },
  // ── Sources (#2182) ─────────────────────────────────────────────────────
  // Where this Station gets agents, skills, plugins and layouts from. All
  // three were previously scattered through one undifferentiated card, so
  // nothing said they answer the same question.
  {
    id: 'registry-url',
    title: 'Registry URL',
    section: 'sources',
    configKeys: ['registryUrl'],
  },
  {
    id: 'default-skill-registries',
    title: 'Disable default skill registries',
    section: 'sources',
    configKeys: ['disableDefaultSkillRegistries'],
  },
  {
    id: 'distribution-profile',
    title: 'Layout sources',
    section: 'sources',
    configKeys: ['distributionProfile'],
  },
  // ── Usage telemetry (#2182) ─────────────────────────────────────────────
  // Whether anything is sent, and whether there is anywhere to send it.
  {
    id: 'usage-telemetry',
    title: 'Usage telemetry',
    section: 'telemetry',
    configKeys: ['telemetryEnabled'],
  },
  {
    id: 'telemetry-destination',
    title: 'Telemetry destination',
    section: 'telemetry',
    keywords: ['endpoint', 'where telemetry goes', 'otel'],
  },
  {
    id: 'diagnostics-bundle',
    title: 'Diagnostics bundle',
    section: 'diagnostics',
    keywords: ['health logs download'],
  },
  // ── Permissions (#2182) ─────────────────────────────────────────────────
  // What agents may do without asking. `approval-guardian` is an always-on
  // screener rather than a fallback, which is why the Control group's caption
  // has to name both kinds of rule.
  {
    id: 'approval-guardian',
    title: 'Approval guardian',
    section: 'permissions',
    configKeys: ['approvalGuardian'],
  },
  {
    id: 'default-approval-mode',
    title: 'Default approval mode',
    section: 'permissions',
    keywords: ['approval', 'permissions', 'auto approve', 'ask first'],
    configKeys: ['defaultApprovalMode'],
  },
  {
    id: 'default-model',
    title: 'Default model',
    section: 'agent-runs',
    configKeys: ['defaultModel'],
  },
  {
    id: 'default-region',
    title: 'Default Region',
    section: 'agent-runs',
    configKeys: ['region'],
  },
  {
    id: 'default-agent-instructions',
    title: 'Default Agent Instructions',
    section: 'agent-runs',
    configKeys: ['systemPrompt'],
  },
  {
    id: 'template-variables',
    title: 'Template Variables',
    section: 'agent-runs',
    configKeys: ['templateVariables'],
  },
  // The five below moved here from the dissolved `station-config` card
  // (#2182). Every one of them bounds or equips a RUN — which engine carries
  // the built-in agent, how many steps and output tokens a run may take, the
  // workspace a new chat gets, and whether that workspace is checkpointed —
  // so they belong with the values a run starts from, not in a card named
  // after a config file. Their `scope` stays `station`: it is read from each
  // key's own registry definition, not from this section (`scopeForEntry`).
  {
    id: 'builtin-agent-engine',
    title: 'Built-in agent engine',
    section: 'agent-runs',
    configKeys: ['builtinAgentEngineConnectionId'],
  },
  {
    id: 'default-max-turns',
    title: 'Default max turns',
    section: 'agent-runs',
    configKeys: ['defaultMaxTurns'],
  },
  {
    id: 'default-max-output-tokens',
    title: 'Default max output tokens',
    section: 'agent-runs',
    configKeys: ['defaultMaxOutputTokens'],
  },
  {
    id: 'default-workspace-isolation',
    title: 'New chat workspace',
    section: 'agent-runs',
    configKeys: ['defaultWorkspaceIsolation'],
  },
  {
    id: 'workspace-checkpoints',
    title: 'Workspace checkpoints',
    section: 'agent-runs',
    configKeys: ['workspaceCheckpoints'],
  },
  // ── Chat (#2144 decision 2) ──────────────────────────────────────────────
  // These two MOVED here from 'appearance'. Their ids are unchanged, so every
  // `highlight=` deep link and every recorded highlight still resolves; what
  // changed is the `view=` each one belongs to, which is the documented soft
  // break — an old `?view=appearance&highlight=chat-font-size` link still
  // opens Settings and still reveals the row, it just opens the section the
  // row is in now.
  {
    id: 'chat-font-size',
    title: 'Chat font size',
    section: 'chat',
    // Device key only: this slider writes `chatFontSize` through the
    // device-settings store. The Station default (`defaultChatFontSize`) is
    // its own row, immediately below.
    configKeys: ['chatFontSize'],
  },
  // The Station default this device's slider falls back to (#2182). It is a
  // STATION-scope row inside the device box, which is exactly the case the
  // scope chip exists for: `containerScope="device"` makes it print a
  // "Station" chip that the device rows around it do not get. It sits here
  // rather than in a Station card because the question it answers —
  // "how big is chat text" — is the one the reader came to this card with.
  {
    id: 'default-chat-font-size',
    title: 'Default chat font size',
    section: 'chat',
    configKeys: ['defaultChatFontSize'],
  },
  {
    // The id is the stable URL/palette identity and stays as minted even
    // though the title no longer matches it (#2144 slice 6 item B) — a
    // rename would break every deep link and every recorded highlight.
    id: 'smooth-answer-reveal',
    title: 'Answer delivery',
    section: 'chat',
    keywords: ['chat streaming steady cadence', 'smooth reveal'],
    configKeys: ['featureSettings'],
  },
  // The five below had a device-settings contract row and no catalog row, so
  // Settings' own search could not find them at all. Where they COULD be
  // changed splits: the in-chat gear panel was the only surface for
  // `chat-show-reasoning`, `chat-show-tool-details` and `chat-dock-auto-hide`
  // (`components/chat/ChatSettingsPanel.tsx` renders those three alongside
  // font size and answer delivery; its other controls act on the session
  // rather than setting a device key). `diff-style` and `diff-wrap`
  // were never on that panel at all — they were reachable only from
  // `DiffPanel`'s own toolbar, whose style toggle and Wrap button write these
  // same two device keys, and had no Settings home.
  {
    id: 'chat-show-reasoning',
    title: 'Show reasoning',
    section: 'chat',
    keywords: ['thinking', 'chain of thought'],
    configKeys: ['chatShowReasoning'],
  },
  {
    id: 'chat-show-tool-details',
    title: 'Show tool details',
    section: 'chat',
    keywords: ['tool calls', 'arguments', 'results'],
    configKeys: ['chatShowToolDetails'],
  },
  {
    id: 'chat-dock-auto-hide',
    title: 'Auto-hide chat dock',
    section: 'chat',
    keywords: ['collapse idle dock'],
    configKeys: ['chatDockAutoHide'],
  },
  {
    id: 'diff-style',
    title: 'Diff view style',
    section: 'chat',
    keywords: ['unified', 'split', 'side by side', 'changed files'],
    configKeys: ['diffStyle'],
  },
  {
    id: 'diff-wrap',
    title: 'Diff line wrap',
    section: 'chat',
    keywords: ['wrap long lines', 'changed files'],
    configKeys: ['diffWrap'],
  },
  {
    id: 'confirm-conversation-delete',
    title: 'Ask before deleting a conversation',
    // #2182: moved from `appearance`. Whether deleting a conversation asks
    // first is a fact about conversations, not about how the app looks; it
    // sat under Appearance only because Appearance was where the device
    // toggles happened to live before Chat existed. Its id is unchanged, so
    // every `highlight=` link still resolves and heals to the new view.
    section: 'chat',
    keywords: ['confirm', 'confirmation', 'delete', 'undo', 'destructive'],
    configKeys: ['confirmConversationDelete'],
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
    // #2182: this row and `tts-readback` below read as one control — both
    // said "text to speech" and both parenthesised the other's job. This one
    // picks WHICH service speaks; that one decides WHETHER anything is read
    // without being asked.
    title: 'Text-to-speech service',
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
    id: 'tts-readback',
    title: 'Read replies aloud',
    section: 'voice',
    configKeys: ['featureSettings'],
  },
  {
    id: 'mobile-pairing',
    title: 'Mobile pairing & network discovery',
    section: 'pairing',
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
  // #2144 slice 6 item F: in the Station's System section, but it writes
  // this device's store and nothing on the Station.
  'reset-device-defaults': 'device',
  // #2144 slice 6 item D: a derived status line with no writer, inside a
  // section whose other rows are all Station-scope writes.
  'telemetry-destination': 'informational',
  'deployed-build': 'informational',
  'message-context': 'temporary',
};

/**
 * The write authority each registry declares for its own key.
 *
 * Both registries carry `scope` on every definition (`settings-registry.ts`
 * for the Station document, `device-settings.ts` for this device's store), so
 * a row that names a key has an authoritative answer and never has to be
 * guessed at from where it is rendered.
 */
const SCOPE_BY_CONFIG_KEY: ReadonlyMap<
  string,
  NonNullable<SettingsCatalogEntry['scope']>
> = new Map(
  [...APP_SETTINGS_REGISTRY, ...DEVICE_SETTINGS_REGISTRY].map((definition) => [
    String(definition.key),
    definition.scope as NonNullable<SettingsCatalogEntry['scope']>,
  ]),
);

/**
 * The scope a row with NO config key gets, from the section it sits in.
 *
 * This is a last resort, not the rule — see `scopeForEntry`. A status
 * reading, a surface or a button has no registry definition to ask, so the
 * section's own storage character is the only honest answer available.
 */
function scopeForKeylessSection(
  section: SettingsSectionId,
): NonNullable<SettingsCatalogEntry['scope']> {
  // No `agent-runs` branch. It used to return 'defaults' and could never
  // execute: `defaults` is a closed six-key list in the registry
  // (`settings-registry.test.ts`), every one of those keys has a row, and a
  // row with a key never reaches this function. A branch that cannot run is
  // a claim nothing checks.
  if (
    section === 'appearance' ||
    section === 'chat' ||
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

/**
 * Which document an edit to this row is written to.
 *
 * Read from the row's OWN key, not from the section it is rendered in
 * (#2182). A section is an information-architecture choice and is expected to
 * move; `scope` is a persistence fact and must not move with it. This field is
 * published to agents in `src-server/generated/settings-registry.json`, so
 * deriving it from the section let "which card is this under" silently decide
 * "which document does an agent write": filing `default-chat-font-size` under
 * Chat would have flipped it from `station` to `device`, and filing the
 * per-run Station controls under the defaults card would have flipped them to
 * `defaults`, contradicting the closed six-key `defaults` list that
 * `packages/contracts/src/__tests__/settings-registry.test.ts` pins.
 *
 * The FIRST config key, matching `scripts/gen-settings-registry.ts`: a row
 * with several keys is one control over one primary value, and that is the
 * key the published artifact names.
 *
 * `SETTING_SCOPE_OVERRIDES` still has the final say — it exists for the rows
 * whose registry answer is true of the KEY but not of what this row does with
 * it (a derived status line, an export that spans both documents).
 */
function scopeForEntry(
  id: SettingsCatalogId,
  section: SettingsSectionId,
  configKeys: readonly string[] | undefined,
): NonNullable<SettingsCatalogEntry['scope']> {
  const override = SETTING_SCOPE_OVERRIDES[id];
  if (override) return override;
  const declaredKey = configKeys?.[0];
  const declared = declaredKey
    ? SCOPE_BY_CONFIG_KEY.get(declaredKey)
    : undefined;
  return declared ?? scopeForKeylessSection(section);
}

/** Every entry has write authority metadata, derived once from its own key. */
type SettingsCatalogWithScope = readonly (SettingsCatalogEntry & {
  readonly id: SettingsCatalogId;
  readonly scope: NonNullable<SettingsCatalogEntry['scope']>;
})[];

export const SETTINGS_CATALOG = SETTINGS_CATALOG_SOURCE.map((entry) => ({
  ...entry,
  // `configKeys` is absent from the literal type of every keyless row, and
  // the source is a union of 54 such literals, so it is read through the
  // declared shape rather than off the union member.
  scope: scopeForEntry(
    entry.id,
    entry.section,
    (entry as Omit<SettingsCatalogEntry, 'scope'>).configKeys,
  ),
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

/**
 * The registry definitions a catalog entry's config keys resolve to, in key
 * order. One lookup, two consumers: `matchingSettingsRows` (the Settings
 * search corpus) and `settingsPaletteCommands` (the palette's keywords). A
 * key with no definition yields nothing here; the key itself is still
 * searchable through each caller's own key list.
 */
function registryDefinitionsFor(entry: SettingsCatalogEntry) {
  return (entry.configKeys ?? [])
    .map((key) => REGISTRY_BY_KEY.get(key))
    .filter((definition) => definition !== undefined);
}

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
    // `help` is the sentence the row renders beside its control, so it is the
    // phrasing somebody who remembers the CONSEQUENCE rather than the name
    // will type ("agent run steps", not "defaultMaxTurns"). Searching the
    // label and description but not the help text made the one sentence the
    // UI actually shows the one sentence search could not find.
    const registryText = registryDefinitionsFor(entry).flatMap((definition) => [
      definition.label,
      definition.description,
      definition.help,
    ]);
    return [
      entry.title,
      ...(entry.keywords ?? []),
      ...(entry.searchKeywords ?? []),
      ...(entry.configKeys ?? []),
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
        // The same consequence sentences the Settings search matches on, so
        // the two entry points answer the same query. Labels/descriptions are
        // deliberately NOT lifted here: the palette already carries
        // `entry.title` and the config keys, and the registry label is
        // usually the title restated.
        ...registryDefinitionsFor(entry).map((definition) => definition.help),
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
