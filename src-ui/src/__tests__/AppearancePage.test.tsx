/** @vitest-environment jsdom */

import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import {
  bindColorThemeToSettings,
  COLOR_THEME_ACCENT_ATTRIBUTE,
  COLOR_THEME_ATTRIBUTE,
  COLOR_THEME_FLAVOR_ATTRIBUTE,
} from '../lib/color-theme-apply';
import { COLOR_THEME_OPTIONS } from '../lib/color-themes';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { AppearancePage, themePreview } from '../pages/AppearancePage';

/**
 * The Appearance page against the REAL settings store and lane A's real
 * applier (`bindColorThemeToSettings`, the binding `main.tsx` installs), so a
 * choice is proven by the root attributes the stylesheet keys on, not by a
 * spy on a setter.
 */

const root = document.documentElement;
let unbind: () => void = () => {};

function seed(values: Partial<DeviceSettings>) {
  act(() => {
    deviceSettingsStore.importEnvelope({ version: 1, values });
  });
}

function renderPage() {
  return render(
    <KeyboardShortcutsProvider>
      <AppearancePage />
    </KeyboardShortcutsProvider>,
  );
}

function attributes() {
  return {
    theme: root.getAttribute(COLOR_THEME_ATTRIBUTE),
    flavor: root.getAttribute(COLOR_THEME_FLAVOR_ATTRIBUTE),
    accent: root.getAttribute(COLOR_THEME_ACCENT_ATTRIBUTE),
  };
}

const gallery = () => screen.getByRole('radiogroup', { name: 'Color theme' });

beforeEach(() => {
  deviceSettingsStore.importEnvelope({ version: 1, values: {} });
  unbind = bindColorThemeToSettings(root, deviceSettingsStore);
});

afterEach(() => {
  cleanup();
  unbind();
  deviceSettingsStore.importEnvelope({ version: 1, values: {} });
  for (const name of [
    COLOR_THEME_ATTRIBUTE,
    COLOR_THEME_FLAVOR_ATTRIBUTE,
    COLOR_THEME_ACCENT_ATTRIBUTE,
  ])
    root.removeAttribute(name);
});

