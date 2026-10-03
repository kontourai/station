import type { SettingsSectionId } from './settings-catalog';

/** Topics organize navigation; each row keeps its own persistence authority. */
export const SETTINGS_PAGES = [
  { id: 'general', title: 'General', sections: ['permissions', 'agent-runs'] },
  { id: 'appearance', title: 'Appearance', sections: ['appearance'] },
  { id: 'chat', title: 'Chat', sections: ['chat'] },
  {
    id: 'alerts',
    title: 'Notifications & voice',
    sections: ['notifications', 'voice'],
  },
  {
    id: 'keyboard-shortcuts',
    title: 'Keyboard shortcuts',
    sections: ['keyboard-shortcuts'],
  },
  { id: 'devices', title: 'Devices', sections: ['pairing', 'device-hosts'] },
  {
    id: 'privacy',
    title: 'Privacy & sharing',
    sections: ['telemetry', 'answer-shares', 'plugin-visibility'],
  },
  { id: 'knowledge', title: 'My knowledge', sections: ['knowledge'] },
  {
    id: 'advanced',
    title: 'Advanced',
    sections: [
      'system',
      'feature-previews',
      'host-runtime',
      'sources',
      'diagnostics',
      'developer-tools',
    ],
  },
] as const satisfies readonly {
  id: string;
  title: string;
  sections: readonly SettingsSectionId[];
}[];

export function settingsPageForSection(section: string) {
  return SETTINGS_PAGES.find((page) =>
    (page.sections as readonly string[]).includes(section),
  );
}

export function settingsSectionsForView(view: string): readonly string[] {
  return SETTINGS_PAGES.find((page) => page.id === view)?.sections ?? [view];
}
