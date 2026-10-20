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

/**
 * jsdom fetches no stylesheets, so a test plays the browser's load event for
 * the family sheets the applier is waiting on (lib/color-theme-apply.ts names
 * a new family on the root only once its sheet has settled).
 */
function settleSheets(event: 'load' | 'error' = 'load') {
  act(() => {
    for (const link of document.head.querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"]:not([data-state])',
    ))
      link.dispatchEvent(new Event(event));
  });
}

/** Settle, then let the page's attribute observer (a microtask) re-render. */
async function settleSheetsAndObserve() {
  settleSheets();
  await act(async () => {
    await Promise.resolve();
  });
}

function seed(values: Partial<DeviceSettings>) {
  act(() => {
    deviceSettingsStore.importEnvelope({ version: 1, values });
  });
  settleSheets();
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
    'data-color-theme-failed',
  ])
    root.removeAttribute(name);
  for (const link of document.head.querySelectorAll('link[rel="stylesheet"]'))
    link.remove();
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
    settleSheets();

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
    // The choice is named in text, not only shown as a ring around a colour.
    expect(
      screen.getByText('Buttons, links and focus. Peach is selected.'),
    ).toBeTruthy();
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

describe('the ⌘H hint', () => {
  function stubMedia(matching: (query: string) => boolean) {
    window.matchMedia = ((query: string) => ({
      matches: matching(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });
  const hint = () => document.querySelector('.appearance__hint');

  test('shows with a fine pointer at a desktop width', () => {
    stubMedia(() => false);
    renderPage();
    expect(hint()?.textContent).toMatch(/switches modes\.$/);
  });

  test.each([
    ['a touch screen', (q: string) => q === '(pointer: coarse)'],
    ['the phone breakpoint', (q: string) => q.includes('max-width: 768px')],
  ])('is hidden on %s, which has no ⌘H to press', (_label, matching) => {
    stubMedia(matching);
    renderPage();
    expect(hint()).toBeNull();
    // The control itself is still there.
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeTruthy();
  });
});

describe('Appearance page while a theme sheet loads', () => {
  const card = (name: RegExp) =>
    screen.getByRole('radio', { name }).closest('label')!;

  // The choice is recorded at once, but the colours change only when the
  // family's sheet arrives. The card must not claim, with its tick, a look
  // that is not on screen yet.
  test('a chosen family reads as loading, not applied, until its sheet settles', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: /^Catppuccin/ }));

    expect(attributes().theme).toBeNull();
    expect(card(/^Catppuccin/).getAttribute('aria-busy')).toBe('true');
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinLoading…');
    expect(
      card(/^Catppuccin/).querySelector('.appearance-theme__check'),
    ).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Loading Catppuccin.');

    await settleSheetsAndObserve();
    expect(attributes().theme).toBe('catppuccin');
    expect(card(/^Catppuccin/).getAttribute('aria-busy')).toBeNull();
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinMocha');
    expect(
      card(/^Catppuccin/).querySelector('.appearance-theme__check'),
    ).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  // The applier drops a sheet that failed and leaves the previous look in
  // force (lib/color-theme-apply.ts). A card waiting on the root to name the
  // theme would then wait forever; it has to say the theme did not load and
  // offer to ask again.
  test('a sheet that fails says so, offers a retry, and the retry applies it', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: /^Catppuccin/ }));
    settleSheets('error');
    await settleSheetsAndObserve();

    expect(attributes().theme).toBeNull();
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinNot loaded');
    expect(card(/^Catppuccin/).getAttribute('aria-busy')).toBeNull();
    expect(
      card(/^Catppuccin/).querySelector('.appearance-theme__check'),
    ).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(
      "Couldn't load Catppuccin.",
    );
    const notice = screen.getByRole('region', { name: 'Theme not loaded' });
    expect(notice.textContent).toContain("Couldn't load Catppuccin.");
    expect(notice.textContent).toContain(
      'The colors you had stay until it loads.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinLoading…');
    expect(
      screen.queryByRole('region', { name: 'Theme not loaded' }),
    ).toBeNull();

    await settleSheetsAndObserve();
    expect(attributes().theme).toBe('catppuccin');
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinMocha');
    expect(
      screen.queryByRole('region', { name: 'Theme not loaded' }),
    ).toBeNull();
  });

  // The applier's failure contract (lib/color-theme-apply.ts):
  // `data-color-theme-failed` names the family whose latest sheet failed, and
  // is absent while a new request for it is in flight. The card follows it:
  // failed when marked, loading while a retry is on its way, and back to the
  // ordinary state once the theme applies.
  test("the failed state follows the applier's failure marker through retries and a new choice", async () => {
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: /^Catppuccin/ }));
    settleSheets('error');
    await settleSheetsAndObserve();
    expect(root.getAttribute('data-color-theme-failed')).toBe('catppuccin');
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinNot loaded');

    // A retry that fails again goes back to failed, not to Loading forever.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(root.getAttribute('data-color-theme-failed')).toBeNull();
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinLoading…');
    settleSheets('error');
    await settleSheetsAndObserve();
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinNot loaded');

    // Choosing another family clears the marker and its failure.
    fireEvent.click(screen.getByRole('radio', { name: /^Nord/ }));
    await settleSheetsAndObserve();
    expect(root.getAttribute('data-color-theme-failed')).toBeNull();
    expect(attributes().theme).toBe('nord');
    expect(
      screen.queryByRole('region', { name: 'Theme not loaded' }),
    ).toBeNull();
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinMocha');
  });

  // A failed theme must stay "Not loaded" through re-applies that do not
  // change the selection — a mode toggle, a save of an unrelated setting —
  // rather than flicker to "Loading…" as each one asks for the sheet again.
  test('a mode toggle and a background save after a failure keep the card on "Not loaded"', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: /^Catppuccin/ }));
    settleSheets('error');
    await settleSheetsAndObserve();
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinNot loaded');
    const sheetsInHead = () =>
      document.head.querySelectorAll('link[rel="stylesheet"]').length;
    const before = sheetsInHead();

    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Mode' })).getByRole(
        'radio',
        { name: 'Light' },
      ),
    );
    await act(async () => {
      deviceSettingsStore.set('chatFontSize', 17);
      await Promise.resolve();
    });

    expect(deviceSettingsStore.getSnapshot().theme).toBe('light');
    expect(sheetsInHead()).toBe(before);
    expect(root.getAttribute('data-color-theme-failed')).toBe('catppuccin');
    expect(card(/^Catppuccin/).textContent).toBe('CatppuccinNot loaded');
    expect(
      screen.getByRole('region', { name: 'Theme not loaded' }),
    ).toBeTruthy();
  });

  test('rapid choices end on the last one, whichever sheet settles first', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: /^Catppuccin/ }));
    const first = document.head.querySelector<HTMLLinkElement>(
      'link[rel="stylesheet"]:not([data-state])',
    )!;
    fireEvent.click(screen.getByRole('radio', { name: /^Nord/ }));
    // The superseded sheet arriving late must not win.
    act(() => {
      first.dispatchEvent(new Event('load'));
    });
    expect(attributes().theme).not.toBe('catppuccin');
    await settleSheetsAndObserve();
    expect(attributes()).toEqual({
      theme: 'nord',
      flavor: 'polar-night',
      accent: expect.any(String),
    });
    expect(card(/^Nord/).getAttribute('aria-busy')).toBeNull();

    // And back to Station before a family's sheet arrives leaves no theme.
    fireEvent.click(screen.getByRole('radio', { name: /^Tokyo Night/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Station/ }));
    settleSheets();
    expect(attributes()).toEqual({ theme: null, flavor: null, accent: null });
    expect(
      document.head.querySelectorAll('link[rel="stylesheet"]'),
    ).toHaveLength(0);
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