describe('Appearance page', () => {
  test('lists every catalog theme as one radio group, Station selected by default', () => {
    renderPage();
    const radios = within(gallery()).getAllByRole('radio');
    expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual(
      COLOR_THEME_OPTIONS.map(
        (option) =>
          // Name then the flavor shown in the current (dark) mode.
          `${option.label}${themePreview(option, 'dark', deviceSettingsStore.getSnapshot()).flavorLabel ?? 'Default'}`,
      ),
    );
    // Native radios sharing one name: the browser gives the group one tab
    // stop and arrow-key movement (exercised for real in
    // appearance-page-keyboard.test.ts).
    expect(
      new Set(radios.map((radio) => (radio as HTMLInputElement).name)).size,
    ).toBe(1);
    expect(
      radios.filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /^Station/ })).toHaveProperty(
      'checked',
      true,
    );
    expect(attributes()).toEqual({ theme: null, flavor: null, accent: null });
  });

  test('choosing a family applies it at the root with its default flavor and accent', () => {
    seed({ colorThemeFlavor: 'frappe', colorThemeAccent: 'pink' });
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: /^Catppuccin/ }));

    const settings = deviceSettingsStore.getSnapshot();
    expect(settings.colorTheme).toBe('catppuccin');
    // Stale per-family ids are cleared, so the family's defaults are in force.
    expect(settings.colorThemeFlavor).toBeNull();
    expect(settings.colorThemeAccent).toBeNull();
    expect(attributes()).toEqual({
      theme: 'catppuccin',
      flavor: 'mocha',
      accent: 'mauve',
    });
  });

  test('a dark flavor choice reaches the root and the copy names the light flavor', () => {
    seed({ colorTheme: 'catppuccin' });
    renderPage();
    const flavors = screen.getByRole('radiogroup', { name: 'Dark flavor' });
    expect(
      within(flavors)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Frappé', 'Macchiato', 'Mocha']);
    expect(
      screen.getByText('Used in dark mode. Light mode uses Latte.'),
    ).toBeTruthy();

    fireEvent.click(within(flavors).getByRole('radio', { name: 'Frappé' }));
    expect(deviceSettingsStore.getSnapshot().colorThemeFlavor).toBe('frappe');
    expect(attributes().flavor).toBe('frappe');
  });

  test.each(['gruvbox', 'nord'] as const)(
    '%s has one dark flavor, so there is no flavor choice',
    (id) => {
      seed({ colorTheme: id });
      renderPage();
      expect(
        screen.queryByRole('radiogroup', { name: 'Dark flavor' }),
      ).toBeNull();
    },
  );

  test('a named accent applies at the root', () => {
    seed({ colorTheme: 'catppuccin' });
    renderPage();
    const accents = screen.getByRole('radiogroup', { name: 'Accent' });
    // Every named accent is a labelled choice, not a bare colour.
    expect(within(accents).getAllByRole('radio')).toHaveLength(14);
    fireEvent.click(within(accents).getByRole('radio', { name: 'Peach' }));
    expect(deviceSettingsStore.getSnapshot().colorThemeAccent).toBe('peach');
    expect(attributes().accent).toBe('peach');
    expect(screen.getByText('Peach')).toBeTruthy();
  });

  // A custom hex `accentColor` wins over a theme's accent (lane A's
  // precedence), so a named accent that left it in place would change nothing
  // on screen while the page showed it selected.
  test('choosing a named accent clears a custom accent, and the copy says so first', () => {
    seed({ colorTheme: 'catppuccin', accentColor: '#22c55e' });
    renderPage();
    expect(
      screen.getByText(
        'Your custom accent #22c55e is in use on every theme. Choosing an accent here replaces it.',
      ),
    ).toBeTruthy();
    const accents = screen.getByRole('radiogroup', { name: 'Accent' });
    // Nothing named is in force while the custom accent is.
    expect(
      within(accents)
        .getAllByRole('radio')
        .filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(0);

    fireEvent.click(within(accents).getByRole('radio', { name: 'Mauve' }));

    const settings = deviceSettingsStore.getSnapshot();
    expect(settings.accentColor).toBeNull();
    expect(settings.colorThemeAccent).toBe('mauve');
    expect(attributes().accent).toBe('mauve');
    expect(
      within(accents).getByRole('radio', { name: 'Mauve' }),
    ).toHaveProperty('checked', true);
    expect(screen.queryByText(/Your custom accent/)).toBeNull();
  });

  test('Station offers its own presets and a custom color, not named accents', () => {
    renderPage();
    expect(screen.queryByRole('radiogroup', { name: 'Accent' })).toBeNull();
    expect(screen.getByLabelText('Custom accent color')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Accent color #ec4899'));
    expect(deviceSettingsStore.getSnapshot().accentColor).toBe('#ec4899');
  });

  test('the mode control writes the same theme setting and the previews follow it', () => {
    seed({ colorTheme: 'catppuccin' });
    renderPage();
    const mode = screen.getByRole('radiogroup', { name: 'Mode' });
    expect(within(mode).getByRole('radio', { name: 'Dark' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByText('Previews show dark mode.')).toBeTruthy();

    fireEvent.click(within(mode).getByRole('radio', { name: 'Light' }));
    expect(deviceSettingsStore.getSnapshot().theme).toBe('light');
    expect(screen.getByText('Previews show light mode.')).toBeTruthy();
    // The selected card now shows Catppuccin's light flavor.
    expect(
      screen.getByRole('radio', { name: /^Catppuccin/ }).closest('label')
        ?.textContent,
    ).toBe('CatppuccinLatte');
    // The dark flavor stays what it was; light mode does not touch it.
    expect(attributes().flavor).toBe('mocha');
  });
});

describe('themePreview', () => {
  const catppuccin = COLOR_THEME_OPTIONS.find((o) => o.id === 'catppuccin')!;
  const station = COLOR_THEME_OPTIONS.find((o) => o.id === 'station')!;
  const base = deviceSettingsStore.getSnapshot();

  test('the selected family shows its chosen flavor and accent', () => {
    const preview = themePreview(catppuccin, 'dark', {
      ...base,
      colorTheme: 'catppuccin',
      colorThemeFlavor: 'frappe',
      colorThemeAccent: 'peach',
    });
    const frappe = catppuccin.flavors.find((f) => f.id === 'frappe')!;
    expect(preview.flavorLabel).toBe('Frappé');
    expect(preview.swatch.background).toBe(frappe.swatch.background);
    expect(preview.swatch.accent).toBe(
      catppuccin.accents.find((a) => a.id === 'peach')!.swatches.frappe,
    );
  });

  test('an unselected family shows its defaults, whatever accent is custom', () => {
    const preview = themePreview(catppuccin, 'light', {
      ...base,
      colorTheme: 'station',
      accentColor: '#22c55e',
    });
    expect(preview.flavorLabel).toBe('Latte');
    expect(preview.swatch).toEqual(catppuccin.preview.light);
  });

  test('the selected card shows a custom accent, because it wins on screen', () => {
    expect(
      themePreview(station, 'dark', { ...base, accentColor: '#22c55e' }).swatch
        .accent,
    ).toBe('#22c55e');
    expect(
      themePreview(catppuccin, 'dark', {
        ...base,
        colorTheme: 'catppuccin',
        accentColor: '#22c55e',
      }).swatch.accent,
    ).toBe('#22c55e');
  });
});
