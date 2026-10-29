import type { DeviceSettings } from './device-settings.js';
import type { ApprovalMode } from './provider.js';

/** Portable choices; device capabilities, grants and geometry are deliberately absent. */
export const ACCOUNT_PREFERENCE_KEYS = [
  'theme',
  'accentColor',
  'colorTheme',
  'colorThemeFlavor',
  'colorThemeAccent',
  'diffStyle',
  'diffWrap',
  'chatShowReasoning',
  'chatShowToolDetails',
  'chatFontSize',
  'chatDockAutoHide',
  'confirmConversationDelete',
  'developerToolsEnabled',
  'modelPickerPreferences',
] as const satisfies readonly (keyof DeviceSettings)[];

export type PortableSettingKey = (typeof ACCOUNT_PREFERENCE_KEYS)[number];
export type InteractiveApprovalEngine = 'codex' | 'claude' | 'muse';
export type InteractiveApprovalDefaults = Partial<
  Record<InteractiveApprovalEngine, Exclude<ApprovalMode, 'connection-default'>>
>;

export type AccountPreferences = Partial<
  Pick<DeviceSettings, Exclude<PortableSettingKey, 'colorTheme'>>
> & {
  /**
   * Stored as a parsed id rather than today's family list: a client newer
   * than the server may name a family this server does not know, and the UI
   * resolves any unknown id to `station`.
   */
  colorTheme?: string;
  smoothReveal?: boolean;
  bufferedDelivery?: boolean;
  interactiveApprovalModes?: InteractiveApprovalDefaults;
};

/** Null resets a setting; omitted fields remain untouched. */
export type AccountPreferencesPatch = {
  [K in Exclude<keyof AccountPreferences, 'interactiveApprovalModes'>]?:
    | AccountPreferences[K]
    | null;
} & {
  interactiveApprovalModes?: Partial<
    Record<InteractiveApprovalEngine, 'ask' | 'auto' | 'never' | null>
  > | null;
};

export interface AccountPreferencesView {
  schemaVersion: 1;
  values: AccountPreferences;
  /** Opaque compare-and-set revision for composite replacements. */
  revision?: string;
}

export interface AccountPreferencesUpdate {
  patch: AccountPreferencesPatch;
  /** Migration imports fill gaps against current server state. */
  onlyMissing?: boolean;
}
