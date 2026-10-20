import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import { useCallback } from 'react';
import { CheckGlyph } from '../components/icons/Glyph';
import { PageRow } from '../components/PageRow';
import { PageSection } from '../components/PageSection';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../contexts/DeviceSettingsContext';
import {
  useKeyboardShortcut,
  useShortcutDisplay,
} from '../hooks/useKeyboardShortcut';
import { useLocale } from '../i18n/LocaleContext';
import type { ColorThemeMode } from '../lib/color-theme-catalog';
import {
  COLOR_THEME_OPTIONS,
  type ColorThemeOption,
  type ColorThemeSwatch,
  type ResolvedColorTheme,
  resolveColorThemeSelection,
} from '../lib/color-themes';
import { AccentColorPicker } from '../views/settings/AccentColorPicker';
import { formatSettingsMessage } from '../views/settings/settings-catalog';
import './AppearancePage.css';
import '../views/page-layout.css';

/** The same shape `applyAccentColor` accepts; anything else is not applied. */
const HEX_ACCENT = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function customAccent(settings: DeviceSettings): string | null {
  const value = settings.accentColor;
  return typeof value === 'string' && HEX_ACCENT.test(value) ? value : null;
}

type FamilyResolution = Exclude<ResolvedColorTheme, { id: 'station' }>;

/** The flavor option a family shows in `mode`, honoring the chosen dark flavor. */
function flavorOptionFor(
  option: ColorThemeOption,
  mode: ColorThemeMode,
  resolved: FamilyResolution | null,
) {
  if (mode === 'light') return option.flavors.find((f) => f.mode === 'light');
  const darkId = resolved?.darkFlavor.id ?? option.defaultDarkFlavor;
  return option.flavors.find((f) => f.id === darkId);
}

export interface ThemePreview {
  readonly swatch: ColorThemeSwatch;
  /** The flavor shown, `null` for Station. */
  readonly flavorLabel: string | null;
}

/**
 * What a gallery card shows in `mode`. The SELECTED card is what is on screen
 * now: its chosen flavor and accent, and a custom accent when one is set (it
 * wins on every theme). Every other card shows that theme's own defaults, so
 * the gallery compares themes rather than one accent on six backgrounds.
 */
export function themePreview(
  option: ColorThemeOption,
  mode: ColorThemeMode,
  settings: DeviceSettings,
): ThemePreview {
  const resolved = resolveColorThemeSelection(settings);
  const selected = resolved.id === option.id;
  const custom = selected ? customAccent(settings) : null;
  if (option.id === 'station') {
    const swatch = option.preview[mode];
    return {
      swatch: custom ? { ...swatch, accent: custom } : swatch,
      flavorLabel: null,
    };
  }
  const family = selected ? (resolved as FamilyResolution) : null;
  const flavor = flavorOptionFor(option, mode, family);
  if (!flavor) return { swatch: option.preview[mode], flavorLabel: null };
  const accentId = family?.accent ?? option.defaultAccent;
  const named = option.accents.find((accent) => accent.id === accentId);
  return {
    swatch: {
      ...flavor.swatch,
      accent: custom ?? named?.swatches[flavor.id] ?? flavor.swatch.accent,
    },
    flavorLabel: flavor.label,
  };
}

function ThemeThumbnail({ swatch }: { swatch: ColorThemeSwatch }) {
  return (
    <span
      className="appearance-theme__preview"
      aria-hidden="true"
      style={{ background: swatch.background, color: swatch.text }}
    >
      <span
        className="appearance-theme__panel"
        style={{ background: swatch.panel }}
      >
        <span className="appearance-theme__line appearance-theme__line--title" />
        <span className="appearance-theme__line appearance-theme__line--muted" />
        <span className="appearance-theme__code">
          <span
            className="appearance-theme__token"
            style={{ background: swatch.accent }}
          />
          <span className="appearance-theme__token appearance-theme__token--text" />
          <span className="appearance-theme__token appearance-theme__token--short" />
        </span>
        <span
          className="appearance-theme__button"
          style={{ background: swatch.accent }}
        />
      </span>
      <span className="appearance-theme__strip">
        {[swatch.background, swatch.panel, swatch.text, swatch.accent].map(
          (color, index) => (
            // Four fixed slots; the index IS the identity.
            <span key={index} style={{ background: color }} />
          ),
        )}
      </span>
    </span>
  );
}

function ModeControl({
  mode,
  onChange,
}: {
  mode: ColorThemeMode;
  onChange: (mode: ColorThemeMode) => void;
}) {
  const shortcut = useShortcutDisplay('theme.toggle');
  return (
    <div className="appearance-mode">
      <div
        className="appearance-mode__options"
        role="radiogroup"
        aria-label="Mode"
      >
        {(['light', 'dark'] as const).map((value) => (
          <label
            key={value}
            className={`appearance-mode__option${mode === value ? ' is-selected' : ''}`}
          >
            <input
              type="radio"
              className="appearance__radio"
              name="appearance-mode"
              value={value}
              checked={mode === value}
              onChange={() => onChange(value)}
            />
            {value === 'light' ? 'Light' : 'Dark'}
          </label>
        ))}
      </div>
      {shortcut && shortcut !== 'Not set' && (
        <span className="appearance__hint">{shortcut} switches modes.</span>
      )}
    </div>
  );
}

