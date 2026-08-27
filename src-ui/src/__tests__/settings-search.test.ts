import { describe, expect, test } from 'vitest';
import { rankCommands } from '../components/command-palette-utils';
import { pseudoLocalize } from '../i18n/pseudo';
import {
  matchingSettingsRows,
  SETTINGS_CATALOG,
  settingsPaletteCommands,
} from '../views/settings/settings-catalog';

describe('settings catalog search', () => {
  test('empty and unknown queries match nothing', () => {
    expect(matchingSettingsRows('')).toEqual([]);
    expect(matchingSettingsRows('zzz-not-a-real-term')).toEqual([]);
  });

  test('titles, descriptions, and raw config keys find their catalog row', () => {
    expect(
      matchingSettingsRows('Default region').map(({ id }) => id),
    ).toContain('default-region');
    expect(matchingSettingsRows('terminalShell').map(({ id }) => id)).toContain(
      'terminal-shell',
    );
    expect(matchingSettingsRows('obsidian').map(({ id }) => id)).toContain(
      'personal-knowledge-store',
    );
  });

  test('every catalog title finds its own exact row', () => {
    for (const entry of SETTINGS_CATALOG) {
      expect(
        matchingSettingsRows(entry.title).map(({ id }) => id),
        entry.id,
      ).toContain(entry.id);
    }
  });

  test('projects stable settings commands from the catalog without DOM text', () => {
    const desktop = settingsPaletteCommands({ isMobile: false });
    expect(desktop).toHaveLength(SETTINGS_CATALOG.length);
    expect(desktop.find((command) => command.id === 'settings:theme')).toEqual(
      expect.objectContaining({ view: 'appearance', highlight: 'theme' }),
    );
    expect(
      desktop.find((command) => command.id === 'settings:haptic-feedback'),
    ).toEqual(expect.objectContaining({ unavailable: true }));
    expect(
      settingsPaletteCommands({ isMobile: true }).find(
        (command) => command.id === 'settings:haptic-feedback',
      )?.unavailable,
    ).toBeUndefined();
  });

  test('keeps export and import authority truthful across Station and device data', () => {
    expect(
      settingsPaletteCommands({ isMobile: false }).find(
        (command) => command.id === 'settings:backup-restore',
      ),
    ).toEqual(expect.objectContaining({ scope: 'mixed' }));
  });

  test('retains English title search terms when palette labels are pseudo-localized', () => {
    const commands = settingsPaletteCommands({ isMobile: false }).map(
      (command) => ({
        ...command,
        label: pseudoLocalize(command.label),
        group: 'Settings',
        keywords: [...command.keywords],
        run: () => undefined,
      }),
    );
    for (const entry of SETTINGS_CATALOG) {
      expect(rankCommands(entry.title, commands).map(({ id }) => id)).toContain(
        `settings:${entry.id}`,
      );
    }
  });

  test('marks read-only and session-only targets with explicit authority', () => {
    const commands = settingsPaletteCommands({ isMobile: false });
    expect(
      commands.find((command) => command.id === 'settings:deployed-build'),
    ).toEqual(expect.objectContaining({ scope: 'informational' }));
    expect(
      commands.find((command) => command.id === 'settings:message-context'),
    ).toEqual(expect.objectContaining({ scope: 'temporary' }));
  });
});
