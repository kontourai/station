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
 * the Appearance page. These pin the row's behavior as a person meets it:
 * "Use default" resets the mode alone, and a saved color theme with no saved
 * mode offers no reset here. They do not prove the catalog's key scoping —
 * the reset already followed a row's first account key before it — only
 * that the row does what it shows.
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

test("the Theme row's reset restores the mode, not the color theme", () => {
  const save = renderThemeRow({ theme: 'light', colorTheme: 'catppuccin' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Reset Theme to default' }),
  );
  expect(save).toHaveBeenCalledWith({ theme: null });
});

test('a saved color theme alone offers no reset on the Theme row', () => {
  renderThemeRow({ colorTheme: 'catppuccin', colorThemeFlavor: 'frappe' });
  expect(
    screen.queryByRole('button', { name: 'Reset Theme to default' }),
  ).toBeNull();
});

test.each([
  ['flavor', 'theme'],
  ['color theme', 'theme'],
  ['named accent', 'accent-color'],
])('Settings search for "%s" still finds the %s row', (query, id) => {
  expect(matchingSettingsRows(query).map((entry) => entry.id)).toContain(id);
});