export function AppearancePage() {
  const settings = useDeviceSettings();
  const { setDeviceSetting, setDeviceSettings } = useDeviceSettingsActions();
  const { locale } = useLocale();
  const mode: ColorThemeMode = settings.theme === 'light' ? 'light' : 'dark';
  const resolved = resolveColorThemeSelection(settings);
  const selectedOption =
    COLOR_THEME_OPTIONS.find((option) => option.id === resolved.id) ??
    COLOR_THEME_OPTIONS[0];
  const family = resolved.id === 'station' ? null : resolved;
  const custom = customAccent(settings);

  const setMode = useCallback(
    (next: ColorThemeMode) => setDeviceSetting('theme', next),
    [setDeviceSetting],
  );
  // The same shortcut, id and handler shape as the Settings ThemeToggle, so
  // ⌘H works on this page as it does there.
  useKeyboardShortcut('theme.toggle', 'h', ['cmd'], 'Toggle theme', () =>
    setMode(mode === 'dark' ? 'light' : 'dark'),
  );

  // A family starts at its own default flavor and accent. Flavor and accent
  // ids are per family, so carrying them over would pick something nobody
  // chose (Gruvbox's `red` is not Catppuccin's).
  const chooseTheme = (id: ColorThemeOption['id']) =>
    setDeviceSettings({
      colorTheme: id,
      colorThemeFlavor: null,
      colorThemeAccent: null,
    });

  // A custom hex accent wins over a theme's named accent, so choosing a named
  // one has to clear it or the choice would change nothing on screen.
  const chooseAccent = (id: string) =>
    setDeviceSettings({ colorThemeAccent: id, accentColor: null });

  const shownFlavor = family
    ? flavorOptionFor(selectedOption, mode, family)
    : undefined;
  const lightFlavor = selectedOption.flavors.find((f) => f.mode === 'light');
  const darkFlavors = selectedOption.flavors.filter((f) => f.mode === 'dark');
  const accentLabel = family
    ? selectedOption.accents.find((accent) => accent.id === family.accent)
        ?.label
    : undefined;

  return (
    <div className="appearance">
      <p className="appearance__scope">
        {formatSettingsMessage('scopeAccount', locale)}
      </p>

      <PageSection className="appearance__section">
        <PageRow
          title="Mode"
          description="Every theme has a light and a dark version."
          control={<ModeControl mode={mode} onChange={setMode} />}
        />
      </PageSection>

      <PageSection
        className="appearance__section"
        title="Theme"
        description={`Previews show ${mode} mode.`}
      >
        <div
          className="appearance-theme__grid"
          role="radiogroup"
          aria-label="Color theme"
        >
          {COLOR_THEME_OPTIONS.map((option) => {
            const preview = themePreview(option, mode, settings);
            const selected = option.id === resolved.id;
            return (
              <label
                key={option.id}
                className={`appearance-theme${selected ? ' is-selected' : ''}`}
              >
                <input
                  type="radio"
                  className="appearance__radio"
                  name="appearance-color-theme"
                  value={option.id}
                  checked={selected}
                  onChange={() => chooseTheme(option.id)}
                />
                <ThemeThumbnail swatch={preview.swatch} />
                {selected && (
                  <span className="appearance-theme__check" aria-hidden="true">
                    <CheckGlyph />
                  </span>
                )}
                <span className="appearance-theme__name">{option.label}</span>
                <span className="appearance-theme__detail">
                  {preview.flavorLabel ?? 'Default'}
                </span>
              </label>
            );
          })}
        </div>
      </PageSection>

      {family && darkFlavors.length > 1 && (
        <PageSection className="appearance__section">
          <PageRow
            title="Dark flavor"
            description={`Used in dark mode. Light mode uses ${lightFlavor?.label ?? 'the light flavor'}.`}
          >
            <div
              className="appearance-choice__row"
              role="radiogroup"
              aria-label="Dark flavor"
            >
              {darkFlavors.map((flavor) => {
                const selected = flavor.id === family.darkFlavor.id;
                return (
                  <label
                    key={flavor.id}
                    className={`appearance-choice${selected ? ' is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      className="appearance__radio"
                      name="appearance-flavor"
                      value={flavor.id}
                      checked={selected}
                      onChange={() =>
                        setDeviceSetting('colorThemeFlavor', flavor.id)
                      }
                    />
                    <span
                      className="appearance-choice__dot"
                      aria-hidden="true"
                      style={{
                        background: flavor.swatch.background,
                        borderColor: flavor.swatch.text,
                      }}
                    />
                    {flavor.label}
                  </label>
                );
              })}
            </div>
          </PageRow>
        </PageSection>
      )}

      <PageSection className="appearance__section">
        {family ? (
          <PageRow
            title="Accent"
            description={
              custom
                ? `Your custom accent ${custom} is in use on every theme. Choosing an accent here replaces it.`
                : 'Buttons, links and focus.'
            }
            status={
              !custom && accentLabel ? (
                <span className="appearance__current">{accentLabel}</span>
              ) : undefined
            }
          >
            <div
              className="appearance-accent__row"
              role="radiogroup"
              aria-label="Accent"
            >
              {selectedOption.accents.map((accent) => {
                const selected = !custom && accent.id === family.accent;
                const color =
                  accent.swatches[shownFlavor?.id ?? family.darkFlavor.id];
                return (
                  <label
                    key={accent.id}
                    className={`appearance-accent${selected ? ' is-selected' : ''}`}
                    title={accent.label}
                  >
                    <input
                      type="radio"
                      className="appearance__radio"
                      name="appearance-accent"
                      value={accent.id}
                      aria-label={accent.label}
                      checked={selected}
                      onChange={() => chooseAccent(accent.id)}
                    />
                    <span
                      className="appearance-accent__swatch"
                      aria-hidden="true"
                      style={{ background: color }}
                    />
                  </label>
                );
              })}
            </div>
          </PageRow>
        ) : (
          <AccentColorPicker description="Buttons, links and focus. A custom color also applies on other themes until you choose one of their accents." />
        )}
      </PageSection>
    </div>
  );
}
