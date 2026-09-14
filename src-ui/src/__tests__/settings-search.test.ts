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
      // `isOperator: true` so the enumeration covers every row; the
      // operator-conditional filtering is asserted on its own below.
      expect(
        matchingSettingsRows(entry.title, { isOperator: true }).map(
          ({ id }) => id,
        ),
        entry.id,
      ).toContain(entry.id);
    }
  });

  test('projects stable settings commands from the catalog without DOM text', () => {
    const desktop = settingsPaletteCommands({
      isMobile: false,
      isDesktop: false,
    });
    expect(desktop).toHaveLength(SETTINGS_CATALOG.length);
    expect(desktop.find((command) => command.id === 'settings:theme')).toEqual(
      expect.objectContaining({ view: 'appearance', highlight: 'theme' }),
    );
    expect(
      desktop.find((command) => command.id === 'settings:haptic-feedback'),
    ).toEqual(expect.objectContaining({ unavailable: true }));
    expect(
      settingsPaletteCommands({ isMobile: true, isDesktop: false }).find(
        (command) => command.id === 'settings:haptic-feedback',
      )?.unavailable,
    ).toBeUndefined();
  });

  test('projects the desktop-only update row with its honest unavailability', () => {
    const unavailable = settingsPaletteCommands({
      isMobile: false,
      isDesktop: false,
    }).find((command) => command.id === 'settings:desktop-app-updates');
    expect(unavailable).toEqual(
      expect.objectContaining({
        unavailable: true,
        unavailableReason: 'desktop',
      }),
    );
    expect(
      settingsPaletteCommands({ isMobile: false, isDesktop: true }).find(
        (command) => command.id === 'settings:desktop-app-updates',
      )?.unavailable,
    ).toBeUndefined();
  });

  test('keeps export and import authority truthful across Station and device data', () => {
    expect(
      settingsPaletteCommands({ isMobile: false, isDesktop: false }).find(
        (command) => command.id === 'settings:backup-restore',
      ),
    ).toEqual(expect.objectContaining({ scope: 'mixed' }));
  });

  test('retains English title search terms when palette labels are pseudo-localized', () => {
    // Every catalog entry is ranked below, so the projection has to offer
    // every catalog entry: this case is about localization, not about who is
    // calling.
    const commands = settingsPaletteCommands({
      isMobile: false,
      isDesktop: false,
    }).map((command) => ({
      ...command,
      label: pseudoLocalize(command.label),
      group: 'Settings',
      keywords: [...command.keywords],
      run: () => undefined,
    }));
    for (const entry of SETTINGS_CATALOG) {
      expect(rankCommands(entry.title, commands).map(({ id }) => id)).toContain(
        `settings:${entry.id}`,
      );
    }
  });

  test('marks read-only and session-only targets with explicit authority', () => {
    const commands = settingsPaletteCommands({
      isMobile: false,
      isDesktop: false,
    });
    expect(
      commands.find((command) => command.id === 'settings:deployed-build'),
    ).toEqual(expect.objectContaining({ scope: 'informational' }));
    expect(
      commands.find((command) => command.id === 'settings:message-context'),
    ).toEqual(expect.objectContaining({ scope: 'temporary' }));
  });

  test('the Settings search hides the operator-only section from a collaborator', () => {
    // #2067. The section renders only when the SERVER agrees the caller is
    // the operator, so offering a jump to it otherwise sends a collaborator
    // to an anchor that is not in the document. Absent `isOperator` reads as
    // "not known to be" — the fail-closed direction.
    expect(
      matchingSettingsRows('plugin visibility').map((entry) => entry.id),
    ).not.toContain('plugin-visibility');
    expect(
      matchingSettingsRows('plugin visibility', { isOperator: true }).map(
        (entry) => entry.id,
      ),
    ).toContain('plugin-visibility');
  });

  test('the palette still offers it, because the palette holds no operator fact', () => {
    // Filtering on a fact the palette cannot have removed the entry for
    // EVERYONE including the operator — a capability removal dressed as a
    // fix. It is offered here exactly as `answer-shares` is, which is
    // credential-gated the same way.
    expect(
      settingsPaletteCommands({ isMobile: false, isDesktop: false }).map(
        (command) => command.id,
      ),
    ).toContain('settings:plugin-visibility');
  });
});
