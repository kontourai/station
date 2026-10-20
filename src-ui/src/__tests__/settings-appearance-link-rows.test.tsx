/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AccountPreferencesContext } from '../contexts/AccountPreferencesContext';
import { SettingsPageRow } from '../views/settings/SettingsPageRow';
import {
  matchingSettingsRows,
  settingsRow,
} from '../views/settings/settings-catalog';

afterEach(cleanup);

/**
 * Settings' Theme row only switches light and dark; the color theme lives on
 * the Appearance page. Its "Use default" therefore resets the mode alone, and
 * a signed-in color theme with no saved mode offers no reset here at all — a
 * reset that silently kept (or silently cleared) the color theme would not be
 * what the row shows.
 */
function renderThemeRow(values: Record<string, unknown>) {
  const save = vi.fn();
  render(
    <AccountPreferencesContext.Provider
      value={{
        status: 'account',
        saving: false,
        waitingForConnection: false,
        error: false,
        conflict: false,
        data: { values } as never,
        save,
        retry: () => {},
      }}
    >
      <SettingsPageRow {...settingsRow('theme')} />
    </AccountPreferencesContext.Provider>,
  );
  return save;
}

test("the Theme row's Use default resets the mode only", () => {
  const save = renderThemeRow({ theme: 'light', colorTheme: 'catppuccin' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Use default for Theme' }),
  );
  expect(save).toHaveBeenCalledWith({ theme: null });
});

test('a saved color theme alone offers no reset on the Theme row', () => {
  renderThemeRow({ colorTheme: 'catppuccin', colorThemeFlavor: 'frappe' });
  expect(
    screen.queryByRole('button', { name: 'Use default for Theme' }),
  ).toBeNull();
});

test.each([
  ['flavor', 'theme'],
  ['color theme', 'theme'],
  ['named accent', 'accent-color'],
])('Settings search for "%s" still finds the %s row', (query, id) => {
  expect(matchingSettingsRows(query).map((entry) => entry.id)).toContain(id);
});
